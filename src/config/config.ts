import { readFile } from 'node:fs/promises';
import { homedir } from 'node:os';
import { isAbsolute, join, resolve } from 'node:path';
import type { AlertRuleConfig, AlertRuleId } from '../types.js';

/**
 * Configuration, its defaults and its validation.
 *
 * Every default is the safe one. The server binds to the loopback address,
 * no token is set because none is needed to reach a loopback-only service,
 * and the database is written under the user's own state directory with
 * owner-only permissions. Changing any of those to something riskier takes
 * an explicit setting, and the ones that genuinely widen exposure —
 * binding off loopback — are refused unless a second setting says the risk
 * was understood.
 *
 * Configuration is read once at startup from a JSON file and from
 * `SABLE_MONITOR_*` environment variables, in that order of increasing
 * precedence, and is never reloaded from a request.
 */

export interface ServerConfig {
  readonly host: string;
  readonly port: number;
  /**
   * Set when the host is not a loopback address. Binding to an address
   * other hosts can reach is refused without it, because it turns a local
   * diagnostic tool into a network service that publishes the state of the
   * machine.
   */
  readonly allowRemote: boolean;
  /**
   * Extra values accepted in the `Host` header. Requests arriving with any
   * other host are refused, which is what stops a name that resolves to
   * 127.0.0.1 being used to reach this server from a web page.
   */
  readonly allowedHosts: readonly string[];
  /** Exact origins allowed to make a cross-origin request. Empty by default. */
  readonly allowedOrigins: readonly string[];
  /** Shared secret required in `Authorization: Bearer`, if set. */
  readonly token: string | null;
  readonly maxRequestBytes: number;
  readonly maxStreamClients: number;
}

export interface CollectionConfig {
  /** Milliseconds between metric samples. */
  readonly intervalMs: number;
  /** Samples held in memory for the live view. */
  readonly bufferSize: number;
  /** Rows the process endpoint returns when the request does not say. */
  readonly processRows: number;
}

export interface StorageConfig {
  readonly path: string;
  /** Days of history kept; older rows are deleted on a timer. */
  readonly retentionDays: number;
  /** Milliseconds between writes to the history table. */
  readonly writeIntervalMs: number;
  /** Milliseconds between retention sweeps. */
  readonly cleanupIntervalMs: number;
}

export interface AlertsConfig {
  readonly enabled: boolean;
  readonly rules: readonly AlertRuleConfig[];
  /** Alert rows kept; the oldest resolved ones are deleted beyond it. */
  readonly historyLimit: number;
}

export interface Config {
  readonly server: ServerConfig;
  readonly collection: CollectionConfig;
  readonly storage: StorageConfig;
  readonly alerts: AlertsConfig;
}

export class ConfigError extends Error {
  readonly problems: readonly string[];

  constructor(problems: readonly string[]) {
    super(`invalid configuration:\n  - ${problems.join('\n  - ')}`);
    this.name = 'ConfigError';
    this.problems = problems;
  }
}

const LOOPBACK = new Set(['127.0.0.1', '::1', 'localhost', '::ffff:127.0.0.1']);

export function isLoopbackHost(host: string): boolean {
  return LOOPBACK.has(host) || /^127\.\d+\.\d+\.\d+$/.test(host);
}

function stateDirectory(): string {
  const xdg = process.env['XDG_STATE_HOME'];
  const base =
    xdg !== undefined && xdg.length > 0 && isAbsolute(xdg)
      ? xdg
      : join(homedir(), '.local', 'state');
  return join(base, 'sable-monitor');
}

export function defaultConfigPath(): string {
  const xdg = process.env['XDG_CONFIG_HOME'];
  const base =
    xdg !== undefined && xdg.length > 0 && isAbsolute(xdg)
      ? xdg
      : join(homedir(), '.config');
  return join(base, 'sable-monitor', 'config.json');
}

