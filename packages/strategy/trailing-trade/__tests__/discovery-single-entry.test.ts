// Discovery single-entry + hard-stop + time-stop (issue #438). A "discovery
// entry" is a flat first entry made while `bundle.entryHint.enterOnAdd === true`.
// Discovery picks momentum/breakouts; averaging down into a failed breakout is
// the worst reaction, so a discovery position:
//   1. fail-closed requires a valid hard stop to even arm (Behavior C),
//   2. never averages down — promotions are suppressed (Behavior D),
//   3. carries a durable `discoveryEntry`/`entryAtMs` marker (Behavior E),
//   4. is time-stopped after N closed candles (Behavior F),
//   5. clears its marker on a full close (Behavior G).
// Every new behavior is dormant when no discovery entry exists.

import { describe, expect, it } from 'vitest';
import { Decimal } from '@app/money';
import type { Candle, TickInput } from '@app/strategy-core';
import type { TechnicalsBundle } from '@app/contracts';

import { evaluateGridBuy } from '../src/branches/grid-buy.js';
import { emitForcedFirstEntry } from '../src/branches/first-entry.js';
import { evaluateSellGate } from '../src/branches/sell-gate.js';
import { trailingTrade } from '../src/index.js';
import {
  initialTTState,
  type TTBundle,
  type TTConfig,
  type TTEntryHintBundle,
  type TTState,
} from '../src/schema.js';

const NOW_MS = 1_700_000_000_000;

const intervalRow = (interval: string) => ({
  interval,
  whenStrongBuy: true,
  whenBuy: true,
  whenSell: false,
  whenStrongSell: false,
  whenNeutral: false,
  mode: 'block' as const,
});

const sig = (
  recommendation: 'BUY' | 'SELL' | 'STRONG_SELL' | 'NEUTRAL' | 'STRONG_BUY',
): TechnicalsBundle['signals'][number]['signal'] => ({
  symbol: 'BTCUSDT',
  recommendation,
  maRecommendation: null,
  oscRecommendation: null,
  receivedAtMs: NOW_MS,
  indicators: null,
});

const tv = (
  rows: ReturnType<typeof intervalRow>[],
  signals: { interval: string; signal: TechnicalsBundle['signals'][number]['signal'] }[],
): TechnicalsBundle => ({
  config: { useOnlyWithinMin: 2, ifExpires: 'do-not-buy', intervals: rows },
  signals,
});

// A fresh BUY technicals read (passes both the normal gate and the floor) so the
// entry tests isolate the hard-stop guard, not a technicals veto.
const buyTv = tv([intervalRow('5m')], [{ interval: '5m', signal: sig('BUY') }]);

const candle = (px: string, closeTimeMs = 0, isClosed = true): Candle => ({
  openTimeMs: 0,
  closeTimeMs,
  open: px,
  high: px,
  low: px,
  close: px,
  volume: '1',
  isClosed,
});

const FILTERS = {
  minNotional: '5',
  tickSize: '0.01',
  stepSize: '0.0001',
  minQty: '0.0001',
  maxQty: '1000000',
  minPrice: '0',
  maxPrice: '1000000',
};

// A grid profile (two levels) so a discovery entry COULD otherwise promote; the
// stop/time-stop knobs are overridable per case.
const gridConfig = (overrides?: {
  stopLossPercentage?: string;
  discoveryTimeStopBars?: number;
}): TTConfig =>
  trailingTrade.configSchema.parse({
    symbol: 'BTCUSDT',
    candleInterval: '1h',
    buy: {
      enabled: true,
      entrySizing: { mode: 'fixed', amount: '15' },
      avgEntryPriceRemoveThreshold: '0',
      firstBuyTriggerBasis: 'immediate',
      gridLevels: [
        { triggerPercentage: '1', maxPurchaseAmount: '15' },
        { triggerPercentage: '0.95', maxPurchaseAmount: '15' },
      ],
    },
    sell: {
      enabled: true,
      stopLossPercentage: overrides?.stopLossPercentage ?? '0.97',
      triggerPercentage: '1.05',
      discoveryTimeStopBars: overrides?.discoveryTimeStopBars ?? 0,
    },
    technicals: { useOnlyWithinMin: 2, ifExpires: 'do-not-buy', intervals: [intervalRow('5m')] },
  }) as TTConfig;

