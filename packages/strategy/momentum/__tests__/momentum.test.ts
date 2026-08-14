import { describe, expect, it } from 'vitest';
import { Decimal } from '@app/money';
import { assertDeterministic, decOrNull, mergeConfig } from '@app/strategy-core';
import type { Candle, OpenOrder, ProfileSnapshot, SymbolInfo, TickInput } from '@app/strategy-core';

import {
  defaultMomentumConfig,
  initialMomentumState,
  momentum,
  momentumPositionAdapter,
  MomentumConfigSchema,
  MomentumOverrideConfigSchema,
  MomentumStateSchema,
  MOMENTUM_STATE_SCHEMA_VERSION,
  type MomentumBundle,
  type MomentumConfig,
  type MomentumState,
} from '../src/index.js';
import { computeEntryQuantity, computeExitQuantity } from '../src/quantity.js';
import {
  evaluateProtectiveStopArm,
  findForeignRestingSell,
  findRestingProtectiveStop,
  protectiveStopCancelDecisions,
} from '../src/protective-stop.js';
import { protectiveStopClientOrderId } from '../src/client-order-id.js';
import { resolveStopLevel } from '../src/stop-level.js';

const FILTERS: SymbolInfo['filters'] = {
  minNotional: '10',
  tickSize: '0.01',
  stepSize: '0.001',
  minQty: '0.001',
  maxQty: '100000',
  minPrice: '0.01',
  maxPrice: '1000000',
};

const SYMBOL_INFO: SymbolInfo = {
  symbol: 'BTCUSDT',
  baseAsset: 'BTC',
  quoteAsset: 'USDT',
  status: 'TRADING',
  filters: FILTERS,
};

const PROFILE: ProfileSnapshot = {
  id: 'p1',
  userId: 'u1',
  binanceMode: 'test',
  status: 'running',
  strategyVersion: '1.0.0',
};

const mkCandles = (closes: readonly string[], isClosed = true): Candle[] =>
  closes.map((c, i) => ({
    openTimeMs: i * 3_600_000,
    closeTimeMs: (i + 1) * 3_600_000,
    open: c,
    high: c,
    low: c,
    close: c,
    volume: '1',
    isClosed,
  }));

const cfg = (over: Record<string, unknown> = {}): MomentumConfig =>
  MomentumConfigSchema.parse({
    candleInterval: '1h',
    entrySizing: { mode: 'fixed', amount: '140' },
    ema: { fast: 2, slow: 3 },
    trailingStopPct: '0.05',
    ...over,
  });

// Generous default quote balance so a fixed-amount entry is never clamped by
// free cash; percent-of-account / reserve-cap tests pass explicit balances and
// a deployed total to drive the sizing math.
const QUOTE_BALANCE = { asset: 'USDT', free: new Decimal('100000'), locked: new Decimal('0') };

interface InputOpts {
  readonly closes: readonly Candle[];
  readonly currentPrice: string;
  readonly state: MomentumState;
  readonly config?: MomentumConfig;
  readonly openOrders?: readonly OpenOrder[];
  readonly filters?: SymbolInfo['filters'];
  readonly balances?: Readonly<Record<string, { asset: string; free: Decimal; locked: Decimal }>>;
  // Defaults to a readable snapshot; a test drives the unreadable path (fail
  // open) by passing false, never by leaving `balances` empty.
  readonly readable?: boolean;
  readonly deployedQuoteAcrossProfiles?: string;
  readonly override?: MomentumBundle['override'];
  // The 1m window the worker feeds for every symbol regardless of
  // `candleInterval`. Only the profit trail reads it.
  readonly oneMinute?: readonly Candle[];
}

const mkInput = (opts: InputOpts): TickInput<MomentumConfig, MomentumState, MomentumBundle> => ({
  clock: { nowMs: () => 0 },
  rng: { next: () => 0 },
  trigger: { kind: 'tick' },
  profile: PROFILE,
  config: opts.config ?? cfg(),
  state: opts.state,
  market: {
    symbol: 'BTCUSDT',
    currentPrice: opts.currentPrice,
    candlesByInterval: {
      '1h': opts.closes,
      ...(opts.oneMinute === undefined ? {} : { '1m': opts.oneMinute }),
    },
    symbolInfo: opts.filters ? { ...SYMBOL_INFO, filters: opts.filters } : SYMBOL_INFO,
    indicatorsByInterval: {},
  },
  account: {
    balances: opts.balances ?? { USDT: QUOTE_BALANCE },
    readable: opts.readable ?? true,
    ...(opts.deployedQuoteAcrossProfiles !== undefined
      ? { deployedQuoteAcrossProfiles: opts.deployedQuoteAcrossProfiles }
      : {}),
  },
  openOrders: opts.openOrders ?? [],
  bundle: { override: opts.override ?? null },
  limits: { weightUsed1m: 0, weightLimit1m: 1200, headroomBps: 10_000 },
});

const flat = initialMomentumState;
const longState = (over: Partial<MomentumState> = {}): MomentumState => ({
  schemaVersion: MOMENTUM_STATE_SCHEMA_VERSION,
  entryPrice: '100',
  highSinceEntry: '100',
  profitHigh: null,
  heldQuantity: '1',
  lastEntryCandleMs: null,
  ...over,
});

// Close series engineered for emaFast=2 / emaSlow=3 (need = 4 candles).
const CROSS_UP = ['12', '10', '8', '14']; // fast crosses above slow on the last candle
const CROSS_DOWN = ['8', '10', '12', '6']; // fast crosses below slow on the last candle
const FLAT_SERIES = ['10', '10', '10', '10']; // no cross either way

// Close time of the last closed candle in those 4-bar series — the value `tick`
// stamps into `lastEntryCandleMs` and later compares against.
const LAST_CLOSE_MS = 4 * 3_600_000;

/**
 * Arm against the level the tick would have resolved from `high`. The arm takes a
 * resolved stop rather than a high-water mark, so the wrapper runs the SAME
 * resolver the tick does: the ATR, fixed-fallback and unusable-retrace cases
 * below keep exercising the real level math instead of a hand-written number.
 */
const armOut = (
  input: TickInput<MomentumConfig, MomentumState, MomentumBundle>,
  state: MomentumState,
  high: Decimal,
): ReturnType<typeof evaluateProtectiveStopArm> =>
  evaluateProtectiveStopArm(
    input,
    state,
    resolveStopLevel(
      input.config,
      new Decimal(state.entryPrice ?? '0'),
      high,
      decOrNull(state.profitHigh),
      (input.market.candlesByInterval[input.config.candleInterval] ?? []).filter((c) => c.isClosed),
    ).stop,
  );

/**
 * The arm evaluator returns decisions AND (when it refuses) a blocker. Most cases
 * below assert only the decisions; the blocker cases call the evaluator directly.
 */
const armDecisions = (...args: Parameters<typeof armOut>): Decision[] => armOut(...args).decisions;

describe('momentum.tick — entry', () => {
  it('enters long on an EMA cross-up', () => {
    const out = momentum.tick(
      mkInput({ closes: mkCandles(CROSS_UP), currentPrice: '14', state: flat() }),
    );
    expect(out.decisions).toHaveLength(1);
    expect(out.decisions[0]).toMatchObject({
      type: 'place-order',
      intent: { symbol: 'BTCUSDT', side: 'BUY', reason: 'entry' },
      params: { type: 'MARKET', quantity: '10.000' },
    });
    const d = out.decisions[0];
    if (d.type !== 'place-order') throw new Error('expected place-order');
    expect(d.intent.clientOrderId).toMatch(/^mo-[0-9a-f]{8}-e$/);
    expect(out.nextState).toEqual({
      schemaVersion: MOMENTUM_STATE_SCHEMA_VERSION,
      entryPrice: '14',
      highSinceEntry: '14',
      // Unarmed at entry by definition; seeded on the first held tick that sees
      // a bucket-end 1m close.
      profitHigh: null,
      heldQuantity: '10.000',
      // Stamped with the closing candle that carried the cross, so the same
      // cross cannot open a second position after this one closes.
      lastEntryCandleMs: CROSS_UP.length * 3_600_000,
      // No 1m window in this input, so the trail has no epoch to fold from.
      // Covered against a real window below.
      profitTrailSinceMs: null,
      // A fired entry clears any prior suppression breadcrumb.
      entryBlocker: null,
      protectiveStopBlocker: null,
    });
    expect(out.metrics).toEqual([{ name: 'momentum.entry', value: 1 }]);
  });

  // One entry per cross. `crossUp` reads the last two CLOSED candles, so it stays
  // true for the rest of the candle it fired on. A position stopped out inside
  // that window leaves the state flat under a still-true signal; without the
  // stamp the next tick buys straight back in at the price the stop just
  // rejected, unbounded, reusing the filled order's clientOrderId.
  it('refuses a second entry on the candle it already entered on', () => {
    const out = momentum.tick(
      mkInput({
        closes: mkCandles(CROSS_UP),
        currentPrice: '14',
        state: { ...flat(), lastEntryCandleMs: LAST_CLOSE_MS },
      }),
    );
    expect(out.decisions).toEqual([{ type: 'noop' }]);
    expect(out.metrics).toEqual([
      {
        name: 'momentum.skip',
        value: 1,
        tags: { side: 'entry', reason: 'already-entered-this-candle' },
      },
    ]);
    expect(out.nextState.lastEntryCandleMs).toBe(LAST_CLOSE_MS);
    expect(out.nextState.entryBlocker?.reason).toBe('already-entered-this-candle');
  });

  // The guard sits ahead of the trend gate so a stale-cross attempt is not
  // mislabelled as a trend-filter veto. `period: 400` against a 4-candle window
  // makes the trend gate veto with `insufficient-history`, and the control case
  // proves it: same config, no stamp -> the trend reason surfaces. Without the
  // ordering, the operator's skip metric would name the wrong lever.
  it('reports the same-candle refusal ahead of the trend-filter veto', () => {
    const trendVeto = cfg({ trendFilter: { enabled: true, maType: 'sma', period: 400 } });

    const control = momentum.tick(
      mkInput({
        closes: mkCandles(CROSS_UP),
        currentPrice: '14',
        state: flat(),
        config: trendVeto,
      }),
    );
    expect(control.metrics).toEqual([
      { name: 'momentum.skip', value: 1, tags: { side: 'entry', reason: 'insufficient-history' } },
    ]);

    const out = momentum.tick(
      mkInput({
        closes: mkCandles(CROSS_UP),
        currentPrice: '14',
        state: { ...flat(), lastEntryCandleMs: LAST_CLOSE_MS },
        config: trendVeto,
      }),
    );
    expect(out.decisions).toEqual([{ type: 'noop' }]);
    expect(out.metrics).toEqual([
      {
        name: 'momentum.skip',
        value: 1,
        tags: { side: 'entry', reason: 'already-entered-this-candle' },
      },
    ]);
  });

  it('allows the entry once a later candle carries the cross', () => {
    const out = momentum.tick(
      mkInput({
        closes: mkCandles(CROSS_UP),
        currentPrice: '14',
        // Stamped by an entry on an EARLIER candle: this cross is a fresh one.
        state: { ...flat(), lastEntryCandleMs: LAST_CLOSE_MS - 3_600_000 },
      }),
    );
    expect(out.decisions[0]).toMatchObject({ type: 'place-order', intent: { side: 'BUY' } });
    expect(out.nextState.lastEntryCandleMs).toBe(LAST_CLOSE_MS);
  });

  // A row written before the stamp existed reaches the pure tick unparsed, so the
  // key is absent rather than null. Absent must fail OPEN — block nothing, then
  // stamp — or deploying the guard would freeze every live momentum profile.
  it('enters when the stamp is absent (state written before the field existed)', () => {
    const { lastEntryCandleMs: _omitted, ...legacy } = flat();
    const out = momentum.tick(
      mkInput({
        closes: mkCandles(CROSS_UP),
        currentPrice: '14',
        state: legacy as MomentumState,
      }),
    );
    expect(out.decisions[0]).toMatchObject({ type: 'place-order', intent: { side: 'BUY' } });
    expect(out.nextState.lastEntryCandleMs).toBe(LAST_CLOSE_MS);
  });

  it('ignores a forming (unclosed) trailing candle when detecting the cross', () => {
    const closes = [...mkCandles(CROSS_UP), ...mkCandles(['999'], false)];
    const out = momentum.tick(mkInput({ closes, currentPrice: '14', state: flat() }));
    expect(out.decisions[0]?.type).toBe('place-order');
  });

  it('holds flat when there is no entry signal', () => {
    const out = momentum.tick(
      mkInput({ closes: mkCandles(FLAT_SERIES), currentPrice: '10', state: flat() }),
    );
    expect(out.decisions).toEqual([{ type: 'noop' }]);
    expect(out.nextState).toEqual(flat());
  });

  it('skips the entry with a typed reason when the budget cannot meet minNotional', () => {
    const out = momentum.tick(
      mkInput({
        closes: mkCandles(CROSS_UP),
        currentPrice: '14',
        state: flat(),
        config: cfg({ entrySizing: { mode: 'fixed', amount: '5' } }),
      }),
    );
    expect(out.decisions).toEqual([{ type: 'noop' }]);
    expect(out.metrics).toEqual([
      { name: 'momentum.skip', value: 1, tags: { side: 'entry', reason: 'min-notional' } },
    ]);
    expect(out.nextState).toEqual({ ...flat(), entryBlocker: { reason: 'min-notional' } });
    expect(out.nextState.entryBlocker?.reason).toBe('min-notional');
  });

  it('skips the entry when the rounded quantity falls below minQty', () => {
    const out = momentum.tick(
      mkInput({
        closes: mkCandles(CROSS_UP),
        currentPrice: '14',
        state: flat(),
        config: cfg({ entrySizing: { mode: 'fixed', amount: '0.005' } }),
      }),
    );
    expect(out.metrics[0]?.tags).toEqual({ side: 'entry', reason: 'min-qty' });
    expect(out.nextState.entryBlocker?.reason).toBe('min-qty');
  });

  it('records an invalid-filters blocker when a cross-up entry hits malformed symbol filters', () => {
    const out = momentum.tick(
      mkInput({
        closes: mkCandles(CROSS_UP),
        currentPrice: '14',
        state: flat(),
        filters: { ...FILTERS, stepSize: 'abc' },
      }),
    );
    expect(out.decisions).toEqual([{ type: 'noop' }]);
    expect(out.metrics[0]?.tags).toEqual({ side: 'entry', reason: 'invalid-filters' });
    expect(out.nextState.entryBlocker?.reason).toBe('invalid-filters');
  });

  it('sizes a percent-of-account entry off total equity (cash + deployed)', () => {
    // equity = free 500 + locked 0 + deployed 500 = 1000; 10% = 100 spend.
    // 100 / 14 = 7.142857 floored to stepSize 0.001 = 7.142.
    const out = momentum.tick(
      mkInput({
        closes: mkCandles(CROSS_UP),
        currentPrice: '14',
        state: flat(),
        config: cfg({ entrySizing: { mode: 'percentOfAccount', percent: '0.1' } }),
        balances: { USDT: { asset: 'USDT', free: new Decimal('500'), locked: new Decimal('0') } },
        deployedQuoteAcrossProfiles: '500',
      }),
    );
    expect(out.decisions[0]).toMatchObject({
      type: 'place-order',
      params: { type: 'MARKET', quantity: '7.142' },
    });
  });

  it('clamps a percent-of-account entry to available free cash', () => {
    // equity 1000 -> 50% desired = 500, but only 30 free cash -> spend 30.
    // 30 / 14 = 2.142857 floored = 2.142.
    const out = momentum.tick(
      mkInput({
        closes: mkCandles(CROSS_UP),
        currentPrice: '14',
        state: flat(),
        config: cfg({ entrySizing: { mode: 'percentOfAccount', percent: '0.5' } }),
        balances: { USDT: { asset: 'USDT', free: new Decimal('30'), locked: new Decimal('0') } },
        deployedQuoteAcrossProfiles: '970',
      }),
    );
    expect(out.decisions[0]).toMatchObject({ params: { quantity: '2.142' } });
  });

  it('downsizes a fixed entry to fit the reserve cap headroom', () => {
    // equity = free 1000 + deployed 900 = 1900; cap 50% = 950; headroom = 50.
    // desired 140 -> clamped to 50; 50 / 14 = 3.571428 floored = 3.571.
    const out = momentum.tick(
      mkInput({
        closes: mkCandles(CROSS_UP),
        currentPrice: '14',
        state: flat(),
        config: cfg({
          entrySizing: { mode: 'fixed', amount: '140' },
          accountCap: { mode: 'percentOfAccount', percent: '0.5' },
        }),
        balances: { USDT: { asset: 'USDT', free: new Decimal('1000'), locked: new Decimal('0') } },
        deployedQuoteAcrossProfiles: '900',
      }),
    );
    expect(out.decisions[0]).toMatchObject({ params: { quantity: '3.571' } });
  });

  it('holds with a cap-reached reason when already at/over the reserve cap', () => {
    // equity 1000; cap 50% = 500; deployed 900 > 500 -> no headroom.
    const out = momentum.tick(
      mkInput({
        closes: mkCandles(CROSS_UP),
        currentPrice: '14',
        state: flat(),
        config: cfg({
          entrySizing: { mode: 'fixed', amount: '140' },
          accountCap: { mode: 'percentOfAccount', percent: '0.5' },
        }),
        balances: { USDT: { asset: 'USDT', free: new Decimal('100'), locked: new Decimal('0') } },
        deployedQuoteAcrossProfiles: '900',
      }),
    );
    expect(out.decisions).toEqual([{ type: 'noop' }]);
    expect(out.metrics).toEqual([
      { name: 'momentum.skip', value: 1, tags: { side: 'entry', reason: 'cap-reached' } },
    ]);
    expect(out.nextState).toEqual({ ...flat(), entryBlocker: { reason: 'cap-reached' } });
    expect(out.nextState.entryBlocker?.reason).toBe('cap-reached');
  });

  it('fails safe (holds) when entrySizing is absent — the live unparsed-config transition', () => {
    // The worker reads stored config unparsed; a config saved before entrySizing
    // existed has no such field. Hold with a specific reason, never guess.
    const legacy = {
      candleInterval: '1h',
      ema: { fast: 2, slow: 3 },
      trailingStopPct: '0.05',
    } as unknown as MomentumConfig;
    const out = momentum.tick(
      mkInput({ closes: mkCandles(CROSS_UP), currentPrice: '14', state: flat(), config: legacy }),
    );
    expect(out.decisions).toEqual([{ type: 'noop' }]);
    expect(out.metrics).toEqual([
      { name: 'momentum.skip', value: 1, tags: { side: 'entry', reason: 'sizing-unconfigured' } },
    ]);
    expect(out.nextState.entryBlocker?.reason).toBe('sizing-unconfigured');
  });
});