export const DEFAULT_ALERT_RULES: readonly AlertRuleConfig[] = [
  {
    id: 'cpu-high',
    enabled: true,
    threshold: 90,
    clearThreshold: 80,
    forSeconds: 120,
    cooldownSeconds: 600,
    severity: 'warning',
  },
  {
    id: 'memory-high',
    enabled: true,
    threshold: 90,
    clearThreshold: 80,
    forSeconds: 120,
    cooldownSeconds: 600,
    severity: 'warning',
  },
  {
    // Measured as used percentage of a filesystem, so the threshold is the
    // point at which too little is left rather than too much is used.
    id: 'disk-low',
    enabled: true,
    threshold: 90,
    clearThreshold: 85,
    forSeconds: 300,
    cooldownSeconds: 3600,
    severity: 'critical',
  },
  {
    // A ratio of the one-minute load average to the logical CPU count, so
    // the same threshold means the same thing on any size of machine.
    id: 'load-high',
    enabled: true,
    threshold: 2,
    clearThreshold: 1.5,
    forSeconds: 300,
    cooldownSeconds: 900,
    severity: 'warning',
  },
  {
    // Seconds since the last successful sample.
    id: 'agent-stale',
    enabled: true,
    threshold: 60,
    clearThreshold: 30,
    forSeconds: 0,
    cooldownSeconds: 300,
    severity: 'critical',
  },
];

export function defaultConfig(): Config {
  return {
    server: {
      host: '127.0.0.1',
      port: 7878,
      allowRemote: false,
      allowedHosts: [],
      allowedOrigins: [],
      token: null,
      maxRequestBytes: 16 * 1024,
      maxStreamClients: 16,
    },
    collection: {
      intervalMs: 2000,
      bufferSize: 900,
      processRows: 100,
    },
    storage: {
      path: join(stateDirectory(), 'metrics.db'),
      retentionDays: 7,
      writeIntervalMs: 10_000,
      cleanupIntervalMs: 3_600_000,
    },
    alerts: {
      enabled: true,
      rules: DEFAULT_ALERT_RULES,
      historyLimit: 1000,
    },
  };
}

/* Parsing of untrusted input ------------------------------------------- */

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

interface Context {
  readonly problems: string[];
}

function integer(
  context: Context,
  value: unknown,
  path: string,
  fallback: number,
  min: number,
  max: number,
): number {
  if (value === undefined) return fallback;
  if (typeof value !== 'number' || !Number.isInteger(value)) {
    context.problems.push(`${path} must be an integer`);
    return fallback;
  }
  if (value < min || value > max) {
    context.problems.push(`${path} must be between ${min} and ${max}`);
    return fallback;
  }
  return value;
}

function decimal(
  context: Context,
  value: unknown,
  path: string,
  fallback: number,
  min: number,
  max: number,
): number {
  if (value === undefined) return fallback;
  if (typeof value !== 'number' || !Number.isFinite(value)) {
    context.problems.push(`${path} must be a number`);
    return fallback;
  }
  if (value < min || value > max) {
    context.problems.push(`${path} must be between ${min} and ${max}`);
    return fallback;
  }
  return value;
}

function boolean(
  context: Context,
  value: unknown,
  path: string,
  fallback: boolean,
): boolean {
  if (value === undefined) return fallback;
  if (typeof value !== 'boolean') {
    context.problems.push(`${path} must be true or false`);
    return fallback;
  }
  return value;
}

function text(
  context: Context,
  value: unknown,
  path: string,
  fallback: string,
): string {
  if (value === undefined) return fallback;
  if (typeof value !== 'string' || value.length === 0) {
    context.problems.push(`${path} must be a non-empty string`);
    return fallback;
  }
  return value;
}

function stringList(
  context: Context,
  value: unknown,
  path: string,
  fallback: readonly string[],
): readonly string[] {
  if (value === undefined) return fallback;
  if (
    !Array.isArray(value) ||
    value.some((item) => typeof item !== 'string' || item.length === 0)
  ) {
    context.problems.push(`${path} must be an array of non-empty strings`);
    return fallback;
  }
  return value.filter((item): item is string => typeof item === 'string');
}

