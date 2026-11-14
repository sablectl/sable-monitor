import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { Agent } from '../../src/agent/agent.js';
import { parseConfig, type Config } from '../../src/config/config.js';
import { MetricsStore } from '../../src/store/database.js';
import { VERSION } from '../../src/version.js';

/**
 * The agent against the kernel of the machine running the suite.
 *
 * Nothing here asserts a particular utilisation — that depends on what
 * else the machine is doing — only that the values are measured, are in
 * range and are internally consistent. A test that demanded a specific
 * figure from a real host would be a test that fails for the wrong
 * reason.
 */

describe('Agent on the local host', () => {
  let directory: string;
  let store: MetricsStore;
  let agent: Agent;
  let config: Config;
  const errors: { scope: string; error: unknown }[] = [];

  beforeEach(async () => {
    directory = await mkdtemp(join(tmpdir(), 'sable-monitor-agent-'));
    // A long interval, so the background timer cannot fire in the middle
    // of a test and make a manual `collect()` a no-op. The timer itself
    // is covered by its own test below.
    config = parseConfig({
      collection: { intervalMs: 300_000, bufferSize: 20 },
      storage: {
        path: join(directory, 'metrics.db'),
        writeIntervalMs: 300_000,
      },
    });
    store = new MetricsStore({
      path: config.storage.path,
      retentionDays: config.storage.retentionDays,
      alertHistoryLimit: config.alerts.historyLimit,
    });
    errors.length = 0;
    agent = new Agent({
      config,
      store,
      version: VERSION,
      onError: (scope, error) => errors.push({ scope, error }),
    });
  });

  afterEach(async () => {
    await agent.stop();
    store.close();
    await rm(directory, { recursive: true, force: true });
  });

  it('starts, samples the host and stops cleanly', async () => {
    await agent.start();
    const first = agent.current();
    expect(first).not.toBeNull();
    // The first sample has no earlier reading to subtract from.
    expect(first?.cpu.usage).toBeNull();
    expect(first?.intervalMs).toBeNull();

    // Long enough for every logical CPU to have accrued a tick, whatever
    // state it spent it in. Two samples taken microseconds apart have no
    // per-core movement to measure, and the collector correctly reports
    // nothing rather than inventing a zero.
    await new Promise((resolve) => setTimeout(resolve, 250));

    const second = await agent.collect();
    expect(second).not.toBeNull();
    if (second === null) return;

    expect(second.cpu.usage).not.toBeNull();
    expect(second.cpu.usage).toBeGreaterThanOrEqual(0);
    expect(second.cpu.usage).toBeLessThanOrEqual(100);
    expect(second.cpu.cores).toHaveLength(second.cpu.logicalCount);
    expect(second.intervalMs).toBeGreaterThan(0);

    await agent.stop();
    expect(errors).toEqual([]);
  });

  it('reads plausible memory and disk figures from the running kernel', async () => {
    await agent.start();
    const sample = await agent.collect();
    expect(sample).not.toBeNull();
    if (sample === null) return;

    expect(sample.memory.totalBytes).toBeGreaterThan(0);
    expect(sample.memory.usedBytes).toBeLessThanOrEqual(
      sample.memory.totalBytes,
    );
    expect(sample.memory.usage).toBeGreaterThan(0);
    expect(sample.memory.usage).toBeLessThanOrEqual(100);

    expect(sample.disk.filesystems.length).toBeGreaterThan(0);
    for (const filesystem of sample.disk.filesystems) {
      expect(filesystem.totalBytes).toBeGreaterThan(0);
      expect(filesystem.usage).toBeLessThanOrEqual(100);
    }

    // A mount point is reported once, however many times it is mounted.
    const mountPoints = (sample?.disk.filesystems ?? []).map(
      (filesystem) => filesystem.mountPoint,
    );
    expect(new Set(mountPoints).size).toBe(mountPoints.length);

    expect(sample?.network.interfaces.length).toBeGreaterThan(0);
    expect(
      sample?.network.interfaces.some((entry) => entry.name === 'lo'),
    ).toBe(true);
  });

  it('lists the processes of this machine without reading their arguments', async () => {
    await agent.start();
    const snapshot = await agent.processes({ limit: 10 });

    expect(snapshot.total).toBeGreaterThan(1);
    expect(snapshot.returned).toBeLessThanOrEqual(10);

    const self = (await agent.processes({ search: String(process.pid) }))
      .processes[0];
    expect(self?.pid).toBe(process.pid);
    expect(self?.memoryBytes).toBeGreaterThan(0);

    // The serialised snapshot must not carry a command line: this
    // process was started with a script path, and it must not appear.
    const scriptPath = process.argv[1];
    expect(scriptPath).toBeDefined();
    expect(JSON.stringify(snapshot)).not.toContain(scriptPath);
  });

  it('writes history to the database and prunes it', async () => {
    await agent.start();
    await agent.collect();
    await agent.collect();
    agent.flush();

    expect(store.countSamples()).toBeGreaterThanOrEqual(2);
    const points = store.history({
      from: 0,
      to: Date.now() + 1000,
      limit: 100,
    });
    expect(points.length).toBeGreaterThanOrEqual(2);
    expect(points[0]?.memory).toBeGreaterThan(0);

    // Nothing is old enough to remove yet.
    expect(store.prune()).toBe(0);
  });

  it('reports its own health', async () => {
    await agent.start();
    await agent.collect();
    const health = agent.health(0);

    expect(health.agentRunning).toBe(true);
    expect(health.status).toBe('ok');
    expect(health.samplesCollected).toBeGreaterThanOrEqual(2);
    expect(health.collectionErrors).toBe(0);
    expect(health.lastSampleAgeMs).toBeGreaterThanOrEqual(0);
    expect(health.version).toBe(VERSION);
  });

  it('describes the host it is running on', async () => {
    await agent.start();
    const system = await agent.systemInfo();

    expect(system.hostname.length).toBeGreaterThan(0);
    expect(system.kernel.length).toBeGreaterThan(0);
    expect(system.architecture.length).toBeGreaterThan(0);
    expect(system.uptimeSeconds).toBeGreaterThan(0);
    expect(system.bootTime).toBeLessThan(Date.now());
    expect(system.agentVersion).toBe(VERSION);
  });

  it('notifies its subscribers, and stops when they unsubscribe', async () => {
    await agent.start();
    let seen = 0;
    const unsubscribe = agent.onSample(() => {
      seen += 1;
    });

    await agent.collect();
    expect(seen).toBe(1);

    unsubscribe();
    await agent.collect();
    expect(seen).toBe(1);
  });

  it('keeps the live buffer within its configured size', async () => {
    await agent.start();
    for (let index = 0; index < 25; index += 1) await agent.collect();
    expect(agent.recent(1000)).toHaveLength(config.collection.bufferSize);
  });

  it('samples on its own timer once started', async () => {
    const ticking = new Agent({
      config: parseConfig({
        collection: { intervalMs: 500 },
        storage: { path: join(directory, 'ticking.db'), writeIntervalMs: 1000 },
      }),
      store,
      version: VERSION,
      onError: (scope, error) => errors.push({ scope, error }),
    });

    await ticking.start();
    const before = ticking.health(0).samplesCollected;
    await new Promise((resolve) => setTimeout(resolve, 1600));
    const after = ticking.health(0).samplesCollected;
    await ticking.stop();

    expect(after).toBeGreaterThan(before);
  });

  it('can be stopped twice without complaint', async () => {
    await agent.start();
    await agent.stop();
    await agent.stop();
    expect(agent.health(0).agentRunning).toBe(false);
  });
});
