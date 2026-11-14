import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import {
  parseAlertQuery,
  parseHistoryQuery,
  parseProcessQuery,
  RANGES,
} from '../../src/server/query.js';
import { VERSION } from '../../src/version.js';

const NOW = 1_700_000_000_000;

function params(query: string): URLSearchParams {
  return new URLSearchParams(query);
}

describe('parseHistoryQuery', () => {
  it('defaults to the last hour', () => {
    const parsed = parseHistoryQuery(params(''), NOW);
    expect(parsed.ok && parsed.value).toEqual({
      from: NOW - 3_600_000,
      to: NOW,
      limit: 600,
    });
  });

  it('accepts every named range', () => {
    for (const [name, window] of Object.entries(RANGES)) {
      const parsed = parseHistoryQuery(params(`range=${name}`), NOW);
      expect(parsed.ok && parsed.value.from).toBe(NOW - window);
    }
  });

  it('refuses a range it does not know', () => {
    const parsed = parseHistoryQuery(params('range=1y'), NOW);
    expect(parsed.ok).toBe(false);
    expect(!parsed.ok && parsed.error).toMatch(/range must be one of/);
  });

  it('accepts an explicit window', () => {
    const parsed = parseHistoryQuery(params('from=1000&to=2000'), NOW);
    expect(parsed.ok && parsed.value).toMatchObject({ from: 1000, to: 2000 });
  });

  it('refuses a window that runs backwards', () => {
    const parsed = parseHistoryQuery(params('from=2000&to=1000'), NOW);
    expect(!parsed.ok && parsed.error).toMatch(/from must not be later/);
  });

  it('refuses the two forms together', () => {
    const parsed = parseHistoryQuery(params('range=1h&from=1000'), NOW);
    expect(!parsed.ok && parsed.error).toMatch(/cannot be combined/);
  });

  it('refuses a limit that is not a number, or is out of range', () => {
    expect(parseHistoryQuery(params('limit=lots'), NOW).ok).toBe(false);
    expect(parseHistoryQuery(params('limit=0'), NOW).ok).toBe(false);
    expect(parseHistoryQuery(params('limit=100000'), NOW).ok).toBe(false);
    expect(parseHistoryQuery(params('limit=-5'), NOW).ok).toBe(false);
  });
});

describe('parseProcessQuery', () => {
  it('defaults to the busiest processes first', () => {
    const parsed = parseProcessQuery(params(''), 100, 500);
    expect(parsed.ok && parsed.value).toEqual({
      search: '',
      sort: 'cpu',
      direction: 'desc',
      limit: 100,
    });
  });

  it('accepts the sort keys and directions it documents', () => {
    for (const sort of ['cpu', 'memory', 'pid', 'name', 'uptime']) {
      expect(parseProcessQuery(params(`sort=${sort}`), 100, 500).ok).toBe(true);
    }
    expect(parseProcessQuery(params('direction=asc'), 100, 500).ok).toBe(true);
  });

  it('refuses anything else', () => {
    expect(parseProcessQuery(params('sort=rss'), 100, 500).ok).toBe(false);
    expect(parseProcessQuery(params('direction=sideways'), 100, 500).ok).toBe(
      false,
    );
  });

  it('refuses a search long enough to be an attack rather than a search', () => {
    const parsed = parseProcessQuery(
      params(`search=${'x'.repeat(100)}`),
      100,
      500,
    );
    expect(!parsed.ok && parsed.error).toMatch(/64 characters or fewer/);
  });

  it('will not return more rows than the server allows', () => {
    expect(parseProcessQuery(params('limit=400'), 100, 200).ok).toBe(false);
  });
});

describe('parseAlertQuery', () => {
  it('defaults to a hundred alerts of any state', () => {
    const parsed = parseAlertQuery(params(''));
    expect(parsed.ok && parsed.value).toEqual({ state: undefined, limit: 100 });
  });

  it('accepts the two states', () => {
    expect(parseAlertQuery(params('state=active')).ok).toBe(true);
    expect(parseAlertQuery(params('state=resolved')).ok).toBe(true);
  });

  it('refuses any other state', () => {
    expect(parseAlertQuery(params('state=pending')).ok).toBe(false);
  });
});

describe('VERSION', () => {
  it('matches the version in package.json', () => {
    const manifest: unknown = JSON.parse(
      readFileSync(new URL('../../package.json', import.meta.url), 'utf8'),
    );
    const version =
      typeof manifest === 'object' && manifest !== null
        ? (manifest as Record<string, unknown>)['version']
        : undefined;
    expect(version).toBe(VERSION);
  });
});
