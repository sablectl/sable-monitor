import { readFile } from 'node:fs/promises';
import { arch, hostname, release, totalmem } from 'node:os';
import type { SystemInfo } from '../types.js';
import { fields, parseDecimal, type Procfs } from './procfs.js';

/**
 * Static and slow-moving facts about the host.
 *
 * Nothing here is sensitive in itself, but the set is deliberately narrow:
 * the dashboard needs to identify the machine and nothing more. Serial
 * numbers, machine IDs, MAC addresses, IP addresses, the kernel command
 * line and the contents of the environment are not collected and not
 * served.
 */

/** Reads `PRETTY_NAME` from an os-release file, if there is one. */
export function parseOsRelease(text: string): string | null {
  for (const line of text.split('\n')) {
    const match = /^PRETTY_NAME=(.*)$/.exec(line.trim());
    if (match === null) continue;
    const value = match[1]?.trim() ?? '';
    const unquoted = /^"(.*)"$/.exec(value)?.[1] ?? value;
    if (unquoted.length > 0) return unquoted;
  }
  return null;
}

export function parseUptime(text: string): number {
  return parseDecimal(fields(text)[0]) ?? 0;
}

async function readOsName(): Promise<string> {
  for (const file of ['/etc/os-release', '/usr/lib/os-release']) {
    try {
      const name = parseOsRelease(await readFile(file, 'utf8'));
      if (name !== null) return name;
    } catch {
      // An os-release file is a convention, not a guarantee.
    }
  }
  return 'Linux';
}

export interface SystemInfoOptions {
  readonly agentVersion: string;
  readonly cpuModel: string | null;
  readonly logicalCpus: number;
}

export async function collectSystemInfo(
  procfs: Procfs,
  options: SystemInfoOptions,
): Promise<SystemInfo> {
  const uptimeSeconds = parseUptime(await procfs.readProc('uptime'));
  const now = Date.now();

  return {
    hostname: hostname(),
    os: await readOsName(),
    kernel: release(),
    architecture: arch(),
    uptimeSeconds: Math.round(uptimeSeconds),
    bootTime: now - Math.round(uptimeSeconds * 1000),
    logicalCpus: options.logicalCpus,
    cpuModel: options.cpuModel,
    totalMemoryBytes: totalmem(),
    agentVersion: options.agentVersion,
    nodeVersion: process.versions.node,
    privileged: typeof process.getuid === 'function' && process.getuid() === 0,
  };
}
