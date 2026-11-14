import type { AlertState, ProcessSortKey } from '../types.js';
import type { HistoryQuery } from '../store/database.js';
import type { ProcessQuery } from '../collect/processes.js';

/**
 * Query string validation.
 *
 * Every value that reaches a route has been through one of these. A
 * parameter that is absent takes its default; a parameter that is present
 * and wrong is an error with a message naming it, never a silent
 * substitution — a chart that quietly shows the last hour when the last
 * week was asked for is a lie about the machine.
 *
 * Each parser also bounds what it accepts, so no request can ask the
 * server for an unbounded amount of work.
 */

export type Parsed<T> =
  | { readonly ok: true; readonly value: T }
  | { readonly ok: false; readonly error: string };

function fail<T>(error: string): Parsed<T> {
  return { ok: false, error };
}

function ok<T>(value: T): Parsed<T> {
  return { ok: true, value };
}

function integerParam(
  params: URLSearchParams,
  name: string,
  fallback: number,
  min: number,
  max: number,
): Parsed<number> {
  const raw = params.get(name);
  if (raw === null) return ok(fallback);
  if (!/^\d{1,19}$/.test(raw)) {
    return fail(`${name} must be a non-negative integer`);
  }
  const value = Number(raw);
  if (!Number.isSafeInteger(value) || value < min || value > max) {
    return fail(`${name} must be between ${min} and ${max}`);
  }
  return ok(value);
}

/** Named windows, in milliseconds. */
export const RANGES: Readonly<Record<string, number>> = {
  '15m': 15 * 60_000,
  '1h': 60 * 60_000,
  '6h': 6 * 60 * 60_000,
  '24h': 24 * 60 * 60_000,
  '7d': 7 * 24 * 60 * 60_000,
};

export const DEFAULT_HISTORY_LIMIT = 600;
export const MAX_HISTORY_LIMIT = 5000;

/**
 * Parses `?range=` or an explicit `?from=&to=` pair.
 *
 * The two forms are mutually exclusive; accepting both at once would
 * leave the caller unsure which one the answer describes.
 */
export function parseHistoryQuery(
  params: URLSearchParams,
  now: number,
): Parsed<HistoryQuery> {
  const range = params.get('range');
  const from = params.get('from');
  const to = params.get('to');

  const limit = integerParam(
    params,
    'limit',
    DEFAULT_HISTORY_LIMIT,
    1,
    MAX_HISTORY_LIMIT,
  );
  if (!limit.ok) return fail(limit.error);

  if (range !== null && (from !== null || to !== null)) {
    return fail('range cannot be combined with from or to');
  }

  if (from !== null || to !== null) {
    const parsedFrom = integerParam(
      params,
      'from',
      0,
      0,
      Number.MAX_SAFE_INTEGER,
    );
    if (!parsedFrom.ok) return fail(parsedFrom.error);
    const parsedTo = integerParam(
      params,
      'to',
      now,
      0,
      Number.MAX_SAFE_INTEGER,
    );
    if (!parsedTo.ok) return fail(parsedTo.error);
    if (parsedFrom.value > parsedTo.value) {
      return fail('from must not be later than to');
    }
    return ok({
      from: parsedFrom.value,
      to: parsedTo.value,
      limit: limit.value,
    });
  }

  const window = RANGES[range ?? '1h'];
  if (window === undefined) {
    return fail(`range must be one of ${Object.keys(RANGES).join(', ')}`);
  }

  return ok({ from: now - window, to: now, limit: limit.value });
}

const SORT_KEYS: readonly ProcessSortKey[] = [
  'cpu',
  'memory',
  'pid',
  'name',
  'uptime',
];

export const MAX_SEARCH_LENGTH = 64;

export function parseProcessQuery(
  params: URLSearchParams,
  defaultLimit: number,
  maxLimit: number,
): Parsed<ProcessQuery> {
  const search = params.get('search') ?? '';
  if (search.length > MAX_SEARCH_LENGTH) {
    return fail(`search must be ${MAX_SEARCH_LENGTH} characters or fewer`);
  }

  const sortRaw = params.get('sort');
  if (sortRaw !== null && !SORT_KEYS.includes(sortRaw as ProcessSortKey)) {
    return fail(`sort must be one of ${SORT_KEYS.join(', ')}`);
  }

  const directionRaw = params.get('direction');
  if (
    directionRaw !== null &&
    directionRaw !== 'asc' &&
    directionRaw !== 'desc'
  ) {
    return fail('direction must be asc or desc');
  }

  const limit = integerParam(params, 'limit', defaultLimit, 1, maxLimit);
  if (!limit.ok) return fail(limit.error);

  return ok({
    search,
    sort: (sortRaw ?? 'cpu') as ProcessSortKey,
    direction: directionRaw ?? 'desc',
    limit: limit.value,
  });
}

export interface AlertQuery {
  readonly state: AlertState | undefined;
  readonly limit: number;
}

export function parseAlertQuery(params: URLSearchParams): Parsed<AlertQuery> {
  const state = params.get('state');
  if (state !== null && state !== 'active' && state !== 'resolved') {
    return fail('state must be active or resolved');
  }
  const limit = integerParam(params, 'limit', 100, 1, 1000);
  if (!limit.ok) return fail(limit.error);
  return ok({ state: state ?? undefined, limit: limit.value });
}
