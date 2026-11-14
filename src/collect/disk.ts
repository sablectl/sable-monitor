import type {
  DiskDeviceMetrics,
  DiskMetrics,
  FilesystemMetrics,
} from '../types.js';
import {
  clampPercent,
  fields,
  lines,
  parseInteger,
  round,
  type Procfs,
} from './procfs.js';

/**
 * Filesystem capacity and block device throughput.
 *
 * Two different things are measured here and they are deliberately kept
 * apart. Capacity is a property of a mounted filesystem and comes from
 * `statfs` on its mount point. Throughput is a property of a block device
 * and comes from the counters in `/proc/diskstats`. A single filesystem can
 * span several devices and a single device can carry several filesystems,
 * so adding one to the other would produce a number that describes nothing.
 *
 * Two kinds of double counting are avoided when the totals are summed:
 *
 * - Pseudo filesystems — `proc`, `sysfs`, `tmpfs`, `overlay`, cgroups and
 *   the rest — are not storage and are excluded entirely.
 * - A filesystem mounted at more than one place, whether by a bind mount or
 *   by a Btrfs subvolume, reports the same blocks each time. Only the first
 *   mount point of a given device is counted towards the totals.
 */

/** Filesystem types that are not backed by storage. */
const PSEUDO_FILESYSTEMS = new Set([
  'autofs',
  'bpf',
  'binfmt_misc',
  'cgroup',
  'cgroup2',
  'configfs',
  'debugfs',
  'devpts',
  'devtmpfs',
  'efivarfs',
  'fuse.gvfsd-fuse',
  'fuse.portal',
  'fusectl',
  'hugetlbfs',
  'mqueue',
  'nsfs',
  'overlay',
  'proc',
  'pstore',
  'ramfs',
  'rpc_pipefs',
  'securityfs',
  'selinuxfs',
  'squashfs',
  'sysfs',
  'tmpfs',
  'tracefs',
]);

export interface MountEntry {
  readonly device: string;
  readonly mountPoint: string;
  readonly fsType: string;
  readonly options: readonly string[];
}

/**
 * Decodes the octal escapes `/proc/self/mounts` uses for the characters
 * that would otherwise break its own field separation.
 */
export function unescapeMountField(value: string): string {
  return value.replace(/\\(\d{3})/g, (_match, octal: string) =>
    String.fromCharCode(parseInt(octal, 8)),
  );
}

export function parseMounts(text: string): MountEntry[] {
  const entries: MountEntry[] = [];
  for (const line of lines(text)) {
    const parts = fields(line);
    const [device, mountPoint, fsType, options] = parts;
    if (
      device === undefined ||
      mountPoint === undefined ||
      fsType === undefined
    ) {
      continue;
    }
    entries.push({
      device: unescapeMountField(device),
      mountPoint: unescapeMountField(mountPoint),
      fsType,
      options: (options ?? '').split(',').filter(Boolean),
    });
  }
  return entries;
}

export function isRealFilesystem(entry: MountEntry): boolean {
  if (PSEUDO_FILESYSTEMS.has(entry.fsType)) return false;
  // A real filesystem is mounted from a device node or a network source;
  // `none` and bare names belong to kernel filesystems.
  return entry.device.includes('/') || entry.device.includes(':');
}

export interface DiskstatsEntry {
  readonly device: string;
  readonly readsCompleted: number;
  readonly sectorsRead: number;
  readonly writesCompleted: number;
  readonly sectorsWritten: number;
  /** Milliseconds the device had at least one request in flight. */
  readonly ioMillis: number;
}

/** `/proc/diskstats` counts in 512-byte sectors regardless of hardware. */
export const SECTOR_BYTES = 512;

/**
 * Partitions and virtual devices, which would double count the disk they
 * sit on or report activity that is not storage at all.
 */
function isPhysicalDevice(name: string, known: ReadonlySet<string>): boolean {
  if (/^(loop|ram|zram|fd)\d+$/.test(name)) return false;
  const partition = /^(.*?)p?\d+$/.exec(name);
  if (partition !== null) {
    const parent = partition[1];
    if (parent !== undefined && parent.length > 0 && known.has(parent)) {
      return false;
    }
  }
  return true;
}

export function parseDiskstats(text: string): Map<string, DiskstatsEntry> {
  const all = new Map<string, DiskstatsEntry>();
  for (const line of lines(text)) {
    const parts = fields(line);
    const device = parts[2];
    if (device === undefined) continue;
    const at = (index: number): number => parseInteger(parts[index]) ?? 0;
    all.set(device, {
      device,
      readsCompleted: at(3),
      sectorsRead: at(5),
      writesCompleted: at(7),
      sectorsWritten: at(9),
      ioMillis: at(12),
    });
  }

  const names = new Set(all.keys());
  const physical = new Map<string, DiskstatsEntry>();
  for (const [name, entry] of all) {
    if (isPhysicalDevice(name, names)) physical.set(name, entry);
  }
  return physical;
}

