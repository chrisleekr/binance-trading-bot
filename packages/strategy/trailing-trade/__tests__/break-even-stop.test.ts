// Break-even stop: between the hard stop-loss and the profit trail. Arms a
// sticky floor once a CLOSED candle confirms a gain of armAtPercentage; while
// armed and before the profit trail takes over, a retrace to floorPercentage
// (1 = entry) market-sells near break-even. evaluateSellGate is fed raw config
// (no schema parse), mirroring the live worker.

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

// Held BTC so a break-even / stop emit can actually size a sell.
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
): TickInput<TTConfig, TTState, TTBundle> =>
  ({
    config: {
      sell: {
        // Inert defaults so each test isolates the break-even branch: the hard
        // stop-loss, profit trigger, fixed trail and ATR are all off unless the
        // test turns one on.
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
    market: { symbol: 'BTCUSDT', currentPrice, candlesByInterval, symbolInfo: SYMBOL_INFO },
    openOrders: [],
    bundle: { technicals: {}, override: null },
    profile: { id: 'p1' },
    account: { balances: BALANCES, readable: true },
  }) as unknown as TickInput<TTConfig, TTState, TTBundle>;

const held = (overrides: Partial<TTState> = {}): TTState =>
  ({
    avgEntryPrice: '100',
    heldQuantity: '1',
    highSinceBuy: null,
    breakEvenArmed: false,
    ...overrides,
  }) as unknown as TTState;

const BE_ON = { breakEven: { enabled: true, armAtPercentage: '1.01', floorPercentage: '1' } };

describe('break-even stop — off / absent', () => {
  it('noops when no breakEven block is present (raw pre-feature config)', () => {
    // The whole branch must tolerate a missing breakEven object (old stored row)
    // rather than crash on `.enabled`.
    const out = evaluateSellGate(input({}), held());
    expect(out.kind).toBe('noop');
  });

  it('noops when breakEven is explicitly disabled', () => {
    const out = evaluateSellGate(
      input({ breakEven: { enabled: false, armAtPercentage: '1.01', floorPercentage: '1' } }),
      held(),
    );
    expect(out.kind).toBe('noop');
  });
});

describe('break-even stop — arming', () => {
  it('arms once a closed candle confirms the gain (bump-high sets breakEvenArmed)', () => {
    // lbp 100, armAt 1.01 → arm threshold 101. Closed candle closes at 101.
    const out = evaluateSellGate(input(BE_ON, '101', { '1h': [candle('101')] }), held());
    expect(out.kind).toBe('bump-high');
    if (out.kind !== 'bump-high') throw new Error('expected bump-high');
    expect(out.state.breakEvenArmed).toBe(true);
    // Arming the break-even floor must NOT also arm the profit trail.
    expect(out.state.highSinceBuy).toBeNull();
  });

  it('does not arm on a live wick when the closed candle is below the threshold', () => {
    // Live price spikes to 102 (>= 101) but the closed candle closes at 100
    // (< 101): arming reads the closed close, so the wick cannot arm it.
    const out = evaluateSellGate(input(BE_ON, '102', { '1h': [candle('100', '102')] }), held());
    expect(out.kind).toBe('noop');
  });

  it('does not re-arm once already armed (no spurious bump-high)', () => {
    // Already armed, price above the floor: falls through to a clean noop, no
    // second arm emission.
    const out = evaluateSellGate(
      input(BE_ON, '100.5', { '1h': [candle('100.5')] }),
      held({ breakEvenArmed: true }),
    );
    expect(out.kind).toBe('noop');
  });
});

describe('break-even stop — exit at the floor', () => {
  it('market-sells at the floor once armed (reason break-even-stop)', () => {
    // Armed, floor 1 = entry 100, live price retraces to 100.
    const out = evaluateSellGate(input(BE_ON, '100'), held({ breakEvenArmed: true }));
    expect(out.kind).toBe('emit');
    if (out.kind !== 'emit') throw new Error('expected emit');
    expect(out.metricName).toBe('tt_break_even_stop_emit');
  });

  it('locks in a positive floor above entry (floorPercentage > 1)', () => {
    // floor 1.002 → exit at 100.2. Price at 100.1 is below the floor → sell.
    const out = evaluateSellGate(
      input(
        { breakEven: { enabled: true, armAtPercentage: '1.01', floorPercentage: '1.002' } },
        '100.1',
      ),
      held({ breakEvenArmed: true }),
    );
    expect(out.kind).toBe('emit');
    if (out.kind !== 'emit') throw new Error('expected emit');
    expect(out.metricName).toBe('tt_break_even_stop_emit');
  });

  it('does not sell while armed but still above the floor', () => {
    const out = evaluateSellGate(input(BE_ON, '100.5'), held({ breakEvenArmed: true }));
    expect(out.kind).toBe('noop');
  });
});

describe('break-even stop — raw-config guards (worker ticks unparsed config)', () => {
  it('does not arm when armAtPercentage is not above 1 (raw "1")', () => {
    // The worker ticks raw stored config; a hand-edited armAtPercentage of '1'
    // parses fine but must not arm (arming below/at entry is meaningless).
    const out = evaluateSellGate(
      input({ breakEven: { enabled: true, armAtPercentage: '1', floorPercentage: '1' } }, '105', {
        '1h': [candle('105')],
      }),
      held(),
    );
    expect(out.kind).toBe('noop');
  });

  it('never sells below entry even if floorPercentage is a corrupted sub-1 value', () => {
    // Schema forbids floor < 1, but the worker ticks raw config. A sub-1 floor
    // must NOT market-sell at a loss under the break-even label — that is the
    // hard stop-loss's job. The break-even floor goes inert (falls through).
    const out = evaluateSellGate(
      input(
        { breakEven: { enabled: true, armAtPercentage: '1.01', floorPercentage: '0.95' } },
        '96',
      ),
      held({ breakEvenArmed: true }),
    );
    expect(out.kind).toBe('noop');
  });
});

describe('break-even stop — precedence and handoff', () => {
  it('the hard stop-loss still wins when both would fire', () => {
    // Price 96 is below the stop (97) AND the break-even floor (100). Stop-loss
    // is evaluated first, so the exit books as grid-stop-loss, not break-even.
    const out = evaluateSellGate(
      input({ ...BE_ON, stopLossPercentage: '0.97' }, '96'),
      held({ breakEvenArmed: true }),
    );
    expect(out.kind).toBe('emit');
    if (out.kind !== 'emit') throw new Error('expected emit');
    expect(out.metricName).toBe('tt_grid_stop_loss_emit');
  });

  it('the profit trail takes over once armed (break-even goes inert)', () => {
    // highSinceBuy set means the profit trail owns the position. Even though the
    // break-even floor (100) is breached at price 100, the break-even exit is
    // gated off; the fixed trail (high 120 × 0.98 = 117.6) fires instead.
    const out = evaluateSellGate(
      input({ ...BE_ON, trailingStopPercentage: '0.98' }, '100'),
      held({ breakEvenArmed: true, highSinceBuy: '120' }),
    );
    expect(out.kind).toBe('emit');
    if (out.kind !== 'emit') throw new Error('expected emit');
    // The fixed trail emits reason 'grid-sell' (metric derives from the reason,
    // not the message prefix); the key point is it is NOT a break-even exit.
    expect(out.metricName).toBe('tt_grid_sell_emit');
  });
});

describe('break-even stop — parse-failure skips', () => {
  it('skips with a warn on a corrupted floorPercentage', () => {
    const out = evaluateSellGate(
      input({ breakEven: { enabled: true, armAtPercentage: '1.01', floorPercentage: 'abc' } }),
      held({ breakEvenArmed: true }),
    );
    expect(out.kind).toBe('skip');
    if (out.kind !== 'skip') throw new Error('expected skip');
    expect(out.log.context?.['field']).toBe('breakEven.floorPercentage');
  });

  it('skips with a warn on a corrupted armAtPercentage (not yet armed)', () => {
    const out = evaluateSellGate(
      input({ breakEven: { enabled: true, armAtPercentage: 'abc', floorPercentage: '1' } }),
      held(),
    );
    expect(out.kind).toBe('skip');
    if (out.kind !== 'skip') throw new Error('expected skip');
    expect(out.log.context?.['field']).toBe('breakEven.armAtPercentage');
  });
});
