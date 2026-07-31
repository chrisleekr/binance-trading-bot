// The live worker hands evaluateSellGate the raw stored config (no schema
// parse), so a corrupted decimal field can reach the gate. Each parse failure
// must surface a typed `tt-sell-gate-parse-failed` warn and skip rather than
// crash the tick. Inputs are cast to model that unvalidated arrival.

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

const input = (
  sell: Record<string, unknown>,
  currentPrice = '100',
  candlesByInterval: Record<string, unknown> = {},
): TickInput<TTConfig, TTState, TTBundle> =>
  ({
    // atrTrailing.enabled=false keeps the ATR branch inert so the fixed-%
    // trailing path is reached; mirrors a schema-shaped sell block.
    config: {
      sell: {
        atrTrailing: { enabled: false, period: 14, multiplier: '3' },
        discoveryTimeStopBars: 0,
        ...sell,
      },
      buy: {},
      candleInterval: '1h',
    },
    market: { symbol: 'BTCUSDT', currentPrice, candlesByInterval, symbolInfo: SYMBOL_INFO },
    openOrders: [],
    bundle: { technicals: {}, override: null },
    profile: { id: 'p1' },
    account: { balances: {}, readable: true },
  }) as unknown as TickInput<TTConfig, TTState, TTBundle>;

const candle = (high: string, low = '99', close = '100') => ({
  openTimeMs: 0,
  closeTimeMs: 1,
  open: '100',
  high,
  low,
  close,
  volume: '1',
  isClosed: true,
});

const heldState = (overrides: Partial<TTState> = {}): TTState =>
  ({ avgEntryPrice: '100', highSinceBuy: null, ...overrides }) as unknown as TTState;

const parseFailField = (out: ReturnType<typeof evaluateSellGate>): string | undefined => {
  if (out.kind !== 'skip') return undefined;
  return out.log.context?.['field'] as string | undefined;
};

describe('evaluateSellGate — parse-failure skips', () => {
  it('skips with a warn when currentPrice is unparseable (avgEntryPrice valid)', () => {
    const out = evaluateSellGate(
      input({ stopLossPercentage: '', triggerPercentage: '' }, 'bad'),
      heldState(),
    );
    expect(out.kind).toBe('skip');
    if (out.kind !== 'skip') throw new Error('expected skip');
    expect(out.log.message).toBe('tt-sell-gate-parse-failed');
  });

  it('skips with a warn when the stored avgEntryPrice itself is unparseable', () => {
    // avgEntryPrice is parsed before currentPrice, so a corrupted held cost
    // basis surfaces the warn on the first parse — the path a valid current
    // price would otherwise skip past.
    const out = evaluateSellGate(
      input({ stopLossPercentage: '', triggerPercentage: '' }, '100'),
      heldState({ avgEntryPrice: 'corrupt' }),
    );
    expect(out.kind).toBe('skip');
    if (out.kind !== 'skip') throw new Error('expected skip');
    expect(out.log.message).toBe('tt-sell-gate-parse-failed');
    expect(out.log.context?.['avgEntryPrice']).toBe('corrupt');
  });

  it('skips with a warn on a corrupted stopLossPercentage', () => {
    const out = evaluateSellGate(
      input({ stopLossPercentage: 'abc', triggerPercentage: '' }),
      heldState(),
    );
    expect(parseFailField(out)).toBe('stopLossPercentage');
  });

  it('skips with a warn on a corrupted triggerPercentage', () => {
    const out = evaluateSellGate(
      input({ stopLossPercentage: '', triggerPercentage: 'abc' }),
      heldState(),
    );
    expect(parseFailField(out)).toBe('triggerPercentage');
  });

  it('skips with a warn when highSinceBuy is corrupted and a trailing stop is armed', () => {
    const out = evaluateSellGate(
      input({ stopLossPercentage: '', triggerPercentage: '', trailingStopPercentage: '0.98' }),
      heldState({ highSinceBuy: 'corrupt' }),
    );
    expect(parseFailField(out)).toBe('highSinceBuy');
  });

  it('skips with a warn on a corrupted trailingStopPercentage', () => {
    const out = evaluateSellGate(
      input({ stopLossPercentage: '', triggerPercentage: '', trailingStopPercentage: 'abc' }),
      heldState({ highSinceBuy: '120' }),
    );
    expect(parseFailField(out)).toBe('trailingStopPercentage');
  });
});

describe('evaluateSellGate — ATR / discovery-time-stop candle absence', () => {
  it('falls through cleanly when ATR is armed but the interval has no candles', () => {
    // ATR enabled, highSinceBuy set, but no candles for the interval → computeAtr
    // returns null (the ?? [] default), so the gate falls back to the fixed-%
    // trail without throwing.
    const out = evaluateSellGate(
      input({
        stopLossPercentage: '',
        triggerPercentage: '',
        trailingStopPercentage: '0',
        atrTrailing: { enabled: true, period: 14, multiplier: '3' },
      }),
      heldState({ highSinceBuy: '120' }),
    );
    expect(out.kind).toBe('noop');
  });

  it('falls through cleanly when ATR computation throws on a malformed candle', () => {
    // 16 closed candles (≥ period+1) so the length guard passes, but one carries
    // a non-numeric high so atr() throws and computeAtr returns null.
    const candles = Array.from({ length: 16 }, (_, i) => candle(i === 5 ? 'corrupt' : '101'));
    const out = evaluateSellGate(
      input(
        {
          stopLossPercentage: '',
          triggerPercentage: '',
          trailingStopPercentage: '0',
          atrTrailing: { enabled: true, period: 14, multiplier: '3' },
        },
        '100',
        { '1h': candles },
      ),
      heldState({ highSinceBuy: '120' }),
    );
    expect(out.kind).toBe('noop');
  });

  it('handles a discovery time-stop with no candles for the interval (?? [] default)', () => {
    const out = evaluateSellGate(
      input({
        stopLossPercentage: '',
        triggerPercentage: '',
        trailingStopPercentage: '0',
        discoveryTimeStopBars: 3,
      }),
      heldState({ highSinceBuy: null, discoveryEntry: true, entryAtMs: 0 } as Partial<TTState>),
    );
    expect(out.kind).toBe('noop');
  });
});

describe('evaluateSellGate — non-sellable preconditions', () => {
  it('noops when there is no position (avgEntryPrice null)', () => {
    const out = evaluateSellGate(
      input({ stopLossPercentage: '', triggerPercentage: '' }),
      heldState({ avgEntryPrice: null } as Partial<TTState>),
    );
    expect(out.kind).toBe('noop');
  });

  it('noops when avgEntryPrice or current price is non-positive', () => {
    const out = evaluateSellGate(
      input({ stopLossPercentage: '', triggerPercentage: '' }, '0'),
      heldState(),
    );
    expect(out.kind).toBe('noop');
  });
});
