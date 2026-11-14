import { el } from '../dom.js';
import {
  formatDecimal,
  formatInteger,
  formatMhz,
  formatPercent,
} from '../format.js';
import { historyPanel, liveChart } from '../history.js';
import {
  bar,
  kv,
  liveSection,
  measured,
  optionalText,
  panel,
  stat,
  viewShell,
  type View,
} from '../ui.js';

export function cpuView(): View {
  const live = liveSection((s) => {
    const cpu = s.cpu;
    const perCpu = (load: number): string =>
      cpu.logicalCount > 0
        ? `${formatDecimal(load / cpu.logicalCount)} per logical CPU`
        : '';
    const cores = el('ul', { class: 'cores' });
    for (const core of cpu.cores) {
      cores.append(
        el(
          'li',
          {},
          el('span', { class: 'core-name' }, `cpu${core.index}`),
          bar(core.usage),
          el('span', { class: 'core-value' }, formatPercent(core.usage)),
        ),
      );
    }
    return [
      panel(
        'Total utilisation',
        el('p', { class: 'big' }, measured(cpu.usage, formatPercent)),
        liveChart({
          name: 'Total CPU utilisation',
          yMax: 100,
          format: formatPercent,
          series: [{ label: 'Utilisation', pick: (m) => m.cpu.usage }],
        }),
      ),
      panel(
        'Load average',
        kv([
          [
            '1 minute',
            `${formatDecimal(cpu.loadAverage.one)}, ${perCpu(cpu.loadAverage.one)}`,
          ],
          [
            '5 minutes',
            `${formatDecimal(cpu.loadAverage.five)}, ${perCpu(cpu.loadAverage.five)}`,
          ],
          [
            '15 minutes',
            `${formatDecimal(cpu.loadAverage.fifteen)}, ${perCpu(cpu.loadAverage.fifteen)}`,
          ],
        ]),
      ),
      panel(
        'Processor',
        kv([
          ['Model', optionalText(cpu.model)],
          ['Logical CPUs', formatInteger(cpu.logicalCount)],
          ['Frequency', measured(cpu.frequencyMhz, formatMhz)],
          ['I/O wait', measured(cpu.iowait, formatPercent)],
          ['Steal', measured(cpu.steal, formatPercent)],
        ]),
      ),
      panel(
        'Per-core utilisation',
        cpu.cores.length === 0 ? stat('Cores', measured(null, String)) : cores,
      ),
    ];
  });
  const history = historyPanel('CPU history', {
    name: 'CPU utilisation history',
    yMax: 100,
    format: formatPercent,
    series: [{ label: 'Utilisation', pick: (p) => p.cpu }],
  });
  const load = historyPanel('Load history', {
    name: 'One-minute load average history',
    format: formatDecimal,
    series: [{ label: 'Load, 1 minute', pick: (p) => p.load1 }],
  });
  return {
    root: viewShell(
      'CPU',
      el('div', { class: 'grid' }, live.box, history.root, load.root),
    ),
    sample: live.update,
    dispose: () => {
      history.dispose();
      load.dispose();
    },
  };
}