const RULE_IDS: readonly AlertRuleId[] = [
  'cpu-high',
  'memory-high',
  'disk-low',
  'load-high',
  'agent-stale',
];

function parseRules(
  context: Context,
  value: unknown,
  fallback: readonly AlertRuleConfig[],
): readonly AlertRuleConfig[] {
  if (value === undefined) return fallback;
  if (!isRecord(value)) {
    context.problems.push('alerts.rules must be an object keyed by rule id');
    return fallback;
  }

  for (const key of Object.keys(value)) {
    if (!RULE_IDS.includes(key as AlertRuleId)) {
      context.problems.push(`alerts.rules.${key} is not a known rule`);
    }
  }

  return fallback.map((rule) => {
    const override = value[rule.id];
    if (override === undefined) return rule;
    if (!isRecord(override)) {
      context.problems.push(`alerts.rules.${rule.id} must be an object`);
      return rule;
    }

    const path = `alerts.rules.${rule.id}`;
    const severity = override['severity'];
    if (
      severity !== undefined &&
      severity !== 'warning' &&
      severity !== 'critical'
    ) {
      context.problems.push(`${path}.severity must be warning or critical`);
    }

    const updated: AlertRuleConfig = {
      id: rule.id,
      enabled: boolean(
        context,
        override['enabled'],
        `${path}.enabled`,
        rule.enabled,
      ),
      threshold: decimal(
        context,
        override['threshold'],
        `${path}.threshold`,
        rule.threshold,
        0,
        100_000,
      ),
      clearThreshold: decimal(
        context,
        override['clearThreshold'],
        `${path}.clearThreshold`,
        rule.clearThreshold,
        0,
        100_000,
      ),
      forSeconds: integer(
        context,
        override['forSeconds'],
        `${path}.forSeconds`,
        rule.forSeconds,
        0,
        86_400,
      ),
      cooldownSeconds: integer(
        context,
        override['cooldownSeconds'],
        `${path}.cooldownSeconds`,
        rule.cooldownSeconds,
        0,
        86_400,
      ),
      severity:
        severity === 'warning' || severity === 'critical'
          ? severity
          : rule.severity,
    };

    // Hysteresis only works if the clearing point is on the quiet side of
    // the firing point. Equal values are allowed and simply disable it.
    if (updated.clearThreshold > updated.threshold) {
      context.problems.push(
        `${path}.clearThreshold must not be greater than ${path}.threshold`,
      );
    }

    return updated;
  });
}

/**
 * Validates a parsed configuration document against the defaults,
 * collecting every problem rather than stopping at the first.
 */