describe('momentum.tick — guards', () => {
  it('holds when there are no candles for the interval', () => {
    const input = mkInput({ closes: [], currentPrice: '10', state: flat() });
    const out = momentum.tick({ ...input, market: { ...input.market, candlesByInterval: {} } });
    expect(out.decisions).toEqual([{ type: 'noop' }]);
    expect(out.logs[0]?.message).toContain('insufficient closed candles');
  });

  it('holds when there are fewer than slow+1 closed candles', () => {
    const out = momentum.tick(
      mkInput({ closes: mkCandles(['10', '10']), currentPrice: '10', state: flat() }),
    );
    expect(out.decisions).toEqual([{ type: 'noop' }]);
  });

  it('holds when every candle is still forming', () => {
    const out = momentum.tick(
      mkInput({ closes: mkCandles(CROSS_UP, false), currentPrice: '14', state: flat() }),
    );
    expect(out.decisions).toEqual([{ type: 'noop' }]);
  });
});

describe('momentum.tick — exit', () => {
  it('exits on a trailing-stop retrace from the high', () => {
    const out = momentum.tick(
      mkInput({
        closes: mkCandles(FLAT_SERIES),
        currentPrice: '90',
        state: longState({ highSinceEntry: '100' }),
      }),
    );
    expect(out.decisions[0]).toMatchObject({
      type: 'place-order',
      intent: { side: 'SELL', reason: 'exit' },
      params: { type: 'MARKET', quantity: '1.000' },
    });
    const d = out.decisions[0];
    if (d.type !== 'place-order') throw new Error('expected place-order');
    expect(d.intent.clientOrderId).toMatch(/^mo-[0-9a-f]{8}-x$/);
    expect(out.metrics).toEqual([
      { name: 'momentum.exit', value: 1, tags: { reason: 'trailing-stop' } },
    ]);
    expect(out.nextState).toEqual({
      schemaVersion: MOMENTUM_STATE_SCHEMA_VERSION,
      entryPrice: null,
      highSinceEntry: null,
      profitHigh: null,
      heldQuantity: null,
      lastEntryCandleMs: null,
      // The epoch belongs to the position just closed; a re-entry stamps its own.
      profitTrailSinceMs: null,
      // An exit is not an entry suppression, so the field stays clear.
      entryBlocker: null,
      // Flat: nothing to protect, so no stop can be blocked.
      protectiveStopBlocker: null,
    });
  });

  // The exit flattens the position but must NOT clear the entry stamp: the flat
  // state it produces is exactly the state a same-cross re-entry would fire from.
  it('carries the entry stamp through the exit flatten', () => {
    const out = momentum.tick(
      mkInput({
        closes: mkCandles(FLAT_SERIES),
        currentPrice: '90',
        state: longState({ highSinceEntry: '100', lastEntryCandleMs: LAST_CLOSE_MS }),
      }),
    );
    expect(out.decisions.at(-1)).toMatchObject({ intent: { side: 'SELL', reason: 'exit' } });
    expect(out.nextState.entryPrice).toBeNull();
    expect(out.nextState.lastEntryCandleMs).toBe(LAST_CLOSE_MS);
  });

  it('exits on an EMA cross-down when the trailing stop is not hit', () => {
    const out = momentum.tick(
      mkInput({
        closes: mkCandles(CROSS_DOWN),
        currentPrice: '6',
        state: longState({ entryPrice: '6', highSinceEntry: '6', heldQuantity: '10' }),
      }),
    );
    expect(out.metrics).toEqual([
      { name: 'momentum.exit', value: 1, tags: { reason: 'ema-cross' } },
    ]);
    expect(out.decisions[0]?.type).toBe('place-order');
  });

  it('ratchets the high-water mark on a new CLOSED-candle close', () => {
    const out = momentum.tick(
      mkInput({
        // last closed close 120 exceeds the prior high 100; EMAs stay above so
        // no cross-down fires.
        closes: mkCandles(['100', '100', '100', '120']),
        currentPrice: '120',
        state: longState({ highSinceEntry: '100' }),
      }),
    );
    expect(out.decisions).toEqual([{ type: 'noop' }]);
    expect(out.nextState.highSinceEntry).toBe('120');
  });

  it('does NOT ratchet the high-water mark on an intra-candle wick (currentPrice above close)', () => {
    const out = momentum.tick(
      mkInput({
        // closed close is 10; currentPrice 110 is a transient wick that must not
        // tighten the trailing stop by inflating the high-water mark.
        closes: mkCandles(FLAT_SERIES),
        currentPrice: '110',
        state: longState({ highSinceEntry: '100' }),
      }),
    );
    expect(out.decisions).toEqual([{ type: 'noop' }]);
    expect(out.nextState.highSinceEntry).toBe('100');
  });

  it('holds the long and keeps the high-water mark when no new high is made', () => {
    const out = momentum.tick(
      mkInput({
        closes: mkCandles(FLAT_SERIES),
        currentPrice: '98',
        state: longState({ highSinceEntry: '100' }),
      }),
    );
    expect(out.decisions).toEqual([{ type: 'noop' }]);
    expect(out.nextState.highSinceEntry).toBe('100');
  });

  it('falls back to the entry price when highSinceEntry was reset by an adopted fill', () => {
    const out = momentum.tick(
      mkInput({
        closes: mkCandles(FLAT_SERIES),
        currentPrice: '100',
        state: longState({ highSinceEntry: null }),
      }),
    );
    expect(out.decisions).toEqual([{ type: 'noop' }]);
    expect(out.nextState.highSinceEntry).toBe('100');
  });

  it('clears a stale entry blocker carried in from an out-of-band adopted fill', () => {
    const out = momentum.tick(
      mkInput({
        closes: mkCandles(FLAT_SERIES),
        currentPrice: '98',
        state: longState({ highSinceEntry: '100', entryBlocker: { reason: 'below-trend' } }),
      }),
    );
    expect(out.decisions).toEqual([{ type: 'noop' }]);
    // A held long is not entry-suppressed: the exit must not later emit a
    // spurious unblock row for a reason set while the position was already open.
    expect(out.nextState.entryBlocker).toBeNull();
  });

  it('defers the exit when long with no tracked held quantity', () => {
    const out = momentum.tick(
      mkInput({
        closes: mkCandles(FLAT_SERIES),
        currentPrice: '90',
        state: longState({ highSinceEntry: '100', heldQuantity: null }),
      }),
    );
    expect(out.decisions).toEqual([{ type: 'noop' }]);
    expect(out.metrics[0]?.tags).toEqual({ side: 'exit', reason: 'no-held' });
  });

  it('skips the exit with a typed reason when the held quantity cannot meet minNotional', () => {
    const out = momentum.tick(
      mkInput({
        closes: mkCandles(FLAT_SERIES),
        currentPrice: '5',
        state: longState({ highSinceEntry: '100', heldQuantity: '0.001' }),
      }),
    );
    expect(out.decisions).toEqual([{ type: 'noop' }]);
    expect(out.metrics[0]?.tags).toEqual({ side: 'exit', reason: 'min-notional' });
  });
});

describe('momentum.tick — ATR trailing stop', () => {
  // high=low=close closes; Wilder ATR(3) ≈ 1.7778, so the multiple-2 chandelier
  // sits at 15 - 3.556 = 11.44 — WIDER than the fixed 5% stop at 14.25.
  const CANDLES = ['10', '12', '11', '14', '13', '15'];
  const held = () => longState({ entryPrice: '10', highSinceEntry: '15', heldQuantity: '1' });
  const atrCfg = (over: Record<string, unknown> = {}) =>
    cfg({ atrTrailingStop: { enabled: true, period: 3, multiple: '2' }, ...over });

  it('holds inside the ATR stop where the fixed stop would have exited', () => {
    // price 12 is below the fixed 14.25 (fixed would exit) but above the ATR 11.44.
    const out = momentum.tick(
      mkInput({ closes: mkCandles(CANDLES), currentPrice: '12', state: held(), config: atrCfg() }),
    );
    const sells = out.decisions.filter((d) => d.type === 'place-order' && d.intent.side === 'SELL');
    expect(sells).toHaveLength(0);
  });

  it('exits when price falls below the ATR chandelier stop', () => {
    const out = momentum.tick(
      mkInput({ closes: mkCandles(CANDLES), currentPrice: '11', state: held(), config: atrCfg() }),
    );
    expect(out.decisions.some((d) => d.type === 'place-order' && d.intent.side === 'SELL')).toBe(
      true,
    );
    expect(out.metrics).toContainEqual({
      name: 'momentum.exit',
      value: 1,
      tags: { reason: 'trailing-stop' },
    });
  });

  it('falls back to the fixed stop when the window is too short for ATR', () => {
    // period 10 needs 11 candles; 6 supplied -> null -> fixed 5% stop at 14.25,
    // so price 12 (< 14.25) exits.
    const out = momentum.tick(
      mkInput({
        closes: mkCandles(CANDLES),
        currentPrice: '12',
        state: held(),
        config: atrCfg({ atrTrailingStop: { enabled: true, period: 10, multiple: '2' } }),
      }),
    );
    expect(out.decisions.some((d) => d.type === 'place-order' && d.intent.side === 'SELL')).toBe(
      true,
    );
  });
});

