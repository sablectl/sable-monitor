import { api } from '../api.js';
import type { Alert, AlertRuleId } from '../api-types.js';
import { el } from '../dom.js';
import { formatDecimal, formatDuration, formatTimestamp } from '../format.js';
import { poll } from '../poll.js';
import { alertEvents, settingsEvents, state } from '../store.js';
import {
  empty,
  errorBox,
  loading,
  note,
  panel,
  table,
  viewShell,
  type View,
} from '../ui.js';

const UNITS: Readonly<Record<AlertRuleId, (value: number) => string>> = {
  'cpu-high': (v) => `${formatDecimal(v, 1)}%`,
  'memory-high': (v) => `${formatDecimal(v, 1)}%`,
  'disk-low': (v) => `${formatDecimal(v, 1)}% used`,
  'load-high': (v) => `${formatDecimal(v)} per logical CPU`,
  'agent-stale': (v) => `${formatDecimal(v, 0)} s`,
};

function condition(alert: Alert): string {
  const format = UNITS[alert.rule];
  return `${format(alert.value)} above ${format(alert.threshold)}`;
}

function rows(alerts: readonly Alert[]): (readonly (string | HTMLElement)[])[] {
  return alerts.map((a) => {
    const end = a.resolvedAt ?? Date.now();
    return [
      el('strong', {}, a.severity.toUpperCase()),
      a.rule,
      a.scope ?? '\u2014',
      condition(a),
      formatTimestamp(a.startedAt),
      a.resolvedAt === null ? 'active' : formatTimestamp(a.resolvedAt),
      formatDuration((end - a.startedAt) / 1000),
    ];
  });
}

const COLUMNS = [
  { label: 'Severity' },
  { label: 'Rule' },
  { label: 'Scope' },
  { label: 'Condition' },
  { label: 'Started' },
  { label: 'Resolved' },
  { label: 'Duration', numeric: true },
];

export function alertsView(): View {
  const activeBox = el('div', {}, loading());
  const historyBox = el('div', {}, loading());

  const refresh = poll(
    async () => {
      try {
        const data = await api.alerts(100);
        activeBox.replaceChildren(
          data.active.length === 0
            ? empty('No active alerts.')
            : table('Active alerts', COLUMNS, rows(data.active)),
        );
        const resolved = data.alerts.filter((a) => a.state === 'resolved');
        historyBox.replaceChildren(
          resolved.length === 0
            ? empty('No resolved alerts have been recorded.')
            : table(
                'Resolved alerts, most recent first',
                COLUMNS,
                rows(resolved),
              ),
        );
      } catch (error: unknown) {
        activeBox.replaceChildren(errorBox(error));
        historyBox.replaceChildren(errorBox(error));
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
      'Alerts',
      panel('Active', activeBox),
      panel('History', historyBox, note('Showing up to 100 recent alerts.')),
    ),
    dispose: () => {
      refresh.stop();
      offSettings();
      offAlerts();
    },
  };
}
