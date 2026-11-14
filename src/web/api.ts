import type {
  AlertsResponse,
  HealthStatus,
  HistoryRange,
  HistoryResponse,
  MetricsSample,
  ProcessSnapshot,
  ProcessSortKey,
  PublicConfig,
  SortDirection,
  SystemInfo,
} from './api-types.js';

export class ApiError extends Error {
  readonly status: number;

  constructor(status: number, message: string) {
    super(message);
    this.name = 'ApiError';
    this.status = status;
  }
}

function errorMessage(body: unknown): string | null {
  if (typeof body !== 'object' || body === null || !('error' in body)) {
    return null;
  }
  const inner = body.error;
  if (typeof inner !== 'object' || inner === null || !('message' in inner)) {
    return null;
  }
  return typeof inner.message === 'string' ? inner.message : null;
}

async function get<T>(
  path: string,
  params: Readonly<Record<string, string>> = {},
  signal?: AbortSignal,
): Promise<T> {
  const query = new URLSearchParams(params).toString();
  const url = query === '' ? path : `${path}?${query}`;
  let response: Response;
  try {
    response = await fetch(url, {
      headers: { accept: 'application/json' },
      cache: 'no-store',
      ...(signal === undefined ? {} : { signal }),
    });
  } catch (error: unknown) {
    if (error instanceof DOMException && error.name === 'AbortError') {
      throw error;
    }
    throw new ApiError(0, 'The agent could not be reached.');
  }
  let body: unknown = null;
  try {
    body = await response.json();
  } catch {
    body = null;
  }
  if (!response.ok) {
    throw new ApiError(
      response.status,
      errorMessage(body) ?? `Request failed with status ${response.status}.`,
    );
  }
  return body as T;
}

export function describeError(error: unknown): string {
  if (error instanceof ApiError) {
    return error.status === 0
      ? error.message
      : `${error.message} (status ${error.status})`;
  }
  return error instanceof Error ? error.message : 'Unknown error.';
}

export const api = {
  health: (): Promise<HealthStatus> => get('/api/health'),
  system: (): Promise<SystemInfo> => get('/api/system'),
  config: (): Promise<PublicConfig> => get('/api/config'),
  current: (): Promise<MetricsSample> => get('/api/metrics/current'),
  history: (
    range: HistoryRange,
    signal?: AbortSignal,
  ): Promise<HistoryResponse> => get('/api/metrics/history', { range }, signal),
  processes: (
    search: string,
    sort: ProcessSortKey,
    direction: SortDirection,
    signal?: AbortSignal,
  ): Promise<ProcessSnapshot> =>
    get('/api/processes', { search, sort, direction }, signal),
  alerts: (limit: number): Promise<AlertsResponse> =>
    get('/api/alerts', { state: 'resolved', limit: String(limit) }),
};