describe('momentum.tick — operator force-sell', () => {
  const triggerSell = { kind: 'trigger-sell' as const, overrideActionId: 'op-1' };
  const held = () => longState({ entryPrice: '100', highSinceEntry: '100', heldQuantity: '1' });

  it('flattens a held position on a trigger-sell override, with no trail or cross', () => {
    // Flat price: no trail hit, no cross-down -> the long would normally ride.
    // The force-sell overrides that and sells at market.
    const out = momentum.tick(
      mkInput({
        closes: mkCandles(['100', '100', '100', '100']),
        currentPrice: '100',
        state: held(),
        override: triggerSell,
      }),
    );
    const sells = out.decisions.filter((d) => d.type === 'place-order' && d.intent.side === 'SELL');
    expect(sells).toHaveLength(1);
    expect(out.metrics).toContainEqual({
      name: 'momentum.exit',
      value: 1,
      tags: { reason: 'operator-force-sell' },
    });
    expect(out.nextState.entryPrice).toBeNull();
    // The override was applied, so the worker must consume it, not re-arm it.
    expect(out.overrideDeferred).toBeUndefined();
  });

  it('stamps the override id on the force-sell exit it emits', () => {
    // The worker settles the operator's `override_actions` row purely on what
    // happened to the orders carrying this id. Drop the stamp and production
    // reports every force-sell as "the strategy did not act" while the market
    // SELL is live on Binance — and no other test would notice, because they all
    // read the id off the INPUT bundle, never off an emitted decision.
    const out = momentum.tick(
      mkInput({
        closes: mkCandles(['100', '100', '100', '100']),
        currentPrice: '100',
        state: held(),
        override: triggerSell,
      }),
    );
    const sell = out.decisions.find((d) => d.type === 'place-order');
    if (sell?.type !== 'place-order') throw new Error('expected a place-order decision');
    expect(sell.intent.overrideActionId).toBe('op-1');
  });

  it('leaves a strategy-initiated trailing-stop exit UNSTAMPED', () => {
    // No override in the bundle: the trail fired on its own. A stamp here would
    // let the worker settle an unrelated override row on this order's fate.
    const out = momentum.tick(
      mkInput({
        closes: mkCandles(FLAT_SERIES),
        currentPrice: '90',
        state: longState({ highSinceEntry: '100' }),
      }),
    );
    const sell = out.decisions.find((d) => d.type === 'place-order');
    if (sell?.type !== 'place-order') throw new Error('expected a place-order decision');
    expect(sell.intent.overrideActionId).toBeUndefined();
  });

  it('does not sell a flat position on a trigger-sell (nothing to flatten)', () => {
    const out = momentum.tick(
      mkInput({
        closes: mkCandles(FLAT_SERIES),
        currentPrice: '10',
        state: flat(),
        override: triggerSell,
      }),
    );
    const sells = out.decisions.filter((d) => d.type === 'place-order' && d.intent.side === 'SELL');
    expect(sells).toHaveLength(0);
  });

  it('defers a force-sell with a distinct reason when the held quantity is not yet tracked', () => {
    // entryPrice revived but heldQuantity not yet pinned: the sell cannot be
    // sized. The blocker is transient (the held-qty reconciler pins it shortly),
    // so the tick asks the worker to keep the one-shot override armed instead of
    // letting it be consumed by a tick that flattened nothing. `force-sell-no-held`
    // keeps the defer queryable.
    const out = momentum.tick(
      mkInput({
        closes: mkCandles(['100', '100', '100', '100']),
        currentPrice: '100',
        state: longState({ entryPrice: '100', highSinceEntry: '100', heldQuantity: null }),
        override: triggerSell,
      }),
    );
    expect(out.decisions.some((d) => d.type === 'place-order' && d.intent.side === 'SELL')).toBe(
      false,
    );
    expect(out.metrics).toContainEqual({
      name: 'momentum.skip',
      value: 1,
      tags: { side: 'exit', reason: 'force-sell-no-held' },
    });
    expect(out.overrideDeferred).toBe(true);
  });

  it('defers a force-sell that lands during candle warm-up', () => {
    // Cold worker / freshly added symbol: the window is too short to compute the
    // EMA cross, so the tick returns before the exit path even runs. The blocker is
    // transient (candles arrive as they close), so the override must stay armed
    // rather than be consumed by a tick that could not evaluate anything.
    const out = momentum.tick(
      mkInput({
        closes: mkCandles(['100', '100']),
        currentPrice: '100',
        state: held(),
        override: triggerSell,
      }),
    );
    expect(out.decisions).toEqual([{ type: 'noop' }]);
    expect(out.overrideDeferred).toBe(true);
  });

  it('does not defer during warm-up when there is no operator override', () => {
    const out = momentum.tick(
      mkInput({ closes: mkCandles(['100', '100']), currentPrice: '100', state: held() }),
    );
    expect(out.decisions).toEqual([{ type: 'noop' }]);
    expect(out.overrideDeferred).toBeUndefined();
  });

  it('does not defer a no-held exit that carries no operator override', () => {
    // A trail / cross-down with no tracked quantity self-heals (the signal recurs
    // next tick), and there is no override to keep armed — so nothing to defer.
    const out = momentum.tick(
      mkInput({
        closes: mkCandles(FLAT_SERIES),
        currentPrice: '5',
        state: longState({ highSinceEntry: '100', heldQuantity: null }),
      }),
    );
    expect(out.metrics[0]?.tags).toEqual({ side: 'exit', reason: 'no-held' });
    expect(out.overrideDeferred).toBeUndefined();
  });

  it('does not defer a force-sell the exchange filters permanently reject', () => {
    // Dust: 0.001 at price 5 = 0.005 notional, under the 10 minNotional filter.
    // That refusal is permanent for this position, so re-arming the override would
    // replay it every tick until the TTL expired. Consume it and warn instead.
    const out = momentum.tick(
      mkInput({
        closes: mkCandles(FLAT_SERIES),
        currentPrice: '5',
        state: longState({ highSinceEntry: '100', heldQuantity: '0.001' }),
        override: triggerSell,
      }),
    );
    expect(out.decisions).toEqual([{ type: 'noop' }]);
    expect(out.metrics[0]?.tags).toEqual({ side: 'exit', reason: 'min-notional' });
    expect(out.overrideDeferred).toBeUndefined();
  });
});

describe('momentum.tick — determinism', () => {
  it('produces identical output across two runs of the same input', () => {
    const { equal } = assertDeterministic(
      momentum,
      mkInput({ closes: mkCandles(CROSS_UP), currentPrice: '14', state: flat() }),
    );
    expect(equal).toBe(true);
  });
});

// A near-cross series for emaFast=2 / emaSlow=3: the fast EMA ends just above the
// slow EMA, so a 0 margin enters but a wider margin rejects.
const NEAR_CROSS_UP = ['10', '10', '10', '10.3'];

describe('momentum.tick — entry confirmation band', () => {
  it('enters on a marginal cross when no margin is configured', () => {
    const out = momentum.tick(
      mkInput({ closes: mkCandles(NEAR_CROSS_UP), currentPrice: '10.3', state: flat() }),
    );
    expect(out.decisions[0]?.type).toBe('place-order');
  });

  it('rejects a marginal cross that fails the confirmation margin', () => {
    const out = momentum.tick(
      mkInput({
        closes: mkCandles(NEAR_CROSS_UP),
        currentPrice: '10.3',
        state: flat(),
        config: cfg({ entryMarginPct: '0.05' }),
      }),
    );
    expect(out.decisions).toEqual([{ type: 'noop' }]);
  });

  it('still enters a strong cross with a margin configured', () => {
    // CROSS_UP clears the slow EMA by ~4.6%, so a 2% margin still confirms.
    const out = momentum.tick(
      mkInput({
        closes: mkCandles(CROSS_UP),
        currentPrice: '14',
        state: flat(),
        config: cfg({ entryMarginPct: '0.02' }),
      }),
    );
    expect(out.decisions[0]?.type).toBe('place-order');
  });

  it('treats a malformed entryMarginPct as zero (bare cross)', () => {
    const out = momentum.tick(
      mkInput({
        closes: mkCandles(NEAR_CROSS_UP),
        currentPrice: '10.3',
        state: flat(),
        config: { ...cfg(), entryMarginPct: 'not-a-number' },
      }),
    );
    expect(out.decisions[0]?.type).toBe('place-order');
  });

  it('treats a negative entryMarginPct as zero (bare cross)', () => {
    const out = momentum.tick(
      mkInput({
        closes: mkCandles(NEAR_CROSS_UP),
        currentPrice: '10.3',
        state: flat(),
        config: { ...cfg(), entryMarginPct: '-0.5' },
      }),
    );
    expect(out.decisions[0]?.type).toBe('place-order');
  });
});

const PS_CID = protectiveStopClientOrderId('p1', 'BTCUSDT');
const PS_CFG = cfg({ protectiveStop: { enabled: true } });

const psOrder = (over: Partial<OpenOrder> = {}): OpenOrder => ({
  orderId: 555,
  clientOrderId: PS_CID,
  symbol: 'BTCUSDT',
  side: 'SELL',
  type: 'STOP_LOSS_LIMIT',
  status: 'NEW',
  price: '93.10',
  origQty: '1.000',
  executedQty: '0',
  cummulativeQuoteQty: '0',
  stopPrice: '95.00',
  timeInForce: 'GTC',
  transactTimeMs: 0,
  updateTimeMs: 0,
  ...over,
});

// A held position with high-water 100: stop = 100 * (1 - 0.05) = 95, limit =
// 95 * 0.98 = 93.10.
const HIGH = new Decimal('100');

// The wallet a `longState()` position actually implies: 1 BTC really held. The
// arm reads an asset absent from a POPULATED balance map as a hard zero (Binance
// reports free AND locked per asset, so an absent line means we hold none), so a
// quote-only fixture would model a position the exchange says does not exist.
const ARM_BALANCES = {
  USDT: QUOTE_BALANCE,
  BTC: { asset: 'BTC', free: new Decimal('1'), locked: new Decimal('0') },
};

const armInput = (
  over: Partial<InputOpts> = {},
): TickInput<MomentumConfig, MomentumState, MomentumBundle> =>
  mkInput({
    closes: mkCandles(FLAT_SERIES),
    currentPrice: '100',
    state: longState(),
    config: PS_CFG,
    balances: ARM_BALANCES,
    ...over,
  });

describe('protective stop — findRestingProtectiveStop', () => {
  it('matches a live protective stop by clientOrderId, side, and status', () => {
    expect(findRestingProtectiveStop([psOrder()], 'p1', 'BTCUSDT')?.orderId).toBe(555);
    expect(
      findRestingProtectiveStop([psOrder({ status: 'PARTIALLY_FILLED' })], 'p1', 'BTCUSDT'),
    ).toBeDefined();
  });

  it('ignores a non-matching clientOrderId, wrong side, or terminal status', () => {
    expect(
      findRestingProtectiveStop([psOrder({ clientOrderId: 'other' })], 'p1', 'BTCUSDT'),
    ).toBeUndefined();
    expect(findRestingProtectiveStop([psOrder({ side: 'BUY' })], 'p1', 'BTCUSDT')).toBeUndefined();
    expect(
      findRestingProtectiveStop([psOrder({ status: 'FILLED' })], 'p1', 'BTCUSDT'),
    ).toBeUndefined();
    expect(findRestingProtectiveStop([], 'p1', 'BTCUSDT')).toBeUndefined();
  });

  it('treats a PENDING_CANCEL stop as still resting so it cannot double-arm', () => {
    // A cancel in flight is not off-book: the stop still locks base and must
    // suppress a re-arm. The canonical isRestingSell denylist keeps it resting;
    // the old inline NEW/PARTIALLY_FILLED allowlist wrongly dropped it (fail-OPEN).
    expect(
      findRestingProtectiveStop([psOrder({ status: 'PENDING_CANCEL' })], 'p1', 'BTCUSDT'),
    ).toBeDefined();
  });
});

