import { el, svgEl, uniqueId } from './dom.js';

export interface ChartPoint {
  readonly t: number;
  readonly v: number | null;
}

export interface ChartSeries {
  readonly label: string;
  readonly points: readonly ChartPoint[];
}

export interface ChartOptions {
  readonly name: string;
  readonly series: readonly ChartSeries[];
  readonly format: (value: number) => string;
  /** Fixed upper bound, such as 100 for a percentage. */
  readonly yMax?: number;
  readonly from?: number;
  readonly to?: number;
  readonly compact?: boolean;
}

const WIDTH = 600;
const HEIGHT = 120;

function median(values: readonly number[]): number {
  const sorted = [...values].sort((a, b) => a - b);
  return sorted[Math.floor(sorted.length / 2)] ?? 0;
}

function niceMax(value: number): number {
  if (value <= 0) return 1;
  const magnitude = 10 ** Math.floor(Math.log10(value));
  for (const step of [1, 2, 5, 10]) {
    if (value <= step * magnitude) return step * magnitude;
  }
  return 10 * magnitude;
}

/**
 * A `null` value or a hole in time ends the current line. Nothing is drawn
 * across it, so an unmeasured stretch looks unmeasured.
 */
function buildPath(
  points: readonly ChartPoint[],
  x: (t: number) => number,
  y: (v: number) => number,
  gapMs: number,
): string {
  const parts: string[] = [];
  let open = false;
  let count = 0;
  let previousT = 0;

  const close = (): void => {
    if (open && count === 1) parts.push(`l0.01 0`);
    open = false;
    count = 0;
  };

  for (const point of points) {
    if (point.v === null) {
      close();
      continue;
    }
    if (open && point.t - previousT > gapMs) close();
    parts.push(
      `${open ? 'L' : 'M'}${x(point.t).toFixed(2)} ${y(point.v).toFixed(2)}`,
    );
    open = true;
    count += 1;
    previousT = point.t;
  }
  close();
  return parts.join('');
}

export function lineChart(options: ChartOptions): HTMLElement {
  const all = options.series.flatMap((s) => s.points);
  const times = all.map((p) => p.t);
  const from = options.from ?? Math.min(...times);
  const to = options.to ?? Math.max(...times);
  const span = to - from;
  const values = all.flatMap((p) => (p.v === null ? [] : [p.v]));
  const yMax = options.yMax ?? niceMax(Math.max(0, ...values));

  const x = (t: number): number =>
    span <= 0 ? WIDTH : ((t - from) / span) * WIDTH;
  const y = (v: number): number =>
    HEIGHT - Math.min(1, Math.max(0, v / yMax)) * HEIGHT;

  const gapFor = (points: readonly ChartPoint[]): number => {
    const deltas: number[] = [];
    for (let i = 1; i < points.length; i += 1) {
      const a = points[i - 1];
      const b = points[i];
      if (a !== undefined && b !== undefined) deltas.push(b.t - a.t);
    }
    return Math.max(1, median(deltas) * 3);
  };

  const chart = svgEl('svg', {
    class: 'chart-svg',
    viewBox: `0 0 ${WIDTH} ${HEIGHT}`,
    preserveAspectRatio: 'none',
    focusable: 'false',
  });
  for (const fraction of [0, 0.25, 0.5, 0.75, 1]) {
    const gy = (HEIGHT * fraction).toFixed(1);
    chart.append(
      svgEl('line', {
        class: 'gridline',
        x1: '0',
        x2: String(WIDTH),
        y1: gy,
        y2: gy,
      }),
    );
  }
  options.series.forEach((series, index) => {
    chart.append(
      svgEl('path', {
        class: `line s${index % 3}`,
        d: buildPath(series.points, x, y, gapFor(series.points)),
      }),
    );
  });

  const latest = options.series.map((series) => {
    const last = [...series.points].reverse().find((p) => p.v !== null);
    return {
      label: series.label,
      text: last?.v == null ? 'not measured' : options.format(last.v),
    };
  });
  const summary = latest.map((l) => `${l.label} ${l.text}`).join(', ');
  chart.setAttribute('role', 'img');
  chart.setAttribute('aria-label', `${options.name}. Latest: ${summary}.`);

  const figure = el('figure', {
    class: options.compact === true ? 'chart compact' : 'chart',
  });
  const frame = el('div', { class: 'chart-frame' }, chart);
  figure.append(frame);
  if (options.compact !== true) {
    const legend = el('ul', { class: 'legend' });
    options.series.forEach((series, index) => {
      const swatch = svgEl(
        'svg',
        { class: 'swatch', viewBox: '0 0 24 4', 'aria-hidden': 'true' },
        svgEl('line', {
          class: `line s${index % 3}`,
          x1: '0',
          x2: '24',
          y1: '2',
          y2: '2',
        }),
      );
      const entry = latest[index];
      legend.append(
        el('li', {}, swatch, ` ${series.label}: `, entry?.text ?? ''),
      );
    });
    figure.append(
      el(
        'figcaption',
        { id: uniqueId('chart-caption') },
        legend,
        el('span', { class: 'scale' }, `Scale 0 to ${options.format(yMax)}`),
      ),
    );
  }
  return figure;
}