/**
 * Rate between two counter readings.
 *
 * A counter that went backwards means the device was removed and replaced,
 * or that a 32-bit counter wrapped. Either way the difference is not a
 * rate, so `null` is reported for that interval and the next one recovers.
 */
function rate(
  previous: number,
  current: number,
  intervalMs: number,
): number | null {
  if (intervalMs <= 0) return null;
  const delta = current - previous;
  if (delta < 0) return null;
  return (delta * 1000) / intervalMs;
}

export function diskDeviceRates(
  previous: ReadonlyMap<string, DiskstatsEntry>,
  current: ReadonlyMap<string, DiskstatsEntry>,
  intervalMs: number,
): DiskDeviceMetrics[] {
  const devices: DiskDeviceMetrics[] = [];
  for (const [name, entry] of [...current].sort((a, b) =>
    a[0].localeCompare(b[0]),
  )) {
    const before = previous.get(name);
    if (before === undefined) continue;
    const busy = rate(before.ioMillis, entry.ioMillis, intervalMs);
    devices.push({
      device: name,
      readBytesPerSecond: round(
        scale(rate(before.sectorsRead, entry.sectorsRead, intervalMs)),
        0,
      ),
      writeBytesPerSecond: round(
        scale(rate(before.sectorsWritten, entry.sectorsWritten, intervalMs)),
        0,
      ),
      readsPerSecond: round(
        rate(before.readsCompleted, entry.readsCompleted, intervalMs),
      ),
      writesPerSecond: round(
        rate(before.writesCompleted, entry.writesCompleted, intervalMs),
      ),
      // `ioMillis` advances in milliseconds of busy time per second of wall
      // clock, so dividing the rate by ten gives a percentage.
      utilisation: busy === null ? null : clampPercent(busy / 10),
    });
  }
  return devices;
}

function scale(sectorsPerSecond: number | null): number | null {
  return sectorsPerSecond === null ? null : sectorsPerSecond * SECTOR_BYTES;
}

export interface DiskReading {
  readonly metrics: DiskMetrics;
  readonly snapshot: Map<string, DiskstatsEntry>;
}

export async function collectDisk(
  procfs: Procfs,
  previous: ReadonlyMap<string, DiskstatsEntry> | null,
  intervalMs: number | null,
): Promise<DiskReading> {
  const [mountsText, diskstatsText] = await Promise.all([
    procfs.readProc('self/mounts'),
    procfs.readProcOptional('diskstats'),
  ]);

  const filesystems: FilesystemMetrics[] = [];
  const countedDevices = new Set<string>();
  let totalBytes = 0;
  let usedBytes = 0;
  let availableBytes = 0;

  for (const entry of parseMounts(mountsText)) {
    if (!isRealFilesystem(entry)) continue;
    const space = await procfs.space(entry.mountPoint);
    if (space === null || space.totalBytes === 0) continue;

    // Used space is measured against what the caller can actually use:
    // the blocks reserved for root are neither used nor available.
    const usable = space.availableBytes + (space.totalBytes - space.freeBytes);
    const used = space.totalBytes - space.freeBytes;

    filesystems.push({
      device: entry.device,
      mountPoint: entry.mountPoint,
      fsType: entry.fsType,
      totalBytes: space.totalBytes,
      usedBytes: used,
      availableBytes: space.availableBytes,
      usage: usable > 0 ? clampPercent((used / usable) * 100) : 0,
      readOnly: entry.options.includes('ro'),
    });

    if (!countedDevices.has(entry.device)) {
      countedDevices.add(entry.device);
      totalBytes += space.totalBytes;
      usedBytes += used;
      availableBytes += space.availableBytes;
    }
  }

  filesystems.sort((a, b) => a.mountPoint.localeCompare(b.mountPoint));

  const snapshot =
    diskstatsText === null
      ? new Map<string, DiskstatsEntry>()
      : parseDiskstats(diskstatsText);

  const devices =
    previous === null || intervalMs === null
      ? []
      : diskDeviceRates(previous, snapshot, intervalMs);

  const totalUsable = usedBytes + availableBytes;

  return {
    metrics: {
      filesystems,
      devices,
      totalBytes,
      usedBytes,
      availableBytes,
      usage:
        totalUsable > 0 ? clampPercent((usedBytes / totalUsable) * 100) : 0,
      readBytesPerSecond: sumRates(devices, 'readBytesPerSecond'),
      writeBytesPerSecond: sumRates(devices, 'writeBytesPerSecond'),
    },
    snapshot,
  };
}

function sumRates(
  devices: readonly DiskDeviceMetrics[],
  key: 'readBytesPerSecond' | 'writeBytesPerSecond',
): number | null {
  const measured = devices
    .map((device) => device[key])
    .filter((value): value is number => value !== null);
  if (measured.length === 0) return null;
  return measured.reduce((a, b) => a + b, 0);
}
