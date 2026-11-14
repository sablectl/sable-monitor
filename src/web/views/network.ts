import { el } from '../dom.js';
import { formatBytes, formatInteger, formatRate } from '../format.js';
import { historyPanel, liveChart } from '../history.js';
import {
  empty,
  liveSection,
  measured,
  note,
  panel,
  table,
  viewShell,
  type View,
} from '../ui.js';

export function networkView(): View {
  const live = liveSection((s) => {
    const n = s.network;
    const interfaces =
      n.interfaces.length === 0
        ? empty('No network interfaces were reported.')
        : table(
            'Network interfaces',
            [
              { label: 'Interface' },
              { label: 'State' },
              { label: 'Receive', numeric: true },
              { label: 'Transmit', numeric: true },
              { label: 'Received total', numeric: true },
              { label: 'Transmitted total', numeric: true },
              { label: 'Errors (rx / tx)', numeric: true },
            ],
            n.interfaces.map((i) => [
              i.loopback ? `${i.name} (loopback)` : i.name,
              i.state,
              measured(i.receiveBytesPerSecond, formatRate),
              measured(i.transmitBytesPerSecond, formatRate),
              formatBytes(i.receivedBytes),
              formatBytes(i.transmittedBytes),
              `${formatInteger(i.receiveErrors)} / ${formatInteger(i.transmitErrors)}`,
            ]),
          );
    return [
      panel(
        'Throughput',
        el(
          'p',
          { class: 'big' },
          'rx ',
          measured(n.receiveBytesPerSecond, formatRate),
          ' / tx ',
          measured(n.transmitBytesPerSecond, formatRate),
        ),
        liveChart({
          name: 'Network throughput',
          format: formatRate,
          series: [
            { label: 'Receive', pick: (x) => x.network.receiveBytesPerSecond },
            {
              label: 'Transmit',
              pick: (x) => x.network.transmitBytesPerSecond,
            },
          ],
        }),
        note('Totals cover non-loopback interfaces only.'),
      ),
      panel('Interfaces', interfaces),
    ];
  });
  const history = historyPanel('Network history', {
    name: 'Network throughput history',
    format: formatRate,
    series: [
      { label: 'Receive', pick: (p) => p.netRxBps },
      { label: 'Transmit', pick: (p) => p.netTxBps },
    ],
  });
  return {
    root: viewShell(
      'Network',
      note('Latency and packet loss are not measured.'),
      el('div', { class: 'grid' }, live.box, history.root),
    ),
    sample: live.update,
    dispose: history.dispose,
  };
}
