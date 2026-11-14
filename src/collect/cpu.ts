import type { CpuMetrics, CpuCoreUsage } from '../types.js';
import {
  clampPercent,
  fields,
  lines,
  parseDecimal,
  parseInteger,
  round,
  type Procfs,
} from './procfs.js';

/**
 * CPU utilisation from `/proc/stat`.
 *
 * The file holds monotonically increasing counters of the time each CPU has
 * spent in each state since boot, measured in USER_HZ ticks. An
 * instantaneous read says nothing about current load — it describes the
 * whole uptime of the machine. Utilisation is therefore the difference
 * between two reads divided by the total time that elapsed between them,
 * which is why the first sample reports `null` instead of a number.
 */

export interface CpuTimes {
  readonly user: number;
  readonly nice: number;
  readonly system: number;
  readonly idle: number;
  readonly iowait: number;
  readonly irq: number;
  readonly softirq: number;
  readonly steal: number;
  readonly guest: number;
  readonly guestNice: number;
}

export interface CpuSnapshot {
  readonly total: CpuTimes;
  /** Per-logical-CPU times, keyed by the kernel's index. */
  readonly cores: ReadonlyMap<number, CpuTimes>;
}

const ZERO: CpuTimes = {
  user: 0,
  nice: 0,
  system: 0,
  idle: 0,
  iowait: 0,
  irq: 0,
  softirq: 0,
  steal: 0,
  guest: 0,
  guestNice: 0,
};

function parseTimes(values: readonly string[]): CpuTimes {
  const at = (index: number): number => parseInteger(values[index]) ?? 0;
  return {
    user: at(0),
    nice: at(1),
    system: at(2),
    idle: at(3),
    iowait: at(4),
    irq: at(5),
    softirq: at(6),
    steal: at(7),
    guest: at(8),
    guestNice: at(9),
  };
}

/**
 * Total ticks in the sample.
 *
 * `guest` and `guest_nice` are excluded because the kernel already counts
 * them inside `user` and `nice`; adding them again would inflate the
 * denominator and understate utilisation on a hypervisor host.
 */
export function totalTicks(times: CpuTimes): number {
  return (
    times.user +
    times.nice +
    times.system +
    times.idle +
    times.iowait +
    times.irq +
    times.softirq +
    times.steal
  );
}

/** Ticks that count as not working: idle plus time blocked on I/O. */
export function idleTicks(times: CpuTimes): number {
  return times.idle + times.iowait;
}

export function parseProcStat(text: string): CpuSnapshot {
  let total: CpuTimes = ZERO;
  const cores = new Map<number, CpuTimes>();

  for (const line of lines(text)) {
    if (!line.startsWith('cpu')) continue;
    const parts = fields(line);
    const label = parts[0];
    if (label === undefined) continue;
    const times = parseTimes(parts.slice(1));
    if (label === 'cpu') {
      total = times;
      continue;
    }
    const index = parseInteger(label.slice(3));
    if (index !== null && index >= 0) cores.set(index, times);
  }

  return { total, cores };
}

/**
 * Utilisation between two readings of the same counter set.
 *
 * Returns `null` when the counters did not advance — two reads inside the
 * same tick — and when they went backwards, which happens if a CPU is
 * hot-unplugged and replugged. Reporting `null` is honest; reporting 0
 * would draw a trough that the machine never had.
 */
export function usageBetween(
  previous: CpuTimes,
  current: CpuTimes,
): number | null {
  const totalDelta = totalTicks(current) - totalTicks(previous);
  if (totalDelta <= 0) return null;
  const idleDelta = idleTicks(current) - idleTicks(previous);
  if (idleDelta < 0) return null;
  return clampPercent(((totalDelta - idleDelta) / totalDelta) * 100);
}

function shareBetween(
  previous: CpuTimes,
  current: CpuTimes,
  field: keyof CpuTimes,
): number | null {
  const totalDelta = totalTicks(current) - totalTicks(previous);
  if (totalDelta <= 0) return null;
  const delta = current[field] - previous[field];
  if (delta < 0) return null;
  return clampPercent((delta / totalDelta) * 100);
}

export function coreUsages(
  previous: CpuSnapshot,
  current: CpuSnapshot,
): CpuCoreUsage[] {
  const usages: CpuCoreUsage[] = [];
  for (const [index, times] of [...current.cores].sort((a, b) => a[0] - b[0])) {
    const before = previous.cores.get(index);
    if (before === undefined) continue;
    const usage = usageBetween(before, times);
    if (usage === null) continue;
    usages.push({ index, usage });
  }
  return usages;
}

export interface LoadAverage {
  readonly one: number;
  readonly five: number;
  readonly fifteen: number;
}

export function parseLoadAverage(text: string): LoadAverage {
  const parts = fields(text);
  return {
    one: parseDecimal(parts[0]) ?? 0,
    five: parseDecimal(parts[1]) ?? 0,
    fifteen: parseDecimal(parts[2]) ?? 0,
  };
}

export interface CpuInfo {
  readonly model: string | null;
  readonly frequencyMhz: number | null;
  readonly logicalCount: number;
}

/**
 * Model name and current frequency from `/proc/cpuinfo`.
 *
 * `model name` is absent on several architectures and `cpu MHz` is absent
 * whenever the kernel has no frequency driver for the part, so both are
 * optional. The frequency reported is the mean over the logical CPUs that
 * do publish one, which is the only summary that means anything on a part
 * whose cores clock independently.
 */
export function parseCpuInfo(text: string): CpuInfo {
  let model: string | null = null;
  const frequencies: number[] = [];
  let processors = 0;

  for (const line of lines(text)) {
    const separator = line.indexOf(':');
    if (separator === -1) continue;
    const key = line.slice(0, separator).trim();
    const value = line.slice(separator + 1).trim();
    if (key === 'processor') processors += 1;
    if (key === 'model name' && model === null && value.length > 0) {
      model = value;
    }
    if (key === 'cpu MHz') {
      const mhz = parseDecimal(value);
      if (mhz !== null && mhz > 0) frequencies.push(mhz);
    }
  }

  const frequencyMhz =
    frequencies.length > 0
      ? round(frequencies.reduce((a, b) => a + b, 0) / frequencies.length, 0)
      : null;

  return { model, frequencyMhz, logicalCount: processors };
}

export interface CpuReading {
  readonly metrics: CpuMetrics;
  readonly snapshot: CpuSnapshot;
}

export async function collectCpu(
  procfs: Procfs,
  previous: CpuSnapshot | null,
): Promise<CpuReading> {
  const [statText, loadText, infoText] = await Promise.all([
    procfs.readProc('stat'),
    procfs.readProc('loadavg'),
    procfs.readProcOptional('cpuinfo'),
  ]);

  const snapshot = parseProcStat(statText);
  const info =
    infoText === null
      ? { model: null, frequencyMhz: null, logicalCount: 0 }
      : parseCpuInfo(infoText);

  const logicalCount =
    snapshot.cores.size > 0 ? snapshot.cores.size : info.logicalCount;

  const metrics: CpuMetrics = {
    usage:
      previous === null ? null : usageBetween(previous.total, snapshot.total),
    cores: previous === null ? [] : coreUsages(previous, snapshot),
    loadAverage: parseLoadAverage(loadText),
    logicalCount,
    model: info.model,
    frequencyMhz: info.frequencyMhz,
    iowait:
      previous === null
        ? null
        : shareBetween(previous.total, snapshot.total, 'iowait'),
    steal:
      previous === null
        ? null
        : shareBetween(previous.total, snapshot.total, 'steal'),
  };

  return { metrics, snapshot };
}
