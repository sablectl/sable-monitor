import { describe, expect, it } from 'vitest';
import {
  CLOCK_TICKS_PER_SECOND,
  collectProcesses,
  filterProcesses,
  parseProcessStat,
  processCpu,
  sortProcesses,
} from '../../src/collect/processes.js';
import type { ProcessInfo } from '../../src/types.js';
import { fixtureProcfs, readFixture } from '../helpers/fixtures.js';

const WEIRD = readFixture('proc-a', '123', 'stat');

describe('parseProcessStat', () => {
  it('reads a name containing spaces and parentheses', () => {
    const raw = parseProcessStat(WEIRD);
    expect(raw?.name).toBe('my (weird) proc');
    expect(raw?.pid).toBe(123);
    expect(raw?.state).toBe('S');
    expect(raw?.ppid).toBe(1);
  });

  it('reads the fields the rates are built from', () => {
    const raw = parseProcessStat(WEIRD);
    expect(raw?.cpuTicks).toBe(750);
    expect(raw?.threads).toBe(4);
    expect(raw?.startTicks).toBe(1000);
    expect(raw?.residentBytes).toBe(2500 * 4096);
  });

  it('returns null for a line that is not a process stat', () => {
    expect(parseProcessStat('')).toBeNull();
    expect(parseProcessStat('nonsense')).toBeNull();
    expect(parseProcessStat('abc (x) S 1')).toBeNull();
  });

  it('survives a truncated line', () => {
    const raw = parseProcessStat('7 (short) R 1');
    expect(raw?.pid).toBe(7);
    expect(raw?.cpuTicks).toBe(0);
  });
});

describe('processCpu', () => {
  const current = parseProcessStat(WEIRD)!;

  it('is the tick delta over the interval, as a share of one CPU', () => {
    const previous = { cpuTicks: 700, startTicks: 1000 };
    // 50 ticks in a second, and a second is 100 ticks.
    expect(processCpu(previous, current, 1000)).toBe(50);
  });

  it('reports null for the first reading', () => {
    expect(processCpu(undefined, current, 1000)).toBeNull();
  });

  it('reports null when the PID has been reused', () => {
    const previous = { cpuTicks: 700, startTicks: 999 };
    expect(processCpu(previous, current, 1000)).toBeNull();
  });

  it('reports null when no time has passed', () => {
    expect(
      processCpu({ cpuTicks: 700, startTicks: 1000 }, current, 0),
    ).toBeNull();
  });

  it('uses the documented clock rate', () => {
    expect(CLOCK_TICKS_PER_SECOND).toBe(100);
  });
});

const SAMPLE: ProcessInfo[] = [
  {
    pid: 2,
    ppid: 1,
    name: 'beta',
    state: 'S',
    cpu: 10,
    memoryBytes: 300,
    memory: 3,
    threads: 1,
    uptimeSeconds: 100,
  },
  {
    pid: 1,
    ppid: 0,
    name: 'alpha',
    state: 'R',
    cpu: null,
    memoryBytes: 100,
    memory: 1,
    threads: 2,
    uptimeSeconds: 200,
  },
  {
    pid: 3,
    ppid: 1,
    name: 'gamma',
    state: 'S',
    cpu: 50,
    memoryBytes: 200,
    memory: 2,
    threads: 3,
    uptimeSeconds: 50,
  },
];

describe('sortProcesses', () => {
  it('sorts by CPU descending by default, with unmeasured last', () => {
    expect(sortProcesses(SAMPLE, 'cpu', 'desc').map((p) => p.pid)).toEqual([
      3, 2, 1,
    ]);
  });

  it('sorts by name', () => {
    expect(sortProcesses(SAMPLE, 'name', 'asc').map((p) => p.name)).toEqual([
      'alpha',
      'beta',
      'gamma',
    ]);
  });

  it('sorts by memory and by pid', () => {
    expect(sortProcesses(SAMPLE, 'memory', 'asc').map((p) => p.pid)).toEqual([
      1, 3, 2,
    ]);
    expect(sortProcesses(SAMPLE, 'pid', 'asc').map((p) => p.pid)).toEqual([
      1, 2, 3,
    ]);
  });

  it('does not modify the array it was given', () => {
    const copy = [...SAMPLE];
    sortProcesses(SAMPLE, 'pid', 'asc');
    expect(SAMPLE).toEqual(copy);
  });
});

describe('filterProcesses', () => {
  it('matches part of a name, ignoring case', () => {
    expect(filterProcesses(SAMPLE, 'ET').map((p) => p.name)).toEqual(['beta']);
  });

  it('matches an exact pid', () => {
    expect(filterProcesses(SAMPLE, '3').map((p) => p.pid)).toEqual([3]);
  });

  it('returns everything for an empty search', () => {
    expect(filterProcesses(SAMPLE, '  ')).toHaveLength(3);
  });
});

describe('collectProcesses', () => {
  it('reads the processes in the fixture, ignoring other entries', async () => {
    const reading = await collectProcesses(fixtureProcfs('proc-a'), {
      previous: null,
      intervalMs: null,
      totalMemoryBytes: 1024 * 4096 * 100,
      systemUptimeSeconds: 123_456.78,
    });

    expect(reading.snapshot.total).toBe(2);
    expect(reading.snapshot.processes.map((p) => p.pid).sort()).toEqual([
      123, 456,
    ]);
    expect(reading.cpuSnapshot.get(123)?.cpuTicks).toBe(750);
  });

  it('reports no CPU usage on the first read', async () => {
    const reading = await collectProcesses(fixtureProcfs('proc-a'), {
      previous: null,
      intervalMs: null,
      totalMemoryBytes: 1000,
      systemUptimeSeconds: 1000,
    });
    expect(reading.snapshot.processes.every((p) => p.cpu === null)).toBe(true);
  });

  it('derives process uptime from the system uptime', async () => {
    const reading = await collectProcesses(fixtureProcfs('proc-a'), {
      previous: null,
      intervalMs: null,
      totalMemoryBytes: 1000,
      systemUptimeSeconds: 1000,
    });
    const process = reading.snapshot.processes.find((p) => p.pid === 123);
    // Started 1000 ticks, that is 10 seconds, after boot.
    expect(process?.uptimeSeconds).toBe(990);
  });

  it('honours the row limit', async () => {
    const reading = await collectProcesses(fixtureProcfs('proc-a'), {
      previous: null,
      intervalMs: null,
      totalMemoryBytes: 1000,
      systemUptimeSeconds: 1000,
      query: { limit: 1 },
    });
    expect(reading.snapshot.returned).toBe(1);
    expect(reading.snapshot.total).toBe(2);
  });
});