describe('protective stop — evaluateProtectiveStopArm', () => {
  it('is disabled when the config block is absent', () => {
    expect(armDecisions(armInput({ config: cfg() }), longState(), HIGH)).toEqual([]);
  });

  it('mirrors the ATR chandelier level in the resting stop when the ATR mode is on', () => {
    // Varying closes give a non-zero ATR; the mirrored stop (100 - 2*ATR) sits
    // well below the fixed 95, proving the resting stop tracks the SAME ATR level
    // the in-process trail uses, not the fixed retrace.
    const candles = mkCandles(['90', '100', '95', '110', '105', '115']);
    const atrConfig = cfg({
      protectiveStop: { enabled: true },
      atrTrailingStop: { enabled: true, period: 3, multiple: '2' },
    });
    const out = armDecisions(armInput({ config: atrConfig, closes: candles }), longState(), HIGH);
    expect(out).toHaveLength(1);
    const place = out[0];
    if (place?.type !== 'place-order' || place.params.type !== 'STOP_LOSS_LIMIT') {
      throw new Error('expected a STOP_LOSS_LIMIT place');
    }
    expect(place.params.stopPrice).not.toBe('95.00');
    const stop = new Decimal(place.params.stopPrice);
    expect(stop.lt(HIGH) && stop.gt(0)).toBe(true);
  });

  it('falls back to the fixed stop when the ATR interval has no loaded candles', () => {
    // ATR enabled but the config's interval is absent from candlesByInterval ->
    // empty window -> ATR uncomputable -> the fixed retrace (95) arms instead.
    const atrConfig = cfg({
      candleInterval: '4h',
      protectiveStop: { enabled: true },
      atrTrailingStop: { enabled: true, period: 3, multiple: '2' },
    });
    const out = armDecisions(armInput({ config: atrConfig }), longState(), HIGH);
    expect(out).toHaveLength(1);
    const place = out[0];
    if (place?.type !== 'place-order' || place.params.type !== 'STOP_LOSS_LIMIT') {
      throw new Error('expected a STOP_LOSS_LIMIT place');
    }
    expect(place.params.stopPrice).toBe('95.00');
  });

  it('places a STOP_LOSS_LIMIT SELL when none is resting', () => {
    expect(armDecisions(armInput(), longState(), HIGH)).toEqual([
      {
        type: 'place-order',
        intent: {
          symbol: 'BTCUSDT',
          side: 'SELL',
          reason: 'protective-stop',
          clientOrderId: PS_CID,
        },
        params: {
          type: 'STOP_LOSS_LIMIT',
          stopPrice: '95.00',
          price: '93.10',
          quantity: '1.000',
          timeInForce: 'GTC',
        },
      },
    ]);
  });

  it('leaves a resting stop within the drift band untouched', () => {
    expect(armDecisions(armInput({ openOrders: [psOrder()] }), longState(), HIGH)).toEqual([]);
  });

  it('cancels and re-places when the trigger drifts beyond the band', () => {
    const out = armDecisions(
      armInput({ openOrders: [psOrder({ stopPrice: '90.00' })] }),
      longState(),
      HIGH,
    );
    expect(out).toHaveLength(2);
    expect(out[0]).toMatchObject({ type: 'cancel-order', orderId: 555, symbol: 'BTCUSDT' });
    // Deferrable ONLY here: the order being replaced keeps resting until the
    // cancel above lands, so the executor may shed the pair on an exhausted
    // order budget. The first-arm case above pins the absence of the flag.
    expect(out[1]).toMatchObject({ type: 'place-order', intent: { deferrable: true } });
  });

  it('leaves a resting stop whose stopPrice reads back unparseable', () => {
    expect(
      armDecisions(
        armInput({ openOrders: [psOrder({ stopPrice: undefined })] }),
        longState(),
        HIGH,
      ),
    ).toEqual([]);
  });

  it('cancels a now-unsizable resting stop', () => {
    const out = armDecisions(
      armInput({ openOrders: [psOrder()] }),
      longState({ heldQuantity: null }),
      HIGH,
    );
    expect(out).toEqual([
      {
        type: 'cancel-order',
        orderId: 555,
        reason: 'momentum-protective-stop-superseded',
        symbol: 'BTCUSDT',
      },
    ]);
  });

  it('emits nothing when unsizable and nothing is resting', () => {
    expect(armDecisions(armInput(), longState({ heldQuantity: null }), HIGH)).toEqual([]);
  });

  it('does not arm when flat', () => {
    expect(armDecisions(armInput(), longState({ entryPrice: null }), HIGH)).toEqual([]);
  });

  it('does not arm with a non-positive held quantity', () => {
    expect(armDecisions(armInput(), longState({ heldQuantity: '0' }), HIGH)).toEqual([]);
  });

  it('does not arm with an unparseable trailingStopPct', () => {
    const config = { ...PS_CFG, trailingStopPct: 'nope' };
    expect(armDecisions(armInput({ config }), longState(), HIGH)).toEqual([]);
  });

  it('does not arm with a non-positive trailingStopPct', () => {
    const config = { ...PS_CFG, trailingStopPct: '0' };
    expect(armDecisions(armInput({ config }), longState(), HIGH)).toEqual([]);
  });

  it('does not arm with a trailingStopPct at or above 1', () => {
    const config = { ...PS_CFG, trailingStopPct: '1.5' };
    expect(armDecisions(armInput({ config }), longState(), HIGH)).toEqual([]);
  });

  it('does not arm with an unparseable tickSize', () => {
    expect(
      armDecisions(armInput({ filters: { ...FILTERS, tickSize: 'x' } }), longState(), HIGH),
    ).toEqual([]);
  });

  it('does not arm with a non-positive tickSize', () => {
    expect(
      armDecisions(armInput({ filters: { ...FILTERS, tickSize: '0' } }), longState(), HIGH),
    ).toEqual([]);
  });

  it('does not arm when the filters cannot be parsed', () => {
    expect(
      armDecisions(armInput({ filters: { ...FILTERS, stepSize: 'bad' } }), longState(), HIGH),
    ).toEqual([]);
  });

  it('does not arm with an unparseable limit offset', () => {
    const config = { ...PS_CFG, protectiveStop: { enabled: true, limitOffsetPercentage: 'huh' } };
    expect(armDecisions(armInput({ config }), longState(), HIGH)).toEqual([]);
  });

  it('does not arm with a limit offset at or above 1', () => {
    const config = { ...PS_CFG, protectiveStop: { enabled: true, limitOffsetPercentage: '1.5' } };
    expect(armDecisions(armInput({ config }), longState(), HIGH)).toEqual([]);
  });

  it('does not arm when the stop rounds to zero', () => {
    expect(armDecisions(armInput(), longState(), new Decimal('0'))).toEqual([]);
  });

  it('does not arm a dust position below minNotional', () => {
    // held 0.001 at stop 95 → notional 0.095 < minNotional 10 → sizing skip.
    expect(armDecisions(armInput(), longState({ heldQuantity: '0.001' }), HIGH)).toEqual([]);
  });

  it('falls back to the default limit offset when the field is absent', () => {
    const config = {
      ...PS_CFG,
      protectiveStop: { enabled: true } as MomentumConfig['protectiveStop'],
    };
    const out = armDecisions(armInput({ config }), longState(), HIGH);
    expect(out[0]).toMatchObject({ params: { price: '93.10' } });
  });
});

describe('protective stop — protectiveStopCancelDecisions', () => {
  it('cancels a resting protective stop', () => {
    expect(protectiveStopCancelDecisions(armInput({ openOrders: [psOrder()] }))).toEqual([
      {
        type: 'cancel-order',
        orderId: 555,
        reason: 'momentum-protective-stop-superseded',
        symbol: 'BTCUSDT',
      },
    ]);
  });

  it('emits nothing when none is resting', () => {
    expect(protectiveStopCancelDecisions(armInput())).toEqual([]);
  });
});

describe('momentum.tick — protective stop wiring', () => {
  it('arms the protective stop on a hold tick when enabled', () => {
    const out = momentum.tick(armInput());
    expect(out.decisions[0]).toMatchObject({
      type: 'place-order',
      intent: { reason: 'protective-stop', clientOrderId: PS_CID },
      params: { type: 'STOP_LOSS_LIMIT' },
    });
  });

  it('cancels the resting stop before the market sell on exit', () => {
    const out = momentum.tick(armInput({ currentPrice: '90', openOrders: [psOrder()] }));
    expect(out.decisions).toHaveLength(2);
    expect(out.decisions[0]).toMatchObject({ type: 'cancel-order', orderId: 555 });
    expect(out.decisions[1]).toMatchObject({
      type: 'place-order',
      intent: { side: 'SELL', reason: 'exit' },
    });
  });

  it('does not arm on the entry tick (base not yet held on the exchange)', () => {
    const out = momentum.tick(
      mkInput({ closes: mkCandles(CROSS_UP), currentPrice: '14', state: flat(), config: PS_CFG }),
    );
    expect(out.decisions).toHaveLength(1);
    expect(out.decisions[0]).toMatchObject({ intent: { reason: 'entry' } });
  });
});

describe('computeEntryQuantity / computeExitQuantity', () => {
  it('rejects malformed filters as invalid-filters', () => {
    expect(computeEntryQuantity('100', '10', { ...FILTERS, stepSize: 'abc' })).toEqual({
      skip: 'invalid-filters',
    });
    expect(computeExitQuantity('1', '10', { ...FILTERS, stepSize: 'abc' })).toEqual({
      skip: 'invalid-filters',
    });
  });

  it('rejects a non-positive step as invalid-filters', () => {
    expect(computeEntryQuantity('100', '10', { ...FILTERS, stepSize: '0' })).toEqual({
      skip: 'invalid-filters',
    });
  });

  it('rejects malformed price/amount as invalid-filters', () => {
    expect(computeEntryQuantity('abc', '10', FILTERS)).toEqual({ skip: 'invalid-filters' });
    expect(computeExitQuantity('abc', '10', FILTERS)).toEqual({ skip: 'invalid-filters' });
  });

  it('rejects a non-positive price as invalid-filters', () => {
    expect(computeEntryQuantity('100', '0', FILTERS)).toEqual({ skip: 'invalid-filters' });
    expect(computeExitQuantity('1', '0', FILTERS)).toEqual({ skip: 'invalid-filters' });
  });

  it('rounds and accepts a valid entry/exit', () => {
    expect(computeEntryQuantity('140', '14', FILTERS)).toEqual({ quantity: '10.000' });
    expect(computeExitQuantity('1', '14', FILTERS)).toEqual({ quantity: '1.000' });
  });
});

describe('momentumPositionAdapter', () => {
  const body = (over: Partial<MomentumState> = {}): MomentumState => longState(over);

  it('defers a non-record or foreign-schema body', () => {
    expect(momentumPositionAdapter.readPosition(null as unknown as MomentumState)).toBeNull();
    expect(momentumPositionAdapter.readPosition(5 as unknown as MomentumState)).toBeNull();
    expect(
      momentumPositionAdapter.readPosition({ schemaVersion: '9.9.9' } as unknown as MomentumState),
    ).toBeNull();
    expect(
      momentumPositionAdapter.applyFill(null as unknown as MomentumState, { kind: 'empty' }),
    ).toBeNull();
    expect(
      momentumPositionAdapter.setHeldQuantity(null as unknown as MomentumState, '1'),
    ).toBeNull();
    expect(
      momentumPositionAdapter.setAvgEntryPrice(null as unknown as MomentumState, '1'),
    ).toBeNull();
    expect(momentumPositionAdapter.clearPosition(null as unknown as MomentumState)).toBeNull();
  });

  it('reads the position view, mapping entryPrice to avgEntryPrice', () => {
    expect(momentumPositionAdapter.readPosition(body())).toEqual({
      avgEntryPrice: '100',
      heldQuantity: '1',
    });
    expect(momentumPositionAdapter.readPosition(body({ entryPrice: null }))).toEqual({
      avgEntryPrice: null,
      heldQuantity: '1',
    });
  });

  it('defers when a position field is a non-string, non-null value', () => {
    expect(
      momentumPositionAdapter.readPosition({ ...body(), entryPrice: 123 as unknown as string }),
    ).toBeNull();
    expect(
      momentumPositionAdapter.readPosition({ ...body(), heldQuantity: 123 as unknown as string }),
    ).toBeNull();
  });

  it('applies a buy fill, resetting both marks but KEEPING the entry stamp', () => {
    // `profitTrailSinceMs` clears: it is the epoch bounding which 1m closes may
    // ratchet the profit trail, and it belongs to the entry this fill replaced.
    // Carried forward it would admit closes from before the new cost basis and
    // seed the mark with a peak this position never held. The adapter has no
    // candle window to derive a fresh one, so the next held tick establishes it.
    //
    // `lastEntryCandleMs` SURVIVES, for the same reason the empty-fill case
    // below keeps it: it is the one-entry-per-cross guard, and this adapter runs
    // for the profile's own strategy entries as well as adopted ones. Clearing
    // it would erase the stamp the placing tick just wrote and let the same
    // cross re-enter after a stop-out. A stale stamp can only ever suppress an
    // entry on a candle already past, which is the safe direction.
    expect(
      momentumPositionAdapter.applyFill(body({ lastEntryCandleMs: LAST_CLOSE_MS }), {
        kind: 'buy',
        avgEntryPrice: '50',
        heldQuantity: '2',
      }),
    ).toEqual({
      schemaVersion: MOMENTUM_STATE_SCHEMA_VERSION,
      lastEntryCandleMs: LAST_CLOSE_MS,
      profitTrailSinceMs: null,
      entryPrice: '50',
      highSinceEntry: null,
      profitHigh: null,
      heldQuantity: '2',
    });
  });

  it('applies a sell-reduce fill, lowering held quantity only', () => {
    expect(
      momentumPositionAdapter.applyFill(body(), { kind: 'sell-reduce', heldQuantity: '0.5' }),
    ).toEqual(body({ heldQuantity: '0.5' }));
  });

  // The exchange-side protective stop reaches the strategy only as `{kind:'empty'}`
  // — no timestamp, no price. Flattening must therefore leave `lastEntryCandleMs`
  // intact, or the next tick re-enters on the cross that is still reading true.
  it('flattens on an empty fill from an open position, keeping the entry stamp', () => {
    expect(
      momentumPositionAdapter.applyFill(body({ lastEntryCandleMs: LAST_CLOSE_MS }), {
        kind: 'empty',
      }),
    ).toEqual({
      schemaVersion: MOMENTUM_STATE_SCHEMA_VERSION,
      lastEntryCandleMs: LAST_CLOSE_MS,
      profitTrailSinceMs: null,
      entryPrice: null,
      highSinceEntry: null,
      profitHigh: null,
      heldQuantity: null,
    });
  });

  it('skips the write on an empty fill when already flat (null held)', () => {
    const f: MomentumState = {
      schemaVersion: MOMENTUM_STATE_SCHEMA_VERSION,
      entryPrice: null,
      highSinceEntry: null,
      heldQuantity: null,
    };
    expect(momentumPositionAdapter.applyFill(f, { kind: 'empty' })).toBeNull();
  });

  it('skips the write on an empty fill when already flat (missing held key)', () => {
    const f = {
      schemaVersion: MOMENTUM_STATE_SCHEMA_VERSION,
      entryPrice: null,
      highSinceEntry: null,
    } as unknown as MomentumState;
    expect(momentumPositionAdapter.applyFill(f, { kind: 'empty' })).toBeNull();
  });

  it('pins held quantity and revives / clears the entry price', () => {
    expect(momentumPositionAdapter.setHeldQuantity(body(), '7')).toEqual(
      body({ heldQuantity: '7' }),
    );
    expect(momentumPositionAdapter.setAvgEntryPrice(body(), '42')).toEqual(
      body({ entryPrice: '42' }),
    );
    expect(momentumPositionAdapter.clearPosition(body())).toEqual(
      body({
        entryPrice: null,
        highSinceEntry: null,
        profitHigh: null,
        profitTrailSinceMs: null,
      }),
    );
  });
});

