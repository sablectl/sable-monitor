import { api } from './api.js';
import type {
  HistoryPoint,
  HistoryRange,
  HistoryResponse,
  MetricsSample,
} from './api-types.js';
import { lineChart, type ChartPoint } from './chart.js';
import { el, uniqueId } from './dom.js';
import { formatTimestamp } from './format.js';
import { poll } from './poll.js';
import { samples, settingsEvents, state } from './store.js';
import { errorBox, loading, panel } from './ui.js';

const RANGES: readonly HistoryRange[] = ['15m', '1h', '6h', '24h', '7d'];

export interface SeriesSpec<T> {
  readonly label: string;
  readonly pick: (source: T) => number | null;
}

export interface ChartSpec<T> {
  readonly name: string;
  readonly series: readonly SeriesSpec<T>[];
  readonly format: (value: number) => string;
  readonly yMax?: number;
  readonly compact?: boolean;
}

export function liveChart(spec: ChartSpec<MetricsSample>): HTMLElement {
  return lineChart({
    name: spec.name,
    format: spec.format,
    ...(spec.yMax === undefined ? {} : { yMax: spec.yMax }),
    ...(spec.compact === undefined ? {} : { compact: spec.compact }),
    series: spec.series.map((s) => ({
      label: s.label,
      points: samples.map((sample): ChartPoint => ({
        t: sample.timestamp,
        v: s.pick(sample),
      })),
    })),
  });
}

export function historyPanel(
  title: string,
  spec: ChartSpec<HistoryPoint>,
): { readonly root: HTMLElement; readonly dispose: () => void } {
  let range: HistoryRange = '1h';
  let controller: AbortController | null = null;
  const body = el('div', { class: 'history-body' }, loading());
  const selectId = uniqueId('range');
  const select = el('select', { id: selectId });
  for (const value of RANGES) {
    select.append(el('option', { value }, value));
  }
  select.value = range;
  const button = el('button', { type: 'button', class: 'button' }, 'Refresh');

  const draw = (data: HistoryResponse): void => {
    const summary =
      data.count === 0
        ? el(
            'p',
            { class: 'state' },
            'No history has been stored for this range.',
          )
        : el(
            'p',
            { class: 'note' },
            `${data.count} points from ${formatTimestamp(data.from)} to ` +
              `${formatTimestamp(data.to)}.`,
            data.retainedFrom === null
              ? null
              : ` History begins at ${formatTimestamp(data.retainedFrom)}.`,
            ' Gaps are periods with no measurement.',
          );
    body.replaceChildren(
      ...(data.count === 0
        ? [summary]
        : [
            lineChart({
              name: spec.name,
              format: spec.format,
              from: data.from,
              to: data.to,
              ...(spec.yMax === undefined ? {} : { yMax: spec.yMax }),
              series: spec.series.map((s) => ({
                label: s.label,
                points: data.points.map((p): ChartPoint => ({
                  t: p.timestamp,
                  v: s.pick(p),
                })),
              })),
            }),
            summary,
          ]),
    );
  };

  const poller = poll(
    async () => {
      controller?.abort();
      const current = new AbortController();
      controller = current;
      try {
        draw(await api.history(range, current.signal));
      } catch (error: unknown) {
        if (current.signal.aborted) return;
        body.replaceChildren(errorBox(error));
      }
    },
    () => state.refreshMs,
  );

  select.addEventListener('change', () => {
    range = select.value as HistoryRange;
    body.replaceChildren(loading());
    poller.refresh();
  });
  button.addEventListener('click', () => {
    poller.refresh();
  });
  const unsubscribe = settingsEvents.on(() => {
    poller.reschedule();
  });

  const controls = el(
    'div',
    { class: 'controls' },
    el('label', { for: selectId }, 'Range'),
    select,
    button,
  );
  return {
    root: panel(title, controls, body),
    dispose: () => {
      poller.stop();
      unsubscribe();
      controller?.abort();
    },
  };
}
