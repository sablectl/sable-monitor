import { AlertEngine, type AlertChange } from '../alerts/engine.js';
import { collectCpu, type CpuSnapshot } from '../collect/cpu.js';
import { collectDisk, type DiskstatsEntry } from '../collect/disk.js';
import { collectMemory } from '../collect/memory.js';
import { collectNetwork, type InterfaceCounters } from '../collect/network.js';
import {
  collectProcesses,
  type ProcessQuery,
  type ProcessCpuSnapshot,
} from '../collect/processes.js';
import { Procfs } from '../collect/procfs.js';
import { collectSystemInfo } from '../collect/system.js';
import type { Config } from '../config/config.js';
import type { MetricsStore } from '../store/database.js';
import type {
  Alert,
  HealthStatus,
  MetricsSample,
  ProcessSnapshot,
  SystemInfo,
  Timestamp,
} from '../types.js';

/**
 * The monitoring agent: one timer, four collectors and a bounded buffer.
 *
 * The loop is a chain of `setTimeout` calls rather than a `setInterval`,
 * so a slow sample delays the next one instead of queueing another on top
 * of it. A collector that throws degrades that one metric for that one
 * sample — its name is listed in `degraded` and the rest of the sample is
 * still produced, stored and served — because a monitoring agent that
 * stops at the first unreadable file is worse than useless on the machine
 * that needs it most.
 *
 * Everything the agent holds is bounded. The live buffer is a ring of a
 * configured size, the pending database writes are capped, and the
 * subscriber list is limited by the server above it. Nothing in here can
 * grow until the host runs out of memory.
 *
 * The agent needs no privileges. Everything it reads is world readable on
 * a stock kernel, and nothing it does writes outside its own database.
 */

export type SampleListener = (sample: MetricsSample) => void;
export type AlertListener = (change: AlertChange) => void;

/** Most samples the write queue holds before the oldest are dropped. */
const MAX_PENDING_WRITES = 2000;

export interface AgentOptions {
  readonly config: Config;
  readonly store: MetricsStore;
  readonly version: string;
  readonly procfs?: Procfs;
  /** Reported but not thrown, so one bad read cannot stop the agent. */
  readonly onError?: (scope: string, error: unknown) => void;
}

export class Agent {
  private readonly config: Config;
  private readonly store: MetricsStore;
  private readonly procfs: Procfs;
  private readonly version: string;
  private readonly onError: (scope: string, error: unknown) => void;
  private readonly alerts: AlertEngine;

  private readonly buffer: MetricsSample[] = [];
  private readonly pending: MetricsSample[] = [];
  private readonly sampleListeners = new Set<SampleListener>();
  private readonly alertListeners = new Set<AlertListener>();

  private cpuSnapshot: CpuSnapshot | null = null;
  private diskSnapshot: ReadonlyMap<string, DiskstatsEntry> | null = null;
  private networkSnapshot: ReadonlyMap<string, InterfaceCounters> | null = null;
  private processSnapshot: ProcessCpuSnapshot | null = null;
  private processSnapshotAt: Timestamp | null = null;

  private sampleTimer: NodeJS.Timeout | null = null;
  private writeTimer: NodeJS.Timeout | null = null;
  private cleanupTimer: NodeJS.Timeout | null = null;
  private staleTimer: NodeJS.Timeout | null = null;

  private lastSampleAt: Timestamp | null = null;
  private startedAt: Timestamp | null = null;
  private running = false;
  private collecting = false;

  private samplesCollected = 0;
  private collectionErrors = 0;
  private droppedWrites = 0;

  constructor(options: AgentOptions) {
    this.config = options.config;
    this.store = options.store;
    this.version = options.version;
    this.procfs = options.procfs ?? new Procfs();
    this.onError =
      options.onError ??
      ((scope, error) => {
        console.error(`[sable-monitor] ${scope}: ${describe(error)}`);
      });
    this.alerts = new AlertEngine(this.config.alerts.rules, this.store);
  }

  /* Lifecycle ---------------------------------------------------------- */

  async start(): Promise<void> {
    if (this.running) return;
    this.running = true;
    this.startedAt = Date.now();

    if (this.config.alerts.enabled) {
      this.alerts.adopt(this.store.activeAlerts());
    }

    // The first sample establishes the counter baseline; its rates are
    // null by construction and it is not stored.
    await this.collect();

    this.scheduleSample();

    this.writeTimer = setInterval(() => {
      this.flush();
    }, this.config.storage.writeIntervalMs);

    this.cleanupTimer = setInterval(() => {
      this.cleanup();
    }, this.config.storage.cleanupIntervalMs);

    // Staleness has to be noticed when sampling has stopped, so it is
    // checked on a timer of its own rather than inside the sample loop.
    this.staleTimer = setInterval(() => {
      this.evaluateAlerts(null);
    }, 15_000);

    for (const timer of [this.writeTimer, this.cleanupTimer, this.staleTimer]) {
      timer.unref();
    }
  }