describe('schema', () => {
  it('seeds a schema-valid default config and flat state', () => {
    expect(() => defaultMomentumConfig()).not.toThrow();
    expect(MomentumStateSchema.parse(initialMomentumState())).toEqual(initialMomentumState());
    expect(defaultMomentumConfig().candleInterval).toBe('1h');
    expect(defaultMomentumConfig().trailingStopPct).toBe('0.05');
  });

  it('seeds the extension guard on by default with a conservative wide ceiling', () => {
    // Default-on: a new profile is protected against buying an overextended
    // blow-off. The wide 40% default only rejects egregious stretch, not a
    // normal early-trend entry.
    expect(defaultMomentumConfig().entryExtension).toEqual({
      enabled: true,
      maType: 'sma',
      period: 50,
      maxPercent: '0.4',
    });
    // The ATR trailing stop stays OFF by default: the fixed retrace is unchanged
    // and no live stop-width is guessed until an operator opts in.
    expect(defaultMomentumConfig().atrTrailingStop).toBeUndefined();
  });

  it('reads a present extension block with enabled omitted as off (fail-safe)', () => {
    expect(cfg({ entryExtension: { period: 3 } }).entryExtension?.enabled).toBe(false);
  });

  it('defaults entryBlocker to null when a stored state omits it (additive, no version bump)', () => {
    // A row written before the field existed reaches the schema without the key.
    // It must revive as null with the version unchanged, so no migrateState hop is
    // needed and live rows are not stranded at an old schemaVersion.
    const legacy = {
      schemaVersion: MOMENTUM_STATE_SCHEMA_VERSION,
      entryPrice: null,
      highSinceEntry: null,
      heldQuantity: null,
      lastEntryCandleMs: null,
    };
    const parsed = MomentumStateSchema.parse(legacy);
    expect(parsed.entryBlocker).toBeNull();
    expect(parsed.schemaVersion).toBe('1.0.0');
  });

  it('rejects fast EMA period at or above the slow period', () => {
    expect(() => cfg({ ema: { fast: 21, slow: 9 } })).toThrow();
    expect(() => cfg({ ema: { fast: 9, slow: 9 } })).toThrow();
  });

  it('validates entrySizing: fixed needs a positive amount, percent needs a fraction in (0, 1]', () => {
    // Fixed mode requires `amount`.
    expect(() => cfg({ entrySizing: { mode: 'fixed', amount: '0' } })).toThrow();
    expect(() => cfg({ entrySizing: { mode: 'fixed', amount: 'abc' } })).toThrow();
    expect(() => cfg({ entrySizing: { mode: 'fixed' } })).toThrow();
    expect(cfg({ entrySizing: { mode: 'fixed', amount: '15' } }).entrySizing).toEqual({
      mode: 'fixed',
      amount: '15',
      percent: '',
    });
    // Percent mode requires `percent` in (0, 1].
    expect(() => cfg({ entrySizing: { mode: 'percentOfAccount' } })).toThrow();
    expect(() => cfg({ entrySizing: { mode: 'percentOfAccount', percent: '0' } })).toThrow();
    expect(() => cfg({ entrySizing: { mode: 'percentOfAccount', percent: '1.5' } })).toThrow();
    expect(cfg({ entrySizing: { mode: 'percentOfAccount', percent: '0.1' } }).entrySizing).toEqual({
      mode: 'percentOfAccount',
      amount: '',
      percent: '0.1',
    });
  });

  it('validates accountCap: off by default, percent needs a fraction in (0, 1] when on', () => {
    expect(cfg().accountCap).toBeUndefined();
    // 'off' must parse with a blank percent (the superRefine only requires a
    // percent for percentOfAccount) — pins the on-screen "cap off" default.
    expect(cfg({ accountCap: { mode: 'off' } }).accountCap).toEqual({ mode: 'off', percent: '' });
    expect(() => cfg({ accountCap: { mode: 'percentOfAccount' } })).toThrow();
    expect(() => cfg({ accountCap: { mode: 'percentOfAccount', percent: '1.5' } })).toThrow();
    expect(cfg({ accountCap: { mode: 'percentOfAccount', percent: '0.5' } }).accountCap).toEqual({
      mode: 'percentOfAccount',
      percent: '0.5',
    });
  });

  it('validates trailingStopPct within (0, 1)', () => {
    expect(() => cfg({ trailingStopPct: '0' })).toThrow();
    expect(() => cfg({ trailingStopPct: '1' })).toThrow();
    expect(() => cfg({ trailingStopPct: 'abc' })).toThrow();
    expect(cfg({ trailingStopPct: '0.1' }).trailingStopPct).toBe('0.1');
  });

  it('validates entryMarginPct within [0, 1) and treats it as optional', () => {
    expect(() => cfg({ entryMarginPct: '1' })).toThrow();
    expect(() => cfg({ entryMarginPct: '-0.1' })).toThrow();
    expect(cfg({ entryMarginPct: '0' }).entryMarginPct).toBe('0');
    expect(cfg().entryMarginPct).toBeUndefined();
  });

  it('validates protectiveStop bounds and defaults', () => {
    expect(() => cfg({ protectiveStop: { limitOffsetPercentage: '1' } })).toThrow();
    expect(() => cfg({ protectiveStop: { limitOffsetPercentage: '0' } })).toThrow();
    // The block is optional at the top level, but once present its fields default.
    expect(cfg({ protectiveStop: {} }).protectiveStop).toEqual({
      enabled: false,
      limitOffsetPercentage: '0.98',
      minRearmDriftPct: '0.001',
    });
    expect(cfg().protectiveStop).toBeUndefined();
  });

  it('defaults the profit trail off, with a trail narrower than its activation', () => {
    expect(cfg().profitTrail).toBeUndefined();
    expect(cfg({ profitTrail: {} }).profitTrail).toEqual({
      enabled: false,
      activationPct: '0.05',
      trailPct: '0.03',
      ratchetMinutes: 5,
    });
  });

  it('rejects a profit trail that would arm at or below the entry price', () => {
    // The bound is trail < act / (1 + act), not trail < act: the pullback is
    // taken off the arming price entry * (1 + act), so it costs more than the
    // activation gained. At act 0.05 that boundary is 0.047619…, and 0.048
    // arms at 100 * 1.05 * 0.952 = 99.96 — under entry. Pinned because the
    // naive comparison passes every other test: the Decimal.max floor in
    // stop-level pins such a stop AT entry, so it books a break-even gross
    // sale instead of an obvious failure.
    expect(() => cfg({ profitTrail: { activationPct: '0.05', trailPct: '0.05' } })).toThrow();
    expect(() => cfg({ profitTrail: { activationPct: '0.05', trailPct: '0.08' } })).toThrow();
    expect(() => cfg({ profitTrail: { activationPct: '0.05', trailPct: '0.048' } })).toThrow();
    expect(
      cfg({ profitTrail: { activationPct: '0.05', trailPct: '0.047' } }).profitTrail?.trailPct,
    ).toBe('0.047');
  });

  it('bounds ratchetMinutes to a whole number of minutes in [1, 60]', () => {
    expect(() => cfg({ profitTrail: { ratchetMinutes: 0 } })).toThrow();
    expect(() => cfg({ profitTrail: { ratchetMinutes: 61 } })).toThrow();
    expect(() => cfg({ profitTrail: { ratchetMinutes: 1.5 } })).toThrow();
    expect(cfg({ profitTrail: { ratchetMinutes: 60 } }).profitTrail?.ratchetMinutes).toBe(60);
  });

  it('accepts a per-symbol profitTrail override', () => {
    expect(
      MomentumOverrideConfigSchema.parse({ profitTrail: { enabled: true } }).profitTrail,
    ).toEqual({ enabled: true, activationPct: '0.05', trailPct: '0.03', ratchetMinutes: 5 });
  });

  it('bounds minRearmDriftPct to a fraction in (0, 1)', () => {
    expect(() => cfg({ protectiveStop: { minRearmDriftPct: '0' } })).toThrow();
    expect(() => cfg({ protectiveStop: { minRearmDriftPct: '1' } })).toThrow();
    expect(cfg({ protectiveStop: { minRearmDriftPct: '0.01' } }).protectiveStop).toMatchObject({
      minRearmDriftPct: '0.01',
    });
  });

  it('revives a stored state written before profitHigh existed', () => {
    const parsed = MomentumStateSchema.parse({
      schemaVersion: MOMENTUM_STATE_SCHEMA_VERSION,
      entryPrice: '10',
      highSinceEntry: '11',
      heldQuantity: '1',
    });
    // `.default(null)` is what keeps MOMENTUM_STATE_SCHEMA_VERSION where it is:
    // without it the revive fails and every live row needs a migrateState hop.
    expect(parsed.profitHigh).toBeNull();
    expect(parsed.schemaVersion).toBe(MOMENTUM_STATE_SCHEMA_VERSION);
  });

  it('enables the protective stop in the seeded default config', () => {
    expect(defaultMomentumConfig().protectiveStop?.enabled).toBe(true);
  });

  it('defaults the trend filter slope veto off, and bounds slopeLookbackBars at >= 1', () => {
    // Present-but-minimal block: slope veto off, lookback seeded to the doc default
    // so an unparsed worker config that omits the field still has a usable window.
    expect(cfg({ trendFilter: { enabled: true, period: 50 } }).trendFilter).toEqual({
      enabled: true,
      maType: 'sma',
      period: 50,
      requireRising: false,
      slopeLookbackBars: 10,
    });
    expect(() =>
      cfg({ trendFilter: { enabled: true, requireRising: true, slopeLookbackBars: 0 } }),
    ).toThrow();
    expect(
      cfg({ trendFilter: { enabled: true, requireRising: true, slopeLookbackBars: 5 } }).trendFilter
        ?.slopeLookbackBars,
    ).toBe(5);
  });

  it('accepts a partial override and rejects the profile-level candleInterval key', () => {
    expect(
      MomentumOverrideConfigSchema.parse({ entrySizing: { mode: 'fixed', amount: '20' } }),
    ).toEqual({
      entrySizing: { mode: 'fixed', amount: '20', percent: '' },
    });
    expect(MomentumOverrideConfigSchema.parse({ ema: { fast: 5, slow: 10 } })).toEqual({
      ema: { fast: 5, slow: 10 },
    });
    expect(() => MomentumOverrideConfigSchema.parse({ candleInterval: '5m' })).toThrow();
  });

  it('accepts per-symbol overrides of the gate and exit levers', () => {
    // A discovery-picked altcoin can tune its own trend filter, entry margin,
    // protective stop, and extension guard — each independent of the BTC-tuned
    // profile default. A scalar override passes its value through verbatim.
    expect(MomentumOverrideConfigSchema.parse({ entryMarginPct: '0.03' })).toEqual({
      entryMarginPct: '0.03',
    });
    // A partial block override is shape-valid (each leaf defaults). The API
    // stores and deep-merges the RAW override, so only the changed field lands.
    for (const override of [
      { trendFilter: { period: 100 } },
      { protectiveStop: { limitOffsetPercentage: '0.97' } },
      { entryExtension: { maxPercent: '0.25' } },
      { atrTrailingStop: { enabled: true, multiple: '2.5' } },
    ]) {
      expect(MomentumOverrideConfigSchema.safeParse(override).success).toBe(true);
    }
  });

  it('deep-merges a raw partial block override, leaving the profile fields intact', () => {
    // The real inheritance path: the stored raw override merges onto the profile
    // config, so overriding trendFilter.period keeps the profile's enabled/maType.
    const profile = cfg({ trendFilter: { enabled: true, maType: 'sma', period: 200 } });
    const merged = mergeConfig(profile, { trendFilter: { period: 100 } });
    expect(merged.trendFilter).toEqual({
      enabled: true,
      maType: 'sma',
      period: 100,
      requireRising: false,
      slopeLookbackBars: 10,
    });
  });

  it('does not throw when a partial trendFilter override enables the filter without a period', () => {
    // The #564 use case: enable the trend filter for one discovery symbol without
    // carrying period. Merged onto a profile with no trendFilter block, the raw
    // override leaves period undefined; the gate must coerce it (not feed
    // undefined to sma/ema, which throw) and hold, never crash the tick.
    const merged = mergeConfig(cfg(), { trendFilter: { enabled: true } });
    const out = momentum.tick(
      mkInput({ closes: mkCandles(CROSS_UP), currentPrice: '14', state: flat(), config: merged }),
    );
    expect(out.decisions).toEqual([{ type: 'noop' }]);
    expect(out.nextState.entryBlocker?.reason).toBe('insufficient-history');
  });

  it('still rejects the account-wide reserve cap as a per-symbol override', () => {
    // accountCap is a cap on the account's total deployment, so a per-symbol
    // value is meaningless; the strict override keeps rejecting it.
    expect(() =>
      MomentumOverrideConfigSchema.parse({
        accountCap: { mode: 'percentOfAccount', percent: '0.5' },
      }),
    ).toThrow();
  });
});

describe('strategy assembly', () => {
  it('declares force-sell + the override bundle, but no grid or manual buy', () => {
    expect(momentum.name).toBe('momentum');
    expect(momentum.position).toBe(momentumPositionAdapter);
    // Force-sell only: the operator can flatten a held position, nothing else.
    expect(momentum.capabilities.operatorActions).toEqual(['trigger-sell']);
    // No grid, no manual BUY: those actions are not declared.
    expect(momentum.capabilities.operatorActions).not.toContain('reset-grid');
    expect(momentum.capabilities.operatorActions).not.toContain('trigger-buy');
    expect(momentum.capabilities.operatorActions).not.toContain('manual-order');
    // Reads the override slot to receive the force-sell.
    expect(momentum.capabilities.bundleProviders).toEqual(['override']);
    expect(momentum.capabilities.needsUserDataStream).toBe(true);
    expect(momentum.capabilities.needsMiniTicker).toBe(true);
    expect(momentum.initialState(defaultMomentumConfig())).toEqual(initialMomentumState());
  });
});

