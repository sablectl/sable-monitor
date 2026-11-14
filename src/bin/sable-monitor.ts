#!/usr/bin/env node
import { Agent } from '../agent/agent.js';
import {
  ConfigError,
  defaultConfigPath,
  loadConfig,
  type Config,
} from '../config/config.js';
import { MonitorServer } from '../server/http.js';
import { MetricsStore } from '../store/database.js';
import { VERSION } from '../version.js';

/**
 * The command.
 *
 * Three subcommands and nothing else: start the agent and dashboard,
 * check the configuration, print the version. There is no subcommand that
 * installs a service, writes to a system directory or changes anything
 * outside the database the user configured — a monitoring tool that
 * modifies the machine it is watching is not one.
 */

const USAGE = `sable-monitor ${VERSION} — real-time Linux monitoring and diagnostics

Usage:
  sable-monitor [start] [options]   Start the agent and the dashboard
  sable-monitor check [options]     Validate the configuration and exit
  sable-monitor --version           Print the version
  sable-monitor --help              Print this message

Options:
  --config <path>       Configuration file (default: ${defaultConfigPath()})
  --host <address>      Address to bind (default: 127.0.0.1)
  --port <number>       Port to bind (default: 7878)
  --interval <ms>       Milliseconds between samples (default: 2000)
  --db <path>           Database file
  --retention-days <n>  Days of history to keep (default: 7)

Environment:
  SABLE_MONITOR_HOST, SABLE_MONITOR_PORT, SABLE_MONITOR_INTERVAL_MS,
  SABLE_MONITOR_DB, SABLE_MONITOR_RETENTION_DAYS, SABLE_MONITOR_TOKEN,
  SABLE_MONITOR_ALLOW_REMOTE

The dashboard binds to the loopback address. To reach it from elsewhere,
forward the port over SSH rather than exposing it:

  ssh -N -L 7878:127.0.0.1:7878 user@host
`;

interface Invocation {
  readonly command: 'start' | 'check' | 'version' | 'help';
  readonly configPath: string | undefined;
  readonly overrides: Record<string, unknown>;
}

export class UsageError extends Error {}

/** Parses the command line. Unknown flags are an error, not a warning. */
export function parseArguments(argv: readonly string[]): Invocation {
  const server: Record<string, unknown> = {};
  const collection: Record<string, unknown> = {};
  const storage: Record<string, unknown> = {};

  let command: Invocation['command'] = 'start';
  let configPath: string | undefined;
  let index = 0;

  const first = argv[0];
  if (first === 'start' || first === 'check') {
    command = first;
    index = 1;
  }

  const value = (flag: string): string => {
    const next = argv[index + 1];
    if (next === undefined || next.startsWith('--')) {
      throw new UsageError(`${flag} requires a value`);
    }
    index += 1;
    return next;
  };

  const number = (flag: string): number => {
    const raw = value(flag);
    const parsed = Number(raw);
    if (!Number.isFinite(parsed)) {
      throw new UsageError(
        `${flag} must be a number, not ${JSON.stringify(raw)}`,
      );
    }
    return parsed;
  };

  for (; index < argv.length; index += 1) {
    const argument = argv[index];
    switch (argument) {
      case '--help':
      case '-h':
        command = 'help';
        break;
      case '--version':
      case '-V':
        command = 'version';
        break;
      case '--config':
        configPath = value('--config');
        break;
      case '--host':
        server['host'] = value('--host');
        break;
      case '--port':
        server['port'] = number('--port');
        break;
      case '--interval':
        collection['intervalMs'] = number('--interval');
        break;
      case '--db':
        storage['path'] = value('--db');
        break;
      case '--retention-days':
        storage['retentionDays'] = number('--retention-days');
        break;
      default:
        throw new UsageError(`unknown argument: ${String(argument)}`);
    }
  }

  const overrides: Record<string, unknown> = {};
  if (Object.keys(server).length > 0) overrides['server'] = server;
  if (Object.keys(collection).length > 0) overrides['collection'] = collection;
  if (Object.keys(storage).length > 0) overrides['storage'] = storage;

  return { command, configPath, overrides };
}

function describeStartup(
  config: Config,
  source: string | null,
  address: { host: string; port: number },
): string {
  const lines = [
    `sable-monitor ${VERSION}`,
    `  configuration  ${source ?? 'defaults (no file)'}`,
    `  dashboard      http://${formatHost(address.host)}:${address.port}`,
    `  sampling       every ${config.collection.intervalMs} ms`,
    `  database       ${config.storage.path}`,
    `  retention      ${config.storage.retentionDays} days`,
    `  alerts         ${config.alerts.enabled ? 'enabled' : 'disabled'}`,
    `  authentication ${config.server.token === null ? 'none (loopback only)' : 'bearer token'}`,
  ];
  if (process.getuid?.() === 0) {
    lines.push(
      '  note           running as root, which this agent does not need',
    );
  }
  return lines.join('\n');
}

function formatHost(host: string): string {
  return host.includes(':') ? `[${host}]` : host;
}

async function main(argv: readonly string[]): Promise<number> {
  let invocation: Invocation;
  try {
    invocation = parseArguments(argv);
  } catch (error: unknown) {
    console.error(error instanceof Error ? error.message : String(error));
    console.error('Run sable-monitor --help for usage.');
    return 2;
  }

  if (invocation.command === 'help') {
    console.log(USAGE);
    return 0;
  }
  if (invocation.command === 'version') {
    console.log(VERSION);
    return 0;
  }

  let config: Config;
  let source: string | null;
  try {
    const loaded = await loadConfig({
      path: invocation.configPath,
      overrides: invocation.overrides,
    });
    config = loaded.config;
    source = loaded.source;
  } catch (error: unknown) {
    if (error instanceof ConfigError) {
      console.error(error.message);
      return 2;
    }
    throw error;
  }

  if (invocation.command === 'check') {
    console.log(`configuration is valid (${source ?? 'defaults, no file'})`);
    console.log(JSON.stringify(redact(config), null, 2));
    return 0;
  }

  const store = new MetricsStore({
    path: config.storage.path,
    retentionDays: config.storage.retentionDays,
    alertHistoryLimit: config.alerts.historyLimit,
  });

  const agent = new Agent({ config, store, version: VERSION });
  const server = new MonitorServer({ config, agent, store, version: VERSION });

  let address: { host: string; port: number };
  try {
    await agent.start();
    address = await server.listen();
  } catch (error: unknown) {
    await agent.stop();
    store.close();
    console.error(
      `failed to start: ${error instanceof Error ? error.message : String(error)}`,
    );
    return 1;
  }

  console.log(describeStartup(config, source, address));

  // A second signal while the first shutdown is in progress exits at
  // once, so the process can always be stopped.
  let stopping = false;
  const shutdown = (signal: string): void => {
    if (stopping) {
      process.exit(130);
    }
    stopping = true;
    console.log(`\nreceived ${signal}, shutting down`);
    void (async () => {
      await server.close();
      await agent.stop();
      store.close();
      process.exit(0);
    })();
  };

  process.on('SIGINT', () => {
    shutdown('SIGINT');
  });
  process.on('SIGTERM', () => {
    shutdown('SIGTERM');
  });

  // Nothing else resolves: the process now lives until it is signalled.
  return await new Promise<number>(() => {
    /* intentionally never resolves */
  });
}

function redact(config: Config): Config {
  return {
    ...config,
    server: {
      ...config.server,
      token: config.server.token === null ? null : '***',
    },
  };
}

const exitCode = await main(process.argv.slice(2));
process.exit(exitCode);
