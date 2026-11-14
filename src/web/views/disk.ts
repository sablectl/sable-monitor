import { el } from '../dom.js';
import {
  formatBytes,
  formatDecimal,
  formatPercent,
  formatRate,
} from '../format.js';
import { historyPanel, liveChart } from '../history.js';
import {
  bar,
  empty,
  liveSection,
  measured,
  panel,
  table,
  viewShell,
  type View,
} from '../ui.js';

export function diskView(): View {
  const live = liveSection((s) => {
    const d = s.disk;
    const filesystems =
      d.filesystems.length === 0
        ? empty('No filesystems were reported.')
        : table(
            'Mounted filesystems',
            [
              { label: 'Device' },
              { label: 'Mount point' },
              { label: 'Type' },
              { label: 'Used / total', numeric: true },
              { label: 'Usage' },
              { label: 'Mode' },
            ],
            d.filesystems.map((f) => [
              f.device,
              f.mountPoint,
              f.fsType,
              `${formatBytes(f.usedBytes)} / ${formatBytes(f.totalBytes)}`,
              el(
                'span',
                { class: 'usage' },
                bar(f.usage),
                formatPercent(f.usage),
              ),
              f.readOnly ? 'read-only' : 'read-write',
            ]),
          );
    const devices =
      d.devices.length === 0
        ? empty('No block devices were reported.')
        : table(
            'Block device throughput',
            [
              { label: 'Device' },
              { label: 'Read', numeric: true },
              { label: 'Write', numeric: true },
              { label: 'Reads/s', numeric: true },
              { label: 'Writes/s', numeric: true },
              { label: 'Busy', numeric: true },
            ],
            d.devices.map((dev) => [
              dev.device,
              measured(dev.readBytesPerSecond, formatRate),
              measured(dev.writeBytesPerSecond, formatRate),
              measured(dev.readsPerSecond, formatDecimal),
              measured(dev.writesPerSecond, formatDecimal),
              measured(dev.utilisation, formatPercent),
            ]),
          );
    return [
      panel('Filesystems', filesystems),
      panel(
        'Device throughput',
        devices,
        liveChart({
          name: 'Total disk throughput',
          format: formatRate,
          series: [
            { label: 'Read', pick: (x) => x.disk.readBytesPerSecond },
            { label: 'Write', pick: (x) => x.disk.writeBytesPerSecond },
          ],
        }),
      ),
    ];
  });
  const usage = historyPanel('Disk usage history', {
    name: 'Disk usage history',
    yMax: 100,
    format: formatPercent,
    series: [{ label: 'Usage', pick: (p) => p.disk }],
  });
  const throughput = historyPanel('Disk throughput history', {
    name: 'Disk throughput history',
    format: formatRate,
    series: [
      { label: 'Read', pick: (p) => p.diskReadBps },
      { label: 'Write', pick: (p) => p.diskWriteBps },
    ],
  });
  return {
    root: viewShell(
      'Disk',
      el('div', { class: 'grid' }, live.box, usage.root, throughput.root),
    ),
    sample: live.update,
    dispose: () => {
      usage.dispose();
      throughput.dispose();
    },
  };
}
