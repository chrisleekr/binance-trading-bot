// The exit blocker must name the rung the ladder ACTUALLY stopped at, using the
// thresholds the ladder itself computed. These tests drive evaluateSellGate with
// raw config (no schema parse), the way the live worker does, and read the
// blocker off the result rather than re-deriving anything.

import { describe, expect, it } from 'vitest';
import type { TickInput } from '@app/strategy-core';

import { evaluateSellGate } from '../src/branches/sell-gate.js';
import type { TTConfig, TTState, TTBundle } from '../src/schema.js';

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

const candle = (close: string, high = close, low = '99') => ({
  openTimeMs: 0,
  closeTimeMs: 1,
  open: '100',
  high,
  low,
  close,
  volume: '1',
  isClosed: true,
});

const input = (
  sell: Record<string, unknown>,
  currentPrice = '100',
  candlesByInterval: Record<string, unknown> = { '1h': [candle('100')] },
  balances: Record<string, unknown> = BALANCES,
): TickInput<TTConfig, TTState, TTBundle> =>
  ({
    config: {
      sell: {
        enabled: true,
        stopLossPercentage: '',
        triggerPercentage: '',
        trailingStopPercentage: '0',
        atrTrailing: { enabled: false, period: 14, multiplier: '3' },
        timeStopBars: 0,
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
    account: { balances, readable: true },
  }) as unknown as TickInput<TTConfig, TTState, TTBundle>;

const held = (overrides: Partial<TTState> = {}): TTState =>
  ({
    avgEntryPrice: '100',
    heldQuantity: '1',
    highSinceBuy: null,
    breakEvenArmed: false,
    ...overrides,
  }) as unknown as TTState;

const blockerOf = (out: ReturnType<typeof evaluateSellGate>) =>
  out.kind === 'emit' ? null : out.blocker;

describe('evaluateSellGate — the blocker names the rung that held the position', () => {
  it('reports the sell arm, not the stop-loss, while the trail is unarmed', () => {
    // The defect this record exists for: a position 5% below its arm ticks
    // forever, and the only rung anyone could see was the hard stop far below.
    const out = evaluateSellGate(
      input({
        stopLossPercentage: '0.9',
        triggerPercentage: '1.05',
        trailingStopPercentage: '0.98',
      }),
      held(),
    );
    expect(blockerOf(out)).toEqual({
      reason: 'awaiting-sell-arm',
      changeKey: 'awaiting-sell-arm|armPrice=105',
      detail: { armPrice: '105', currentPrice: '100', hasDownsideExit: true },
    });
  });

  it('reports the armed fixed trail once a high exists', () => {
    const out = evaluateSellGate(
      input({ triggerPercentage: '1.05', trailingStopPercentage: '0.9' }, '110'),
      held({ highSinceBuy: '120' }),
    );
    expect(blockerOf(out)).toEqual({
      reason: 'trail-above-price',
      changeKey: 'trail-above-price|trailPrice=108|highSinceBuy=120',
      detail: {
        trailPrice: '108',
        highSinceBuy: '120',
        currentPrice: '110',
        hasDownsideExit: false,
      },
    });
  });

  it('reports the raised high on the tick that ratchets it, not a lower rung', () => {
    // The trail level for the NEW high is computed by a rung this tick never
    // reaches, so naming the stop-loss here would point at the wrong price.
    const out = evaluateSellGate(
      input(
        { stopLossPercentage: '0.9', triggerPercentage: '1.05', trailingStopPercentage: '0.98' },
        '106',
        { '1h': [candle('106')] },
      ),
      held(),
    );
    expect(out.kind).toBe('bump-high');
    expect(blockerOf(out)).toEqual({
      reason: 'trail-high-raised',
      changeKey: 'trail-high-raised|highSinceBuy=106',
      detail: { highSinceBuy: '106', currentPrice: '106', hasDownsideExit: true },
    });
  });

  it('reports the break-even floor on the tick that arms it', () => {
    const out = evaluateSellGate(
      input(
        { breakEven: { enabled: true, armAtPercentage: '1.01', floorPercentage: '1' } },
        '101',
        { '1h': [candle('101')] },
      ),
      held(),
    );
    expect(out.kind).toBe('bump-high');
    expect(blockerOf(out)).toEqual({
      reason: 'break-even-floor-not-hit',
      changeKey: 'break-even-floor-not-hit|floorPrice=100',
      detail: { floorPrice: '100', currentPrice: '101', hasDownsideExit: true },
    });
  });

  it('names no floor when a corrupted sub-entry floor disarmed that rung', () => {
    // floorPercentage < 1 would sell at a LOSS under the break-even label, so
    // the branch refuses the level — and the blocker must not invent one.
    const out = evaluateSellGate(
      input(
        { breakEven: { enabled: true, armAtPercentage: '1.01', floorPercentage: '0.9' } },
        '101',
        { '1h': [candle('101')] },
      ),
      held(),
    );
    expect(out.kind).toBe('bump-high');
    expect(blockerOf(out)?.reason).toBe('no-exit-configured');
  });

  it('reports the pending break-even arm while the gain is short of it', () => {
    const out = evaluateSellGate(
      input({ breakEven: { enabled: true, armAtPercentage: '1.01', floorPercentage: '1' } }),
      held(),
    );
    expect(blockerOf(out)).toEqual({
      reason: 'break-even-not-armed',
      changeKey: 'break-even-not-armed|armPrice=101',
      detail: { armPrice: '101', currentPrice: '100', hasDownsideExit: true },
    });
  });

  it('reports the stop-loss when it is the only rung standing', () => {
    const out = evaluateSellGate(input({ stopLossPercentage: '0.9' }), held());
    expect(blockerOf(out)).toEqual({
      reason: 'stop-loss-not-hit',
      changeKey: 'stop-loss-not-hit|stopPrice=90',
      detail: { stopPrice: '90', currentPrice: '100', hasDownsideExit: true },
    });
  });

  it('skips the stop-loss rung when the stored percentage is out of bounds', () => {
    // A raw row above 1 would put the "stop" ABOVE the entry; the branch ignores
    // it, so the blocker must not report a stop the gate will never fire.
    const out = evaluateSellGate(input({ stopLossPercentage: '1.5' }), held());
    expect(blockerOf(out)?.reason).toBe('no-exit-configured');
  });

  it('skips the fixed trail rung when the stored percentage is out of bounds', () => {
    const out = evaluateSellGate(
      input({ trailingStopPercentage: '1.5' }, '110'),
      held({ highSinceBuy: '120' }),
    );
    expect(blockerOf(out)?.reason).toBe('no-exit-configured');
  });

  it('reports the time stop with its bar counts', () => {
    const out = evaluateSellGate(
      input({ timeStopBars: 8 }, '100', { '1h': [candle('100'), candle('100')] }),
      held({ entryAtMs: 0 }),
    );
    expect(blockerOf(out)).toEqual({
      reason: 'time-stop-pending',
      changeKey: 'time-stop-pending|closedBars=2|requiredBars=8',
      detail: { closedBars: 2, requiredBars: 8, currentPrice: '100', hasDownsideExit: true },
    });
  });

  it('reports a rung that fired but could not be sized as unsellable', () => {
    // The loudest case: the exit triggered and the position is stuck.
    const out = evaluateSellGate(
      input({ stopLossPercentage: '0.9' }, '80', { '1h': [candle('100')] }, {}),
      held({ heldQuantity: '0' }),
    );
    expect(blockerOf(out)?.reason).toBe('exit-unsellable');
  });

  it('reports a corrupted threshold as a dead rung, not as a level', () => {
    const out = evaluateSellGate(
      input({ trailingStopPercentage: '0.98' }, '110'),
      held({ highSinceBuy: 'corrupt' }),
    );
    expect(blockerOf(out)).toEqual({
      reason: 'exit-config-invalid',
      changeKey: 'exit-config-invalid|field=highSinceBuy',
      detail: { field: 'highSinceBuy', currentPrice: '110', hasDownsideExit: false },
    });
  });

  it('names a corrupt stop-loss as a dead rung, not as nothing configured', () => {
    // The field IS present, so `hasDownsideExit` is true; reporting
    // `no-exit-configured` here would contradict that on the same record and
    // read as a soft "nothing set up" instead of an invalid config.
    const out = evaluateSellGate(input({ stopLossPercentage: 'not-a-number' }), held());
    expect(blockerOf(out)).toEqual({
      reason: 'exit-config-invalid',
      changeKey: 'exit-config-invalid|field=stopLossPercentage',
      detail: { field: 'stopLossPercentage', currentPrice: '100', hasDownsideExit: true },
    });
  });

  it('names the corrupt break-even floor when that is the rung that died', () => {
    const out = evaluateSellGate(
      input({ breakEven: { enabled: true, armAtPercentage: '1.01', floorPercentage: 'oops' } }),
      held(),
    );
    expect(blockerOf(out)?.reason).toBe('exit-config-invalid');
    expect(blockerOf(out)?.detail?.['field']).toBe('breakEven.floorPercentage');
  });

  it('leaves the blocker null when a rung actually fires', () => {
    const out = evaluateSellGate(input({ stopLossPercentage: '0.9' }, '80'), held());
    expect(out.kind).toBe('emit');
    expect(blockerOf(out)).toBeNull();
  });
});