const makeInput = (
  config: TTConfig,
  entryHint: TTEntryHintBundle | undefined,
  opts?: {
    currentPrice?: string;
    candles?: Candle[];
    technicals?: TechnicalsBundle;
  },
): TickInput<TTConfig, TTState, TTBundle> =>
  ({
    config,
    market: {
      symbol: 'BTCUSDT',
      currentPrice: opts?.currentPrice ?? '100',
      candlesByInterval: {
        '1h': opts?.candles ?? [candle('100'), candle('100'), candle('100')],
      },
      symbolInfo: {
        symbol: 'BTCUSDT',
        baseAsset: 'BTC',
        quoteAsset: 'USDT',
        status: 'TRADING',
        filters: FILTERS,
      },
    },
    openOrders: [],
    profile: { id: 'p1' },
    account: {
      balances: { USDT: { free: '1000', locked: '0' }, BTC: { free: '0.1', locked: '0' } },
      readable: true,
    },
    bundle: { technicals: opts?.technicals ?? buyTv, override: null, entryHint },
  }) as unknown as TickInput<TTConfig, TTState, TTBundle>;

// ── Behavior C: fail-closed hard stop ──────────────────────────────────────
describe('evaluateGridBuy — discovery fail-closed hard stop (#438)', () => {
  it('refuses to arm a discovery entry when stopLossPercentage is empty', () => {
    const result = evaluateGridBuy(
      makeInput(gridConfig({ stopLossPercentage: '' }), { enterOnAdd: true }),
      initialTTState(),
      NOW_MS,
    );
    expect(result).toMatchObject({ kind: 'skip-guardrail', reason: 'discovery-no-stop' });
  });

  it("refuses when stopLossPercentage is '0' (disabled)", () => {
    const result = evaluateGridBuy(
      makeInput(gridConfig({ stopLossPercentage: '0' }), { enterOnAdd: true }),
      initialTTState(),
      NOW_MS,
    );
    expect(result).toMatchObject({ kind: 'skip-guardrail', reason: 'discovery-no-stop' });
  });

  it('arms and emits level 0 when a valid stop is set, stamping the discovery marker', () => {
    const result = evaluateGridBuy(
      makeInput(gridConfig({ stopLossPercentage: '0.9' }), { enterOnAdd: true }),
      initialTTState(),
      NOW_MS,
    );
    expect(result.kind).toBe('emit');
    if (result.kind !== 'emit') throw new Error('expected emit');
    expect(result.level).toBe(0);
    expect(result.state.discoveryEntry).toBe(true);
    expect(result.state.entryAtMs).toBe(NOW_MS);
  });

  it('dormant: a NON-discovery entry (no hint) never sets the marker', () => {
    const result = evaluateGridBuy(
      makeInput(gridConfig({ stopLossPercentage: '0.9' }), undefined),
      initialTTState(),
      NOW_MS,
    );
    expect(result.kind).toBe('emit');
    if (result.kind !== 'emit') throw new Error('expected emit');
    expect(result.state.discoveryEntry).toBe(false);
    expect(result.state.entryAtMs).toBe(null);
  });
});

// ── Behavior D: promotion suppression ──────────────────────────────────────
describe('evaluateGridBuy — discovery promotion suppression (#438)', () => {
  const heldDiscovery = (): TTState => ({
    ...initialTTState(),
    avgEntryPrice: '100',
    heldQuantity: '0.1',
    currentGridTradeIndex: 0,
    discoveryEntry: true,
    entryAtMs: NOW_MS,
  });

  it('noops at the level-1 promotion trigger when the position is a discovery entry', () => {
    // Price at 95 = 100 × 0.95 (the level-1 trigger). A normal grid would promote.
    const result = evaluateGridBuy(
      makeInput(gridConfig(), undefined, { currentPrice: '95' }),
      heldDiscovery(),
      NOW_MS,
    );
    expect(result).toEqual({ kind: 'noop' });
  });

  it('a NON-discovery held position at the same trigger promotes (emit)', () => {
    const result = evaluateGridBuy(
      makeInput(gridConfig(), undefined, { currentPrice: '95' }),
      { ...heldDiscovery(), discoveryEntry: false, entryAtMs: null },
      NOW_MS,
    );
    expect(result.kind).toBe('emit');
  });
});

