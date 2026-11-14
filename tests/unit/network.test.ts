import { describe, expect, it } from 'vitest';
import {
  collectNetwork,
  interfaceRates,
  parseNetDev,
} from '../../src/collect/network.js';
import { fixtureProcfs, readFixture } from '../helpers/fixtures.js';

const BEFORE = parseNetDev(readFixture('proc-a', 'net', 'dev'));
const AFTER = parseNetDev(readFixture('proc-b', 'net', 'dev'));

describe('parseNetDev', () => {
  it('reads both directions past the colon', () => {
    expect(BEFORE.get('eth0')).toEqual({
      name: 'eth0',
      receivedBytes: 1_000_000,
      receivedPackets: 1000,
      receiveErrors: 2,
      transmittedBytes: 500_000,
      transmittedPackets: 500,
      transmitErrors: 1,
    });
  });

  it('ignores the two header lines', () => {
    expect([...BEFORE.keys()]).toEqual(['lo', 'eth0']);
  });
});

describe('interfaceRates', () => {
  it('is the byte delta over the elapsed time', () => {
    const rates = interfaceRates(BEFORE.get('eth0'), AFTER.get('eth0')!, 1000);
    expect(rates).toEqual({ receive: 500_000, transmit: 200_000 });
  });

  it('halves when the same delta takes twice as long', () => {
    const rates = interfaceRates(BEFORE.get('eth0'), AFTER.get('eth0')!, 2000);
    expect(rates.receive).toBe(250_000);
  });

  it('reports null for the first sample', () => {
    expect(interfaceRates(undefined, AFTER.get('eth0')!, 1000)).toEqual({
      receive: null,
      transmit: null,
    });
  });

  it('reports null when a counter was reset', () => {
    const rates = interfaceRates(AFTER.get('eth0'), BEFORE.get('eth0')!, 1000);
    expect(rates).toEqual({ receive: null, transmit: null });
  });
});

describe('collectNetwork', () => {
  it('reports no rates for the first sample', async () => {
    const reading = await collectNetwork(fixtureProcfs('proc-a'), null, null);
    expect(reading.metrics.receiveBytesPerSecond).toBeNull();
    expect(reading.metrics.interfaces).toHaveLength(2);
  });

  it('excludes loopback from the totals', async () => {
    const first = await collectNetwork(fixtureProcfs('proc-a'), null, null);
    const second = await collectNetwork(
      fixtureProcfs('proc-b'),
      first.snapshot,
      1000,
    );
    // eth0 moved 500 kB; lo moved 2 kB and is not counted.
    expect(second.metrics.receiveBytesPerSecond).toBe(500_000);
    expect(second.metrics.transmitBytesPerSecond).toBe(200_000);
  });

  it('lists an interface that appeared, without inventing a rate for it', async () => {
    const first = await collectNetwork(fixtureProcfs('proc-a'), null, null);
    const second = await collectNetwork(
      fixtureProcfs('proc-b'),
      first.snapshot,
      1000,
    );
    const wlan = second.metrics.interfaces.find(
      (entry) => entry.name === 'wlan0',
    );
    expect(wlan?.receiveBytesPerSecond).toBeNull();
    expect(wlan?.receivedBytes).toBe(4096);
  });

  it('reads the link state from /sys, and says unknown without it', async () => {
    const reading = await collectNetwork(fixtureProcfs('proc-a'), null, null);
    const byName = new Map(
      reading.metrics.interfaces.map((entry) => [entry.name, entry]),
    );
    expect(byName.get('eth0')?.state).toBe('up');
    expect(byName.get('lo')?.state).toBe('unknown');
    expect(byName.get('lo')?.loopback).toBe(true);
  });
});
