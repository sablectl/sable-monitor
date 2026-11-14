import type { AlertEvent, MetricsSample } from './api-types.js';

export type ConnectionState = 'connecting' | 'live' | 'reconnecting';

export const SAMPLE_CAP = 900;

type Listener<T> = (value: T) => void;

export class Emitter<T> {
  private readonly listeners = new Set<Listener<T>>();

  on(listener: Listener<T>): () => void {
    this.listeners.add(listener);
    return () => {
      this.listeners.delete(listener);
    };
  }

  emit(value: T): void {
    for (const listener of [...this.listeners]) listener(value);
  }
}

/** Oldest first. Capped so a tab left open for days does not grow. */
export const samples: MetricsSample[] = [];

export const state: { connection: ConnectionState; refreshMs: number } = {
  connection: 'connecting',
  refreshMs: 15_000,
};

export const sampleEvents = new Emitter<MetricsSample>();
export const alertEvents = new Emitter<AlertEvent>();
export const connectionEvents = new Emitter<ConnectionState>();
export const settingsEvents = new Emitter<number>();

export function pushSample(sample: MetricsSample): void {
  const last = samples.at(-1);
  if (last !== undefined && last.timestamp >= sample.timestamp) return;
  samples.push(sample);
  if (samples.length > SAMPLE_CAP)
    samples.splice(0, samples.length - SAMPLE_CAP);
  sampleEvents.emit(sample);
}

export function setConnection(next: ConnectionState): void {
  if (state.connection === next) return;
  state.connection = next;
  connectionEvents.emit(next);
}

export function setRefresh(ms: number): void {
  state.refreshMs = ms;
  settingsEvents.emit(ms);
}