  /**
   * Stops the timers, writes what is buffered and resolves active alerts.
   *
   * An in-flight collection is allowed to finish first: abandoning it
   * would leave the counter snapshots describing a moment that never
   * ended, and the whole operation takes milliseconds.
   */
  async stop(): Promise<void> {
    if (!this.running) return;
    this.running = false;

    for (const timer of [
      this.sampleTimer,
      this.writeTimer,
      this.cleanupTimer,
      this.staleTimer,
    ]) {
      if (timer !== null) clearInterval(timer);
    }
    this.sampleTimer = null;
    this.writeTimer = null;
    this.cleanupTimer = null;
    this.staleTimer = null;

    const deadline = Date.now() + 5000;
    while (this.collecting && Date.now() < deadline) {
      await new Promise((resolve) => setTimeout(resolve, 20));
    }

    this.flush();
    try {
      this.store.resolveAllActive(Date.now());
    } catch (error: unknown) {
      this.onError('shutdown', error);
    }

    this.sampleListeners.clear();
    this.alertListeners.clear();
  }

  private scheduleSample(): void {
    if (!this.running) return;
    this.sampleTimer = setTimeout(() => {
      void this.collect().finally(() => {
        this.scheduleSample();
      });
    }, this.config.collection.intervalMs);
    this.sampleTimer.unref();
  }

  /* Collection --------------------------------------------------------- */

  /** Takes one sample. Never rejects: failures are recorded, not thrown. */
  async collect(): Promise<MetricsSample | null> {
    if (this.collecting) return null;
    this.collecting = true;

    const now = Date.now();
    const intervalMs =
      this.lastSampleAt === null ? null : now - this.lastSampleAt;
    const degraded: string[] = [];

    try {
      const cpu = await this.tryCollect('cpu', degraded, () =>
        collectCpu(this.procfs, this.cpuSnapshot),
      );
      const memory = await this.tryCollect('memory', degraded, () =>
        collectMemory(this.procfs),
      );
      const disk = await this.tryCollect('disk', degraded, () =>
        collectDisk(this.procfs, this.diskSnapshot, intervalMs),
      );
      const network = await this.tryCollect('network', degraded, () =>
        collectNetwork(this.procfs, this.networkSnapshot, intervalMs),
      );

      if (cpu !== null) this.cpuSnapshot = cpu.snapshot;
      if (disk !== null) this.diskSnapshot = disk.snapshot;
      if (network !== null) this.networkSnapshot = network.snapshot;

      // A sample without CPU or memory describes nothing useful, and
      // storing it would draw a hole in every chart.
      if (cpu === null || memory === null) {
        this.collectionErrors += 1;
        return null;
      }

      const sample: MetricsSample = {
        timestamp: now,
        intervalMs,
        cpu: cpu.metrics,
        memory,
        disk: disk?.metrics ?? EMPTY_DISK,
        network: network?.metrics ?? EMPTY_NETWORK,
        degraded,
      };

      this.lastSampleAt = now;
      this.samplesCollected += 1;
      this.remember(sample);

      // The first sample has no rates to store, so it is kept in memory
      // for the live view but not written to the history table.
      if (intervalMs !== null) this.enqueue(sample);

      this.evaluateAlerts(sample);

      for (const listener of this.sampleListeners) {
        try {
          listener(sample);
        } catch (error: unknown) {
          this.onError('subscriber', error);
        }
      }

      return sample;
    } finally {
      this.collecting = false;
    }
  }

  private async tryCollect<T>(
    scope: string,
    degraded: string[],
    collector: () => Promise<T>,
  ): Promise<T | null> {
    try {
      return await collector();
    } catch (error: unknown) {
      degraded.push(scope);
      this.collectionErrors += 1;
      this.onError(scope, error);
      return null;
    }
  }

  private remember(sample: MetricsSample): void {
    this.buffer.push(sample);
    while (this.buffer.length > this.config.collection.bufferSize) {
      this.buffer.shift();
    }
  }

  private enqueue(sample: MetricsSample): void {
    this.pending.push(sample);
    while (this.pending.length > MAX_PENDING_WRITES) {
      this.pending.shift();
      this.droppedWrites += 1;
    }
  }

  /** Writes the queued samples in one transaction. */
  flush(): void {
    if (this.pending.length === 0) return;
    const batch = this.pending.splice(0, this.pending.length);
    try {
      this.store.insertSamples(batch);
    } catch (error: unknown) {
      // The samples are dropped rather than retried: a store that is
      // failing will not be fixed by a larger queue, and live monitoring
      // has to keep working while it is.
      this.onError('storage', error);
    }
  }