// ── Behavior F: time-stop ──────────────────────────────────────────────────
describe('evaluateSellGate — discovery time-stop (#438)', () => {
  // Closed candles AFTER entryAtMs. entryAtMs = NOW_MS; bars close at NOW_MS+1k…
  const barsAfter = (n: number): Candle[] => {
    const out: Candle[] = [];
    for (let i = 1; i <= n; i += 1) out.push(candle('100', NOW_MS + i * 1000, true));
    return out;
  };

  const heldDiscovery = (): TTState => ({
    ...initialTTState(),
    avgEntryPrice: '100',
    heldQuantity: '0.1',
    currentGridTradeIndex: 0,
    discoveryEntry: true,
    entryAtMs: NOW_MS,
  });

  it('emits a discovery-time-stop market sell once enough closed bars elapse', () => {
    const result = evaluateSellGate(
      makeInput(gridConfig({ discoveryTimeStopBars: 3 }), undefined, {
        currentPrice: '100',
        candles: barsAfter(3),
      }),
      heldDiscovery(),
    );
    expect(result.kind).toBe('emit');
    if (result.kind !== 'emit') throw new Error('expected emit');
    expect(result.metricName).toBe('tt_discovery_time_stop_emit');
    expect(result.decision).toMatchObject({
      type: 'place-order',
      intent: { side: 'SELL', reason: 'discovery-time-stop' },
    });
  });

  it('does NOT fire with only 2 closed bars after entry (threshold 3)', () => {
    const result = evaluateSellGate(
      makeInput(gridConfig({ discoveryTimeStopBars: 3 }), undefined, {
        currentPrice: '100',
        candles: barsAfter(2),
      }),
      heldDiscovery(),
    );
    expect(result.kind).toBe('noop');
  });

  it('only counts bars that close AFTER entryAtMs (a bar at entry does not count)', () => {
    // 3 bars but all close AT or BEFORE entryAtMs → zero qualifying bars.
    const atOrBefore = [
      candle('100', NOW_MS - 1000, true),
      candle('100', NOW_MS, true),
      candle('100', NOW_MS, true),
    ];
    const result = evaluateSellGate(
      makeInput(gridConfig({ discoveryTimeStopBars: 1 }), undefined, {
        currentPrice: '100',
        candles: atOrBefore,
      }),
      heldDiscovery(),
    );
    expect(result.kind).toBe('noop');
  });

  it('is dormant when discoveryTimeStopBars is 0 (default off)', () => {
    const result = evaluateSellGate(
      makeInput(gridConfig({ discoveryTimeStopBars: 0 }), undefined, {
        currentPrice: '100',
        candles: barsAfter(5),
      }),
      heldDiscovery(),
    );
    expect(result.kind).toBe('noop');
  });

  it('is dormant on a NON-discovery position even past the bar count', () => {
    const result = evaluateSellGate(
      makeInput(gridConfig({ discoveryTimeStopBars: 3 }), undefined, {
        currentPrice: '100',
        candles: barsAfter(5),
      }),
      { ...heldDiscovery(), discoveryEntry: false, entryAtMs: null },
    );
    expect(result.kind).toBe('noop');
  });

  it('stop-loss still takes precedence over the time-stop', () => {
    // Price 90 < 100 × 0.97 stop AND past the bar count: stop-loss wins.
    const result = evaluateSellGate(
      makeInput(gridConfig({ discoveryTimeStopBars: 3, stopLossPercentage: '0.97' }), undefined, {
        currentPrice: '90',
        candles: barsAfter(5),
      }),
      heldDiscovery(),
    );
    expect(result.kind).toBe('emit');
    if (result.kind !== 'emit') throw new Error('expected emit');
    expect(result.metricName).toBe('tt_grid_stop_loss_emit');
  });
});

