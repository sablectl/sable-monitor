import { describe, expect, it } from 'vitest';
import {
  assertSafeRelativePath,
  clampPercent,
  fields,
  lines,
  parseDecimal,
  parseInteger,
  round,
  UnsafePathError,
} from '../../src/collect/procfs.js';
import { fixtureProcfs } from '../helpers/fixtures.js';

describe('assertSafeRelativePath', () => {
  it('accepts the paths the collectors read', () => {
    for (const path of [
      'stat',
      'self/mounts',
      'net/dev',
      '1234/stat',
      'class/net/eth0/operstate',
      'class/net/br-0a1b.2/operstate',
    ]) {
      expect(() => {
        assertSafeRelativePath(path);
      }).not.toThrow();
    }
  });

  it('refuses to climb out of the root', () => {
    for (const path of [
      '..',
      '../etc/shadow',
      'self/../../etc/shadow',
      'a/../b',
    ]) {
      expect(() => {
        assertSafeRelativePath(path);
      }).toThrow(UnsafePathError);
    }
  });

  it('refuses an absolute path and an empty one', () => {
    expect(() => {
      assertSafeRelativePath('/etc/shadow');
    }).toThrow(UnsafePathError);
    expect(() => {
      assertSafeRelativePath('');
    }).toThrow(UnsafePathError);
  });

  it('refuses a separator smuggled through a name', () => {
    expect(() => {
      assertSafeRelativePath('class/net/eth0\u0000/operstate');
    }).toThrow(UnsafePathError);
    expect(() => {
      assertSafeRelativePath('class/net/a b/operstate');
    }).toThrow(UnsafePathError);
  });
});

describe('Procfs', () => {
  const procfs = fixtureProcfs('proc-a');

  it('reads a file under its root', async () => {
    expect(await procfs.readProc('loadavg')).toContain('1.25');
  });

  it('refuses a traversal at the point of reading', async () => {
    await expect(procfs.readProc('../proc-b/stat')).rejects.toThrow(
      UnsafePathError,
    );
  });

  it('returns null for a file that is not there', async () => {
    expect(await procfs.readProcOptional('999999/stat')).toBeNull();
    expect(await procfs.readSysOptional('class/net/nope/operstate')).toBeNull();
  });

  it('returns null rather than throwing for a path it cannot stat', async () => {
    expect(await procfs.space('/this/does/not/exist')).toBeNull();
  });
});

describe('parsing helpers', () => {
  it('parses an integer, and nothing else', () => {
    expect(parseInteger('42')).toBe(42);
    expect(parseInteger(' -7 ')).toBe(-7);
    expect(parseInteger('4.2')).toBeNull();
    expect(parseInteger('N/A')).toBeNull();
    expect(parseInteger(undefined)).toBeNull();
    expect(parseInteger('99999999999999999999')).toBeNull();
  });

  it('parses a decimal, and nothing else', () => {
    expect(parseDecimal('1.25')).toBe(1.25);
    expect(parseDecimal('1e10')).toBeNull();
    expect(parseDecimal('')).toBeNull();
  });

  it('splits fields and lines', () => {
    expect(fields('  a   b\tc ')).toEqual(['a', 'b', 'c']);
    expect(lines('a\n\nb\n')).toEqual(['a', 'b']);
  });

  it('clamps a percentage into range', () => {
    expect(clampPercent(50.456)).toBe(50.46);
    expect(clampPercent(-1)).toBe(0);
    expect(clampPercent(101)).toBe(100);
    expect(clampPercent(Number.NaN)).toBe(0);
  });

  it('rounds, leaving null alone', () => {
    expect(round(1.2345)).toBe(1.23);
    expect(round(1.5, 0)).toBe(2);
    expect(round(null)).toBeNull();
  });
});