export function parseConfig(input: unknown, base = defaultConfig()): Config {
  const context: Context = { problems: [] };

  if (input !== undefined && !isRecord(input)) {
    throw new ConfigError(['configuration must be a JSON object']);
  }

  const document = input ?? {};
  const server = isRecord(document['server']) ? document['server'] : {};
  const collection = isRecord(document['collection'])
    ? document['collection']
    : {};
  const storage = isRecord(document['storage']) ? document['storage'] : {};
  const alerts = isRecord(document['alerts']) ? document['alerts'] : {};

  for (const [key, value] of Object.entries(document)) {
    if (!['server', 'collection', 'storage', 'alerts'].includes(key)) {
      context.problems.push(`${key} is not a known configuration section`);
    } else if (!isRecord(value)) {
      context.problems.push(`${key} must be an object`);
    }
  }

  const host = text(context, server['host'], 'server.host', base.server.host);
  const allowRemote = boolean(
    context,
    server['allowRemote'],
    'server.allowRemote',
    base.server.allowRemote,
  );
  const token = server['token'];
  if (token !== undefined && token !== null && typeof token !== 'string') {
    context.problems.push('server.token must be a string or null');
  }
  if (typeof token === 'string' && token.length < 16) {
    context.problems.push('server.token must be at least 16 characters');
  }

  if (!isLoopbackHost(host) && !allowRemote) {
    context.problems.push(
      `server.host ${host} is reachable from other machines; ` +
        'set server.allowRemote to true to confirm that is intended, and ' +
        'set server.token as well',
    );
  }
  if (!isLoopbackHost(host) && allowRemote && typeof token !== 'string') {
    context.problems.push(
      'server.token is required when the server binds off loopback',
    );
  }

  const parsed: Config = {
    server: {
      host,
      port: integer(
        context,
        server['port'],
        'server.port',
        base.server.port,
        1,
        65_535,
      ),
      allowRemote,
      allowedHosts: stringList(
        context,
        server['allowedHosts'],
        'server.allowedHosts',
        base.server.allowedHosts,
      ),
      allowedOrigins: stringList(
        context,
        server['allowedOrigins'],
        'server.allowedOrigins',
        base.server.allowedOrigins,
      ),
      token: typeof token === 'string' ? token : base.server.token,
      maxRequestBytes: integer(
        context,
        server['maxRequestBytes'],
        'server.maxRequestBytes',
        base.server.maxRequestBytes,
        1024,
        1024 * 1024,
      ),
      maxStreamClients: integer(
        context,
        server['maxStreamClients'],
        'server.maxStreamClients',
        base.server.maxStreamClients,
        1,
        256,
      ),
    },
    collection: {
      intervalMs: integer(
        context,
        collection['intervalMs'],
        'collection.intervalMs',
        base.collection.intervalMs,
        500,
        300_000,
      ),
      bufferSize: integer(
        context,
        collection['bufferSize'],
        'collection.bufferSize',
        base.collection.bufferSize,
        10,
        10_000,
      ),
      processRows: integer(
        context,
        collection['processRows'],
        'collection.processRows',
        base.collection.processRows,
        1,
        500,
      ),
    },
    storage: {
      path: resolve(
        text(context, storage['path'], 'storage.path', base.storage.path),
      ),
      retentionDays: integer(
        context,
        storage['retentionDays'],
        'storage.retentionDays',
        base.storage.retentionDays,
        1,
        365,
      ),
      writeIntervalMs: integer(
        context,
        storage['writeIntervalMs'],
        'storage.writeIntervalMs',
        base.storage.writeIntervalMs,
        1000,
        600_000,
      ),
      cleanupIntervalMs: integer(
        context,
        storage['cleanupIntervalMs'],
        'storage.cleanupIntervalMs',
        base.storage.cleanupIntervalMs,
        60_000,
        86_400_000,
      ),
    },
    alerts: {
      enabled: boolean(
        context,
        alerts['enabled'],
        'alerts.enabled',
        base.alerts.enabled,
      ),
      rules: parseRules(context, alerts['rules'], base.alerts.rules),
      historyLimit: integer(
        context,
        alerts['historyLimit'],
        'alerts.historyLimit',
        base.alerts.historyLimit,
        10,
        100_000,
      ),
    },
  };

  if (parsed.storage.writeIntervalMs < parsed.collection.intervalMs) {
    context.problems.push(
      'storage.writeIntervalMs must not be shorter than collection.intervalMs',
    );
  }

  if (context.problems.length > 0) throw new ConfigError(context.problems);
  return parsed;
}

/** Overrides applied after the file, from the environment. */
export interface EnvironmentOverrides {
  readonly SABLE_MONITOR_HOST?: string | undefined;
  readonly SABLE_MONITOR_PORT?: string | undefined;
  readonly SABLE_MONITOR_INTERVAL_MS?: string | undefined;
  readonly SABLE_MONITOR_DB?: string | undefined;
  readonly SABLE_MONITOR_RETENTION_DAYS?: string | undefined;
  readonly SABLE_MONITOR_TOKEN?: string | undefined;
  readonly SABLE_MONITOR_ALLOW_REMOTE?: string | undefined;
}

function numeric(value: string | undefined): number | undefined {
  if (value === undefined) return undefined;
  const parsed = Number(value);
  return Number.isFinite(parsed) ? parsed : Number.NaN;
}