  private cleanup(): void {
    try {
      this.store.prune();
    } catch (error: unknown) {
      this.onError('retention', error);
    }
  }

  private evaluateAlerts(sample: MetricsSample | null): void {
    if (!this.config.alerts.enabled) return;
    try {
      const changes = this.alerts.evaluate(sample, {
        now: Date.now(),
        logicalCpus: sample?.cpu.logicalCount ?? 0,
        lastSampleAgeMs:
          this.lastSampleAt === null ? null : Date.now() - this.lastSampleAt,
      });
      for (const change of changes) {
        for (const listener of this.alertListeners) {
          try {
            listener(change);
          } catch (error: unknown) {
            this.onError('subscriber', error);
          }
        }
      }
    } catch (error: unknown) {
      this.onError('alerts', error);
    }
  }

  /* Reading ------------------------------------------------------------ */

  current(): MetricsSample | null {
    return this.buffer.at(-1) ?? null;
  }

  recent(limit: number): MetricsSample[] {
    const bounded = Math.max(1, Math.min(limit, this.buffer.length));
    return this.buffer.slice(-bounded);
  }

  activeAlerts(): Alert[] {
    return this.store.activeAlerts();
  }

  async systemInfo(): Promise<SystemInfo> {
    const current = this.current();
    return await collectSystemInfo(this.procfs, {
      agentVersion: this.version,
      cpuModel: current?.cpu.model ?? null,
      logicalCpus: current?.cpu.logicalCount ?? 0,
    });
  }

  /**
   * Reads the process table.
   *
   * Per-process CPU is a rate like any other, so it needs two readings.
   * The snapshot taken by the previous call is used as the baseline, which
   * means the first call after startup reports `null` for every process
   * and the second reports the usage over the time between them.
   */
  async processes(query: ProcessQuery = {}): Promise<ProcessSnapshot> {
    const now = Date.now();
    const current = this.current();
    const uptime = await this.uptimeSeconds();

    const reading = await collectProcesses(this.procfs, {
      previous: this.processSnapshot,
      intervalMs:
        this.processSnapshotAt === null ? null : now - this.processSnapshotAt,
      totalMemoryBytes: current?.memory.totalBytes ?? 0,
      systemUptimeSeconds: uptime,
      query,
      maxRows: this.config.collection.processRows,
    });

    this.processSnapshot = reading.cpuSnapshot;
    this.processSnapshotAt = now;
    return reading.snapshot;
  }

  private async uptimeSeconds(): Promise<number> {
    try {
      const text = await this.procfs.readProc('uptime');
      return Number.parseFloat(text.split(' ')[0] ?? '0');
    } catch {
      return 0;
    }
  }

  health(streamClients: number): HealthStatus {
    const now = Date.now();
    const age = this.lastSampleAt === null ? null : now - this.lastSampleAt;
    const stale = age !== null && age > this.config.collection.intervalMs * 5;
    const degraded = this.current()?.degraded ?? [];

    let storedPoints = 0;
    let databaseBytes: number | null = null;
    try {
      storedPoints = this.store.countSamples();
      databaseBytes = this.store.sizeBytes();
    } catch (error: unknown) {
      this.onError('health', error);
    }

    return {
      status: stale ? 'stale' : degraded.length > 0 ? 'degraded' : 'ok',
      agentRunning: this.running,
      uptimeSeconds:
        this.startedAt === null ? 0 : Math.round((now - this.startedAt) / 1000),
      samplesCollected: this.samplesCollected,
      collectionErrors: this.collectionErrors,
      lastSampleAt: this.lastSampleAt,
      lastSampleAgeMs: age,
      degraded,
      storedPoints,
      databaseBytes,
      activeAlerts: this.store.activeAlerts().length,
      streamClients,
      version: this.version,
    };
  }

  /** Samples dropped because the write queue was full. */
  get dropped(): number {
    return this.droppedWrites;
  }

  onSample(listener: SampleListener): () => void {
    this.sampleListeners.add(listener);
    return () => this.sampleListeners.delete(listener);
  }

  onAlert(listener: AlertListener): () => void {
    this.alertListeners.add(listener);
    return () => this.alertListeners.delete(listener);
  }
}

const EMPTY_DISK = {
  filesystems: [],
  devices: [],
  totalBytes: 0,
  usedBytes: 0,
  availableBytes: 0,
  usage: 0,
  readBytesPerSecond: null,
  writeBytesPerSecond: null,
} as const;

const EMPTY_NETWORK = {
  interfaces: [],
  receiveBytesPerSecond: null,
  transmitBytesPerSecond: null,
  receivedBytes: 0,
  transmittedBytes: 0,
} as const;

function describe(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
