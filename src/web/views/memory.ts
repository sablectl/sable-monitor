import { el } from '../dom.js';
import { formatBytes, formatPercent } from '../format.js';
import { historyPanel, liveChart } from '../history.js';
import { bar, kv, liveSection, panel, viewShell, type View } from '../ui.js';

export function memoryView(): View {
  const live = liveSection((s) => {
    const m = s.memory;
    return [
      panel(
        'Usage',
        el('p', { class: 'big' }, formatPercent(m.usage)),
        bar(m.usage),
        liveChart({
          name: 'Memory and swap usage',
          yMax: 100,
          format: formatPercent,
          series: [
            { label: 'Memory', pick: (x) => x.memory.usage },
            { label: 'Swap', pick: (x) => x.memory.swapUsage },
          ],
        }),
      ),
      panel(
        'Breakdown',
        kv([
          ['Total', formatBytes(m.totalBytes)],
          ['Used', formatBytes(m.usedBytes)],
          ['Available', formatBytes(m.availableBytes)],
          ['Free', formatBytes(m.freeBytes)],
          ['Cached', formatBytes(m.cachedBytes)],
          ['Buffers', formatBytes(m.buffersBytes)],
        ]),
      ),
      panel(
        'Swap',
        m.swapUsage === null
          ? el('p', { class: 'state' }, 'No swap configured.')
          : el(
              'div',
              {},
              el('p', { class: 'big' }, formatPercent(m.swapUsage)),
              bar(m.swapUsage),
              kv([
                ['Used', formatBytes(m.swapUsedBytes)],
                ['Total', formatBytes(m.swapTotalBytes)],
              ]),
            ),
      ),
    ];
  });
  const history = historyPanel('Memory history', {
    name: 'Memory and swap usage history',
    yMax: 100,
    format: formatPercent,
    series: [
      { label: 'Memory', pick: (p) => p.memory },
      { label: 'Swap', pick: (p) => p.swap },
    ],
  });
  return {
    root: viewShell(
      'Memory',
      el('div', { class: 'grid' }, live.box, history.root),
    ),
    sample: live.update,
    dispose: history.dispose,
  };
}
