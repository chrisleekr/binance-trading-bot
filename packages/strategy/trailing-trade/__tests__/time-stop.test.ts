// General time-stop: cuts a NON-discovery position that never reached its sell
// trigger (highSinceBuy still null) after `timeStopBars` closed candles. The
// discovery single-entry keeps its own `discoveryTimeStopBars`. evaluateSellGate
// is fed raw config (no schema parse), mirroring the live worker.

import { describe, expect, it } from 'vitest';
import { evaluateSellGate } from '../src/branches/sell-gate.js';
import type { TTConfig, TTState, TTBundle } from '../src/schema.js';
import type { TickInput } from '@app/strategy-core';

const SYMBOL_INFO = {
  symbol: 'BTCUSDT',
  baseAsset: 'BTC',
  quoteAsset: 'USDT',
  status: 'TRADING',
  filters: {
    minNotional: '10',
    tickSize: '0.01',
    stepSize: '0.0001',
    minQty: '0.0001',
    maxQty: '9000',
    minPrice: '0.01',
    maxPrice: '1000000',
  },
} as const;

const BALANCES = { BTC: { free: '1', locked: '0' }, USDT: { free: '1000', locked: '0' } };

/** `n` closed candles with closeTimeMs 1..n, all strictly after entryAtMs 0. */
const barsAfter = (n: number): unknown[] =>
  Array.from({ length: n }, (_, i) => ({
    openTimeMs: i,
    closeTimeMs: i + 1,
    open: '100',
    high: '100',
    low: '100',
    close: '100',
    volume: '1',
    isClosed: true,
  }));

const input = (
  sell: Record<string, unknown>,
  candleCount: number,
): TickInput<TTConfig, TTState, TTBundle> =>
  ({
    config: {
      sell: {
        stopLossPercentage: '',
        triggerPercentage: '',
        trailingStopPercentage: '0',
        atrTrailing: { enabled: false, period: 14, multiplier: '3' },
        discoveryTimeStopBars: 0,
        ...sell,
      },
      buy: {},
      candleInterval: '1h',
    },
    market: {
      symbol: 'BTCUSDT',
      currentPrice: '100',
      candlesByInterval: { '1h': barsAfter(candleCount) },
      symbolInfo: SYMBOL_INFO,
    },
    openOrders: [],
    bundle: { technicals: {}, override: null },
    profile: { id: 'p1' },
    account: { balances: BALANCES, readable: true },
  }) as unknown as TickInput<TTConfig, TTState, TTBundle>;

/** A held NON-discovery position with entryAtMs at 0 (so barsAfter close strictly after). */
const held = (overrides: Partial<TTState> = {}): TTState =>
  ({
    avgEntryPrice: '100',
    heldQuantity: '1',
    highSinceBuy: null,
    discoveryEntry: false,
    entryAtMs: 0,
    ...overrides,
  }) as unknown as TTState;

describe('general time-stop', () => {
  it('is inert when timeStopBars is 0 (default)', () => {
    expect(evaluateSellGate(input({ timeStopBars: 0 }, 5), held()).kind).toBe('noop');
  });

  it('is inert when the field is absent (raw pre-feature config)', () => {
    expect(evaluateSellGate(input({}, 5), held()).kind).toBe('noop');
  });

  it('does not fire before enough closed candles elapse', () => {
    expect(evaluateSellGate(input({ timeStopBars: 5 }, 3), held()).kind).toBe('noop');
  });

  it('market-sells once timeStopBars closed candles elapse (reason time-stop)', () => {
    const out = evaluateSellGate(input({ timeStopBars: 3 }, 3), held());
    expect(out.kind).toBe('emit');
    if (out.kind !== 'emit') throw new Error('expected emit');
    expect(out.metricName).toBe('tt_time_stop_emit');
  });

  it('does NOT fire once the profit trail has armed (highSinceBuy set)', () => {
    // A position that reached the sell trigger is managed by the trail, not the
    // time-stop — even after the bar count elapses.
    const out = evaluateSellGate(input({ timeStopBars: 3 }, 5), held({ highSinceBuy: '110' }));
    expect(out.kind).toBe('noop');
  });

  it('does NOT apply to a discovery entry (that path uses discoveryTimeStopBars)', () => {
    // discoveryEntry true + timeStopBars set but discoveryTimeStopBars 0 → neither
    // time-stop fires; the general branch is gated on discoveryEntry !== true.
    const out = evaluateSellGate(
      input({ timeStopBars: 3, discoveryTimeStopBars: 0 }, 5),
      held({ discoveryEntry: true }),
    );
    expect(out.kind).toBe('noop');
  });

  it('does not fire when entryAtMs is null (entry time unknown, fail-safe)', () => {
    const out = evaluateSellGate(input({ timeStopBars: 3 }, 5), held({ entryAtMs: null }));
    expect(out.kind).toBe('noop');
  });
});
