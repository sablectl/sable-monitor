import { describeError } from './api.js';
import { el, svgEl, uniqueId, type Child } from './dom.js';
import type { MetricsSample } from './api-types.js';
import { samples } from './store.js';

export interface View {
  readonly root: HTMLElement;
  readonly sample?: (sample: MetricsSample) => void;
  readonly dispose?: () => void;
}

export const NOT_MEASURED = 'not measured';

/** An em dash for a value that could not be measured, never a zero. */
export function measured(
  value: number | null | undefined,
  format: (value: number) => string,
): HTMLElement {
  if (value === null || value === undefined) {
    return el(
      'span',
      { class: 'null', title: NOT_MEASURED, 'aria-label': NOT_MEASURED },
      '\u2014',
    );
  }
  return el('span', {}, format(value));
}

export function optionalText(value: string | null): HTMLElement {
  if (value === null || value === '') return measured(null, String);
  return el('span', {}, value);
}

export function panel(title: string, ...children: Child[]): HTMLElement {
  const id = uniqueId('panel');
  return el(
    'section',
    { class: 'panel', 'aria-labelledby': id },
    el('h2', { class: 'label', id }, title),
    ...children,
  );
}

export function viewShell(title: string, ...children: Child[]): HTMLElement {
  return el(
    'div',
    { class: 'view' },
    el('h1', { class: 'view-title', tabindex: '-1' }, title),
    ...children,
  );
}

export function note(text: string): HTMLElement {
  return el('p', { class: 'note' }, text);
}

export function loading(text = 'Loading'): HTMLElement {
  return el('p', { class: 'state', role: 'status' }, `${text}\u2026`);
}

export function errorBox(error: unknown): HTMLElement {
  return el(
    'p',
    { class: 'state error', role: 'alert' },
    'Error: ',
    describeError(error),
  );
}

export function empty(text: string): HTMLElement {
  return el('p', { class: 'state' }, text);
}

export function stat(
  label: string,
  value: Child,
  detail?: Child,
  extra?: Child,
): HTMLElement {
  return el(
    'div',
    { class: 'stat' },
    el('div', { class: 'label' }, label),
    el('div', { class: 'stat-value' }, value),
    detail === undefined ? null : el('div', { class: 'stat-detail' }, detail),
    extra,
  );
}

export function kv(rows: readonly (readonly [string, Child])[]): HTMLElement {
  const list = el('dl', { class: 'kv' });
  for (const [label, value] of rows) {
    list.append(el('dt', {}, label), el('dd', {}, value));
  }
  return list;
}

/** A bar drawn as SVG so that no inline style is needed. */
export function bar(percent: number | null): HTMLElement {
  const known = percent !== null;
  const width = known ? Math.min(100, Math.max(0, percent)) : 0;
  const graphic = svgEl(
    'svg',
    {
      class: 'bar',
      viewBox: '0 0 100 1',
      preserveAspectRatio: 'none',
      role: 'img',
      'aria-label': known ? `${percent.toFixed(1)} per cent` : NOT_MEASURED,
    },
    svgEl('rect', {
      class: 'bar-fill',
      x: '0',
      y: '0',
      width: String(width),
      height: '1',
    }),
  );
  return el('span', { class: 'bar-wrap' }, graphic);
}

export interface Column {
  readonly label: string;
  readonly numeric?: boolean;
  readonly sortKey?: string;
}

export interface SortState {
  readonly key: string;
  readonly direction: 'asc' | 'desc';
  readonly onSort: (key: string) => void;
}

export function table(
  caption: string,
  columns: readonly Column[],
  rows: readonly (readonly Child[])[],
  sort?: SortState,
): HTMLElement {
  const head = el('tr');
  for (const column of columns) {
    const attrs: Record<string, string> = { scope: 'col' };
    if (column.numeric === true) attrs['class'] = 'num';
    const key = column.sortKey;
    if (sort !== undefined && key !== undefined) {
      const active = sort.key === key;
      attrs['aria-sort'] = active
        ? sort.direction === 'asc'
          ? 'ascending'
          : 'descending'
        : 'none';
      const button = el(
        'button',
        { type: 'button', class: 'sort' },
        column.label,
        active ? (sort.direction === 'asc' ? ' \u25B2' : ' \u25BC') : null,
      );
      button.addEventListener('click', () => {
        sort.onSort(key);
      });
      head.append(el('th', attrs, button));
    } else {
      head.append(el('th', attrs, column.label));
    }
  }
  const body = el('tbody');
  for (const row of rows) {
    const tr = el('tr');
    row.forEach((cell, index) => {
      const numeric = columns[index]?.numeric === true;
      tr.append(el('td', numeric ? { class: 'num' } : {}, cell));
    });
    body.append(tr);
  }
  return el(
    'div',
    { class: 'table-wrap' },
    el('table', {}, el('caption', {}, caption), el('thead', {}, head), body),
  );
}

/**
 * A container that is redrawn from the latest sample. Until one arrives it
 * says so rather than showing empty values.
 */
export function liveSection(draw: (latest: MetricsSample) => Child[]): {
  readonly box: HTMLElement;
  readonly update: () => void;
} {
  const box = el('div', { class: 'live' });
  const update = (): void => {
    const latest = samples.at(-1);
    box.replaceChildren(
      ...(latest === undefined
        ? [loading('Waiting for the first sample')]
        : draw(latest).flatMap((c) =>
            c === null || c === undefined || c === false
              ? []
              : [
                  typeof c === 'object'
                    ? c
                    : document.createTextNode(String(c)),
                ],
          )),
    );
  };
  update();
  return { box, update };
}
