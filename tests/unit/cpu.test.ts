import { describe, expect, it } from 'vitest';
import {
  collectCpu,
  coreUsages,
  parseCpuInfo,
  parseLoadAverage,
  parseProcStat,
  totalTicks,
  usageBetween,
} from '../../src/collect/cpu.js';
import { fixtureProcfs, readFixture } from '../helpers/fixtures.js';

describe('parseProcStat', () => {
  it('reads the aggregate line and every core', () => {
    const snapshot = parseProcStat(readFixture('proc-a', 'stat'));
    expect(snapshot.total.user).toBe(1000);
    expect(snapshot.total.idle).toBe(8000);
    expect(snapshot.total.iowait).toBe(200);
    expect(snapshot.cores.size).toBe(2);
    expect(snapshot.cores.get(0)?.system).toBe(250);
  });

  it('ignores lines that are not CPU times', () => {
    const snapshot = parseProcStat('intr 1 2 3\nctxt 4\n');
    expect(snapshot.cores.size).toBe(0);
    expect(totalTicks(snapshot.total)).toBe(0);
  });

  it('survives a truncated line', () => {
    const snapshot = parseProcStat('cpu  100 200\ncpu0\n');
    expect(snapshot.total.user).toBe(100);
    expect(snapshot.total.idle).toBe(0);
    expect(snapshot.cores.get(0)?.user).toBe(0);
  });
});

describe('usageBetween', () => {
  it('is the busy share of the elapsed ticks', () => {
    const a = parseProcStat(readFixture('proc-a', 'stat'));
    const b = parseProcStat(readFixture('proc-b', 'stat'));
    // 850 ticks elapsed, 650 of them idle or waiting on I/O.
    expect(usageBetween(a.total, b.total)).toBeCloseTo(23.53, 2);
  });

  it('excludes guest time from the denominator', () => {
    const base = parseProcStat('cpu 100 0 0 100 0 0 0 0 50 0').total;
    expect(totalTicks(base)).toBe(200);
  });

  it('reports null when no time has passed', () => {
    const a = parseProcStat(readFixture('proc-a', 'stat'));
    expect(usageBetween(a.total, a.total)).toBeNull();
  });

  it('reports null when the counters went backwards', () => {
    const a = parseProcStat(readFixture('proc-a', 'stat'));
    const b = parseProcStat(readFixture('proc-b', 'stat'));
    expect(usageBetween(b.total, a.total)).toBeNull();
  });

  it('never exceeds 100 per cent', () => {
    const before = parseProcStat('cpu 0 0 0 1000 0 0 0 0').total;
    const after = parseProcStat('cpu 5000 0 0 1000 0 0 0 0').total;
    expect(usageBetween(before, after)).toBe(100);
  });
});

describe('coreUsages', () => {
  it('reports one entry per core, in kernel order', () => {
    const a = parseProcStat(readFixture('proc-a', 'stat'));
    const b = parseProcStat(readFixture('proc-b', 'stat'));
    const cores = coreUsages(a, b);
    expect(cores.map((core) => core.index)).toEqual([0, 1]);
    expect(cores[0]?.usage).toBeCloseTo(23.53, 2);
  });

  it('skips a core that was not present in the earlier sample', () => {
    const a = parseProcStat('cpu 1 0 0 1 0 0 0 0\ncpu0 1 0 0 1 0 0 0 0');
    const b = parseProcStat(
      'cpu 2 0 0 2 0 0 0 0\ncpu0 2 0 0 2 0 0 0 0\ncpu1 2 0 0 2 0 0 0 0',
    );
    expect(coreUsages(a, b).map((core) => core.index)).toEqual([0]);
  });
});

describe('parseCpuInfo', () => {
  it('reads the model, the mean frequency and the processor count', () => {
    const info = parseCpuInfo(readFixture('proc-a', 'cpuinfo'));
    expect(info.model).toBe('Test CPU @ 3.00GHz');
    expect(info.frequencyMhz).toBe(3000);
    expect(info.logicalCount).toBe(2);
  });

  it('reports no model and no frequency where the kernel omits them', () => {
    const info = parseCpuInfo('processor\t: 0\nBogoMIPS\t: 100.00\n');
    expect(info.model).toBeNull();
    expect(info.frequencyMhz).toBeNull();
    expect(info.logicalCount).toBe(1);
  });
});

describe('parseLoadAverage', () => {
  it('reads the three averages', () => {
    expect(parseLoadAverage(readFixture('proc-a', 'loadavg'))).toEqual({
      one: 1.25,
      five: 0.75,
      fifteen: 0.5,
    });
  });
});

describe('collectCpu', () => {
  it('reports no utilisation for the first sample', async () => {
    const reading = await collectCpu(fixtureProcfs('proc-a'), null);
    expect(reading.metrics.usage).toBeNull();
    expect(reading.metrics.cores).toEqual([]);
    expect(reading.metrics.logicalCount).toBe(2);
    expect(reading.metrics.loadAverage.one).toBe(1.25);
  });

  it('reports utilisation once there is something to compare with', async () => {
    const first = await collectCpu(fixtureProcfs('proc-a'), null);
    const second = await collectCpu(fixtureProcfs('proc-b'), first.snapshot);
    expect(second.metrics.usage).toBeCloseTo(23.53, 2);
    expect(second.metrics.iowait).toBeCloseTo(5.88, 2);
    expect(second.metrics.steal).toBe(0);
    expect(second.metrics.cores).toHaveLength(2);
  });
});
