import type { NetworkInterfaceMetrics, NetworkMetrics } from '../types.js';
import { fields, lines, parseInteger, round, type Procfs } from './procfs.js';

/**
 * Interface counters from `/proc/net/dev`, and link state from `/sys`.
 *
 * Throughput is the difference between two readings of the byte counters
 * divided by the elapsed time. Three situations break that subtraction and
 * each is handled rather than papered over:
 *
 * - The first sample has nothing to subtract from, so its rates are `null`.
 * - An interface that appeared since the last sample has no previous
 *   reading, so its rates are `null` until the next one.
 * - A counter that went backwards means the interface was reset, or that a
 *   32-bit counter wrapped on a long-running machine. The interval is
 *   reported as `null` instead of as an enormous spike.
 *
 * Only what the kernel counts is reported. Latency and packet loss are not
 * measured, so they are not shown.
 */

export interface InterfaceCounters {
  readonly name: string;
  readonly receivedBytes: number;
  readonly receivedPackets: number;
  readonly receiveErrors: number;
  readonly transmittedBytes: number;
  readonly transmittedPackets: number;
  readonly transmitErrors: number;
}

export function parseNetDev(text: string): Map<string, InterfaceCounters> {
  const counters = new Map<string, InterfaceCounters>();
  for (const line of lines(text)) {
    const separator = line.indexOf(':');
    if (separator === -1) continue;
    const name = line.slice(0, separator).trim();
    if (name.length === 0) continue;
    const parts = fields(line.slice(separator + 1));
    const at = (index: number): number => parseInteger(parts[index]) ?? 0;
    counters.set(name, {
      name,
      receivedBytes: at(0),
      receivedPackets: at(1),
      receiveErrors: at(2),
      transmittedBytes: at(8),
      transmittedPackets: at(9),
      transmitErrors: at(10),
    });
  }
  return counters;
}

function rate(
  previous: number,
  current: number,
  intervalMs: number,
): number | null {
  if (intervalMs <= 0) return null;
  const delta = current - previous;
  if (delta < 0) return null;
  return round((delta * 1000) / intervalMs, 0);
}

export function interfaceRates(
  previous: InterfaceCounters | undefined,
  current: InterfaceCounters,
  intervalMs: number | null,
): { receive: number | null; transmit: number | null } {
  if (previous === undefined || intervalMs === null) {
    return { receive: null, transmit: null };
  }
  return {
    receive: rate(previous.receivedBytes, current.receivedBytes, intervalMs),
    transmit: rate(
      previous.transmittedBytes,
      current.transmittedBytes,
      intervalMs,
    ),
  };
}

export interface NetworkReading {
  readonly metrics: NetworkMetrics;
  readonly snapshot: Map<string, InterfaceCounters>;
}

export async function collectNetwork(
  procfs: Procfs,
  previous: ReadonlyMap<string, InterfaceCounters> | null,
  intervalMs: number | null,
): Promise<NetworkReading> {
  const snapshot = parseNetDev(await procfs.readProc('net/dev'));
  const interfaces: NetworkInterfaceMetrics[] = [];

  let receiveTotal: number | null = null;
  let transmitTotal: number | null = null;
  let receivedBytes = 0;
  let transmittedBytes = 0;

  for (const [name, counters] of [...snapshot].sort((a, b) =>
    a[0].localeCompare(b[0]),
  )) {
    const rates = interfaceRates(previous?.get(name), counters, intervalMs);
    const state =
      (await procfs.readSysOptional(`class/net/${name}/operstate`))?.trim() ??
      'unknown';
    const loopback = name === 'lo';

    interfaces.push({
      name,
      receivedBytes: counters.receivedBytes,
      transmittedBytes: counters.transmittedBytes,
      receivedPackets: counters.receivedPackets,
      transmittedPackets: counters.transmittedPackets,
      receiveErrors: counters.receiveErrors,
      transmitErrors: counters.transmitErrors,
      receiveBytesPerSecond: rates.receive,
      transmitBytesPerSecond: rates.transmit,
      state,
      loopback,
    });

    // Loopback traffic never leaves the machine, so counting it in the
    // totals would report local socket activity as network throughput.
    if (loopback) continue;
    receivedBytes += counters.receivedBytes;
    transmittedBytes += counters.transmittedBytes;
    if (rates.receive !== null)
      receiveTotal = (receiveTotal ?? 0) + rates.receive;
    if (rates.transmit !== null) {
      transmitTotal = (transmitTotal ?? 0) + rates.transmit;
    }
  }

  return {
    metrics: {
      interfaces,
      receiveBytesPerSecond: receiveTotal,
      transmitBytesPerSecond: transmitTotal,
      receivedBytes,
      transmittedBytes,
    },
    snapshot,
  };
}
