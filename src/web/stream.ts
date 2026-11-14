import { api } from './api.js';
import type { AlertEvent, MetricsSample } from './api-types.js';
import { alertEvents, pushSample, setConnection } from './store.js';

const MIN_DELAY_MS = 1000;
const MAX_DELAY_MS = 30_000;

function parse(event: Event): unknown {
  if (!(event instanceof MessageEvent) || typeof event.data !== 'string') {
    return null;
  }
  try {
    return JSON.parse(event.data) as unknown;
  } catch {
    return null;
  }
}

function isObject(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null;
}

/**
 * Opens the event stream and keeps it open. The browser retries by itself
 * after a drop, but it gives up for good on some failures, so a closed
 * source is reopened here with a growing delay.
 */
export function startStream(): void {
  let delay = MIN_DELAY_MS;
  let timer: number | undefined;

  // The stream only sends samples as they are taken, so the first chart
  // would otherwise sit empty for a whole interval.
  api.current().then(pushSample, () => {
    // A 503 before the first sample is expected; the stream will follow.
  });

  const open = (): void => {
    const source = new EventSource('/api/stream');

    source.onopen = () => {
      delay = MIN_DELAY_MS;
      setConnection('live');
    };

    source.addEventListener('metrics', (event) => {
      const data = parse(event);
      if (isObject(data) && typeof data['timestamp'] === 'number') {
        pushSample(data as unknown as MetricsSample);
      }
    });

    source.addEventListener('alert', (event) => {
      const data = parse(event);
      if (isObject(data) && isObject(data['alert'])) {
        alertEvents.emit(data as unknown as AlertEvent);
      }
    });

    source.onerror = () => {
      setConnection('reconnecting');
      if (source.readyState !== EventSource.CLOSED) return;
      source.close();
      window.clearTimeout(timer);
      timer = window.setTimeout(open, delay);
      delay = Math.min(delay * 2, MAX_DELAY_MS);
    };
  };

  open();
}