// Macro trend filter: gates ENTRY on a long-term MA so the strategy sits out
// confirmed downtrends; the exit path never consults it. The gate compares the
// LIVE price to the MA of the candle closes, so these tests fire the EMA cross
// from CROSS_UP and drive the gate via currentPrice (above vs below the line).
describe('momentum.tick — trend filter', () => {
  it('enters on a cross-up when the filter is OFF, even below the line', () => {
    const out = momentum.tick(
      mkInput({
        closes: mkCandles(CROSS_UP),
        currentPrice: '9',
        state: flat(),
        config: cfg({ trendFilter: { enabled: false, period: 3 } }),
      }),
    );
    expect(out.decisions[0]?.type).toBe('place-order');
  });

  it('suppresses an entry while price is below the trend line', () => {
    // sma(3) of [10,8,14] = 10.67; live price 9 is below it -> sit out.
    const out = momentum.tick(
      mkInput({
        closes: mkCandles(CROSS_UP),
        currentPrice: '9',
        state: flat(),
        config: cfg({ trendFilter: { enabled: true, period: 3 } }),
      }),
    );
    expect(out.decisions).toEqual([{ type: 'noop' }]);
    expect(out.metrics).toEqual([
      { name: 'momentum.skip', value: 1, tags: { side: 'entry', reason: 'below-trend' } },
    ]);
    expect(out.nextState).toEqual({ ...flat(), entryBlocker: { reason: 'below-trend' } });
    expect(out.nextState.entryBlocker?.reason).toBe('below-trend');
  });

  it('allows an entry while price is above the trend line', () => {
    // sma(3) = 10.67; live price 14 is above it -> enter on the cross-up.
    const out = momentum.tick(
      mkInput({
        closes: mkCandles(CROSS_UP),
        currentPrice: '14',
        state: flat(),
        config: cfg({ trendFilter: { enabled: true, period: 3 } }),
      }),
    );
    expect(out.decisions[0]).toMatchObject({ type: 'place-order', intent: { side: 'BUY' } });
    // An entry clears any prior blocker so the next re-block is a fresh transition.
    expect(out.nextState.entryBlocker).toBeNull();
  });

  it('fails closed with a distinct reason when the window is too short', () => {
    const out = momentum.tick(
      mkInput({
        closes: mkCandles(CROSS_UP), // 4 candles, period 10 unreachable
        currentPrice: '14',
        state: flat(),
        config: cfg({ trendFilter: { enabled: true, period: 10 } }),
      }),
    );
    expect(out.decisions).toEqual([{ type: 'noop' }]);
    expect(out.metrics).toEqual([
      { name: 'momentum.skip', value: 1, tags: { side: 'entry', reason: 'insufficient-history' } },
    ]);
    expect(out.nextState.entryBlocker?.reason).toBe('insufficient-history');
  });

  it('gates with an EMA trend line too', () => {
    // ema(3) of CROSS_UP = 12; live price 9 is below it -> suppressed.
    const out = momentum.tick(
      mkInput({
        closes: mkCandles(CROSS_UP),
        currentPrice: '9',
        state: flat(),
        config: cfg({ trendFilter: { enabled: true, maType: 'ema', period: 3 } }),
      }),
    );
    expect(out.decisions).toEqual([{ type: 'noop' }]);
  });

  it('never gates an exit: an open long holds while the filter is enabled', () => {
    // Flat price: no trail hit, no cross-down -> the long rides. The exit path
    // never consults the trend filter, so enabling it injects no SELL.
    const out = momentum.tick(
      mkInput({
        closes: mkCandles(['100', '100', '100', '100']),
        currentPrice: '100',
        state: longState({ entryPrice: '100', highSinceEntry: '100', heldQuantity: '1' }),
        config: cfg({ trendFilter: { enabled: true, period: 4 } }),
      }),
    );
    const sells = out.decisions.filter((d) => d.type === 'place-order' && d.intent.side === 'SELL');
    expect(sells).toHaveLength(0);
  });

  // Slope veto. All three reuse the proven CROSS_UP tail (['12','10','8','14'])
  // with a 2-candle prefix that only moves the sma(3) value `slopeLookbackBars`
  // back, so the EMA cross still fires on the last candle while the trend-line
  // slope is set independently. Live price 14 sits above sma(3)=(10+8+14)/3=10.67
  // in every case, so only the slope decides.
  const SLOPE_CFG = {
    enabled: true,
    maType: 'sma' as const,
    period: 3,
    requireRising: true,
    slopeLookbackBars: 3,
  };

  it('allows the entry when price is above the line and the line is rising', () => {
    // Proven CROSS_UP tail with a 1-bar slope: sma(3) now = (10+8+14)/3 = 10.67,
    // one bar back = (12+10+8)/3 = 10 -> rising. Price 14 is above the line, so
    // the entry is admitted.
    const out = momentum.tick(
      mkInput({
        closes: mkCandles(CROSS_UP),
        currentPrice: '14',
        state: flat(),
        config: cfg({
          trendFilter: {
            enabled: true,
            maType: 'sma',
            period: 3,
            requireRising: true,
            slopeLookbackBars: 1,
          },
        }),
      }),
    );
    expect(out.decisions[0]).toMatchObject({ type: 'place-order', intent: { side: 'BUY' } });
  });

  it('vetoes the entry when price is above the line but the line is falling', () => {
    // High prefix [14,14]: sma(3) three bars back = (14+14+12)/3 = 13.33 > 10.67
    // -> falling. Price is above the line, so only the slope veto can block here:
    // the bear-rally signature the price-only gate misses.
    const out = momentum.tick(
      mkInput({
        closes: mkCandles(['14', '14', '12', '10', '8', '14']),
        currentPrice: '14',
        state: flat(),
        config: cfg({ trendFilter: SLOPE_CFG }),
      }),
    );
    expect(out.decisions).toEqual([{ type: 'noop' }]);
    expect(out.metrics).toEqual([
      { name: 'momentum.skip', value: 1, tags: { side: 'entry', reason: 'falling-trend' } },
    ]);
    expect(out.nextState).toEqual({ ...flat(), entryBlocker: { reason: 'falling-trend' } });
  });

  it('fails closed when the window cannot reach slopeLookbackBars back', () => {
    // 5 candles, but period 3 + slopeLookbackBars 3 = 6 needed to read the line
    // three bars back -> insufficient-history, not a falling-trend guess.
    const out = momentum.tick(
      mkInput({
        closes: mkCandles(['14', '12', '10', '8', '14']),
        currentPrice: '14',
        state: flat(),
        config: cfg({ trendFilter: SLOPE_CFG }),
      }),
    );
    expect(out.decisions).toEqual([{ type: 'noop' }]);
    expect(out.metrics).toEqual([
      { name: 'momentum.skip', value: 1, tags: { side: 'entry', reason: 'insufficient-history' } },
    ]);
  });

  it('leaves the price-only gate intact when requireRising is off (falling line, price above)', () => {
    // Same falling-line series, requireRising off: the slope is never consulted,
    // so price-above-line alone admits the entry. Proves the veto is opt-in and
    // the prior price-only behaviour is unchanged by default.
    const out = momentum.tick(
      mkInput({
        closes: mkCandles(['14', '14', '12', '10', '8', '14']),
        currentPrice: '14',
        state: flat(),
        config: cfg({ trendFilter: { enabled: true, maType: 'sma', period: 3 } }),
      }),
    );
    expect(out.decisions[0]).toMatchObject({ type: 'place-order', intent: { side: 'BUY' } });
  });

  it('vetoes on a falling EMA trend line too, not only SMA', () => {
    // Same falling series under an EMA line: ema(3) now = 11.92, three bars back
    // (slice [14,14,12]) = 13.33 -> falling. Price 14 is above the current line,
    // so only the EMA slope veto blocks. Covers the maType='ema' slope arm.
    const out = momentum.tick(
      mkInput({
        closes: mkCandles(['14', '14', '12', '10', '8', '14']),
        currentPrice: '14',
        state: flat(),
        config: cfg({
          trendFilter: {
            enabled: true,
            maType: 'ema',
            period: 3,
            requireRising: true,
            slopeLookbackBars: 3,
          },
        }),
      }),
    );
    expect(out.metrics).toEqual([
      { name: 'momentum.skip', value: 1, tags: { side: 'entry', reason: 'falling-trend' } },
    ]);
  });

  // The live worker reads stored config UNPARSED, so the slope fields can arrive
  // raw: missing (an older config the operator hand-extended), out of range, or a
  // wrong JSON type (a hand-edited row). The gate coerces all rather than crashing
  // or bricking. The raw casts mirror that unparsed shape, which a parsed cfg() cannot.
  const rawTrendFilter = (tf: Record<string, unknown>): MomentumConfig => ({
    ...cfg(),
    trendFilter: tf as unknown as MomentumConfig['trendFilter'],
  });

  it('defaults a missing slopeLookbackBars to 10 when requireRising is set on a raw config', () => {
    // requireRising on, slopeLookbackBars absent -> k defaults to 10, so period 2
    // needs 12 candles; the 4-candle CROSS_UP is too short -> insufficient-history.
    // Without the default, k would be undefined and the length guard would not fire.
    const out = momentum.tick(
      mkInput({
        closes: mkCandles(CROSS_UP),
        currentPrice: '14',
        state: flat(),
        config: rawTrendFilter({ enabled: true, maType: 'sma', period: 2, requireRising: true }),
      }),
    );
    expect(out.metrics).toEqual([
      { name: 'momentum.skip', value: 1, tags: { side: 'entry', reason: 'insufficient-history' } },
    ]);
  });

  it('coerces a zero slopeLookbackBars up to 1 so a hand-edited config cannot brick entries', () => {
    // slopeLookbackBars 0 (a hand edit; the schema forbids it) would make the line
    // equal itself and read as flat -> falling-trend, blocking every entry. Coerced
    // to 1, the rising CROSS_UP line (10.67 now vs 10 one bar back) admits the entry.
    const out = momentum.tick(
      mkInput({
        closes: mkCandles(CROSS_UP),
        currentPrice: '14',
        state: flat(),
        config: rawTrendFilter({
          enabled: true,
          maType: 'sma',
          period: 3,
          requireRising: true,
          slopeLookbackBars: 0,
        }),
      }),
    );
    expect(out.decisions[0]).toMatchObject({ type: 'place-order', intent: { side: 'BUY' } });
  });

  it('treats a raw string slopeLookbackBars as the number, not a string concatenation', () => {
    // A hand-edited JSON string "3" must coerce to 3, not make `period + "3"` a
    // string that inflates the history guard and bricks entries. Here it reads the
    // line three bars back (falling, 13.33 > 10.67) and vetoes as expected.
    const out = momentum.tick(
      mkInput({
        closes: mkCandles(['14', '14', '12', '10', '8', '14']),
        currentPrice: '14',
        state: flat(),
        config: rawTrendFilter({
          enabled: true,
          maType: 'sma',
          period: 3,
          requireRising: true,
          slopeLookbackBars: '3',
        }),
      }),
    );
    expect(out.metrics).toEqual([
      { name: 'momentum.skip', value: 1, tags: { side: 'entry', reason: 'falling-trend' } },
    ]);
  });
});

// entryBlocker is the queryable per-reason suppression breadcrumb the generic
// worker path turns into action_log rows. The strategy's contract is only that a
// suppressed tick sets a stable `{reason}` and an entry clears it to null; the
// on-change append itself lives in the worker and is not exercised here.
describe('momentum.tick — entryBlocker traceability', () => {
  const trend = cfg({ trendFilter: { enabled: true, period: 3 } });

  it('holds a stable reason across repeat suppressions and switches on a different one', () => {
    // Two consecutive below-trend suppressions carry the identical reason, so the
    // worker's on-change append no-ops on the second tick.
    const a = momentum.tick(
      mkInput({ closes: mkCandles(CROSS_UP), currentPrice: '9', state: flat(), config: trend }),
    );
    const b = momentum.tick(
      mkInput({
        closes: mkCandles(CROSS_UP),
        currentPrice: '9',
        state: a.nextState,
        config: trend,
      }),
    );
    expect(a.nextState.entryBlocker?.reason).toBe('below-trend');
    expect(b.nextState.entryBlocker?.reason).toBe(a.nextState.entryBlocker?.reason);

    // A different suppression cause (budget below minNotional) is a fresh reason,
    // so the worker would append a new row: a transition, not a no-op.
    const c = momentum.tick(
      mkInput({
        closes: mkCandles(CROSS_UP),
        currentPrice: '14',
        state: flat(),
        config: cfg({ entrySizing: { mode: 'fixed', amount: '5' } }),
      }),
    );
    expect(c.nextState.entryBlocker?.reason).toBe('min-notional');
    expect(c.nextState.entryBlocker?.reason).not.toBe(a.nextState.entryBlocker?.reason);
  });

  it('clears the blocker on entry so a later re-block is a fresh transition', () => {
    // Block: live price below the sma(3)=10.67 trend line.
    const blocked = momentum.tick(
      mkInput({ closes: mkCandles(CROSS_UP), currentPrice: '9', state: flat(), config: trend }),
    );
    expect(blocked.nextState.entryBlocker?.reason).toBe('below-trend');

    // Entry: price above the line, feeding the blocked state forward. The entry
    // clears the blocker to null so the next block is a genuine null -> reason edge.
    const entered = momentum.tick(
      mkInput({
        closes: mkCandles(CROSS_UP),
        currentPrice: '14',
        state: blocked.nextState,
        config: trend,
      }),
    );
    expect(entered.decisions[0]).toMatchObject({ type: 'place-order', intent: { side: 'BUY' } });
    expect(entered.nextState.entryBlocker).toBeNull();
  });
});