// ── Behavior E (consumer): the skip-guardrail kind is wired through tick ────
describe('trailingTrade.tick — discovery guardrail veto observability (#438)', () => {
  const tickInput = (
    config: TTConfig,
    entryHint: TTEntryHintBundle | undefined,
  ): TickInput<TTConfig, TTState, TTBundle> =>
    ({
      clock: { nowMs: () => NOW_MS },
      rng: { next: () => 0 },
      trigger: { kind: 'tick' },
      profile: { id: 'p1', userId: 'u1', binanceMode: 'test', status: 'running' },
      config,
      state: initialTTState(),
      market: {
        symbol: 'BTCUSDT',
        currentPrice: '100',
        candlesByInterval: { '1h': [candle('100'), candle('100'), candle('100')] },
        symbolInfo: {
          symbol: 'BTCUSDT',
          baseAsset: 'BTC',
          quoteAsset: 'USDT',
          status: 'TRADING',
          filters: FILTERS,
        },
      },
      account: { balances: { USDT: { asset: 'USDT', free: '1000', locked: '0' } }, readable: true },
      openOrders: [],
      bundle: { technicals: buyTv, override: null, entryHint },
    }) as unknown as TickInput<TTConfig, TTState, TTBundle>;

  it('refuses the entry, emits a warn log + counter, and places no order', () => {
    const out = trailingTrade.tick(
      tickInput(gridConfig({ stopLossPercentage: '' }), { enterOnAdd: true }),
    );
    expect(out.decisions.some((d) => d.type === 'place-order')).toBe(false);
    expect(out.nextState.discoveryEntry).toBe(false);
    expect(
      out.logs.some((l) => l.message === 'tt-discovery-guardrail-veto' && l.level === 'warn'),
    ).toBe(true);
    expect(out.metrics.some((m) => m.name === 'tt_discovery_guardrail_veto')).toBe(true);
  });

  it('with a valid stop, the discovery entry is placed and the marker is set via tick', () => {
    const out = trailingTrade.tick(
      tickInput(gridConfig({ stopLossPercentage: '0.9' }), { enterOnAdd: true }),
    );
    expect(out.decisions.some((d) => d.type === 'place-order' && d.intent.side === 'BUY')).toBe(
      true,
    );
    expect(out.nextState.discoveryEntry).toBe(true);
    expect(out.nextState.entryAtMs).toBe(NOW_MS);
  });
});

// ── Behavior G: reset on full close ────────────────────────────────────────
describe('discovery marker reset on full close (#438)', () => {
  // Full single-arg tick input (clock/rng live inside it) so the post-sell
  // state reset in tick.ts is exercised end-to-end.
  const tickInput = (
    state: TTState,
    currentPrice: string,
  ): TickInput<TTConfig, TTState, TTBundle> =>
    ({
      clock: { nowMs: () => NOW_MS },
      rng: { next: () => 0 },
      trigger: { kind: 'tick' },
      profile: { id: 'p1', userId: 'u1', binanceMode: 'test', status: 'running' },
      config: gridConfig({ discoveryTimeStopBars: 3 }),
      state,
      market: {
        symbol: 'BTCUSDT',
        currentPrice,
        candlesByInterval: { '1h': [candle('100'), candle('100'), candle('100')] },
        symbolInfo: {
          symbol: 'BTCUSDT',
          baseAsset: 'BTC',
          quoteAsset: 'USDT',
          status: 'TRADING',
          filters: FILTERS,
        },
      },
      account: { balances: { BTC: { asset: 'BTC', free: '0.1', locked: '0' } }, readable: true },
      openOrders: [],
      bundle: { technicals: buyTv, override: null },
    }) as unknown as TickInput<TTConfig, TTState, TTBundle>;

  it('a full-close trailing-stop sell returns state with discoveryEntry=false, entryAtMs=null', () => {
    const state: TTState = {
      ...initialTTState(),
      avgEntryPrice: '100',
      heldQuantity: '0.1',
      currentGridTradeIndex: 0,
      highSinceBuy: '120',
      discoveryEntry: true,
      entryAtMs: NOW_MS,
    };
    // trailingStopPercentage default 0.98: sells when price <= 120 × 0.98 = 117.6.
    const out = trailingTrade.tick(tickInput(state, '110'));
    expect(out.decisions.some((d) => d.type === 'place-order')).toBe(true);
    expect(out.nextState.discoveryEntry).toBe(false);
    expect(out.nextState.entryAtMs).toBe(null);
  });

  it('a discovery-time-stop close also clears the marker', () => {
    const candles = [
      candle('100', NOW_MS + 1000, true),
      candle('100', NOW_MS + 2000, true),
      candle('100', NOW_MS + 3000, true),
    ];
    const state: TTState = {
      ...initialTTState(),
      avgEntryPrice: '100',
      heldQuantity: '0.1',
      currentGridTradeIndex: 0,
      discoveryEntry: true,
      entryAtMs: NOW_MS,
    };
    const input = tickInput(state, '101');
    // swap in the post-entry candles
    (input.market as { candlesByInterval: Record<string, Candle[]> }).candlesByInterval['1h'] =
      candles;
    const out = trailingTrade.tick(input);
    expect(
      out.decisions.some(
        (d) => d.type === 'place-order' && d.intent.reason === 'discovery-time-stop',
      ),
    ).toBe(true);
    expect(out.nextState.discoveryEntry).toBe(false);
    expect(out.nextState.entryAtMs).toBe(null);
  });
});

