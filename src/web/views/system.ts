import { api } from '../api.js';
import { el } from '../dom.js';
import {
  formatBytes,
  formatDuration,
  formatInteger,
  formatTimestamp,
} from '../format.js';
import { poll } from '../poll.js';
import { settingsEvents, state } from '../store.js';
import {
  empty,
  errorBox,
  kv,
  loading,
  optionalText,
  panel,
  table,
  viewShell,
  type View,
} from '../ui.js';

export function systemView(): View {
  const systemBox = el('div', {}, loading());
  const configBox = el('div', {}, loading());

  const refresh = poll(
    async () => {
      const [system, config] = await Promise.allSettled([
        api.system(),
        api.config(),
      ]);
      if (system.status === 'fulfilled') {
        const s = system.value;
        systemBox.replaceChildren(
          kv([
            ['Hostname', s.hostname],
            ['Operating system', s.os],
            ['Kernel', s.kernel],
            ['Architecture', s.architecture],
            ['Uptime', formatDuration(s.uptimeSeconds)],
            ['Boot time', formatTimestamp(s.bootTime)],
            ['Logical CPUs', formatInteger(s.logicalCpus)],
            ['CPU model', optionalText(s.cpuModel)],
            ['Total memory', formatBytes(s.totalMemoryBytes)],
            ['Agent version', s.agentVersion],
            ['Node version', s.nodeVersion],
            ['Privileged', s.privileged ? 'yes (uid 0)' : 'no'],
          ]),
        );
      } else {
        systemBox.replaceChildren(errorBox(system.reason));
      }
      if (config.status === 'fulfilled') {
        const c = config.value;
        configBox.replaceChildren(
          kv([
            [
              'Sampling interval',
              `${formatInteger(c.collection.intervalMs)} ms`,
            ],
            [
              'Live buffer',
              `${formatInteger(c.collection.bufferSize)} samples`,
            ],
            ['Process rows', formatInteger(c.collection.processRows)],
            ['History retention', `${c.storage.retentionDays} days`],
            [
              'History write interval',
              `${formatInteger(c.storage.writeIntervalMs)} ms`,
            ],
            ['Alerts', c.alerts.enabled ? 'enabled' : 'disabled'],
            ['Listening on', `${c.security.host}:${c.security.port}`],
            ['Token required', c.security.tokenRequired ? 'yes' : 'no'],
            ['Remote access', c.security.remoteAccess ? 'yes' : 'no'],
            ['API version', String(c.apiVersion)],
          ]),
          c.alerts.rules.length === 0
            ? empty('No alert rules are configured.')
            : table(
                'Alert rules',
                [
                  { label: 'Rule' },
                  { label: 'Enabled' },
                  { label: 'Severity' },
                  { label: 'Threshold', numeric: true },
                  { label: 'Clears at', numeric: true },
                  { label: 'For', numeric: true },
                  { label: 'Cooldown', numeric: true },
                ],
                c.alerts.rules.map((r) => [
                  r.id,
                  r.enabled ? 'yes' : 'no',
                  r.severity,
                  String(r.threshold),
                  String(r.clearThreshold),
                  `${r.forSeconds} s`,
                  `${r.cooldownSeconds} s`,
                ]),
              ),
        );
      } else {
        configBox.replaceChildren(errorBox(config.reason));
      }
    },
    () => state.refreshMs,
  );
  const off = settingsEvents.on(() => {
    refresh.reschedule();
  });

  return {
    root: viewShell(
      'System',
      el(
        'div',
        { class: 'grid' },
        panel('Host', systemBox),
        panel('Agent configuration', configBox),
      ),
    ),
    dispose: () => {
      refresh.stop();
      off();
    },
  };
}
