// Measures what the agent costs to run.
//
// Everything printed is measured on the machine the script is run on: CPU
// time actually consumed, resident memory actually used, bytes actually
// written to the database. Run it yourself rather than trusting the
// figures in the documentation, which are from one laptop.
//
//   npm run build && npm run bench
//
// Usage: node scripts/bench.js [samples] [intervalMs]

import { mkdtempSync, rmSync, statSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Agent } from '../dist/agent/agent.js';
import { parseConfig } from '../dist/config/config.js';
import { MetricsStore } from '../dist/store/database.js';
import { VERSION } from '../dist/version.js';

const samples = Number(process.argv[2] ?? 200);
const intervalMs = Number(process.argv[3] ?? 1000);

const directory = mkdtempSync(join(tmpdir(), 'sable-monitor-bench-'));
const path = join(directory, 'metrics.db');

const config = parseConfig({
  collection: { intervalMs: 300_000 },
  storage: { path, writeIntervalMs: 300_000 },
});

const store = new MetricsStore({
  path,
  retentionDays: config.storage.retentionDays,
  alertHistoryLimit: config.alerts.historyLimit,
});
const agent = new Agent({ config, store, version: VERSION });

await agent.start();

const durations = [];
const cpuBefore = process.cpuUsage();
const wallBefore = process.hrtime.bigint();

for (let index = 0; index < samples; index += 1) {
  const started = process.hrtime.bigint();
  await agent.collect();
  durations.push(Number(process.hrtime.bigint() - started) / 1e6);
}

const cpuAfter = process.cpuUsage(cpuBefore);
const wallMs = Number(process.hrtime.bigint() - wallBefore) / 1e6;

agent.flush();

// A process listing is the most expensive thing the agent does, so it is
// measured separately rather than hidden in the average.
const processStart = process.hrtime.bigint();
const processes = await agent.processes({ limit: 100 });
const processMs = Number(process.hrtime.bigint() - processStart) / 1e6;

const rss = process.memoryUsage().rss;
const heap = process.memoryUsage().heapUsed;

await agent.stop();
// Closing folds the write-ahead log into the file, so the size below is
// the whole database rather than the main file alone.
store.close();
const bytes = statSync(path).size;

const sorted = [...durations].sort((a, b) => a - b);
const percentile = (p) =>
  sorted[Math.min(sorted.length - 1, Math.floor((sorted.length * p) / 100))];
const mean = durations.reduce((a, b) => a + b, 0) / durations.length;
const cpuMs = (cpuAfter.user + cpuAfter.system) / 1000;

const fmt = (value, digits = 2) => value.toFixed(digits);

console.log(`sable-monitor ${VERSION} benchmark`);
console.log(
  `  node                 ${process.version} on ${process.platform}-${process.arch}`,
);
console.log(`  samples              ${samples}`);
console.log('');
console.log('collection');
console.log(`  mean                 ${fmt(mean)} ms`);
console.log(`  median               ${fmt(percentile(50))} ms`);
console.log(`  95th percentile      ${fmt(percentile(95))} ms`);
console.log(`  slowest              ${fmt(sorted[sorted.length - 1])} ms`);
console.log('');
console.log('cost');
console.log(
  `  CPU time             ${fmt(cpuMs)} ms over ${fmt(wallMs)} ms of wall clock`,
);
console.log(`  CPU per sample       ${fmt(cpuMs / samples)} ms`);
console.log(
  `  equivalent duty      ${fmt((cpuMs / samples / intervalMs) * 100)} % of one core at a ${intervalMs} ms interval`,
);
console.log(`  resident memory      ${fmt(rss / 1024 / 1024)} MiB`);
console.log(`  heap used            ${fmt(heap / 1024 / 1024)} MiB`);
console.log('');
console.log('storage');
console.log(`  database             ${bytes} bytes for ${samples} samples`);
console.log(`  per sample           ${fmt(bytes / samples, 1)} bytes`);
console.log(
  `  projected            ${fmt(((bytes / samples) * (86_400_000 / intervalMs) * 7) / 1024 / 1024)} MiB for 7 days at a ${intervalMs} ms interval`,
);
console.log('');
console.log('processes');
console.log(`  ${processes.total} processes read in ${fmt(processMs)} ms`);

rmSync(directory, { recursive: true, force: true });