/**
 * Builds a configuration document from environment variables.
 *
 * Values are left as they are found, including values that are not
 * numbers: `parseConfig` reports those as errors with the same message a
 * bad file would produce, rather than silently falling back.
 */
export function environmentDocument(
  environment: EnvironmentOverrides,
): Record<string, unknown> {
  const server: Record<string, unknown> = {};
  const collection: Record<string, unknown> = {};
  const storage: Record<string, unknown> = {};

  if (environment.SABLE_MONITOR_HOST !== undefined) {
    server['host'] = environment.SABLE_MONITOR_HOST;
  }
  const port = numeric(environment.SABLE_MONITOR_PORT);
  if (port !== undefined) server['port'] = port;
  if (environment.SABLE_MONITOR_TOKEN !== undefined) {
    server['token'] = environment.SABLE_MONITOR_TOKEN;
  }
  if (environment.SABLE_MONITOR_ALLOW_REMOTE !== undefined) {
    server['allowRemote'] = environment.SABLE_MONITOR_ALLOW_REMOTE === 'true';
  }

  const interval = numeric(environment.SABLE_MONITOR_INTERVAL_MS);
  if (interval !== undefined) collection['intervalMs'] = interval;

  if (environment.SABLE_MONITOR_DB !== undefined) {
    storage['path'] = environment.SABLE_MONITOR_DB;
  }
  const retention = numeric(environment.SABLE_MONITOR_RETENTION_DAYS);
  if (retention !== undefined) storage['retentionDays'] = retention;

  const document: Record<string, unknown> = {};
  if (Object.keys(server).length > 0) document['server'] = server;
  if (Object.keys(collection).length > 0) document['collection'] = collection;
  if (Object.keys(storage).length > 0) document['storage'] = storage;
  return document;
}

function merge(
  base: Record<string, unknown>,
  overlay: Record<string, unknown>,
): Record<string, unknown> {
  const merged: Record<string, unknown> = { ...base };
  for (const [key, value] of Object.entries(overlay)) {
    const existing = merged[key];
    merged[key] =
      isRecord(existing) && isRecord(value) ? merge(existing, value) : value;
  }
  return merged;
}

export interface LoadOptions {
  /** Explicit path; the default location is used when absent. */
  readonly path?: string | undefined;
  readonly environment?: EnvironmentOverrides;
  /** Applied last, from command-line flags. */
  readonly overrides?: Record<string, unknown>;
}

export interface LoadedConfig {
  readonly config: Config;
  /** The file the settings came from, or `null` if none was read. */
  readonly source: string | null;
}

/**
 * Reads the configuration file if there is one, overlays the environment
 * and then the command line, and validates the result.
 *
 * A missing file at the default location is not an error — the defaults
 * are a working configuration. A missing file at a path the user named is,
 * because the alternative is silently ignoring what they asked for.
 */
export async function loadConfig(
  options: LoadOptions = {},
): Promise<LoadedConfig> {
  const explicit = options.path !== undefined;
  const path = options.path ?? defaultConfigPath();

  let document: Record<string, unknown> = {};
  let source: string | null = null;

  try {
    const text_ = await readFile(path, 'utf8');
    const parsed: unknown = JSON.parse(text_);
    if (!isRecord(parsed)) {
      throw new ConfigError([`${path} must contain a JSON object`]);
    }
    document = parsed;
    source = path;
  } catch (error: unknown) {
    if (error instanceof ConfigError) throw error;
    const code =
      isRecord(error) && typeof error['code'] === 'string'
        ? error['code']
        : null;
    if (code !== 'ENOENT' || explicit) {
      if (code === 'ENOENT') {
        throw new ConfigError([`configuration file not found: ${path}`]);
      }
      if (error instanceof SyntaxError) {
        throw new ConfigError([`${path} is not valid JSON: ${error.message}`]);
      }
      throw error;
    }
  }

  document = merge(
    document,
    environmentDocument(options.environment ?? process.env),
  );
  if (options.overrides !== undefined) {
    document = merge(document, options.overrides);
  }

  return { config: parseConfig(document), source };
}
