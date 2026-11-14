import { beforeEach, describe, expect, it } from 'vitest';
import { AlertEngine, observationsFor } from '../../src/alerts/engine.js';
import { DEFAULT_ALERT_RULES } from '../../src/config/config.js';
import type {
  Alert,
  AlertRuleConfig,
  AlertRuleId,
  MetricsSample,
  Timestamp,
} from '../../src/types.js';

/** Records what the engine decided, in place of the database. */
class RecordingSink {
  readonly inserted: Omit<Alert, 'id'>[] = [];
  readonly resolved: { id: number; at: Timestamp }[] = [];
  private nextId = 1;

  insertAlert(alert: Omit<Alert, 'id'>): number {
    this.inserted.push(alert);
    return this.nextId++;
  }

  resolveAlert(id: number, at: Timestamp): void {
    this.resolved.push({ id, at });
  }
}

function rule(overrides: Partial<AlertRuleConfig> = {}): AlertRuleConfig {
  return {
    id: 'cpu-high',
    enabled: true,
    threshold: 90,
    clearThreshold: 80,
    forSeconds: 0,
    cooldownSeconds: 0,
    severity: 'warning',
    ...overrides,
  };
}

function sample(
  cpu: number | null,
  options: Partial<{
    memory: number;
    load: number;
    filesystems: { mountPoint: string; usage: number; readOnly: boolean }[];
  }> = {},
): MetricsSample {
  return {
    timestamp: 0,
    intervalMs: 1000,
    cpu: {
      usage: cpu,
      cores: [],
      loadAverage: { one: options.load ?? 0, five: 0, fifteen: 0 },
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
      freeBytes: 50,
      buffersBytes: 0,
      cachedBytes: 0,
      usage: options.memory ?? 10,
      swapTotalBytes: 0,
      swapUsedBytes: 0,
      swapUsage: null,
    },
    disk: {
      filesystems: (options.filesystems ?? []).map((entry) => ({
        device: '/dev/test',
        mountPoint: entry.mountPoint,
        fsType: 'ext4',
        totalBytes: 100,
        usedBytes: entry.usage,
        availableBytes: 100 - entry.usage,
        usage: entry.usage,
        readOnly: entry.readOnly,
      })),
      devices: [],
      totalBytes: 100,
      usedBytes: 10,
      availableBytes: 90,
      usage: 10,
      readBytesPerSecond: null,
      writeBytesPerSecond: null,
    },
    network: {
      interfaces: [],
      receiveBytesPerSecond: null,
      transmitBytesPerSecond: null,
      receivedBytes: 0,
      transmittedBytes: 0,
    },
    degraded: [],
  };
}

const CONTEXT = { now: 1_000_000, logicalCpus: 4, lastSampleAgeMs: null };

describe('observationsFor', () => {
  it('produces no CPU observation when utilisation was not measured', () => {
    const rules = observationsFor(sample(null), CONTEXT).map((o) => o.rule);
    expect(rules).not.toContain('cpu-high');
    expect(rules).toContain('memory-high');
  });

  it('measures load relative to the logical CPU count', () => {
    const observation = observationsFor(sample(10, { load: 8 }), CONTEXT).find(
      (entry) => entry.rule === 'load-high',
    );
    expect(observation?.value).toBe(2);
  });

  it('produces one disk observation per writable filesystem', () => {
    const observations = observationsFor(
      sample(10, {
        filesystems: [
          { mountPoint: '/', usage: 50, readOnly: false },
          { mountPoint: '/boot/efi', usage: 99, readOnly: true },
        ],
      }),
      CONTEXT,
    ).filter((entry) => entry.rule === 'disk-low');
    expect(observations.map((entry) => entry.scope)).toEqual(['/']);
  });
});

