import { describe, expect, it } from 'vitest';
import {
  collectMemory,
  memoryFromMeminfo,
  parseMeminfo,
} from '../../src/collect/memory.js';
import { fixtureProcfs, readFixture } from '../helpers/fixtures.js';

const MEMINFO = readFixture('proc-a', 'meminfo');

describe('parseMeminfo', () => {
  it('converts kibibytes to bytes', () => {
    const values = parseMeminfo(MEMINFO);
    expect(values.get('MemTotal')).toBe(16_384_000 * 1024);
    expect(values.get('MemAvailable')).toBe(8_192_000 * 1024);
  });

  it('leaves a value without a unit alone', () => {
    expect(parseMeminfo(MEMINFO).get('HugePages_Total')).toBe(0);
  });

  it('ignores a line it cannot read', () => {
    const values = parseMeminfo('MemTotal: not a number kB\nMemFree: 8 kB\n');
    expect(values.has('MemTotal')).toBe(false);
    expect(values.get('MemFree')).toBe(8192);
  });
});

describe('memoryFromMeminfo', () => {
  it('derives used memory from MemAvailable, not from MemFree', () => {
    const memory = memoryFromMeminfo(parseMeminfo(MEMINFO));
    // 16000 MiB total, 8000 MiB available: cache and buffers are not used.
    expect(memory.usedBytes).toBe(8_192_000 * 1024);
    expect(memory.usage).toBe(50);
    expect(memory.cachedBytes).toBe((4_096_000 + 256_000) * 1024);
  });

  it('reports swap usage as a percentage of swap', () => {
    const memory = memoryFromMeminfo(parseMeminfo(MEMINFO));
    expect(memory.swapUsedBytes).toBe(1_024_000 * 1024);
    expect(memory.swapUsage).toBe(25);
  });

  it('reports no swap usage when the host has no swap', () => {
    const memory = memoryFromMeminfo(
      parseMeminfo(
        'MemTotal: 1000 kB\nMemAvailable: 500 kB\nSwapTotal: 0 kB\n',
      ),
    );
    expect(memory.swapUsage).toBeNull();
  });

  it('falls back to free plus reclaimable on a kernel without MemAvailable', () => {
    const memory = memoryFromMeminfo(
      parseMeminfo(
        'MemTotal: 1000 kB\nMemFree: 100 kB\nBuffers: 100 kB\nCached: 300 kB\n',
      ),
    );
    expect(memory.availableBytes).toBe(500 * 1024);
    expect(memory.usage).toBe(50);
  });

  it('cannot report more available memory than the machine has', () => {
    const memory = memoryFromMeminfo(
      parseMeminfo('MemTotal: 100 kB\nMemAvailable: 400 kB\n'),
    );
    expect(memory.availableBytes).toBe(100 * 1024);
    expect(memory.usedBytes).toBe(0);
  });
});

describe('collectMemory', () => {
  it('reads the fixture host', async () => {
    const memory = await collectMemory(fixtureProcfs('proc-a'));
    expect(memory.totalBytes).toBe(16_384_000 * 1024);
    expect(memory.usage).toBe(50);
  });
});