describe('momentum.tick — extension guard', () => {
  // sma(3) over CROSS_UP's last three closes [10,8,14] = 10.6667; ema(3) = 12.
  // trendFilter stays OFF so only the extension ceiling decides.
  it('enters on a cross-up when the guard is OFF, even far above the baseline', () => {
    const out = momentum.tick(
      mkInput({
        closes: mkCandles(CROSS_UP),
        currentPrice: '14',
        state: flat(),
        config: cfg({ entryExtension: { enabled: false, period: 3 } }),
      }),
    );
    expect(out.decisions[0]?.type).toBe('place-order');
  });

  it('suppresses an entry when price is stretched above the baseline ceiling', () => {
    // sma(3)=10.6667; ceiling = 10.6667 * 1.2 = 12.8; live price 14 is above it.
    const out = momentum.tick(
      mkInput({
        closes: mkCandles(CROSS_UP),
        currentPrice: '14',
        state: flat(),
        config: cfg({
          entryExtension: { enabled: true, maType: 'sma', period: 3, maxPercent: '0.2' },
        }),
      }),
    );
    expect(out.decisions).toEqual([{ type: 'noop' }]);
    expect(out.metrics).toEqual([
      { name: 'momentum.skip', value: 1, tags: { side: 'entry', reason: 'overextended' } },
    ]);
    expect(out.nextState).toEqual({ ...flat(), entryBlocker: { reason: 'overextended' } });
    expect(out.nextState.entryBlocker?.reason).toBe('overextended');
  });

  it('allows an entry when price is within the baseline ceiling', () => {
    // ceiling = 10.6667 * 1.2 = 12.8; live price 12 is below it -> enter.
    const out = momentum.tick(
      mkInput({
        closes: mkCandles(CROSS_UP),
        currentPrice: '12',
        state: flat(),
        config: cfg({
          entryExtension: { enabled: true, maType: 'sma', period: 3, maxPercent: '0.2' },
        }),
      }),
    );
    expect(out.decisions[0]).toMatchObject({ type: 'place-order', intent: { side: 'BUY' } });
    expect(out.nextState.entryBlocker).toBeNull();
  });

  it('fails closed with its own extension-insufficient-history when the window is shorter than the period', () => {
    const out = momentum.tick(
      mkInput({
        closes: mkCandles(CROSS_UP), // 4 candles, period 10 unreachable
        currentPrice: '14',
        state: flat(),
        config: cfg({ entryExtension: { enabled: true, period: 10 } }),
      }),
    );
    expect(out.decisions).toEqual([{ type: 'noop' }]);
    expect(out.metrics).toEqual([
      {
        name: 'momentum.skip',
        value: 1,
        tags: { side: 'entry', reason: 'extension-insufficient-history' },
      },
    ]);
    expect(out.nextState.entryBlocker?.reason).toBe('extension-insufficient-history');
  });

  it('measures extension against an EMA baseline too', () => {
    // ema(3) of CROSS_UP = 12; ceiling = 12 * 1.05 = 12.6; live price 14 exceeds it.
    const out = momentum.tick(
      mkInput({
        closes: mkCandles(CROSS_UP),
        currentPrice: '14',
        state: flat(),
        config: cfg({
          entryExtension: { enabled: true, maType: 'ema', period: 3, maxPercent: '0.05' },
        }),
      }),
    );
    expect(out.decisions).toEqual([{ type: 'noop' }]);
    expect(out.nextState.entryBlocker?.reason).toBe('overextended');
  });

  it('never gates an exit: an open long holds while the guard is enabled', () => {
    const out = momentum.tick(
      mkInput({
        closes: mkCandles(['100', '100', '100', '100']),
        currentPrice: '100',
        state: longState({ entryPrice: '100', highSinceEntry: '100', heldQuantity: '1' }),
        config: cfg({ entryExtension: { enabled: true, period: 3, maxPercent: '0.001' } }),
      }),
    );
    const sells = out.decisions.filter((d) => d.type === 'place-order' && d.intent.side === 'SELL');
    expect(sells).toHaveLength(0);
  });

  it('runs after the trend gate: a below-trend sit-out reports below-trend, not overextended', () => {
    // Price 9 is below sma(3)=10.6667, so the trend gate vetoes first; the
    // extension ceiling is never consulted.
    const out = momentum.tick(
      mkInput({
        closes: mkCandles(CROSS_UP),
        currentPrice: '9',
        state: flat(),
        config: cfg({
          trendFilter: { enabled: true, maType: 'sma', period: 3 },
          entryExtension: { enabled: true, maType: 'sma', period: 3, maxPercent: '0.001' },
        }),
      }),
    );
    expect(out.nextState.entryBlocker?.reason).toBe('below-trend');
  });

  it('coerces an unparsed non-numeric period to the default and fails closed on the short window', () => {
    // The live worker stores config unparsed: period arrives as a raw string.
    // parseInt('x') is NaN -> falls back to 50, which the 4-candle window cannot
    // reach -> insufficient-history rather than a guess.
    const config = {
      ...cfg(),
      entryExtension: { enabled: true, period: 'x', maxPercent: '0.2' },
    } as unknown as MomentumConfig;
    const out = momentum.tick(
      mkInput({ closes: mkCandles(CROSS_UP), currentPrice: '14', state: flat(), config }),
    );
    expect(out.nextState.entryBlocker?.reason).toBe('extension-insufficient-history');
  });

  it('coerces a finite-but-below-2 period to the default, failing closed on the short window', () => {
    // period 1 is a degenerate baseline; the >= 2 floor sends it to 50, which the
    // 4-candle window cannot reach -> extension-insufficient-history.
    const config = {
      ...cfg(),
      entryExtension: { enabled: true, period: 1, maxPercent: '0.2' },
    } as unknown as MomentumConfig;
    const out = momentum.tick(
      mkInput({ closes: mkCandles(CROSS_UP), currentPrice: '14', state: flat(), config }),
    );
    expect(out.nextState.entryBlocker?.reason).toBe('extension-insufficient-history');
  });

  it('falls back to the default ceiling when maxPercent is non-positive or malformed', () => {
    // Fallback ceiling = sma(3)=10.6667 * (1 + 0.4) = 14.93; live price 12 is
    // within it -> enter. Covers both the <=0 and the throw coercion branches.
    const zero = {
      ...cfg(),
      entryExtension: { enabled: true, period: 3, maxPercent: '0' },
    } as unknown as MomentumConfig;
    const malformed = {
      ...cfg(),
      entryExtension: { enabled: true, period: 3, maxPercent: 'abc' },
    } as unknown as MomentumConfig;
    for (const config of [zero, malformed]) {
      const out = momentum.tick(
        mkInput({ closes: mkCandles(CROSS_UP), currentPrice: '12', state: flat(), config }),
      );
      expect(out.decisions[0]).toMatchObject({ type: 'place-order', intent: { side: 'BUY' } });
    }
  });

  it('applies field defaults when an unparsed extension block omits period or maxPercent', () => {
    // period omitted -> 50, which the 4-candle window cannot reach -> fail closed.
    const noPeriod = {
      ...cfg(),
      entryExtension: { enabled: true, maxPercent: '0.2' },
    } as unknown as MomentumConfig;
    expect(
      momentum.tick(
        mkInput({
          closes: mkCandles(CROSS_UP),
          currentPrice: '14',
          state: flat(),
          config: noPeriod,
        }),
      ).nextState.entryBlocker?.reason,
    ).toBe('extension-insufficient-history');
    // maxPercent omitted -> 0.4 ceiling (sma(3)=10.6667 * 1.4 = 14.93); price 12 within -> enter.
    const noMax = {
      ...cfg(),
      entryExtension: { enabled: true, period: 3 },
    } as unknown as MomentumConfig;
    expect(
      momentum.tick(
        mkInput({ closes: mkCandles(CROSS_UP), currentPrice: '12', state: flat(), config: noMax }),
      ).decisions[0],
    ).toMatchObject({ type: 'place-order', intent: { side: 'BUY' } });
  });
});

// The -2010 storm, at the strategy boundary. A deleted profile's protective stop
// was left resting on Binance and adopted into this profile; it LOCKS the whole
// position, so a stop sized from the tracked quantity can never fill — Binance
// answers -2010 to every attempt, and a stop re-derived each tick is re-sent
// forever. The strategy must not emit it at all.
describe('protective stop — a foreign resting SELL holding the base', () => {
  const FOREIGN = psOrder({ orderId: 999, clientOrderId: 'legacy-deleted-profile-stop' });
  const NO_FREE_BASE = {
    USDT: QUOTE_BALANCE,
    BTC: { asset: 'BTC', free: new Decimal('0'), locked: new Decimal('1') },
  };

  it('findForeignRestingSell matches only a live SELL that is not ours', () => {
    const ours = protectiveStopClientOrderId('p1', 'BTCUSDT');
    expect(findForeignRestingSell([FOREIGN], ours, 'BTCUSDT')?.orderId).toBe(999);
    expect(
      findForeignRestingSell([psOrder({ clientOrderId: ours })], ours, 'BTCUSDT'),
    ).toBeUndefined();
    expect(findForeignRestingSell([psOrder({ side: 'BUY' })], ours, 'BTCUSDT')).toBeUndefined();
    expect(
      findForeignRestingSell([psOrder({ status: 'FILLED' })], ours, 'BTCUSDT'),
    ).toBeUndefined();
    expect(
      findForeignRestingSell(
        [psOrder({ clientOrderId: 'x', status: 'PARTIALLY_FILLED' })],
        ours,
        'BTCUSDT',
      )?.orderId,
    ).toBe(555);
    expect(findForeignRestingSell([], ours, 'BTCUSDT')).toBeUndefined();
  });

  it('refuses to place the stop, and neither cancels the foreign order nor blocks entries', () => {
    const out = armOut(
      armInput({ openOrders: [FOREIGN], balances: NO_FREE_BASE }),
      longState(),
      HIGH,
    );
    // No place (it could only be rejected) and NO cancel: `openOrders` is a TTL
    // cache that can be stale, and cancelling an order we did not place could
    // strip the operator's own protection.
    expect(out.decisions).toEqual([]);
    expect(out.blocker).toMatchObject({
      reason: 'base-locked-by-foreign-order',
      detail: { foreignOrderId: 999, required: '1.000', free: '0' },
    });
  });

  // FAIL OPEN, deliberately. A cold or malformed `account-info` degrades to an
  // unreadable snapshot (`readable: false`): that is "we cannot read the wallet",
  // not "zero free". Reading it as zero would refuse the stop on every symbol the
  // moment Redis went cold — an unprotected open position, strictly worse than the
  // single Binance rejection this guard exists to avoid. The executor's own
  // pre-flight fails open on the same input and is the backstop. An absent line in
  // a READABLE map is a different claim (a hard zero) and is covered separately.
  it('an UNREADABLE wallet still arms the stop — refusing needs proof', () => {
    const out = armOut(
      armInput({ openOrders: [FOREIGN], balances: {}, readable: false }),
      longState(),
      HIGH,
    );
    expect(out.blocker).toBeNull();
    expect(out.decisions[0]).toMatchObject({ type: 'place-order', intent: { side: 'SELL' } });
  });

  // Two momentum profiles on one symbol each see the other's stop as foreign. The
  // refusal must not deadlock them: while the wallet can fund both stops, both arm.
  it('still arms when the free base covers the stop despite a foreign resting SELL', () => {
    const out = armOut(
      armInput({
        openOrders: [FOREIGN],
        balances: {
          USDT: QUOTE_BALANCE,
          BTC: { asset: 'BTC', free: new Decimal('5'), locked: new Decimal('1') },
        },
      }),
      longState(),
      HIGH,
    );
    expect(out.blocker).toBeNull();
    expect(out.decisions).toHaveLength(1);
    expect(out.decisions[0]).toMatchObject({ type: 'place-order', intent: { side: 'SELL' } });
  });

  // Our OWN resting stop locks the base too, but we cancel it in the same batch,
  // which frees it before the replacement is sent — no refusal is owed there.
  it('re-prices our own resting stop even with zero free base', () => {
    const out = armOut(
      armInput({
        openOrders: [psOrder({ stopPrice: '80.00' })],
        balances: NO_FREE_BASE,
      }),
      longState(),
      HIGH,
    );
    expect(out.blocker).toBeNull();
    expect(out.decisions.map((d) => d.type)).toEqual(['cancel-order', 'place-order']);
  });

  it('the held-long tick records the blocker on state and emits no order', () => {
    const out = momentum.tick(
      armInput({ openOrders: [FOREIGN], balances: NO_FREE_BASE, state: longState() }),
    );
    expect(out.decisions).toEqual([{ type: 'noop' }]);
    expect(out.nextState.protectiveStopBlocker?.reason).toBe('base-locked-by-foreign-order');
    // Scope: the stop-arm only. The position stays open and the entry path is
    // untouched — this never suppresses an entry.
    expect(out.nextState.entryPrice).toBe('100');
    expect(out.nextState.entryBlocker).toBeNull();
  });

  it('logs a stop still covered at its previous level at info, not warn', () => {
    // The exchange band refuses the re-price while our own stop keeps resting at
    // the old trigger, so the position IS covered. A winning trail can sit
    // outside the band for hours; warning every tick through it is how the real
    // "no stop at all" warning gets skimmed past.
    const out = momentum.tick(
      armInput({
        openOrders: [psOrder({ stopPrice: '80.00' })],
        filters: {
          ...FILTERS,
          percentPriceBySide: {
            askMultiplierUp: '5',
            askMultiplierDown: '0.99',
            bidMultiplierUp: '5',
            bidMultiplierDown: '0.2',
            avgPriceMins: 5,
          },
        },
      }),
    );
    // Neither half of the re-arm goes out, and the resting stop is left alone.
    expect(out.decisions).toEqual([{ type: 'noop' }]);
    expect(out.nextState.protectiveStopBlocker).toMatchObject({
      reason: 'price-outside-exchange-band',
      detail: { guarded: true },
    });
    expect(out.logs[0]).toMatchObject({
      level: 'info',
      message: 'momentum: protective stop held at its previous level',
    });
  });

  it('clears the blocker on the tick the stop finally arms', () => {
    const blocked = longState({
      protectiveStopBlocker: { reason: 'base-locked-by-foreign-order' },
    });
    const out = momentum.tick(armInput({ state: blocked }));
    expect(out.nextState.protectiveStopBlocker).toBeNull();
    expect(out.decisions[0]).toMatchObject({ type: 'place-order', intent: { side: 'SELL' } });
  });
});