describe('AlertEngine', () => {
  let sink: RecordingSink;

  beforeEach(() => {
    sink = new RecordingSink();
  });

  function engineWith(...rules: AlertRuleConfig[]): AlertEngine {
    const disabled = DEFAULT_ALERT_RULES.map((existing) => ({
      ...existing,
      enabled: false,
    }));
    const byId = new Map<AlertRuleId, AlertRuleConfig>(
      disabled.map((existing) => [existing.id, existing]),
    );
    for (const override of rules) byId.set(override.id, override);
    return new AlertEngine([...byId.values()], sink);
  }

  it('raises nothing while the value is below the threshold', () => {
    const engine = engineWith(rule());
    expect(engine.evaluate(sample(50), CONTEXT)).toEqual([]);
    expect(sink.inserted).toHaveLength(0);
  });

  it('raises once the threshold is passed', () => {
    const engine = engineWith(rule());
    const changes = engine.evaluate(sample(95), CONTEXT);
    expect(changes).toHaveLength(1);
    expect(changes[0]?.kind).toBe('raised');
    expect(changes[0]?.alert.message).toContain('95.0%');
    expect(changes[0]?.alert.threshold).toBe(90);
  });

  it('raises only once while the condition holds', () => {
    const engine = engineWith(rule());
    engine.evaluate(sample(95), CONTEXT);
    engine.evaluate(sample(96), { ...CONTEXT, now: CONTEXT.now + 1000 });
    expect(sink.inserted).toHaveLength(1);
  });

  it('waits for the condition to hold for the configured duration', () => {
    const engine = engineWith(rule({ forSeconds: 60 }));
    engine.evaluate(sample(95), CONTEXT);
    expect(sink.inserted).toHaveLength(0);

    engine.evaluate(sample(95), { ...CONTEXT, now: CONTEXT.now + 30_000 });
    expect(sink.inserted).toHaveLength(0);

    engine.evaluate(sample(95), { ...CONTEXT, now: CONTEXT.now + 61_000 });
    expect(sink.inserted).toHaveLength(1);
  });

  it('restarts the duration when the value falls back', () => {
    const engine = engineWith(rule({ forSeconds: 60 }));
    engine.evaluate(sample(95), CONTEXT);
    engine.evaluate(sample(10), { ...CONTEXT, now: CONTEXT.now + 30_000 });
    engine.evaluate(sample(95), { ...CONTEXT, now: CONTEXT.now + 61_000 });
    expect(sink.inserted).toHaveLength(0);
  });

  it('does not resolve between the clearing and firing thresholds', () => {
    const engine = engineWith(rule());
    engine.evaluate(sample(95), CONTEXT);
    const changes = engine.evaluate(sample(85), {
      ...CONTEXT,
      now: CONTEXT.now + 1000,
    });
    expect(changes).toEqual([]);
    expect(sink.resolved).toHaveLength(0);
  });

  it('resolves once the value returns to the clearing threshold', () => {
    const engine = engineWith(rule());
    engine.evaluate(sample(95), CONTEXT);
    const changes = engine.evaluate(sample(70), {
      ...CONTEXT,
      now: CONTEXT.now + 5000,
    });
    expect(changes[0]?.kind).toBe('resolved');
    expect(sink.resolved).toEqual([{ id: 1, at: CONTEXT.now + 5000 }]);
  });

  it('stays quiet for the cooldown after resolving', () => {
    const engine = engineWith(rule({ cooldownSeconds: 600 }));
    engine.evaluate(sample(95), CONTEXT);
    engine.evaluate(sample(10), { ...CONTEXT, now: CONTEXT.now + 1000 });

    engine.evaluate(sample(95), { ...CONTEXT, now: CONTEXT.now + 2000 });
    expect(sink.inserted).toHaveLength(1);

    engine.evaluate(sample(95), { ...CONTEXT, now: CONTEXT.now + 700_000 });
    expect(sink.inserted).toHaveLength(2);
  });

  it('tracks each filesystem separately', () => {
    const engine = engineWith(
      rule({ id: 'disk-low', threshold: 90, clearThreshold: 85 }),
    );
    const changes = engine.evaluate(
      sample(0, {
        filesystems: [
          { mountPoint: '/', usage: 95, readOnly: false },
          { mountPoint: '/home', usage: 50, readOnly: false },
        ],
      }),
      CONTEXT,
    );
    expect(changes).toHaveLength(1);
    expect(changes[0]?.alert.scope).toBe('/');
  });

  it('resolves an alert whose scope has gone away', () => {
    const engine = engineWith(
      rule({ id: 'disk-low', threshold: 90, clearThreshold: 85 }),
    );
    engine.evaluate(
      sample(0, {
        filesystems: [{ mountPoint: '/mnt', usage: 95, readOnly: false }],
      }),
      CONTEXT,
    );
    const changes = engine.evaluate(sample(0, { filesystems: [] }), {
      ...CONTEXT,
      now: CONTEXT.now + 1000,
    });
    expect(changes[0]?.kind).toBe('resolved');
    expect(changes[0]?.alert.scope).toBe('/mnt');
  });

  it('raises staleness from the context, with no sample at all', () => {
    const engine = engineWith(
      rule({
        id: 'agent-stale',
        threshold: 60,
        clearThreshold: 30,
        severity: 'critical',
      }),
    );
    const changes = engine.evaluate(null, {
      ...CONTEXT,
      lastSampleAgeMs: 120_000,
    });
    expect(changes).toHaveLength(1);
    expect(changes[0]?.alert.rule).toBe('agent-stale');
    expect(changes[0]?.alert.severity).toBe('critical');
  });

  it('ignores a rule that is disabled', () => {
    const engine = engineWith(rule({ enabled: false }));
    expect(engine.evaluate(sample(99), CONTEXT)).toEqual([]);
  });

  it('adopts alerts left active by an earlier run', () => {
    const engine = engineWith(rule());
    engine.adopt([
      {
        id: 42,
        rule: 'cpu-high',
        severity: 'warning',
        state: 'active',
        scope: null,
        message: 'busy',
        value: 95,
        threshold: 90,
        startedAt: 1,
        resolvedAt: null,
      },
    ]);

    // The condition is over, so the adopted alert resolves rather than a
    // second one being raised for the same thing.
    const changes = engine.evaluate(sample(10), CONTEXT);
    expect(sink.inserted).toHaveLength(0);
    expect(changes[0]?.kind).toBe('resolved');
    expect(sink.resolved[0]?.id).toBe(42);
  });
});
