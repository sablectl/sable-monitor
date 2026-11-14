/**
 * Sable Monitor — real-time Linux monitoring and diagnostics.
 *
 * The package is distributed for its command, `sable-monitor`. These
 * exports exist so that the agent, the store and the server can be
 * embedded in another Node process, and so that the tests can drive each
 * piece in isolation.
 */

export { Agent } from './agent/agent.js';
export type {
  AgentOptions,
  SampleListener,
  AlertListener,
} from './agent/agent.js';

export { AlertEngine, observationsFor } from './alerts/engine.js';
export type {
  AlertChange,
  AlertSink,
  EvaluationContext,
} from './alerts/engine.js';

export {
  collectCpu,
  parseProcStat,
  parseCpuInfo,
  usageBetween,
} from './collect/cpu.js';
export {
  collectMemory,
  parseMeminfo,
  memoryFromMeminfo,
} from './collect/memory.js';
export { collectDisk, parseMounts, parseDiskstats } from './collect/disk.js';
export { collectNetwork, parseNetDev } from './collect/network.js';
export { collectProcesses, parseProcessStat } from './collect/processes.js';
export { collectSystemInfo, parseOsRelease } from './collect/system.js';
export { Procfs } from './collect/procfs.js';

export {
  defaultConfig,
  defaultConfigPath,
  loadConfig,
  parseConfig,
  ConfigError,
  DEFAULT_ALERT_RULES,
} from './config/config.js';
export type {
  Config,
  ServerConfig,
  CollectionConfig,
  StorageConfig,
  AlertsConfig,
} from './config/config.js';

export { MetricsStore, SCHEMA_VERSION } from './store/database.js';
export type { StoreOptions, HistoryQuery } from './store/database.js';

export { MonitorServer, API_VERSION } from './server/http.js';
export type { MonitorServerOptions } from './server/http.js';
export { admit, SECURITY_HEADERS } from './server/security.js';
export {
  parseHistoryQuery,
  parseProcessQuery,
  parseAlertQuery,
} from './server/query.js';

export { VERSION } from './version.js';
export type * from './types.js';
