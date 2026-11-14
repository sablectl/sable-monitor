import { readFile, readdir, statfs } from 'node:fs/promises';
import { posix as path } from 'node:path';

/**
 * Reads of the kernel's pseudo-filesystems.
 *
 * Everything the collectors read goes through here, for three reasons.
 *
 * - The roots are injectable, so the unit tests point them at a directory
 *   of captured fixtures and assert on exact numbers instead of on whatever
 *   the machine running the suite happens to be doing.
 * - Relative paths are validated before they are joined, so a value that
 *   came from the kernel — a device name, an interface name, a PID — cannot
 *   escape the root through `..` or an absolute path.
 * - A missing or unreadable file is an ordinary outcome on Linux. `/proc`
 *   entries disappear between `readdir` and `readFile` whenever a process
 *   exits, and `/sys` attributes are absent on hardware that does not have
 *   them. `readOptional` returns `null` for those rather than throwing.
 */

/** Rejects anything that is not a plain relative path of safe segments. */
const SAFE_SEGMENT = /^[A-Za-z0-9._:@+-]+$/;

export class UnsafePathError extends Error {
  constructor(relative: string) {
    super(`refusing to read unsafe path: ${JSON.stringify(relative)}`);
    this.name = 'UnsafePathError';
  }
}

export function assertSafeRelativePath(relative: string): void {
  if (relative.length === 0 || relative.startsWith('/')) {
    throw new UnsafePathError(relative);
  }
  for (const segment of relative.split('/')) {
    if (!SAFE_SEGMENT.test(segment) || segment === '.' || segment === '..') {
      throw new UnsafePathError(relative);
    }
  }
}

export interface ProcfsOptions {
  readonly procRoot?: string;
  readonly sysRoot?: string;
}

export interface FilesystemSpace {
  readonly totalBytes: number;
  readonly freeBytes: number;
  readonly availableBytes: number;
}

export class Procfs {
  readonly procRoot: string;
  readonly sysRoot: string;

  constructor(options: ProcfsOptions = {}) {
    this.procRoot = options.procRoot ?? '/proc';
    this.sysRoot = options.sysRoot ?? '/sys';
  }

  private resolve(root: string, relative: string): string {
    assertSafeRelativePath(relative);
    return path.join(root, relative);
  }

  /** Reads a `/proc` file, throwing if it cannot be read. */
  async readProc(relative: string): Promise<string> {
    return await readFile(this.resolve(this.procRoot, relative), 'utf8');
  }

  /** Reads a `/proc` file, returning `null` if it cannot be read. */
  async readProcOptional(relative: string): Promise<string | null> {
    return await readOptional(this.resolve(this.procRoot, relative));
  }

  /** Reads a `/sys` file, returning `null` if it cannot be read. */
  async readSysOptional(relative: string): Promise<string | null> {
    return await readOptional(this.resolve(this.sysRoot, relative));
  }

  /** Lists a directory under `/proc`; an empty path means the root. */
  async listProc(relative = ''): Promise<string[]> {
    const directory =
      relative.length === 0
        ? this.procRoot
        : this.resolve(this.procRoot, relative);
    return await readdir(directory);
  }

  /**
   * `statfs` on a mount point. The path comes from `/proc/self/mounts` and
   * is used as given, because a mount point is an absolute path by
   * definition and no relative resolution applies.
   */
  async space(mountPoint: string): Promise<FilesystemSpace | null> {
    try {
      const stats = await statfs(mountPoint, { bigint: false });
      const blockSize = stats.bsize;
      return {
        totalBytes: stats.blocks * blockSize,
        freeBytes: stats.bfree * blockSize,
        availableBytes: stats.bavail * blockSize,
      };
    } catch {
      return null;
    }
  }
}

async function readOptional(absolute: string): Promise<string | null> {
  try {
    return await readFile(absolute, 'utf8');
  } catch {
    return null;
  }
}

/**
 * Parses a decimal integer that came from the kernel, returning `null` for
 * anything that is not one. Kernel text is not always what the
 * documentation says it is — fields are added between releases, and some
 * drivers print `N/A` — so every field is parsed defensively.
 */
export function parseInteger(value: string | undefined): number | null {
  if (value === undefined) return null;
  const trimmed = value.trim();
  if (!/^-?\d+$/.test(trimmed)) return null;
  const parsed = Number(trimmed);
  return Number.isSafeInteger(parsed) ? parsed : null;
}

export function parseDecimal(value: string | undefined): number | null {
  if (value === undefined) return null;
  const trimmed = value.trim();
  if (!/^-?\d+(\.\d+)?$/.test(trimmed)) return null;
  const parsed = Number(trimmed);
  return Number.isFinite(parsed) ? parsed : null;
}

/** Splits a line on runs of whitespace, discarding empty fields. */
export function fields(line: string): string[] {
  return line.trim().split(/\s+/).filter(Boolean);
}

/** Splits text into lines, discarding the trailing empty one. */
export function lines(text: string): string[] {
  return text.split('\n').filter((line) => line.length > 0);
}

/** Clamps a percentage into 0 to 100 and rounds it to two decimals. */
export function clampPercent(value: number): number {
  if (!Number.isFinite(value)) return 0;
  return Math.round(Math.min(100, Math.max(0, value)) * 100) / 100;
}

/** Rounds to `digits` decimal places, leaving `null` alone. */
export function round(value: number | null, digits = 2): number | null {
  if (value === null || !Number.isFinite(value)) return null;
  const factor = 10 ** digits;
  return Math.round(value * factor) / factor;
}
