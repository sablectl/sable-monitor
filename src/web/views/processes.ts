import { api } from '../api.js';
import type { ProcessSortKey, SortDirection } from '../api-types.js';
import { el, uniqueId } from '../dom.js';
import {
  formatBytes,
  formatDuration,
  formatInteger,
  formatPercent,
} from '../format.js';
import { poll } from '../poll.js';
import {
  empty,
  errorBox,
  loading,
  measured,
  note,
  panel,
  table,
  viewShell,
  type View,
} from '../ui.js';

const INTERVALS: readonly (readonly [string, number])[] = [
  ['Off', 0],
  ['2 s', 2000],
  ['5 s', 5000],
  ['10 s', 10_000],
];

const SORT_KEYS: readonly ProcessSortKey[] = [
  'cpu',
  'memory',
  'pid',
  'name',
  'uptime',
];

function isSortKey(value: string): value is ProcessSortKey {
  return (SORT_KEYS as readonly string[]).includes(value);
}

export function processesView(): View {
  let search = '';
  let sort: ProcessSortKey = 'cpu';
  let direction: SortDirection = 'desc';
  let intervalMs = 5000;
  let controller: AbortController | null = null;
  let debounce: number | undefined;

  const results = el('div', {}, loading());
  const status = el('p', { class: 'note', 'aria-live': 'polite' });

  const draw = (snapshot: Awaited<ReturnType<typeof api.processes>>): void => {
    status.textContent =
      `Showing ${snapshot.returned} of ${snapshot.total} processes, ` +
      `sampled ${new Date(snapshot.timestamp).toLocaleTimeString('en-GB')}.`;
    results.replaceChildren(
      snapshot.processes.length === 0
        ? empty('No processes match.')
        : table(
            'Processes',
            [
              { label: 'PID', numeric: true, sortKey: 'pid' },
              { label: 'Name', sortKey: 'name' },
              { label: 'State' },
              { label: 'CPU %', numeric: true, sortKey: 'cpu' },
              { label: 'Memory %', numeric: true, sortKey: 'memory' },
              { label: 'Memory', numeric: true, sortKey: 'memory' },
              { label: 'Threads', numeric: true },
              { label: 'Uptime', numeric: true, sortKey: 'uptime' },
            ],
            snapshot.processes.map((p) => [
              String(p.pid),
              p.name,
              p.state,
              measured(p.cpu, formatPercent),
              formatPercent(p.memory),
              formatBytes(p.memoryBytes),
              formatInteger(p.threads),
              measured(p.uptimeSeconds, formatDuration),
            ]),
            {
              key: sort,
              direction,
              onSort: (key) => {
                if (!isSortKey(key)) return;
                if (key === sort) {
                  direction = direction === 'asc' ? 'desc' : 'asc';
                } else {
                  sort = key;
                  direction = key === 'name' || key === 'pid' ? 'asc' : 'desc';
                }
                poller.refresh();
              },
            },
          ),
    );
  };

  const poller = poll(
    async () => {
      controller?.abort();
      const current = new AbortController();
      controller = current;
      try {
        draw(await api.processes(search, sort, direction, current.signal));
      } catch (error: unknown) {
        if (current.signal.aborted) return;
        status.textContent = '';
        results.replaceChildren(errorBox(error));
      }
    },
    () => intervalMs,
  );

  const searchId = uniqueId('search');
  const intervalId = uniqueId('interval');
  const input = el('input', {
    id: searchId,
    type: 'search',
    placeholder: 'Name or exact PID',
    autocomplete: 'off',
    spellcheck: 'false',
  });
  input.addEventListener('input', () => {
    window.clearTimeout(debounce);
    debounce = window.setTimeout(() => {
      search = input.value.trim();
      controller?.abort();
      poller.refresh();
    }, 250);
  });
  const select = el('select', { id: intervalId });
  for (const [label, ms] of INTERVALS) {
    const option = el('option', { value: String(ms) }, label);
    if (ms === intervalMs) option.selected = true;
    select.append(option);
  }
  select.addEventListener('change', () => {
    intervalMs = Number(select.value);
    poller.reschedule();
  });

  return {
    root: viewShell(
      'Processes',
      panel(
        'Process list',
        el(
          'div',
          { class: 'controls' },
          el('label', { for: searchId }, 'Search'),
          input,
          el('label', { for: intervalId }, 'Refresh'),
          select,
        ),
        note(
          'CPU is a share of one logical CPU, so a busy multi-threaded ' +
            'process can exceed 100%. It is not measured on the first read ' +
            'of a process, shown as a dash.',
        ),
        status,
        results,
      ),
    ),
    dispose: () => {
      window.clearTimeout(debounce);
      poller.stop();
      controller?.abort();
    },
  };
}
