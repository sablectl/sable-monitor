import { mkdtemp, stat } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { MetricsStore, SCHEMA_VERSION } from '../../src/store/database.js';
import type { MetricsSample } from '../../src/types.js';

function sampleAt(timestamp: number, cpu: number | null): MetricsSample {
  return {
    timestamp,
    intervalMs: 1000,
    cpu: {
      usage: cpu,
      cores: [],
      loadAverage: { one: 1, five: 1, fifteen: 1 },
      logicalCount: 4,
      model: null,
      frequencyMhz: null,
      iowait: null,
      steal: null,
    },
    memory: {
      totalBytes: 100,
      availableBytes: 50,
      usedBytes: 50,
      freeBytes: 20,
      buffersBytes: 10,
      cachedBytes: 20,
      usage: 50,
      swapTotalBytes: 0,
      swapUsedBytes: 0,
      swapUsage: null,
    },
    disk: {
      filesystems: [],
      devices: [],
      totalBytes: 100,
      usedBytes: 10,
      availableBytes: 90,
      usage: 10,
      readBytesPerSecond: 1000,
      writeBytesPerSecond: null,
    },
    network: {
      interfaces: [],
      receiveBytesPerSecond: 2000,
      transmitBytesPerSecond: null,
      receivedBytes: 0,
      transmittedBytes: 0,
    },
    degraded: [],
  };
}

describe('MetricsStore', () => {
  let store: MetricsStore;

  beforeEach(() => {
    store = new MetricsStore({
      path: ':memory:',
      retentionDays: 1,
      alertHistoryLimit: 5,
    });
  });

  afterEach(() => {
    store.close();
  });

  it('starts empty', () => {
    expect(store.countSamples()).toBe(0);
    expect(store.oldestSample()).toBeNull();
    expect(store.history({ from: 0, to: Date.now(), limit: 10 })).toEqual([]);
  });

  it('stores and reads back a sample, nulls included', () => {
    store.insertSample(sampleAt(1000, null));
    const [point] = store.history({ from: 0, to: 2000, limit: 10 });
    expect(point?.timestamp).toBe(1000);
    expect(point?.cpu).toBeNull();
    expect(point?.memory).toBe(50);
    expect(point?.diskWriteBps).toBeNull();
    expect(point?.netRxBps).toBe(2000);
  });

  it('writes a batch in one transaction', () => {
    store.insertSamples([sampleAt(1, 1), sampleAt(2, 2), sampleAt(3, 3)]);
    expect(store.countSamples()).toBe(3);
  });

  it('replaces a sample that shares a timestamp', () => {
    store.insertSamples([sampleAt(1, 1), sampleAt(1, 2)]);
    expect(store.countSamples()).toBe(1);
    expect(store.history({ from: 0, to: 10, limit: 10 })[0]?.cpu).toBe(2);
  });

  it('returns only the window asked for', () => {
    store.insertSamples([sampleAt(10, 1), sampleAt(20, 2), sampleAt(30, 3)]);
    const points = store.history({ from: 15, to: 25, limit: 10 });
    expect(points.map((point) => point.timestamp)).toEqual([20]);
  });

  it('thins a long series to the requested limit, without inventing points', () => {
    const samples = Array.from({ length: 100 }, (_unused, index) =>
      sampleAt(index + 1, index),
    );
    store.insertSamples(samples);
    const points = store.history({ from: 0, to: 1000, limit: 10 });
    expect(points.length).toBeLessThanOrEqual(10);
    expect(points.every((point) => point.timestamp % 1 === 0)).toBe(true);
    // Every returned point is one that was actually stored.
    const stored = new Set(samples.map((sample) => sample.timestamp));
    expect(points.every((point) => stored.has(point.timestamp))).toBe(true);
  });

  it('deletes samples older than the retention window', () => {
    const now = Date.now();
    store.insertSamples([
      sampleAt(now - 3 * 86_400_000, 1),
      sampleAt(now - 2 * 86_400_000, 2),
      sampleAt(now - 1000, 3),
    ]);
    expect(store.prune(now)).toBe(2);
    expect(store.countSamples()).toBe(1);
  });

  it('reports the oldest sample it still holds', () => {
    store.insertSamples([sampleAt(500, 1), sampleAt(900, 2)]);
    expect(store.oldestSample()).toBe(500);
  });

  it('records an alert and resolves it', () => {
    const id = store.insertAlert({
      rule: 'cpu-high',
      severity: 'warning',
      state: 'active',
      scope: null,
      message: 'busy',
      value: 95,
      threshold: 90,
      startedAt: 1000,
      resolvedAt: null,
    });

    expect(store.activeAlerts()).toHaveLength(1);
    store.resolveAlert(id, 2000);
    expect(store.activeAlerts()).toHaveLength(0);

    const [alert] = store.alerts(10, 'resolved');
    expect(alert?.resolvedAt).toBe(2000);
    expect(alert?.rule).toBe('cpu-high');
  });

  it('keeps alert history within its limit, sparing active alerts', () => {
    for (let index = 0; index < 20; index += 1) {
      const id = store.insertAlert({
        rule: 'cpu-high',
        severity: 'warning',
        state: 'active',
        scope: null,
        message: 'busy',
        value: 95,
        threshold: 90,
        startedAt: 1000 + index,
        resolvedAt: null,
      });
      if (index < 19) store.resolveAlert(id, 2000 + index);
    }

    store.prune(Date.now());
    expect(store.alerts(100, 'resolved')).toHaveLength(5);
    expect(store.activeAlerts()).toHaveLength(1);
  });

  it('resolves everything still active', () => {
    store.insertAlert({
      rule: 'memory-high',
      severity: 'warning',
      state: 'active',
      scope: null,
      message: 'full',
      value: 95,
      threshold: 90,
      startedAt: 1,
      resolvedAt: null,
    });
    store.resolveAllActive(5);
    expect(store.activeAlerts()).toHaveLength(0);
  });
});

describe('MetricsStore on disk', () => {
  it('creates the database with owner-only permissions and migrates it', async () => {
    const directory = await mkdtemp(join(tmpdir(), 'sable-monitor-store-'));
    const path = join(directory, 'nested', 'metrics.db');

    const first = new MetricsStore({
      path,
      retentionDays: 1,
      alertHistoryLimit: 10,
    });
    first.insertSample(sampleAt(1000, 1));
    expect(first.sizeBytes()).toBeGreaterThan(0);
    first.close();

    const mode = (await stat(path)).mode & 0o777;
    expect(mode).toBe(0o600);
    expect((await stat(join(directory, 'nested'))).mode & 0o777).toBe(0o700);

    // Reopening an existing database must find its data, not replace it.
    const second = new MetricsStore({
      path,
      retentionDays: 1,
      alertHistoryLimit: 10,
    });
    expect(second.countSamples()).toBe(1);
    second.close();

    expect(SCHEMA_VERSION).toBe(1);
  });
});
