import { describe, expect, it } from 'vitest';
import {
  diskDeviceRates,
  isRealFilesystem,
  parseDiskstats,
  parseMounts,
  unescapeMountField,
} from '../../src/collect/disk.js';
import { readFixture } from '../helpers/fixtures.js';

const MOUNTS = parseMounts(readFixture('proc-a', 'self', 'mounts'));

describe('parseMounts', () => {
  it('reads every mount', () => {
    expect(MOUNTS).toHaveLength(9);
    expect(MOUNTS[4]).toMatchObject({
      device: '/dev/nvme0n1p2',
      mountPoint: '/',
      fsType: 'ext4',
    });
  });

  it('decodes the octal escapes in a mount point', () => {
    expect(unescapeMountField('/mnt/data\\040disk')).toBe('/mnt/data disk');
    expect(MOUNTS.at(-2)?.mountPoint).toBe('/mnt/data disk');
  });

  it('reads the mount options', () => {
    expect(MOUNTS[5]?.options).toContain('ro');
  });
});

describe('isRealFilesystem', () => {
  it('excludes the kernel pseudo filesystems', () => {
    const real = MOUNTS.filter(isRealFilesystem).map(
      (entry) => entry.mountPoint,
    );
    expect(real).toEqual(['/', '/boot/efi', '/home', '/mnt/data disk']);
  });

  it('excludes a tmpfs however it is mounted', () => {
    expect(
      isRealFilesystem({
        device: 'tmpfs',
        mountPoint: '/tmp',
        fsType: 'tmpfs',
        options: [],
      }),
    ).toBe(false);
  });

  it('keeps a network filesystem', () => {
    expect(
      isRealFilesystem({
        device: 'server:/export',
        mountPoint: '/net',
        fsType: 'nfs4',
        options: [],
      }),
    ).toBe(true);
  });
});

describe('parseDiskstats', () => {
  it('keeps whole devices and drops their partitions', () => {
    const devices = parseDiskstats(readFixture('proc-a', 'diskstats'));
    expect([...devices.keys()].sort()).toEqual(['nvme0n1', 'sda']);
  });

  it('drops loop devices', () => {
    expect(parseDiskstats('   7 0 loop0 1 0 1 1 0 0 0 0 0 1 1').size).toBe(0);
  });

  it('reads the counters a rate needs', () => {
    const device = parseDiskstats(readFixture('proc-a', 'diskstats')).get(
      'nvme0n1',
    );
    expect(device).toMatchObject({
      readsCompleted: 100,
      sectorsRead: 2000,
      writesCompleted: 50,
      sectorsWritten: 1000,
      ioMillis: 500,
    });
  });
});

describe('diskDeviceRates', () => {
  const before = parseDiskstats(readFixture('proc-a', 'diskstats'));
  const after = parseDiskstats(readFixture('proc-b', 'diskstats'));

  it('converts sector deltas to bytes per second', () => {
    const rates = diskDeviceRates(before, after, 1000);
    const nvme = rates.find((device) => device.device === 'nvme0n1');
    // 2000 sectors of 512 bytes in one second.
    expect(nvme?.readBytesPerSecond).toBe(1_024_000);
    expect(nvme?.writeBytesPerSecond).toBe(512_000);
    expect(nvme?.readsPerSecond).toBe(50);
  });

  it('reports busy time as a percentage of the interval', () => {
    const rates = diskDeviceRates(before, after, 1000);
    // 400 ms of I/O in a 1000 ms interval.
    expect(
      rates.find((device) => device.device === 'nvme0n1')?.utilisation,
    ).toBe(40);
  });

  it('reports zero for a device that did nothing', () => {
    const rates = diskDeviceRates(before, after, 1000);
    expect(
      rates.find((device) => device.device === 'sda')?.readBytesPerSecond,
    ).toBe(0);
  });

  it('reports null when a counter went backwards', () => {
    const rates = diskDeviceRates(after, before, 1000);
    const nvme = rates.find((device) => device.device === 'nvme0n1');
    expect(nvme?.readBytesPerSecond).toBeNull();
    expect(nvme?.utilisation).toBeNull();
  });

  it('skips a device that was not in the earlier sample', () => {
    const rates = diskDeviceRates(new Map(), after, 1000);
    expect(rates).toEqual([]);
  });
});
