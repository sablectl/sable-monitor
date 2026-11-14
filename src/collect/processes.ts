import type {
  ProcessInfo,
  ProcessSnapshot,
  ProcessSortKey,
  SortDirection,
} from '../types.js';
import {
  clampPercent,
  fields,
  parseInteger,
  round,
  type Procfs,
} from './procfs.js';

/**
 * Process inspection from `/proc/<pid>/stat`.
 *
 * What is deliberately not read:
 *
 * - `/proc/<pid>/cmdline`, which routinely carries passwords, tokens and
 *   connection strings passed as arguments.
 * - `/proc/<pid>/environ`, which carries the whole environment.
 * - `/proc/<pid>/cwd`, `fd`, `maps` and the rest of the per-process state.
 *
 * The executable name in `stat` is enough to identify a process in a
 * monitoring view, and it is the only identifying string served. Sable
 * Monitor has no way to signal, stop or otherwise act on a process: it
 * reads, and that is all it can do.
 *
 * Unprivileged operation is the normal case. A process owned by another
 * user is still listed — `stat` is world readable — and anything the
 * kernel hides under `hidepid` is skipped silently rather than failing the
 * sample.
 */

/**
 * USER_HZ, the unit of the CPU times in `/proc/<pid>/stat`.
 *
 * Linux has defined this as 100 on every architecture it supports for user
 * space accounting, and there is no portable way to ask libc for it from
 * Node. It is a constant here, and `docs/known-limitations.md` records the
 * assumption.
 */
export const CLOCK_TICKS_PER_SECOND = 100;

/**
 * Page size for the resident set, which `stat` counts in pages. 4096 is
 * the value on x86-64 and on every arm64 kernel in general distribution;
 * a kernel built with 16K or 64K pages reports resident memory
 * proportionally low, which is also recorded in the known limitations.
 */
export const PAGE_BYTES = 4096;

export interface RawProcess {
  readonly pid: number;
  readonly ppid: number;
  readonly name: string;
  readonly state: string;
  /** `utime + stime` in clock ticks since the process started. */
  readonly cpuTicks: number;
  readonly threads: number;
  /** Ticks after boot at which the process started. */
  readonly startTicks: number;
  readonly residentBytes: number;
}

/**
 * Parses one `/proc/<pid>/stat` line.
 *
 * The second field is the executable name in parentheses and may itself
 * contain spaces and parentheses, so the fields after it are located from
 * the last `)` in the line rather than by splitting the whole thing.
 */
export function parseProcessStat(text: string): RawProcess | null {
  const open = text.indexOf('(');
  const close = text.lastIndexOf(')');
  if (open === -1 || close === -1 || close < open) return null;

  const pid = parseInteger(text.slice(0, open));
  if (pid === null) return null;

  const name = text.slice(open + 1, close);
  const rest = fields(text.slice(close + 1));

  // `rest[0]` is field 3 of the file, so field n is at `rest[n - 3]`.
  const at = (field: number): number | null => parseInteger(rest[field - 3]);

  const state = rest[0] ?? '?';
  const utime = at(14) ?? 0;
  const stime = at(15) ?? 0;
  const residentPages = at(24) ?? 0;

  return {
    pid,
    ppid: at(4) ?? 0,
    name,
    state,
    cpuTicks: utime + stime,
    threads: at(20) ?? 0,
    startTicks: at(22) ?? 0,
    residentBytes: residentPages * PAGE_BYTES,
  };
}

/** CPU times of the previous sample, keyed by PID. */
export type ProcessCpuSnapshot = ReadonlyMap<
  number,
  { readonly cpuTicks: number; readonly startTicks: number }
>;

/**
 * Share of one logical CPU used by a process over the interval, 0 to 100.
 *
 * A PID that has been reused since the last sample would otherwise report
 * a wild figure, so the start time is compared as well: if it differs, the
 * process is a different one and no rate is reported for it.
 */
export function processCpu(
  previous:
    { readonly cpuTicks: number; readonly startTicks: number } | undefined,
  current: RawProcess,
  intervalMs: number,
): number | null {
  if (previous === undefined || intervalMs <= 0) return null;
  if (previous.startTicks !== current.startTicks) return null;
  const deltaTicks = current.cpuTicks - previous.cpuTicks;
  if (deltaTicks < 0) return null;
  const intervalTicks = (intervalMs / 1000) * CLOCK_TICKS_PER_SECOND;
  if (intervalTicks <= 0) return null;
  return clampPercent((deltaTicks / intervalTicks) * 100);
}