// ── Behavior G (forced-entry path): a forced re-entry must not inherit a stale
// discovery marker. An unfilled discovery entry (marker set at emit, cgti=0,
// avgEntryPrice still null) that is force-re-entered while the hint is no longer
// armed would otherwise carry a phantom single-entry flag and silently suppress
// the new position's grid promotions. The grid-buy emit only SETS the marker,
// never clears it, so emitForcedFirstEntry must clear it on the fresh entry.
describe('emitForcedFirstEntry — clears a stale discovery marker (#438)', () => {
  it('a forced re-entry without an armed hint emits a NON-discovery position', () => {
    const staleState: TTState = {
      ...initialTTState(),
      discoveryEntry: true,
      entryAtMs: NOW_MS - 1_000,
      currentGridTradeIndex: 0,
    };
    const result = emitForcedFirstEntry(
      makeInput(gridConfig({ stopLossPercentage: '0.9' }), undefined),
      staleState,
      NOW_MS,
    );
    expect(result.kind).toBe('emit');
    if (result.kind !== 'emit') throw new Error('expected emit');
    expect(result.state.discoveryEntry).toBe(false);
    expect(result.state.entryAtMs).toBe(null);
  });
});

// ── Behavior G (remaining tick close paths): each path that fully exits a
// position MUST clear the discovery marker, or a stale flag would suppress the
// next position's promotions. Behavior G above covers the trailing-stop and
// time-stop closes; these drive the other four close sites end-to-end through
// trailingTrade.tick. Each starts from a HELD discovery position. (#438)
describe('discovery marker reset — remaining tick close paths (#438)', () => {
  const heldDiscovery = (over?: Partial<TTState>): TTState => ({
    ...initialTTState(),
    avgEntryPrice: '100',
    heldQuantity: '0.1',
    currentGridTradeIndex: 0,
    discoveryEntry: true,
    entryAtMs: NOW_MS,
    ...over,
  });

  // A full single-arg tick input with the same fixtures as the Behavior G block,
  // but parameterised so each close path can supply its own config / technicals /
  // candles / override / balances.
  const fullTick = (opts: {
    config: TTConfig;
    state: TTState;
    currentPrice: string;
    technicals?: TechnicalsBundle;
    candlesByInterval?: Record<string, Candle[]>;
    override?: unknown;
    balances?: Record<string, { asset: string; free: unknown; locked: unknown }>;
    openOrders?: unknown[];
  }): TickInput<TTConfig, TTState, TTBundle> =>
    ({
      clock: { nowMs: () => NOW_MS },
      rng: { next: () => 0 },
      trigger: { kind: 'tick' },
      profile: { id: 'p1', userId: 'u1', binanceMode: 'test', status: 'running' },
      config: opts.config,
      state: opts.state,
      market: {
        symbol: 'BTCUSDT',
        currentPrice: opts.currentPrice,
        candlesByInterval: opts.candlesByInterval ?? {
          '1h': [candle('100'), candle('100'), candle('100')],
        },
        symbolInfo: {
          symbol: 'BTCUSDT',
          baseAsset: 'BTC',
          quoteAsset: 'USDT',
          status: 'TRADING',
          filters: FILTERS,
        },
      },
      account: {
        balances: opts.balances ?? { BTC: { asset: 'BTC', free: '0.1', locked: '0' } },
        readable: true,
      },
      openOrders: opts.openOrders ?? [],
      bundle: { technicals: opts.technicals ?? buyTv, override: opts.override ?? null },
    }) as unknown as TickInput<TTConfig, TTState, TTBundle>;

  // A daily-bear window: last 2 closed daily candles below the SMA(3) line.
  const bearDayCandles: Candle[] = [
    candle('100', 1000, true),
    candle('100', 2000, true),
    candle('100', 3000, true),
    candle('85', 4000, true),
    candle('80', 5000, true),
  ];

  // A force-sell-arming config + market: in profit (price > avgEntry), price
  // below the sell trigger (avgEntry × 1.05 = 105), and a fresh STRONG_SELL on a
  // whenStrongSell row. A NORMAL position force-sells here; a discovery entry
  // must NOT — it exits only via the ATR trailing stop, hard stop, or time-stop.
  const forceSellConfig = (): TTConfig => {
    const strongSellRow = { ...intervalRow('5m'), whenStrongSell: true };
    return trailingTrade.configSchema.parse({
      symbol: 'BTCUSDT',
      candleInterval: '1h',
      buy: {
        enabled: true,
        entrySizing: { mode: 'fixed', amount: '15' },
        avgEntryPriceRemoveThreshold: '0',
        firstBuyTriggerBasis: 'immediate',
        gridLevels: [
          { triggerPercentage: '1', maxPurchaseAmount: '15' },
          { triggerPercentage: '0.95', maxPurchaseAmount: '15' },
        ],
      },
      sell: { enabled: true, stopLossPercentage: '0.9', triggerPercentage: '1.05' },
      // Opt out of the sub-1h confirm default so a single STRONG_SELL print would
      // close a normal position the same tick — isolates the discovery suppression.
      technicals: {
        useOnlyWithinMin: 2,
        ifExpires: 'do-not-buy',
        intervals: [strongSellRow],
        forceSellConfirmMinutes: 0,
      },
    }) as TTConfig;
  };
  const strongSellTv = (): ReturnType<typeof tv> =>
    tv(
      [{ ...intervalRow('5m'), whenStrongSell: true }],
      [{ interval: '5m', signal: sig('STRONG_SELL') }],
    );

  it('(a) technicals-force-sell is suppressed for a discovery entry — it holds, marker kept', () => {
    const out = trailingTrade.tick(
      fullTick({
        config: forceSellConfig(),
        state: heldDiscovery(),
        currentPrice: '102',
        technicals: strongSellTv(),
      }),
    );
    // No force-sell: a discovery breakout is not clipped on a bearish print.
    expect(
      out.decisions.some(
        (d) => d.type === 'place-order' && d.intent.reason === 'technicals-force-sell',
      ),
    ).toBe(false);
    // Nothing else closes the position (no stop, trail unarmed, no time-stop), so
    // the position is held and the discovery marker survives.
    expect(out.decisions.some((d) => d.type === 'place-order')).toBe(false);
    expect(out.nextState.discoveryEntry).toBe(true);
    expect(out.nextState.entryAtMs).toBe(NOW_MS);
  });

  it('(a2) a NON-discovery position DOES force-sell on the same setup (regression)', () => {
    const out = trailingTrade.tick(
      fullTick({
        config: forceSellConfig(),
        state: { ...heldDiscovery(), discoveryEntry: false, entryAtMs: null },
        currentPrice: '102',
        technicals: strongSellTv(),
      }),
    );
    expect(
      out.decisions.some(
        (d) => d.type === 'place-order' && d.intent.reason === 'technicals-force-sell',
      ),
    ).toBe(true);
    expect(out.nextState.discoveryEntry).toBe(false);
    expect(out.nextState.entryAtMs).toBe(null);
  });

  it('(b) regime-exit (confirmed daily bear) close clears the marker', () => {
    const config = trailingTrade.configSchema.parse({
      symbol: 'BTCUSDT',
      candleInterval: '1h',
      buy: {
        enabled: true,
        entrySizing: { mode: 'fixed', amount: '15' },
        avgEntryPriceRemoveThreshold: '0',
        firstBuyTriggerBasis: 'immediate',
        gridLevels: [
          { triggerPercentage: '1', maxPurchaseAmount: '15' },
          { triggerPercentage: '0.95', maxPurchaseAmount: '15' },
        ],
      },
      // No stop-loss / trigger so only the regime-exit can fire the sell.
      sell: { enabled: true, stopLossPercentage: '', triggerPercentage: '' },
      regime: {
        ma: 'sma',
        period: 3,
        confirmBars: 2,
        onBear: { exitToCash: true },
      },
      technicals: { useOnlyWithinMin: 2, ifExpires: 'do-not-buy', intervals: [intervalRow('5m')] },
    }) as TTConfig;
    const out = trailingTrade.tick(
      fullTick({
        config,
        state: heldDiscovery(),
        currentPrice: '100',
        candlesByInterval: { '1h': [candle('100')], '1d': bearDayCandles },
      }),
    );
    expect(
      out.decisions.some((d) => d.type === 'place-order' && d.intent.reason === 'regime-exit'),
    ).toBe(true);
    expect(out.nextState.discoveryEntry).toBe(false);
    expect(out.nextState.entryAtMs).toBe(null);
  });

  it('(c) the lbp-clear escape hatch clears the marker (no order, state reset)', () => {
    // avgEntryPriceRemoveThreshold trips (price ≤ 100 × 0.95) AND held base is
    // below minQty (dust) AND no open BUY ⇒ maybeClearAvgEntryPrice fires.
    const config = trailingTrade.configSchema.parse({
      symbol: 'BTCUSDT',
      candleInterval: '1h',
      buy: {
        enabled: true,
        entrySizing: { mode: 'fixed', amount: '15' },
        avgEntryPriceRemoveThreshold: '0.95',
        firstBuyTriggerBasis: 'immediate',
        gridLevels: [
          { triggerPercentage: '1', maxPurchaseAmount: '15' },
          { triggerPercentage: '0.95', maxPurchaseAmount: '15' },
        ],
      },
      sell: { enabled: true, stopLossPercentage: '0.9', triggerPercentage: '1.05' },
      technicals: { useOnlyWithinMin: 2, ifExpires: 'do-not-buy', intervals: [intervalRow('5m')] },
    }) as TTConfig;
    const out = trailingTrade.tick(
      fullTick({
        config,
        state: heldDiscovery({ heldQuantity: null }),
        currentPrice: '90', // ≤ 100 × 0.95 = 95
        // Held base below minQty (0.0001) so the clear's dust guard passes. The
        // lbp-clear path reads free/locked as Decimal off the snapshot loader.
        balances: { BTC: { asset: 'BTC', free: new Decimal(0), locked: new Decimal(0) } },
      }),
    );
    expect(out.logs.some((l) => l.message === 'tt-lbp-cleared')).toBe(true);
    expect(out.nextState.avgEntryPrice).toBe(null);
    expect(out.nextState.discoveryEntry).toBe(false);
    expect(out.nextState.entryAtMs).toBe(null);
  });

  it('(d) a manual trigger-sell close clears the marker', () => {
    const config = gridConfig({ stopLossPercentage: '0.9' });
    const out = trailingTrade.tick(
      fullTick({
        config,
        state: heldDiscovery(),
        currentPrice: '100',
        override: { kind: 'trigger-sell', overrideActionId: 'a1' },
      }),
    );
    expect(
      out.decisions.some((d) => d.type === 'place-order' && d.intent.reason === 'manual'),
    ).toBe(true);
    expect(out.nextState.discoveryEntry).toBe(false);
    expect(out.nextState.entryAtMs).toBe(null);
  });
});

