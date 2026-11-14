/**
 * The shapes exchanged between the collector, the store, the HTTP API and
 * the dashboard.
 *
 * Every numeric field is a measurement. A field that could not be measured
 * on the running kernel is `null`, never zero and never a guess: the
 * dashboard draws "unavailable" for `null` and a value for everything else,
 * so the distinction has to survive the whole path from `/proc` to the
 * browser.
 */

/** Milliseconds since the Unix epoch. */
export type Timestamp = number;

export interface CpuCoreUsage {
  /** Kernel index of the logical CPU, as it appears in `/proc/stat`. */
  readonly index: number;
  /** Busy time as a percentage of the sampling interval, 0 to 100. */
  readonly usage: number;
}

export interface CpuMetrics {
  /**
   * Busy time across all logical CPUs as a percentage of the sampling
   * interval, 0 to 100. `null` until two samples have been taken, because a
   * utilisation is a difference between two readings and the first reading
   * has nothing to be subtracted from.
   */
  readonly usage: number | null;
  readonly cores: readonly CpuCoreUsage[];
  readonly loadAverage: {
    readonly one: number;
    readonly five: number;
    readonly fifteen: number;
  };
  readonly logicalCount: number;
  /** From `/proc/cpuinfo`, which does not carry it on every architecture. */
  readonly model: string | null;
  /** Mean current frequency in MHz, or `null` where the kernel omits it. */
  readonly frequencyMhz: number | null;
  /** Fraction of the interval spent waiting on I/O, 0 to 100. */
  readonly iowait: number | null;
  /** Fraction of the interval stolen by a hypervisor, 0 to 100. */
  readonly steal: number | null;
}

export interface MemoryMetrics {
  readonly totalBytes: number;
  /**
   * `MemAvailable` from the kernel: memory obtainable without swapping,
   * which already accounts for reclaimable page cache. Used memory is
   * derived from it rather than from `MemFree`.
   */
  readonly availableBytes: number;
  readonly usedBytes: number;
  readonly freeBytes: number;
  readonly buffersBytes: number;
  readonly cachedBytes: number;
  /** `usedBytes / totalBytes` as a percentage, 0 to 100. */
  readonly usage: number;
  readonly swapTotalBytes: number;
  readonly swapUsedBytes: number;
  /** `null` when the host has no swap configured. */
  readonly swapUsage: number | null;
}

export interface FilesystemMetrics {
  readonly device: string;
  readonly mountPoint: string;
  readonly fsType: string;
  readonly totalBytes: number;
  readonly usedBytes: number;
  /** Space available to an unprivileged user, excluding reserved blocks. */
  readonly availableBytes: number;
  /** Used as a percentage of the space the user can actually reach. */
  readonly usage: number;
  readonly readOnly: boolean;
}

export interface DiskDeviceMetrics {
  readonly device: string;
  readonly readBytesPerSecond: number | null;
  readonly writeBytesPerSecond: number | null;
  readonly readsPerSecond: number | null;
  readonly writesPerSecond: number | null;
  /** Share of the interval the device had I/O in flight, 0 to 100. */
  readonly utilisation: number | null;
}

export interface DiskMetrics {
  readonly filesystems: readonly FilesystemMetrics[];
  readonly devices: readonly DiskDeviceMetrics[];
  /** Totals across the distinct filesystems, with bind mounts excluded. */
  readonly totalBytes: number;
  readonly usedBytes: number;
  readonly availableBytes: number;
  readonly usage: number;
  readonly readBytesPerSecond: number | null;
  readonly writeBytesPerSecond: number | null;
}

export interface NetworkInterfaceMetrics {
  readonly name: string;
  readonly receivedBytes: number;
  readonly transmittedBytes: number;
  readonly receivedPackets: number;
  readonly transmittedPackets: number;
  readonly receiveErrors: number;
  readonly transmitErrors: number;
  readonly receiveBytesPerSecond: number | null;
  readonly transmitBytesPerSecond: number | null;
  /** `up`, `down`, `unknown` or whatever `/sys` reports for the link. */
  readonly state: string;
  readonly loopback: boolean;
}

export interface NetworkMetrics {
  readonly interfaces: readonly NetworkInterfaceMetrics[];
  /** Totals over the non-loopback interfaces only. */
  readonly receiveBytesPerSecond: number | null;
  readonly transmitBytesPerSecond: number | null;
  readonly receivedBytes: number;
  readonly transmittedBytes: number;
}