export interface ProcessQuery {
  readonly search?: string;
  readonly sort?: ProcessSortKey;
  readonly direction?: SortDirection;
  readonly limit?: number;
}

export function sortProcesses(
  processes: readonly ProcessInfo[],
  sort: ProcessSortKey,
  direction: SortDirection,
): ProcessInfo[] {
  const sign = direction === 'asc' ? 1 : -1;
  return [...processes].sort((a, b) => {
    switch (sort) {
      case 'name':
        return sign * a.name.localeCompare(b.name);
      case 'pid':
        return sign * (a.pid - b.pid);
      case 'memory':
        return sign * (a.memoryBytes - b.memoryBytes);
      case 'uptime':
        return sign * ((a.uptimeSeconds ?? -1) - (b.uptimeSeconds ?? -1));
      case 'cpu':
        return sign * ((a.cpu ?? -1) - (b.cpu ?? -1));
    }
  });
}

export function filterProcesses(
  processes: readonly ProcessInfo[],
  search: string,
): ProcessInfo[] {
  const needle = search.trim().toLowerCase();
  if (needle.length === 0) return [...processes];
  return processes.filter(
    (entry) =>
      entry.name.toLowerCase().includes(needle) || String(entry.pid) === needle,
  );
}

export interface ProcessReading {
  readonly snapshot: ProcessSnapshot;
  readonly cpuSnapshot: Map<number, { cpuTicks: number; startTicks: number }>;
}

export interface CollectProcessOptions {
  readonly previous: ProcessCpuSnapshot | null;
  readonly intervalMs: number | null;
  readonly totalMemoryBytes: number;
  readonly systemUptimeSeconds: number;
  readonly query?: ProcessQuery;
  /** Hard cap on the rows returned, whatever the request asks for. */
  readonly maxRows?: number;
}

export const DEFAULT_PROCESS_ROWS = 100;
export const MAX_PROCESS_ROWS = 500;

export async function collectProcesses(
  procfs: Procfs,
  options: CollectProcessOptions,
): Promise<ProcessReading> {
  const entries = await procfs.listProc('');
  const cpuSnapshot = new Map<
    number,
    { cpuTicks: number; startTicks: number }
  >();
  const processes: ProcessInfo[] = [];

  for (const entry of entries) {
    if (!/^\d+$/.test(entry)) continue;
    const text = await procfs.readProcOptional(`${entry}/stat`);
    // The process exited between the directory listing and the read, or
    // the kernel is hiding it. Neither is an error.
    if (text === null) continue;
    const raw = parseProcessStat(text);
    if (raw === null) continue;

    cpuSnapshot.set(raw.pid, {
      cpuTicks: raw.cpuTicks,
      startTicks: raw.startTicks,
    });

    const uptimeSeconds =
      options.systemUptimeSeconds > 0
        ? round(
            options.systemUptimeSeconds -
              raw.startTicks / CLOCK_TICKS_PER_SECOND,
            0,
          )
        : null;

    processes.push({
      pid: raw.pid,
      ppid: raw.ppid,
      name: raw.name,
      state: raw.state,
      cpu:
        options.previous === null || options.intervalMs === null
          ? null
          : processCpu(options.previous.get(raw.pid), raw, options.intervalMs),
      memoryBytes: raw.residentBytes,
      memory:
        options.totalMemoryBytes > 0
          ? clampPercent((raw.residentBytes / options.totalMemoryBytes) * 100)
          : 0,
      threads: raw.threads,
      uptimeSeconds: uptimeSeconds === null ? null : Math.max(0, uptimeSeconds),
    });
  }

  const query = options.query ?? {};
  const filtered = filterProcesses(processes, query.search ?? '');
  const sorted = sortProcesses(
    filtered,
    query.sort ?? 'cpu',
    query.direction ?? 'desc',
  );

  const cap = Math.min(options.maxRows ?? MAX_PROCESS_ROWS, MAX_PROCESS_ROWS);
  const limit = Math.min(query.limit ?? DEFAULT_PROCESS_ROWS, cap);
  const returned = sorted.slice(0, limit);

  return {
    snapshot: {
      timestamp: Date.now(),
      total: processes.length,
      returned: returned.length,
      processes: returned,
    },
    cpuSnapshot,
  };
}
