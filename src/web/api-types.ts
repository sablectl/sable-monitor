/**
 * The API payloads as the dashboard reads them.
 *
 * These mirror `src/types.ts`. They are restated here because the web
 * build has its own root directory and cannot import from the server tree.
 * A `null` is a value that could not be measured and is never replaced by
 * zero.
 */

export interface CpuCoreUsage {
  readonly index: number;
  readonly usage: number;
}

export interface CpuMetrics {
  readonly usage: number | null;
  readonly cores: readonly CpuCoreUsage[];
  readonly loadAverage: {
    readonly one: number;
    readonly five: number;
    readonly fifteen: number;
  };
  readonly logicalCount: number;
  readonly model: string | null;
  readonly frequencyMhz: number | null;
  readonly iowait: number | null;
  readonly steal: number | null;
}

export interface MemoryMetrics {
  readonly totalBytes: number;
  readonly availableBytes: number;
  readonly usedBytes: number;
  readonly freeBytes: number;
  readonly buffersBytes: number;
  readonly cachedBytes: number;
  readonly usage: number;
  readonly swapTotalBytes: number;
  readonly swapUsedBytes: number;
  readonly swapUsage: number | null;
}

export interface FilesystemMetrics {
  readonly device: string;
  readonly mountPoint: string;
  readonly fsType: string;
  readonly totalBytes: number;
  readonly usedBytes: number;
  readonly availableBytes: number;
  readonly usage: number;
  readonly readOnly: boolean;
}

export interface DiskDeviceMetrics {
  readonly device: string;
  readonly readBytesPerSecond: number | null;
  readonly writeBytesPerSecond: number | null;
  readonly readsPerSecond: number | null;
  readonly writesPerSecond: number | null;
  readonly utilisation: number | null;
}

export interface DiskMetrics {
  readonly filesystems: readonly FilesystemMetrics[];
  readonly devices: readonly DiskDeviceMetrics[];
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
  readonly state: string;
  readonly loopback: boolean;
}

export interface NetworkMetrics {
  readonly interfaces: readonly NetworkInterfaceMetrics[];
  readonly receiveBytesPerSecond: number | null;
  readonly transmitBytesPerSecond: number | null;
  readonly receivedBytes: number;
  readonly transmittedBytes: number;
}

export interface MetricsSample {
  readonly timestamp: number;
  readonly intervalMs: number | null;
  readonly cpu: CpuMetrics;
  readonly memory: MemoryMetrics;
  readonly disk: DiskMetrics;
  readonly network: NetworkMetrics;
  readonly degraded: readonly string[];
}

export interface SystemInfo {
  readonly hostname: string;
  readonly os: string;
  readonly kernel: string;
  readonly architecture: string;
  readonly uptimeSeconds: number;
  readonly bootTime: number;
  readonly logicalCpus: number;
  readonly cpuModel: string | null;
  readonly totalMemoryBytes: number;
  readonly agentVersion: string;
  readonly nodeVersion: string;
  readonly privileged: boolean;
}

export type ProcessSortKey = 'cpu' | 'memory' | 'pid' | 'name' | 'uptime';
export type SortDirection = 'asc' | 'desc';

export interface ProcessInfo {
  readonly pid: number;
  readonly ppid: number;
  readonly name: string;
  readonly state: string;
  readonly cpu: number | null;
  readonly memoryBytes: number;
  readonly memory: number;
  readonly threads: number;
  readonly uptimeSeconds: number | null;
}

export interface ProcessSnapshot {
  readonly timestamp: number;
  readonly total: number;
  readonly returned: number;
  readonly processes: readonly ProcessInfo[];
}

export interface HistoryPoint {
  readonly timestamp: number;
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

export type HistoryRange = '15m' | '1h' | '6h' | '24h' | '7d';

export interface HistoryResponse {
  readonly from: number;
  readonly to: number;
  readonly count: number;
  readonly retainedFrom: number | null;
  readonly points: readonly HistoryPoint[];
}

export type AlertSeverity = 'warning' | 'critical';
export type AlertRuleId =
  'cpu-high' | 'memory-high' | 'disk-low' | 'load-high' | 'agent-stale';

export interface Alert {
  readonly id: number;
  readonly rule: AlertRuleId;
  readonly severity: AlertSeverity;
  readonly state: 'active' | 'resolved';
  readonly scope: string | null;
  readonly message: string;
  readonly value: number;
  readonly threshold: number;
  readonly startedAt: number;
  readonly resolvedAt: number | null;
}

export interface AlertsResponse {
  readonly active: readonly Alert[];
  readonly alerts: readonly Alert[];
}

export interface AlertEvent {
  readonly kind: 'raised' | 'resolved';
  readonly alert: Alert;
}

export interface HealthStatus {
  readonly status: 'ok' | 'degraded' | 'stale';
  readonly agentRunning: boolean;
  readonly uptimeSeconds: number;
  readonly samplesCollected: number;
  readonly collectionErrors: number;
  readonly lastSampleAt: number | null;
  readonly lastSampleAgeMs: number | null;
  readonly degraded: readonly string[];
  readonly storedPoints: number;
  readonly databaseBytes: number | null;
  readonly activeAlerts: number;
  readonly streamClients: number;
  readonly version: string;
}

export interface AlertRuleConfig {
  readonly id: AlertRuleId;
  readonly enabled: boolean;
  readonly threshold: number;
  readonly clearThreshold: number;
  readonly forSeconds: number;
  readonly cooldownSeconds: number;
  readonly severity: AlertSeverity;
}

export interface PublicConfig {
  readonly version: string;
  readonly apiVersion: string | number;
  readonly collection: {
    readonly intervalMs: number;
    readonly bufferSize: number;
    readonly processRows: number;
  };
  readonly storage: {
    readonly retentionDays: number;
    readonly writeIntervalMs: number;
  };
  readonly alerts: {
    readonly enabled: boolean;
    readonly rules: readonly AlertRuleConfig[];
  };
  readonly security: {
    readonly host: string;
    readonly port: number;
    readonly tokenRequired: boolean;
    readonly remoteAccess: boolean;
  };
}