export interface SystemInfo {
  readonly hostname: string;
  readonly os: string;
  readonly kernel: string;
  readonly architecture: string;
  readonly uptimeSeconds: number;
  readonly bootTime: Timestamp;
  readonly logicalCpus: number;
  readonly cpuModel: string | null;
  readonly totalMemoryBytes: number;
  readonly agentVersion: string;
  readonly nodeVersion: string;
  /** True when the agent runs as uid 0; shown so the user can see it. */
  readonly privileged: boolean;
}

export type ProcessSortKey = 'cpu' | 'memory' | 'pid' | 'name' | 'uptime';
export type SortDirection = 'asc' | 'desc';

export interface ProcessInfo {
  readonly pid: number;
  readonly ppid: number;
  /** The executable name from `/proc/<pid>/stat`, never the command line. */
  readonly name: string;
  /** Single-letter process state: R, S, D, Z, T and the rest. */
  readonly state: string;
  /** Share of one logical CPU over the interval, 0 to 100. */
  readonly cpu: number | null;
  readonly memoryBytes: number;
  /** Resident memory as a percentage of total memory. */
  readonly memory: number;
  readonly threads: number;
  /** Seconds since the process started, from its start time in jiffies. */
  readonly uptimeSeconds: number | null;
}

export interface ProcessSnapshot {
  readonly timestamp: Timestamp;
  readonly total: number;
  readonly returned: number;
  readonly processes: readonly ProcessInfo[];
}

export interface MetricsSample {
  readonly timestamp: Timestamp;
  /** Length of the interval the rates were measured over, in ms. */
  readonly intervalMs: number | null;
  readonly cpu: CpuMetrics;
  readonly memory: MemoryMetrics;
  readonly disk: DiskMetrics;
  readonly network: NetworkMetrics;
  /** Collectors that threw during this sample, by name. */
  readonly degraded: readonly string[];
}

/** One row of the history table: the subset worth keeping on disk. */
export interface HistoryPoint {
  readonly timestamp: Timestamp;
  readonly cpu: number | null;
  readonly memory: number | null;
  readonly swap: number | null;
  readonly disk: number | null;
  readonly diskReadBps: number | null;
  readonly diskWriteBps: number | null;
  readonly netRxBps: number | null;
  readonly netTxBps: number | null;
  readonly load1: number | null;
}

export type AlertSeverity = 'warning' | 'critical';
export type AlertState = 'active' | 'resolved';

export type AlertRuleId =
  'cpu-high' | 'memory-high' | 'disk-low' | 'load-high' | 'agent-stale';

export interface AlertRuleConfig {
  readonly id: AlertRuleId;
  readonly enabled: boolean;
  /**
   * The value at which the rule starts firing. Its unit depends on the
   * rule: a percentage for CPU, memory and disk, a ratio of load to logical
   * CPUs for load, seconds for staleness.
   */
  readonly threshold: number;
  /**
   * The value the metric must come back past before the alert resolves.
   * Keeping it apart from `threshold` is what stops an alert flapping once
   * a measurement sits on the boundary.
   */
  readonly clearThreshold: number;
  /** The condition must hold for this long before the alert is raised. */
  readonly forSeconds: number;
  /** No further alert from this rule is raised inside this window. */
  readonly cooldownSeconds: number;
  readonly severity: AlertSeverity;
}

export interface Alert {
  readonly id: number;
  readonly rule: AlertRuleId;
  readonly severity: AlertSeverity;
  readonly state: AlertState;
  /** Human-readable subject, such as a mount point or an interface name. */
  readonly scope: string | null;
  readonly message: string;
  readonly value: number;
  readonly threshold: number;
  readonly startedAt: Timestamp;
  readonly resolvedAt: Timestamp | null;
}

export interface HealthStatus {
  readonly status: 'ok' | 'degraded' | 'stale';
  readonly agentRunning: boolean;
  readonly uptimeSeconds: number;
  readonly samplesCollected: number;
  readonly collectionErrors: number;
  readonly lastSampleAt: Timestamp | null;
  /** Milliseconds since the last successful sample, or `null` if none. */
  readonly lastSampleAgeMs: number | null;
  readonly degraded: readonly string[];
  readonly storedPoints: number;
  readonly databaseBytes: number | null;
  readonly activeAlerts: number;
  readonly streamClients: number;
  readonly version: string;
}
