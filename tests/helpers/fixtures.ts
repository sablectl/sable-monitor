import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { Procfs } from '../../src/collect/procfs.js';

/**
 * Captured kernel files, used so that the unit tests assert on exact
 * numbers. `proc-a` and `proc-b` are two readings of the same machine one
 * second apart, which is what the rate calculations need.
 */

export const FIXTURES = fileURLToPath(new URL('../fixtures/', import.meta.url));

export function fixturePath(...parts: string[]): string {
  return join(FIXTURES, ...parts);
}

export function readFixture(...parts: string[]): string {
  return readFileSync(fixturePath(...parts), 'utf8');
}

/** A `Procfs` rooted at one of the captured snapshots. */
export function fixtureProcfs(snapshot: 'proc-a' | 'proc-b'): Procfs {
  return new Procfs({
    procRoot: fixturePath(snapshot),
    sysRoot: fixturePath('sys'),
  });
}
