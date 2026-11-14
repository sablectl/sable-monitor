import { mkdtemp, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import {
  ConfigError,
  defaultConfig,
  environmentDocument,
  isLoopbackHost,
  loadConfig,
  parseConfig,
} from '../../src/config/config.js';

async function temporaryFile(name: string, contents: string): Promise<string> {
  const directory = await mkdtemp(join(tmpdir(), 'sable-monitor-config-'));
  const path = join(directory, name);
  await writeFile(path, contents, 'utf8');
  return path;
}

describe('defaults', () => {
  it('binds to loopback, with no token and no remote access', () => {
    const config = defaultConfig();
    expect(config.server.host).toBe('127.0.0.1');
    expect(config.server.allowRemote).toBe(false);
    expect(config.server.token).toBeNull();
    expect(isLoopbackHost(config.server.host)).toBe(true);
  });

  it('keeps a week of history and samples every two seconds', () => {
    const config = defaultConfig();
    expect(config.storage.retentionDays).toBe(7);
    expect(config.collection.intervalMs).toBe(2000);
  });

  it('enables every alert rule with hysteresis below its threshold', () => {
    for (const rule of defaultConfig().alerts.rules) {
      expect(rule.enabled).toBe(true);
      expect(rule.clearThreshold).toBeLessThanOrEqual(rule.threshold);
    }
  });
});

describe('parseConfig', () => {
  it('accepts an empty document', () => {
    expect(parseConfig({})).toEqual(defaultConfig());
  });

  it('refuses a document that is not an object', () => {
    expect(() => parseConfig([])).toThrow(ConfigError);
    expect(() => parseConfig('nope')).toThrow(ConfigError);
  });

  it('refuses an unknown section and an unknown rule', () => {
    expect(() => parseConfig({ nonsense: {} })).toThrow(
      /nonsense is not a known configuration section/,
    );
    expect(() => parseConfig({ alerts: { rules: { nope: {} } } })).toThrow(
      /nope is not a known rule/,
    );
  });

  it('reports every problem at once', () => {
    try {
      parseConfig({ server: { port: 0 }, collection: { intervalMs: 1 } });
      expect.unreachable('should have thrown');
    } catch (error: unknown) {
      expect(error).toBeInstanceOf(ConfigError);
      expect((error as ConfigError).problems).toHaveLength(2);
    }
  });

  it('bounds the numbers it accepts', () => {
    expect(() => parseConfig({ server: { port: 70_000 } })).toThrow(
      /server.port must be between/,
    );
    expect(() => parseConfig({ storage: { retentionDays: 0 } })).toThrow(
      /storage.retentionDays must be between/,
    );
    expect(() => parseConfig({ collection: { intervalMs: 1.5 } })).toThrow(
      /must be an integer/,
    );
  });

  it('refuses binding off loopback without an explicit confirmation', () => {
    expect(() => parseConfig({ server: { host: '0.0.0.0' } })).toThrow(
      /reachable from other machines/,
    );
  });

  it('refuses binding off loopback without a token', () => {
    expect(() =>
      parseConfig({ server: { host: '0.0.0.0', allowRemote: true } }),
    ).toThrow(/server.token is required/);
  });

  it('allows binding off loopback when both are set', () => {
    const config = parseConfig({
      server: {
        host: '10.0.0.5',
        allowRemote: true,
        token: 'a-sufficiently-long-token',
      },
    });
    expect(config.server.host).toBe('10.0.0.5');
  });

  it('refuses a token short enough to guess', () => {
    expect(() => parseConfig({ server: { token: 'short' } })).toThrow(
      /at least 16 characters/,
    );
  });

  it('refuses a clearing threshold above the firing threshold', () => {
    expect(() =>
      parseConfig({
        alerts: {
          rules: { 'cpu-high': { threshold: 50, clearThreshold: 60 } },
        },
      }),
    ).toThrow(/clearThreshold must not be greater/);
  });

  it('overrides one rule and leaves the others alone', () => {
    const config = parseConfig({
      alerts: { rules: { 'cpu-high': { threshold: 75, clearThreshold: 70 } } },
    });
    const cpu = config.alerts.rules.find((rule) => rule.id === 'cpu-high');
    const memory = config.alerts.rules.find(
      (rule) => rule.id === 'memory-high',
    );
    expect(cpu?.threshold).toBe(75);
    expect(memory?.threshold).toBe(90);
  });

  it('refuses to write history faster than it is collected', () => {
    expect(() =>
      parseConfig({
        collection: { intervalMs: 60_000 },
        storage: { writeIntervalMs: 1000 },
      }),
    ).toThrow(/writeIntervalMs must not be shorter/);
  });
});

describe('environmentDocument', () => {
  it('maps the variables it knows', () => {
    expect(
      environmentDocument({
        SABLE_MONITOR_HOST: '127.0.0.2',
        SABLE_MONITOR_PORT: '9000',
        SABLE_MONITOR_RETENTION_DAYS: '2',
      }),
    ).toEqual({
      server: { host: '127.0.0.2', port: 9000 },
      storage: { retentionDays: 2 },
    });
  });

  it('passes a value that is not a number through to validation', () => {
    expect(() =>
      parseConfig(environmentDocument({ SABLE_MONITOR_PORT: 'eighty' })),
    ).toThrow(/server.port must be an integer/);
  });

  it('produces nothing when nothing is set', () => {
    expect(environmentDocument({})).toEqual({});
  });
});

describe('loadConfig', () => {
  it('uses the defaults when there is no file', async () => {
    const loaded = await loadConfig({
      path: undefined,
      environment: {},
    });
    expect(loaded.config.server.port).toBe(7878);
  });

  it('reads a file that was named', async () => {
    const path = await temporaryFile(
      'config.json',
      JSON.stringify({ server: { port: 9100 } }),
    );
    const loaded = await loadConfig({ path, environment: {} });
    expect(loaded.config.server.port).toBe(9100);
    expect(loaded.source).toBe(path);
  });

  it('refuses a named file that is not there', async () => {
    await expect(
      loadConfig({ path: '/nonexistent/sable-monitor.json', environment: {} }),
    ).rejects.toThrow(/configuration file not found/);
  });

  it('refuses a file that is not valid JSON', async () => {
    const path = await temporaryFile('config.json', '{ not json');
    await expect(loadConfig({ path, environment: {} })).rejects.toThrow(
      /is not valid JSON/,
    );
  });

  it('lets the command line win over the file', async () => {
    const path = await temporaryFile(
      'config.json',
      JSON.stringify({ server: { port: 9100 } }),
    );
    const loaded = await loadConfig({
      path,
      environment: {},
      overrides: { server: { port: 9200 } },
    });
    expect(loaded.config.server.port).toBe(9200);
  });
});
