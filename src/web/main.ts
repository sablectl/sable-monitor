import {
  connectionEvents,
  sampleEvents,
  setRefresh,
  state,
  type ConnectionState,
} from './store.js';
import { startStream } from './stream.js';
import type { View } from './ui.js';
import { alertsView } from './views/alerts.js';
import { cpuView } from './views/cpu.js';
import { diskView } from './views/disk.js';
import { memoryView } from './views/memory.js';
import { networkView } from './views/network.js';
import { overviewView } from './views/overview.js';
import { processesView } from './views/processes.js';
import { systemView } from './views/system.js';

interface Route {
  readonly id: string;
  readonly title: string;
  readonly build: () => View;
}

const ROUTES: readonly Route[] = [
  { id: 'overview', title: 'Overview', build: overviewView },
  { id: 'cpu', title: 'CPU', build: cpuView },
  { id: 'memory', title: 'Memory', build: memoryView },
  { id: 'disk', title: 'Disk', build: diskView },
  { id: 'network', title: 'Network', build: networkView },
  { id: 'processes', title: 'Processes', build: processesView },
  { id: 'alerts', title: 'Alerts', build: alertsView },
  { id: 'system', title: 'System', build: systemView },
];

const STATUS_TEXT: Readonly<Record<ConnectionState, string>> = {
  connecting: 'Connecting',
  live: 'Live',
  reconnecting: 'Reconnecting',
};

function required<T extends HTMLElement>(id: string, type: new () => T): T {
  const node = document.getElementById(id);
  if (!(node instanceof type)) throw new Error(`Missing element #${id}`);
  return node;
}

const main = required('main', HTMLElement);
const nav = required('nav-list', HTMLElement);
const statusText = required('connection-text', HTMLElement);
const statusBox = required('connection', HTMLElement);
const refresh = required('refresh', HTMLSelectElement);

let current: View | null = null;
let currentId = '';
let firstRender = true;

function routeFromHash(): Route {
  const id = window.location.hash.replace(/^#\/?/, '');
  return ROUTES.find((r) => r.id === id) ?? ROUTES[0] ?? fallback();
}

function fallback(): never {
  throw new Error('No routes defined');
}

function renderNav(active: string): void {
  nav.replaceChildren(
    ...ROUTES.map((route) => {
      const item = document.createElement('li');
      const link = document.createElement('a');
      link.href = `#/${route.id}`;
      link.textContent = route.title;
      if (route.id === active) link.setAttribute('aria-current', 'page');
      item.append(link);
      return item;
    }),
  );
}

function render(): void {
  const route = routeFromHash();
  if (route.id === currentId) return;
  current?.dispose?.();
  currentId = route.id;
  current = route.build();
  main.replaceChildren(current.root);
  renderNav(route.id);
  document.title = `${route.title} - Sable Monitor`;
  if (!firstRender) {
    const heading = main.querySelector<HTMLElement>('h1');
    heading?.focus();
  }
  firstRender = false;
}

function renderStatus(connection: ConnectionState): void {
  statusText.textContent = STATUS_TEXT[connection];
  statusBox.dataset['state'] = connection;
}

window.addEventListener('hashchange', render);
connectionEvents.on(renderStatus);
sampleEvents.on((sample) => {
  current?.sample?.(sample);
});

refresh.value = String(state.refreshMs);
refresh.addEventListener('change', () => {
  setRefresh(Number(refresh.value));
});

renderStatus(state.connection);
render();
startStream();
