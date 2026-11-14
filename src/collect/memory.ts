import type { MemoryMetrics } from '../types.js';
import { clampPercent, lines, parseInteger, type Procfs } from './procfs.js';

/**
 * Memory accounting from `/proc/meminfo`.
 *
 * The values in that file are in kibibytes. The important decision here is
 * which of them counts as "used": page cache and buffers are memory the
 * kernel will hand back the moment something asks for it, so counting them
 * as used reports a machine with plenty of headroom as nearly full. The
 * kernel publishes `MemAvailable` precisely so that userspace does not have
 * to guess at that, and this collector uses it:
 *
 *     used = MemTotal - MemAvailable
 *
 * On a kernel too old to publish `MemAvailable` — before 3.14 — the
 * collector falls back to `MemFree + Buffers + Cached`, which is the
 * approximation `MemAvailable` replaced.
 */

export function parseMeminfo(text: string): Map<string, number> {
  const values = new Map<string, number>();
  for (const line of lines(text)) {
    const separator = line.indexOf(':');
    if (separator === -1) continue;
    const key = line.slice(0, separator).trim();
    const rest = line.slice(separator + 1).trim();
    const amount = parseInteger(rest.replace(/\s*kB$/, ''));
    if (amount === null) continue;
    // Every field `/proc/meminfo` suffixes with kB is in kibibytes; the
    // handful without a suffix are counts, and none of those are read here.
    values.set(key, rest.endsWith('kB') ? amount * 1024 : amount);
  }
  return values;
}

export function memoryFromMeminfo(
  values: ReadonlyMap<string, number>,
): MemoryMetrics {
  const get = (key: string): number => values.get(key) ?? 0;

  const totalBytes = get('MemTotal');
  const freeBytes = get('MemFree');
  const buffersBytes = get('Buffers');
  const cachedBytes = get('Cached') + get('SReclaimable');

  const reported = values.get('MemAvailable');
  const availableBytes = Math.min(
    totalBytes,
    reported ?? freeBytes + buffersBytes + cachedBytes,
  );

  const usedBytes = Math.max(0, totalBytes - availableBytes);

  const swapTotalBytes = get('SwapTotal');
  const swapFreeBytes = get('SwapFree');
  const swapUsedBytes = Math.max(0, swapTotalBytes - swapFreeBytes);

  return {
    totalBytes,
    availableBytes,
    usedBytes,
    freeBytes,
    buffersBytes,
    cachedBytes,
    usage: totalBytes > 0 ? clampPercent((usedBytes / totalBytes) * 100) : 0,
    swapTotalBytes,
    swapUsedBytes,
    swapUsage:
      swapTotalBytes > 0
        ? clampPercent((swapUsedBytes / swapTotalBytes) * 100)
        : null,
  };
}

export async function collectMemory(procfs: Procfs): Promise<MemoryMetrics> {
  return memoryFromMeminfo(parseMeminfo(await procfs.readProc('meminfo')));
}