// Standing down entirely is an all-or-nothing answer to a partial problem: a
// ghost order that locks 2.4% of the base leaves 97.6% protectable, and today
// none of it is protected.
describe('protective stop — a foreign order locking PART of the base (#613)', () => {
  const GHOST = psOrder({
    orderId: 999,
    clientOrderId: 'legacy-deleted-profile-stop',
    origQty: '0.0085',
  });

  it('arms on the FREE remainder instead of protecting nothing', () => {
    // Live shape: held 0.3526, free 0.3441, the ghost locks 0.0085 (2.4%).
    const out = armOut(
      armInput({
        openOrders: [GHOST],
        balances: {
          USDT: QUOTE_BALANCE,
          BTC: { asset: 'BTC', free: new Decimal('0.3441'), locked: new Decimal('0.0085') },
        },
      }),
      longState({ heldQuantity: '0.3526' }),
      HIGH,
    );
    // 0.3441 floored to stepSize 0.001 = 0.344; notional 0.344 × 95 = 32.68 ≥ 10.
    expect(out.decisions).toHaveLength(1);
    expect(out.decisions[0]).toMatchObject({
      type: 'place-order',
      intent: { side: 'SELL', reason: 'protective-stop' },
      params: { type: 'STOP_LOSS_LIMIT', quantity: '0.344', stopPrice: '95.00' },
    });
  });

  // Regression lock on the EXISTING stand-down: with nothing usable free there is
  // no partial stop to arm, so refusing (and saying why) stays correct.
  it('stands down with a blocker when the free remainder is zero', () => {
    const out = armOut(
      armInput({
        openOrders: [psOrder({ orderId: 999, clientOrderId: 'legacy-deleted-profile-stop' })],
        balances: {
          USDT: QUOTE_BALANCE,
          BTC: { asset: 'BTC', free: new Decimal('0'), locked: new Decimal('1') },
        },
      }),
      longState(),
      HIGH,
    );
    expect(out.decisions).toEqual([]);
    expect(out.blocker?.reason).toBe('base-locked-by-foreign-order');
  });

  // No foreign order to blame: the wallet simply holds less base than the tracked
  // position (drift, a withdrawal, or the operator's base reserve, which the worker
  // subtracts from `free` before the strategy sees it). Silence here is the same
  // defect as the foreign-lock silence, so it gets its own blocker — and the resting
  // stop is LEFT alone: cancelling a live stop we merely cannot resize strips real
  // protection from an open position.
  it('blocks (and keeps the resting stop) when the free base is below the exchange minimum', () => {
    // Our own stop rests on a dust 0.001 and the wallet holds nothing else, so the
    // most we could re-commit is 0.001 — below minNotional at stop 95.
    const out = armOut(
      armInput({
        openOrders: [psOrder({ origQty: '0.001' })],
        balances: {
          USDT: QUOTE_BALANCE,
          BTC: { asset: 'BTC', free: new Decimal('0'), locked: new Decimal('0.001') },
        },
      }),
      longState(),
      HIGH,
    );
    expect(out.decisions).toEqual([]);
    expect(out.blocker).toMatchObject({
      reason: 'base-below-exchange-minimum',
      detail: { required: '1.000', free: '0', available: '0.001' },
    });
  });

  it('blocks with base-short-of-tracked-position when no base is free at all', () => {
    const out = armOut(
      armInput({
        balances: {
          USDT: QUOTE_BALANCE,
          BTC: { asset: 'BTC', free: new Decimal('0'), locked: new Decimal('0') },
        },
      }),
      longState(),
      HIGH,
    );
    expect(out.decisions).toEqual([]);
    expect(out.blocker?.reason).toBe('base-short-of-tracked-position');
  });

  it('stands down with a blocker when the free remainder is below minNotional', () => {
    // free 0.05 × stop 95 = 4.75 < minNotional 10 ⇒ no armable partial stop.
    const out = armOut(
      armInput({
        openOrders: [GHOST],
        balances: {
          USDT: QUOTE_BALANCE,
          BTC: { asset: 'BTC', free: new Decimal('0.05'), locked: new Decimal('0.95') },
        },
      }),
      longState(),
      HIGH,
    );
    expect(out.decisions).toEqual([]);
    expect(out.blocker?.reason).toBe('base-locked-by-foreign-order');
  });
});

describe('protective stop — quantity drift on the resting stop (#613)', () => {
  it('re-arms at the full quantity when the resting stop is materially undersized', () => {
    // Our stop was armed at 0.100 while a foreign order locked the rest; that lock
    // has cleared, so the desired quantity is the full 1.000. The trigger is
    // UNCHANGED (95.00), so the price-drift band does not fire — and quantity is
    // never compared, leaving 90% of the position unprotected forever.
    const out = armOut(
      armInput({
        openOrders: [psOrder({ origQty: '0.100', stopPrice: '95.00' })],
        balances: {
          USDT: QUOTE_BALANCE,
          BTC: { asset: 'BTC', free: new Decimal('0.9'), locked: new Decimal('0.1') },
        },
      }),
      longState(),
      HIGH,
    );
    expect(out.decisions.map((d) => d.type)).toEqual(['cancel-order', 'place-order']);
    expect(out.decisions[1]).toMatchObject({
      params: { type: 'STOP_LOSS_LIMIT', quantity: '1.000', stopPrice: '95.00' },
    });
  });
});

// An UNREADABLE wallet (a cold or malformed account-info degrades the balance map
// to `{}`) is ignorance, not a zero balance: the arm must fall back on the tracked
// position rather than leave an open holding undefended. But a base line ABSENT
// from a POPULATED map is Binance stating we hold none of it — arming the tracked
// quantity there is an unfundable order, rejected -2010 on every tick.
describe('protective stop — unknown wallet vs known-zero base', () => {
  it('refuses to arm when the base line is absent from a populated map', () => {
    const out = armOut(armInput({ balances: { USDT: QUOTE_BALANCE } }), longState(), HIGH);
    expect(out.decisions).toEqual([]);
    expect(out.blocker?.reason).toBe('base-short-of-tracked-position');
  });

  it('refuses to arm on a known-zero base line even when our own stop rests', () => {
    // The account snapshot outranks the TTL-cached openOrders view: base locked by
    // a live stop would show as a PRESENT line with locked>0, so an absent line
    // means that stop already filled. Arming its quantity is an unfundable order.
    const out = armOut(
      armInput({ openOrders: [psOrder()], balances: { USDT: QUOTE_BALANCE } }),
      longState(),
      HIGH,
    );
    expect(out.decisions.some((d) => d.type === 'place-order')).toBe(false);
    expect(out.blocker).toBeDefined();
  });

  it('still fails OPEN on the tracked position when the snapshot is unreadable', () => {
    const out = armOut(armInput({ balances: {}, readable: false }), longState(), HIGH);
    expect(out.blocker).toBeNull();
    expect(out.decisions).toEqual([
      {
        type: 'place-order',
        intent: {
          symbol: 'BTCUSDT',
          side: 'SELL',
          reason: 'protective-stop',
          clientOrderId: PS_CID,
        },
        params: {
          type: 'STOP_LOSS_LIMIT',
          stopPrice: '95.00',
          price: '93.10',
          quantity: '1.000',
          timeInForce: 'GTC',
        },
      },
    ]);
  });

  it('arms the free remainder when the base line is present but short', () => {
    const out = armOut(
      armInput({
        balances: {
          USDT: QUOTE_BALANCE,
          BTC: { asset: 'BTC', free: new Decimal('0.4'), locked: new Decimal('0') },
        },
      }),
      longState(),
      HIGH,
    );
    expect(out.decisions[0]).toMatchObject({
      params: { type: 'STOP_LOSS_LIMIT', quantity: '0.400' },
    });
  });
});

// ---------------------------------------------------------------------------
// Profit-side ratchet, end to end through tick()
// ---------------------------------------------------------------------------

const MINUTE = 60_000;

/** 1m candles from `startMs`, one per minute, all closed. */
const min1 = (startMs: number, closes: readonly string[]): Candle[] =>
  closes.map((c, i) => ({
    openTimeMs: startMs + i * MINUTE,
    closeTimeMs: startMs + (i + 1) * MINUTE,
    open: c,
    high: c,
    low: c,
    close: c,
    volume: '1',
    isClosed: true,
  }));

// Trading-interval candles flat at the entry price: no EMA cross either way, so
// the only thing that can move is the trail. The hard leg sits at 100 * 0.95 = 95.
const HOLD_SERIES = mkCandles(['100', '100', '100', '100']);

const PROFIT_CFG = cfg({
  protectiveStop: { enabled: true },
  profitTrail: { enabled: true, activationPct: '0.05', trailPct: '0.03', ratchetMinutes: 5 },
});

// Five 1m closes ending on the 5m grid at 130 -> profitHigh 130, armed (>= 105),
// profit stop 130 * 0.97 = 126.10, well above the hard leg's 95.
const RUN_TO_130 = min1(0, ['110', '115', '120', '125', '130']);

// Epoch 0: the position opened before the first candle of every 1m window
// below, so the whole window is eligible to fold. Without it the guard reads the
// absent field as "epoch unknown" and folds nothing.
const heldLong = () => longState({ lastEntryCandleMs: 0, profitTrailSinceMs: 0 });

describe('momentum.tick — profit trail', () => {
  it('exits on the profit leg at a price the hard leg would have held through', () => {
    const out = momentum.tick(
      mkInput({
        closes: HOLD_SERIES,
        currentPrice: '125',
        state: heldLong(),
        config: PROFIT_CFG,
        oneMinute: RUN_TO_130,
      }),
    );
    expect(new Decimal('125').gt('95')).toBe(true);
    expect(out.decisions.at(-1)).toMatchObject({
      type: 'place-order',
      intent: { side: 'SELL', reason: 'exit' },
      params: { type: 'MARKET' },
    });
    expect(out.metrics[0]).toMatchObject({
      name: 'momentum.exit',
      tags: { reason: 'trailing-stop' },
    });
    expect(out.nextState.profitHigh).toBeNull();
  });

  it('persists the mark and mirrors the profit leg in the resting stop while holding', () => {
    const out = momentum.tick(
      mkInput({
        closes: HOLD_SERIES,
        currentPrice: '128',
        state: heldLong(),
        config: PROFIT_CFG,
        oneMinute: RUN_TO_130,
        balances: ARM_BALANCES,
      }),
    );
    expect(out.nextState.profitHigh).toBe('130');
    const place = out.decisions[0];
    expect(place).toMatchObject({
      type: 'place-order',
      intent: { reason: 'protective-stop' },
      params: { type: 'STOP_LOSS_LIMIT', stopPrice: '126.10' },
    });
    // A FIRST arm, so it must not be sheddable: nothing is resting behind it.
    if (place?.type !== 'place-order') throw new Error('expected place-order');
    expect(place.intent.deferrable).toBeUndefined();
  });

  it('establishes the epoch when the state carries none, folding nothing on that tick', () => {
    // An ADOPTED entry (the fill adapter has no candle window to derive an epoch
    // from) and a wallet-reconciled position both arrive with a null epoch.
    // Without establishing one the mark would stay pinned at the entry price for
    // the life of the position and the leg would never arm at all.
    const out = momentum.tick(
      mkInput({
        closes: HOLD_SERIES,
        currentPrice: '128',
        state: longState({ lastEntryCandleMs: 0, profitTrailSinceMs: null }),
        config: PROFIT_CFG,
        oneMinute: RUN_TO_130,
        balances: ARM_BALANCES,
      }),
    );
    // The newest closed 1m close in the window — the same anchor an entry tick
    // would have stamped.
    expect(out.nextState.profitTrailSinceMs).toBe(5 * MINUTE);
    // Every candle in this window opened BEFORE that epoch, so none is eligible:
    // establishing it late can only ever fold fewer closes, never seed the mark
    // with the 130 peak this position may not have held.
    expect(out.nextState.profitHigh).toBe('100');
    expect(out.decisions[0]).toMatchObject({ params: { stopPrice: '95.00' } });
  });

  it('arms on the tick after the epoch is established, from candles that follow it', () => {
    const first = momentum.tick(
      mkInput({
        closes: HOLD_SERIES,
        currentPrice: '128',
        state: longState({ lastEntryCandleMs: 0, profitTrailSinceMs: null }),
        config: PROFIT_CFG,
        oneMinute: RUN_TO_130,
        balances: ARM_BALANCES,
      }),
    );
    // Feed the persisted epoch back with a window that CONTINUES past it, which
    // is what the next real tick sees. The adopted position costs the profit leg
    // one tick, not the whole position.
    const out = momentum.tick(
      mkInput({
        closes: HOLD_SERIES,
        currentPrice: '128',
        state: first.nextState,
        config: PROFIT_CFG,
        oneMinute: min1(5 * MINUTE, ['131', '132', '133', '134', '135']),
        balances: ARM_BALANCES,
      }),
    );
    // The leg is live: it folded to 135, putting the profit stop at 135 * 0.97 =
    // 130.95, and 128 is through it. With the epoch left null the mark would
    // still be pinned at the entry price, the profit stop would sit at 97, and
    // this tick would have held — which is the whole defect.
    expect(out.decisions.at(-1)).toMatchObject({
      type: 'place-order',
      intent: { side: 'SELL', reason: 'exit' },
      params: { type: 'MARKET' },
    });
    expect(out.metrics[0]).toMatchObject({
      name: 'momentum.exit',
      tags: { reason: 'trailing-stop' },
    });
  });

  it('leaves the position untouched while the mark is below the activation threshold', () => {
    // Bucket-end close 104 < 100 * 1.05, so the hard leg's 95 still rules and a
    // price of 100 is nowhere near it.
    const out = momentum.tick(
      mkInput({
        closes: HOLD_SERIES,
        currentPrice: '100',
        state: heldLong(),
        config: PROFIT_CFG,
        oneMinute: min1(0, ['101', '102', '103', '104', '104']),
        balances: ARM_BALANCES,
      }),
    );
    expect(out.nextState.profitHigh).toBe('104');
    expect(out.decisions[0]).toMatchObject({ params: { stopPrice: '95.00' } });
  });

  it('is inert while the trail is off, mark included', () => {
    const out = momentum.tick(
      mkInput({
        closes: HOLD_SERIES,
        currentPrice: '125',
        state: heldLong(),
        config: PS_CFG,
        oneMinute: RUN_TO_130,
        balances: ARM_BALANCES,
      }),
    );
    expect(out.nextState.profitHigh).toBeNull();
    expect(out.decisions[0]).toMatchObject({ params: { stopPrice: '95.00' } });
  });

  it('spends at most 60 / ratchetMinutes placements per hour of rising price', () => {
    // The Layer-1 order-budget claim, as a gate rather than a paragraph: the
    // resting stop cannot be rewritten more often than the ratchet advances the
    // level, no matter how many times the strategy is ticked in between.
    const closes = Array.from({ length: 60 }, (_, i) => new Decimal(110).plus(i).toString());
    const window = min1(0, closes);
    let state = heldLong();
    let resting: OpenOrder | null = null;
    let placements = 0;

    for (let minute = 0; minute < 60; minute += 1) {
      const out = momentum.tick(
        mkInput({
          closes: HOLD_SERIES,
          // Stay well above the trail so the run never exits: the test measures
          // re-arm spend, not exit timing.
          currentPrice: new Decimal(200).plus(minute).toString(),
          state,
          config: PROFIT_CFG,
          oneMinute: window.slice(0, minute + 1),
          openOrders: resting === null ? [] : [resting],
          balances: ARM_BALANCES,
        }),
      );
      state = out.nextState;
      for (const d of out.decisions) {
        if (d.type !== 'place-order' || d.params.type !== 'STOP_LOSS_LIMIT') continue;
        placements += 1;
        resting = psOrder({
          stopPrice: d.params.stopPrice,
          price: d.params.price,
          origQty: d.params.quantity,
        });
      }
    }

    // The first arm lands on the hard leg before the trail has any mark, then
    // one re-price per 5m bucket end — 12 of them in the hour.
    expect(placements).toBe(13);
    expect(placements).toBeLessThanOrEqual(1 + 60 / 5);
  });
});