// ── Behavior F (precedence): the fixed trailing-stop must win over the
// time-stop, just as the stop-loss does. A discovery position that retraced
// into the trailing zone AND is past the bar count emits the trailing sell, not
// the time-stop. Mirrors the stop-loss-precedence test. (#438)
describe('evaluateSellGate — trailing-stop precedence over the time-stop (#438)', () => {
  const barsAfter = (n: number): Candle[] => {
    const out: Candle[] = [];
    for (let i = 1; i <= n; i += 1) out.push(candle('100', NOW_MS + i * 1000, true));
    return out;
  };
  it('emits the trailing-stop sell, not the time-stop, when both could fire', () => {
    // highSinceBuy 120; default trailingStopPercentage 0.98 ⇒ sell at ≤ 117.6.
    // Price 110 is in the trailing zone AND we are past discoveryTimeStopBars.
    const state: TTState = {
      ...initialTTState(),
      avgEntryPrice: '100',
      heldQuantity: '0.1',
      currentGridTradeIndex: 0,
      highSinceBuy: '120',
      discoveryEntry: true,
      entryAtMs: NOW_MS,
    };
    const result = evaluateSellGate(
      makeInput(gridConfig({ discoveryTimeStopBars: 3, stopLossPercentage: '0.9' }), undefined, {
        currentPrice: '110',
        candles: barsAfter(5),
      }),
      state,
    );
    expect(result.kind).toBe('emit');
    if (result.kind !== 'emit') throw new Error('expected emit');
    expect(result.metricName).toBe('tt_grid_sell_emit');
  });
});
