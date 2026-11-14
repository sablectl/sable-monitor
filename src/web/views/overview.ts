import { api } from '../api.js';
import type { Alert, HealthStatus } from '../api-types.js';
import { el } from '../dom.js';
import {
  formatBytes,
  formatDuration,
  formatPercent,
  formatRate,
} from '../format.js';
import { liveChart } from '../history.js';
import { poll } from '../poll.js';
import { alertEvents, settingsEvents, state } from '../store.js';
import {
  errorBox,
  kv,
  liveSection,
  loading,
  measured,
  panel,
  stat,
  viewShell,
  type View,
} from '../ui.js';

function overall(health: HealthStatus, active: readonly Alert[]): string {
  if (health.status === 'stale' || !health.agentRunning) return 'STALE';
  if (health.status === 'degraded') return 'DEGRADED';
  if (active.some((a) => a.severity === 'critical')) return 'CRITICAL';
  if (active.length > 0) return 'WARNING';
  return 'OK';
}

export function overviewView(): View {
  const live = liveSection((s) => [
    stat(
      'CPU',
      measured(s.cpu.usage, formatPercent),
      `Load ${s.cpu.loadAverage.one.toFixed(2)} over ${s.cpu.logicalCount} logical CPUs`,
      liveChart({
        name: 'CPU utilisation',
        yMax: 100,
        compact: true,
        format: formatPercent,
        series: [{ label: 'CPU', pick: (x) => x.cpu.usage }],
      }),
    ),
    stat(
      'Memory',
      formatPercent(s.memory.usage),
      `${formatBytes(s.memory.usedBytes)} of ${formatBytes(s.memory.totalBytes)}`,
      liveChart({
        name: 'Memory usage',
        yMax: 100,
        compact: true,
        format: formatPercent,
        series: [{ label: 'Memory', pick: (x) => x.memory.usage }],
      }),
    ),
    stat(
      'Disk',
      formatPercent(s.disk.usage),
      `${formatBytes(s.disk.usedBytes)} of ${formatBytes(s.disk.totalBytes)}`,
      liveChart({
        name: 'Disk usage',
        yMax: 100,
        compact: true,
        format: formatPercent,
        series: [{ label: 'Disk', pick: (x) => x.disk.usage }],
      }),
    ),
    stat(
      'Network',
      el(
        'span',
        {},
        'rx ',
        measured(s.network.receiveBytesPerSecond, formatRate),
      ),
      el(
        'span',
        {},
        'tx ',
        measured(s.network.transmitBytesPerSecond, formatRate),
      ),
      liveChart({
        name: 'Network throughput',
        compact: true,
        format: formatRate,
        series: [
          { label: 'Receive', pick: (x) => x.network.receiveBytesPerSecond },
          { label: 'Transmit', pick: (x) => x.network.transmitBytesPerSecond },
        ],
      }),
    ),
  ]);

  const healthBox = el('div', {}, loading());
  const uptimeBox = el('div', { class: 'stat' }, loading());

  const refresh = poll(
    async () => {
      try {
        const [health, alerts, system] = await Promise.all([
          api.health(),
          api.alerts(1),
          api.system(),
        ]);
        const active = alerts.active;
        healthBox.replaceChildren(
          el('p', { class: 'big' }, overall(health, active)),
          kv([
            ['Agent', health.agentRunning ? 'running' : 'not running'],
            ['Collection', health.status],
            [
              'Last sample',
              health.lastSampleAgeMs === null
                ? measured(null, String)
                : `${formatDuration(health.lastSampleAgeMs / 1000)} ago`,
            ],
            [
              'Degraded collectors',
              health.degraded.length === 0
                ? 'none'
                : health.degraded.join(', '),
            ],
            ['Collection errors', String(health.collectionErrors)],
            ['Active alerts', String(active.length)],
          ]),
          ...active.map((a) =>
            el(
              'p',
              { class: `alert-line ${a.severity}` },
              el('strong', {}, a.severity.toUpperCase()),
              ` ${a.rule}${a.scope === null ? '' : ` (${a.scope})`}: ${a.message}`,
            ),
          ),
        );
        uptimeBox.replaceChildren(
          el('div', { class: 'label' }, 'System uptime'),
          el(
            'div',
            { class: 'stat-value' },
            formatDuration(system.uptimeSeconds),
          ),
          el('div', { class: 'stat-detail' }, system.hostname),
        );
      } catch (error: unknown) {
        healthBox.replaceChildren(errorBox(error));
        uptimeBox.replaceChildren(errorBox(error));
      }
    },
    () => state.refreshMs,
  );
  const offSettings = settingsEvents.on(() => {
    refresh.reschedule();
  });
  const offAlerts = alertEvents.on(() => {
    refresh.refresh();
  });

  return {
    root: viewShell(
      'Overview',
      el('div', { class: 'grid' }, panel('Health', healthBox), uptimeBox),
      el('div', { class: 'stats' }, live.box),
    ),
    sample: live.update,
    dispose: () => {
      refresh.stop();
      offSettings();
      offAlerts();
    },
  };
}
