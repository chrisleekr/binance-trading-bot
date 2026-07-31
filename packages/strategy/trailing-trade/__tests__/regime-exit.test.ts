// Cash-rotation regime exit. Two halves, one verdict:
//   - sell side: exit the whole position to cash on a CONFIRMED daily bear
//     (the last `confirmBars` closed daily candles all below the regime MA),
//     placed after the per-symbol gates so stop-loss / trailing keep precedence;
//   - buy side: suppress a fresh entry while the regime is confirmed bear, so
//     the profile stays in cash until price recovers.
// Fail-safe is the throughline: a short / malformed daily window is inert — it
// never sells and never freezes entry (the OPPOSITE of the buy filter's
// fail-closed promotion halt).

import { describe, expect, it } from 'vitest';
import { Decimal } from '@app/money';
import type {
  TechnicalsBundle,
  TechnicalsIntervalSignal,
  TechnicalsRecommendation,
} from '@app/contracts';
import {
  evaluateRegimeExit,
  evaluateRegimeEntryBlock,
  evaluateRegimeEntryRequirement,
  evaluateRegimeRearm,
} from '../src/branches/regime-exit.js';
import {
  trailingTrade,
  TTConfigSchema,
  TTBundleSchema,
  type TTConfig,
  type TTState,
  type TTBundle,
} from '../src/index.js';
import type { MarketSnapshot, OpenOrder, TickInput } from '@app/strategy-core';

const dayCandles = (closes: string[], trailingForming?: string) => {
  const base = closes.map((close, i) => ({
    openTimeMs: i * 86_400_000,
    closeTimeMs: i * 86_400_000 + 86_399_999,
    open: close,
    high: close,
    low: close,
    close,
    volume: '1',
    isClosed: true,
  }));
  const last = base[base.length - 1];
  if (trailingForming !== undefined && last) {
    base.push({ ...last, close: trailingForming, isClosed: false });
  }
  return base;
};

// ───────────────────────── unit: evaluateRegimeExit ─────────────────────────

describe('evaluateRegimeExit', () => {
  const cfg = (
    re: Partial<{ enabled: boolean; ma: 'sma' | 'ema'; period: number; confirmBars: number }>,
  ): TTConfig => {
    const { enabled = true, ma = 'sma', period = 3, confirmBars = 2 } = re;
    return {
      regime: { ma, period, confirmBars, onBear: { exitToCash: enabled } },
    } as unknown as TTConfig;
  };

  const mkt = (closes: string[], trailingForming?: string): MarketSnapshot =>
    ({
      symbol: 'BTCUSDT',
      currentPrice: '100',
      candlesByInterval: { '1d': dayCandles(closes, trailingForming) },
    }) as unknown as MarketSnapshot;

  it('returns disabled when the feature is off', () => {
    expect(evaluateRegimeExit(mkt(['100', '100', '100']), cfg({ enabled: false }))).toEqual({
      kind: 'disabled',
    });
  });

  it('is disabled (no throw) when the stored config predates the field', () => {
    // The live worker passes raw stored config (no schema defaults applied), so
    // a config saved before the regime block existed has `regime` undefined.
    const legacy = { buy: {}, sell: {} } as unknown as TTConfig;
    expect(evaluateRegimeExit(mkt(['100', '100', '100', '90', '88']), legacy)).toEqual({
      kind: 'disabled',
    });
  });

  it('is unavailable when the daily interval is absent entirely', () => {
    const m = {
      symbol: 'BTCUSDT',
      currentPrice: '100',
      candlesByInterval: {},
    } as unknown as MarketSnapshot;
    expect(evaluateRegimeExit(m, cfg({}))).toMatchObject({
      kind: 'unavailable',
      context: { have: 0 },
    });
  });

  it('is unavailable (fail-safe) until the MA lookback window exists', () => {
    const out = evaluateRegimeExit(mkt(['100', '100']), cfg({ period: 3 }));
    // `need` is max(period, confirmBars) = max(3, 2) = 3.
    expect(out).toMatchObject({ kind: 'unavailable', context: { have: 2, need: 3 } });
  });

  it('is unavailable when fewer candles than confirmBars exist', () => {
    // period satisfied (3 >= 2) but confirmBars 5 not (3 < 5) — exercises the
    // window guard via need = max(period, confirmBars) = max(2, 5) = 5.
    const out = evaluateRegimeExit(mkt(['100', '100', '100']), cfg({ period: 2, confirmBars: 5 }));
    expect(out).toMatchObject({ kind: 'unavailable', context: { need: 5 } });
  });

  it('confirms bear when the last confirmBars closes are all below the MA (sma)', () => {
    // sma(last 3) = (100 + 90 + 88) / 3 = 92.67; last 2 closes 90, 88 both below.
    const out = evaluateRegimeExit(mkt(['100', '100', '100', '90', '88']), cfg({}));
    expect(out.kind).toBe('bear');
  });

  it('returns ok when not every confirmation close is below the MA', () => {
    // sma(last 3) = (100 + 90 + 95) / 3 = 95; latest close 95 is NOT below it.
    const out = evaluateRegimeExit(mkt(['100', '100', '100', '90', '95']), cfg({}));
    expect(out.kind).toBe('ok');
  });

  it('supports an ema regime line', () => {
    const out = evaluateRegimeExit(mkt(['200', '200', '200', '1', '1']), cfg({ ma: 'ema' }));
    expect(out.kind).toBe('bear');
  });

  it('ignores a still-forming daily candle (closes-only confirmation)', () => {
    // A forming candle at 999 would flip the verdict if counted; it is filtered.
    const out = evaluateRegimeExit(mkt(['100', '100', '100', '90', '88'], '999'), cfg({}));
    expect(out.kind).toBe('bear');
  });

  it('fails safe to unavailable on a malformed confirmation close', () => {
    const out = evaluateRegimeExit(mkt(['100', '100', '100', '90', 'bad']), cfg({}));
    expect(out).toMatchObject({ kind: 'unavailable', context: { missing: 'close' } });
  });

  it('fails safe to unavailable when the MA cannot be computed (malformed older close)', () => {
    // confirmBars 1 → only the last close is parsed in confirmation; the
    // malformed older close inside the MA window makes sma throw.
    const out = evaluateRegimeExit(mkt(['bad', '90', '88']), cfg({ confirmBars: 1 }));
    expect(out).toMatchObject({ kind: 'unavailable', context: { missing: 'compute' } });
  });
});

// ───────────────────── unit: evaluateRegimeEntryBlock ─────────────────────

describe('evaluateRegimeEntryBlock', () => {
  const mkt = (closes: string[]): MarketSnapshot =>
    ({
      symbol: 'BTCUSDT',
      currentPrice: '100',
      candlesByInterval: { '1d': dayCandles(closes) },
    }) as unknown as MarketSnapshot;
  const cfg = (onBear: Record<string, boolean>): TTConfig =>
    ({ regime: { ma: 'sma', period: 3, confirmBars: 2, onBear } }) as unknown as TTConfig;
  const BEAR_CLOSES = ['100', '100', '100', '90', '88'];

  it('is disabled when neither exitToCash nor blockEntry is set', () => {
    expect(
      evaluateRegimeEntryBlock(mkt(BEAR_CLOSES), cfg({ exitToCash: false, blockEntry: false })),
    ).toEqual({ kind: 'disabled' });
  });

  it('is disabled (no throw) when the stored config predates the regime block', () => {
    // The live worker passes raw stored config (no schema defaults), so a config
    // saved before the regime block existed has `regime` undefined — must not throw.
    const legacy = { buy: {}, sell: {} } as unknown as TTConfig;
    expect(evaluateRegimeEntryBlock(mkt(BEAR_CLOSES), legacy)).toEqual({ kind: 'disabled' });
  });

  it('is unavailable (fail-safe) on a short daily window even with blockEntry on', () => {
    // Never freeze entries on missing data — the destructive direction is to block.
    expect(evaluateRegimeEntryBlock(mkt(['100', '100']), cfg({ blockEntry: true }))).toMatchObject({
      kind: 'unavailable',
    });
  });

  it('confirms bear on blockEntry alone (exitToCash off)', () => {
    expect(evaluateRegimeEntryBlock(mkt(BEAR_CLOSES), cfg({ blockEntry: true })).kind).toBe('bear');
  });

  it('confirms bear on exitToCash alone (so enabling cash rotation still blocks entry)', () => {
    expect(evaluateRegimeEntryBlock(mkt(BEAR_CLOSES), cfg({ exitToCash: true })).kind).toBe('bear');
  });

  it('is ok (not bear) on a flat regime even when blockEntry is on', () => {
    expect(
      evaluateRegimeEntryBlock(mkt(['100', '100', '100', '100', '100']), cfg({ blockEntry: true }))
        .kind,
    ).toBe('ok');
  });

  it('the SELL gate stays exit-only: blockEntry alone does NOT enable evaluateRegimeExit', () => {
    // The whole point of blockEntry is to sit out WITHOUT force-selling — so the
    // exit evaluator must remain disabled when only blockEntry is set.
    expect(evaluateRegimeExit(mkt(BEAR_CLOSES), cfg({ blockEntry: true }))).toEqual({
      kind: 'disabled',
    });
  });
});

// ───────────────── unit: evaluateRegimeEntryRequirement ─────────────────

describe('evaluateRegimeEntryRequirement', () => {
  const mkt = (closes: string[]): MarketSnapshot =>
    ({
      symbol: 'BTCUSDT',
      currentPrice: '100',
      candlesByInterval: { '1d': dayCandles(closes) },
    }) as unknown as MarketSnapshot;
  const cfg = (requireEntry: boolean): TTConfig =>
    ({
      regime: { ma: 'sma', period: 3, confirmBars: 2, onBull: { requireEntry } },
    }) as unknown as TTConfig;
  const BULL_CLOSES = ['80', '82', '84', '90', '92'];
  const BEAR_CLOSES = ['100', '100', '100', '90', '88'];
  const NEUTRAL_CLOSES = ['100', '100', '100', '101', '99'];

  it('is disabled when requireEntry is off', () => {
    expect(evaluateRegimeEntryRequirement(mkt(BULL_CLOSES), cfg(false))).toEqual({
      kind: 'disabled',
    });
  });

  it('is disabled (no throw) on a raw config that predates the regime block', () => {
    const legacy = { buy: {}, sell: {} } as unknown as TTConfig;
    expect(evaluateRegimeEntryRequirement(mkt(BULL_CLOSES), legacy)).toEqual({ kind: 'disabled' });
  });

  it('allows a confirmed bull', () => {
    expect(evaluateRegimeEntryRequirement(mkt(BULL_CLOSES), cfg(true)).kind).toBe('allow');
  });

  it('blocks a confirmed bear', () => {
    expect(evaluateRegimeEntryRequirement(mkt(BEAR_CLOSES), cfg(true)).kind).toBe('block');
  });

  it('blocks a neutral regime (the new behaviour: not just bear)', () => {
    expect(evaluateRegimeEntryRequirement(mkt(NEUTRAL_CLOSES), cfg(true)).kind).toBe('block');
  });

  it('blocks (fail-CLOSED) when the daily trend cannot be confirmed', () => {
    // The opposite fail-direction from the bear block: a short window cannot
    // prove an uptrend, so it stays out rather than opening.
    expect(evaluateRegimeEntryRequirement(mkt(['100', '100']), cfg(true)).kind).toBe('block');
  });
});

// ─────────────────────── unit: evaluateRegimeRearm ───────────────────────

describe('evaluateRegimeRearm', () => {
  const T = 1_700_000_000_000;
  // Minimal bundle: the evaluator reads only `signals` and `config.useOnlyWithinMin`,
  // so a cast avoids the schema's 1:1 signals↔intervals refine here (exercised in
  // the integration tests below, which parse the real bundle).
  const tv = (signals: { interval: string; recommendation: string; receivedAtMs?: number }[]) =>
    ({
      config: { useOnlyWithinMin: 60, ifExpires: 'do-not-buy', intervals: [] },
      signals: signals.map((s) => ({
        interval: s.interval,
        signal: {
          symbol: 'BTCUSDT',
          recommendation: s.recommendation,
          maRecommendation: null,
          oscRecommendation: null,
          receivedAtMs: s.receivedAtMs ?? T,
          indicators: null,
        },
      })),
    }) as unknown as TechnicalsBundle;

  const cfg = (
    rearm: Partial<{ enabled: boolean; interval: string; minRecommendation: string }>,
    onBear: Partial<{ exitToCash: boolean; blockEntry: boolean }> = { blockEntry: true },
  ): TTConfig =>
    ({
      regime: {
        onBear: { ...onBear, rearm: { interval: '4h', minRecommendation: 'STRONG_BUY', ...rearm } },
      },
    }) as unknown as TTConfig;

  it('is blocked when rearm is disabled (default)', () => {
    expect(
      evaluateRegimeRearm(
        tv([{ interval: '4h', recommendation: 'STRONG_BUY' }]),
        cfg({ enabled: false }),
        T,
      ),
    ).toEqual({
      kind: 'blocked',
    });
  });

  it('is blocked (no throw) when the stored config has no regime block', () => {
    const legacy = { buy: {} } as unknown as TTConfig;
    expect(
      evaluateRegimeRearm(tv([{ interval: '4h', recommendation: 'STRONG_BUY' }]), legacy, T),
    ).toEqual({
      kind: 'blocked',
    });
  });

  it('never re-arms while exitToCash is on, even on a fresh STRONG_BUY', () => {
    expect(
      evaluateRegimeRearm(
        tv([{ interval: '4h', recommendation: 'STRONG_BUY' }]),
        cfg({ enabled: true }, { exitToCash: true }),
        T,
      ),
    ).toEqual({ kind: 'blocked' });
  });

  it('is blocked when no signal exists for the configured interval', () => {
    expect(
      evaluateRegimeRearm(
        tv([{ interval: '1h', recommendation: 'STRONG_BUY' }]),
        cfg({ enabled: true }),
        T,
      ),
    ).toEqual({ kind: 'blocked' });
  });

  it('is blocked when the matching signal is stale (older than useOnlyWithinMin)', () => {
    const stale = T - 60 * 60_000 - 1; // 1 ms past the 60-min window
    expect(
      evaluateRegimeRearm(
        tv([{ interval: '4h', recommendation: 'STRONG_BUY', receivedAtMs: stale }]),
        cfg({ enabled: true }),
        T,
      ),
    ).toEqual({ kind: 'blocked' });
  });

  it('treats a future-dated signal as fresh (clock-skew clamp) and re-arms', () => {
    const future = T + 5_000;
    expect(
      evaluateRegimeRearm(
        tv([{ interval: '4h', recommendation: 'STRONG_BUY', receivedAtMs: future }]),
        cfg({ enabled: true }),
        T,
      ).kind,
    ).toBe('rearmed');
  });

  it('re-arms on a fresh STRONG_BUY and reports the interval + recommendation', () => {
    expect(
      evaluateRegimeRearm(
        tv([{ interval: '4h', recommendation: 'STRONG_BUY' }]),
        cfg({ enabled: true }),
        T,
      ),
    ).toEqual({
      kind: 'rearmed',
      context: { interval: '4h', recommendation: 'STRONG_BUY', minRecommendation: 'STRONG_BUY' },
    });
  });

  it('does NOT re-arm on a plain BUY when STRONG_BUY is required', () => {
    expect(
      evaluateRegimeRearm(
        tv([{ interval: '4h', recommendation: 'BUY' }]),
        cfg({ enabled: true }),
        T,
      ),
    ).toEqual({ kind: 'blocked' });
  });

  it('re-arms on a plain BUY when minRecommendation is lowered to BUY', () => {
    expect(
      evaluateRegimeRearm(
        tv([{ interval: '4h', recommendation: 'BUY' }]),
        cfg({ enabled: true, minRecommendation: 'BUY' }),
        T,
      ).kind,
    ).toBe('rearmed');
  });

  it('does NOT re-arm on NEUTRAL even when minRecommendation is BUY', () => {
    expect(
      evaluateRegimeRearm(
        tv([{ interval: '4h', recommendation: 'NEUTRAL' }]),
        cfg({ enabled: true, minRecommendation: 'BUY' }),
        T,
      ),
    ).toEqual({ kind: 'blocked' });
  });

  it('does NOT re-arm on a still-bearish fast frame (STRONG_SELL) even at the BUY floor', () => {
    // The realistic "fast frame still collapsing" case the override must reject.
    expect(
      evaluateRegimeRearm(
        tv([{ interval: '4h', recommendation: 'STRONG_SELL' }]),
        cfg({ enabled: true, minRecommendation: 'BUY' }),
        T,
      ),
    ).toEqual({ kind: 'blocked' });
  });
});

// ─────────────────── integration: computeTick wiring ───────────────────

const NOW = 1_700_000_000_000;

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

const buildInput = (opts: {
  config: TTConfig;
  state: TTState;
  currentPrice: string;
  dailyCloses: string[];
  freeBase?: number;
  openOrders?: readonly OpenOrder[];
  technicalsSignals?: readonly TechnicalsIntervalSignal[];
}): TickInput<TTConfig, TTState, TTBundle> => {
  const { config } = opts;
  const bundle = TTBundleSchema.parse({
    technicals: { config: config.technicals, signals: opts.technicalsSignals ?? [] },
    override: null,
  });
  return {
    clock: { nowMs: () => NOW },
    rng: { next: () => 0 },
    trigger: { kind: 'tick' },
    profile: {
      id: 'p1',
      userId: 'u1',
      binanceMode: 'test',
      status: 'running',
      strategyVersion: '1.0.0',
    },
    config,
    state: opts.state,
    market: {
      symbol: 'BTCUSDT',
      currentPrice: opts.currentPrice,
      candlesByInterval: { '1d': dayCandles(opts.dailyCloses) },
      symbolInfo: SYMBOL_INFO,
    },
    account: {
      balances: {
        BTC: { asset: 'BTC', free: new Decimal(opts.freeBase ?? 1), locked: new Decimal(0) },
      },
      readable: true,
    },
    openOrders: opts.openOrders ?? ([] as readonly OpenOrder[]),
    bundle,
    limits: { weightUsed1m: 0, weightLimit1m: 1200, headroomBps: 10000 },
  };
};

// Daily series that confirms bear (last 2 closes below the 3-day SMA) vs one
// that does not.
const BEAR = ['100', '100', '100', '90', '88'];
const FLAT = ['100', '100', '100', '100', '100'];

const exitConfig = (over?: {
  stopLossPercentage?: string;
  regimeEnabled?: boolean;
  gridLevels?: unknown[];
}): TTConfig =>
  TTConfigSchema.parse({
    symbol: 'BTCUSDT',
    buy: {
      enabled: true,
      entrySizing: { mode: 'fixed', amount: '50' },
      avgEntryPriceRemoveThreshold: '0',
      autoTriggerBuy: { enabled: true, triggerAfterMinutes: 20 },
      ...(over?.gridLevels ? { gridLevels: over.gridLevels } : {}),
    },
    sell: {
      enabled: true,
      stopLossPercentage: over?.stopLossPercentage ?? '',
      triggerPercentage: '',
    },
    regime: {
      ma: 'sma',
      period: 3,
      confirmBars: 2,
      onBear: { exitToCash: over?.regimeEnabled ?? true },
    },
    technicals: { useOnlyWithinMin: 2, ifExpires: 'do-not-buy', intervals: [] },
  });

const heldState = (config: TTConfig, over?: Partial<TTState>): TTState => ({
  ...trailingTrade.initialState(config),
  avgEntryPrice: '100',
  heldQuantity: '0.2',
  currentGridTradeIndex: 0,
  ...over,
});

describe('trailingTrade tick — regime exit (cash rotation)', () => {
  it('exits the position to cash on a confirmed daily bear, even at a loss', () => {
    const config = exitConfig();
    const out = trailingTrade.tick(
      buildInput({ config, state: heldState(config), currentPrice: '95', dailyCloses: BEAR }),
    );
    expect(out.decisions).toHaveLength(1);
    expect(out.decisions[0]).toMatchObject({
      type: 'place-order',
      intent: { side: 'SELL', reason: 'regime-exit' },
      params: { type: 'MARKET' },
    });
    expect(out.nextState.avgEntryPrice).toBeNull();
    expect(out.nextState.highSinceBuy).toBeNull();
    expect(out.nextState.currentGridTradeIndex).toBeNull();
    // Re-entry must wait for the regime to recover, NOT a re-arm timer — so the
    // auto-trigger-buy timer stays null despite autoTriggerBuy being enabled.
    expect(out.nextState.autoTriggerBuyAtMs).toBeNull();
    // This exit was underwater (95 < 100), so the loss-exit cooldown arms so a
    // recovery does not immediately re-buy into the same drop.
    expect(out.nextState.lastLossExitReason).toBe('regime-exit');
    expect(typeof out.nextState.lastLossExitAt).toBe('number');
    expect(out.metrics).toEqual(
      expect.arrayContaining([expect.objectContaining({ name: 'tt_regime_exit_emit' })]),
    );
  });

  it('does NOT arm the loss cooldown when the regime exit is in profit', () => {
    // Same confirmed-bear exit, but currentPrice 105 > entry 100 ⇒ a profitable
    // exit: the loss-exit cooldown must stay disarmed.
    const config = exitConfig();
    const out = trailingTrade.tick(
      buildInput({ config, state: heldState(config), currentPrice: '105', dailyCloses: BEAR }),
    );
    expect(out.decisions[0]).toMatchObject({ intent: { side: 'SELL', reason: 'regime-exit' } });
    expect(out.nextState.lastLossExitAt).toBeNull();
    expect(out.nextState.lastLossExitReason).toBeNull();
  });

  it('lets the stop-loss win precedence when both fire on the same tick', () => {
    // price 95 <= entry 100 * 0.97 → stop-loss fires inside evaluateSellGate,
    // ahead of the regime-exit catch-all.
    const config = exitConfig({ stopLossPercentage: '0.97' });
    const out = trailingTrade.tick(
      buildInput({ config, state: heldState(config), currentPrice: '95', dailyCloses: BEAR }),
    );
    expect(out.decisions[0]).toMatchObject({ intent: { reason: 'grid-stop-loss' } });
  });

  it('does NOT exit when the daily window is too short to confirm (fail-safe)', () => {
    const config = exitConfig();
    const out = trailingTrade.tick(
      buildInput({ config, state: heldState(config), currentPrice: '95', dailyCloses: ['100'] }),
    );
    expect(out.decisions.every((d) => d.type !== 'place-order')).toBe(true);
  });

  it('does not emit a sell it cannot place (dust position), and falls through', () => {
    const config = exitConfig();
    const out = trailingTrade.tick(
      buildInput({
        config,
        state: heldState(config, { heldQuantity: null }),
        currentPrice: '95',
        dailyCloses: BEAR,
        freeBase: 0,
      }),
    );
    expect(out.decisions.every((d) => d.type !== 'place-order')).toBe(true);
  });

  it('suppresses a fresh entry while the regime is confirmed bear (non-grid)', () => {
    const config = exitConfig();
    const out = trailingTrade.tick(
      buildInput({
        config,
        state: trailingTrade.initialState(config),
        currentPrice: '95',
        dailyCloses: BEAR,
      }),
    );
    expect(out.decisions.every((d) => d.type !== 'place-order')).toBe(true);
    expect(out.metrics).toEqual(
      expect.arrayContaining([expect.objectContaining({ name: 'tt_regime_exit_entry_block' })]),
    );
    expect(out.logs.some((l) => l.message === 'tt-regime-exit-entry-blocked')).toBe(true);
  });

  it('suppresses a fresh grid entry while the regime is confirmed bear', () => {
    const config = exitConfig({
      gridLevels: [{ triggerPercentage: '1', maxPurchaseAmount: '50' }],
    });
    const out = trailingTrade.tick(
      buildInput({
        config,
        state: trailingTrade.initialState(config),
        currentPrice: '95',
        dailyCloses: BEAR,
      }),
    );
    expect(out.decisions.every((d) => d.type !== 'place-order')).toBe(true);
    expect(out.metrics).toEqual(
      expect.arrayContaining([expect.objectContaining({ name: 'tt_regime_exit_entry_block' })]),
    );
  });

  it('does not suppress entry when the regime is not confirmed bear', () => {
    const config = exitConfig();
    const out = trailingTrade.tick(
      buildInput({
        config,
        state: trailingTrade.initialState(config),
        currentPrice: '100',
        dailyCloses: FLAT,
      }),
    );
    expect(out.metrics.every((m) => m.name !== 'tt_regime_exit_entry_block')).toBe(true);
  });

  it('does not suppress entry when the daily window is too short (fail-safe inert)', () => {
    const config = exitConfig();
    const out = trailingTrade.tick(
      buildInput({
        config,
        state: trailingTrade.initialState(config),
        currentPrice: '95',
        dailyCloses: ['100'],
      }),
    );
    expect(out.metrics.every((m) => m.name !== 'tt_regime_exit_entry_block')).toBe(true);
  });

  it('halts a grid promotion on a confirmed bear even with the buy-side regimeFilter off', () => {
    // sell disabled so the regime-exit SELL does not pre-empt the promotion path,
    // isolating the promotion veto; regimeFilter left OFF to prove regimeExit
    // halts averaging-down on its own (the self-contained "stop deepening" promise).
    const config = TTConfigSchema.parse({
      symbol: 'BTCUSDT',
      candleInterval: '1h',
      buy: {
        enabled: true,
        entrySizing: { mode: 'fixed', amount: '50' },
        avgEntryPriceRemoveThreshold: '0',
        gridLevels: [
          { triggerPercentage: '1', maxPurchaseAmount: '50' },
          { triggerPercentage: '0.95', maxPurchaseAmount: '50' },
        ],
      },
      sell: {
        enabled: false,
        stopLossPercentage: '',
        triggerPercentage: '',
      },
      regime: { ma: 'sma', period: 3, confirmBars: 2, onBear: { exitToCash: true } },
      technicals: { useOnlyWithinMin: 2, ifExpires: 'do-not-buy', intervals: [] },
    });
    const state: TTState = {
      ...trailingTrade.initialState(config),
      avgEntryPrice: '100',
      heldQuantity: '0.2',
      currentGridTradeIndex: 0,
    };
    // price 90 <= avgEntry 100 * level-1 trigger 0.95 → a promotion would fire.
    const out = trailingTrade.tick(
      buildInput({ config, state, currentPrice: '90', dailyCloses: BEAR }),
    );
    expect(out.decisions.every((d) => d.type !== 'place-order')).toBe(true);
    expect(out.metrics).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          name: 'tt_regime_filter_veto',
          tags: expect.objectContaining({ reason: 'regime-downtrend' }),
        }),
      ]),
    );
  });

  it('blockEntry alone suppresses a fresh entry in a confirmed bear (exitToCash off)', () => {
    const config = TTConfigSchema.parse({
      symbol: 'BTCUSDT',
      buy: {
        enabled: true,
        entrySizing: { mode: 'fixed', amount: '50' },
        avgEntryPriceRemoveThreshold: '0',
      },
      sell: { enabled: true, stopLossPercentage: '', triggerPercentage: '' },
      regime: { ma: 'sma', period: 3, confirmBars: 2, onBear: { blockEntry: true } },
      technicals: { useOnlyWithinMin: 2, ifExpires: 'do-not-buy', intervals: [] },
    });
    const out = trailingTrade.tick(
      buildInput({
        config,
        state: trailingTrade.initialState(config),
        currentPrice: '95',
        dailyCloses: BEAR,
      }),
    );
    expect(out.decisions.every((d) => d.type !== 'place-order')).toBe(true);
    expect(out.metrics).toEqual(
      expect.arrayContaining([expect.objectContaining({ name: 'tt_regime_exit_entry_block' })]),
    );
  });

  const restingBuy = (over?: Partial<OpenOrder>): OpenOrder => ({
    orderId: 4242,
    clientOrderId: 'tt-old-entry',
    symbol: 'BTCUSDT',
    side: 'BUY',
    type: 'LIMIT',
    status: 'NEW',
    price: '90',
    origQty: '0.5',
    executedQty: '0',
    cummulativeQuoteQty: '0',
    transactTimeMs: NOW - 60_000,
    updateTimeMs: NOW - 60_000,
    ...over,
  });

  it('cancels every resting entry BUY for the symbol (but not a sibling symbol) when blockEntry fires', () => {
    // The reported bug: a symbol shows BLOCKED with no position yet keeps a
    // resting BUY that would still fill the entry the block exists to prevent.
    // Two BTCUSDT BUYs must both be cancelled; an ETHUSDT BUY in the same list
    // must be left alone — the filter is symbol-scoped.
    const config = TTConfigSchema.parse({
      symbol: 'BTCUSDT',
      buy: {
        enabled: true,
        entrySizing: { mode: 'fixed', amount: '50' },
        avgEntryPriceRemoveThreshold: '0',
      },
      sell: { enabled: true, stopLossPercentage: '', triggerPercentage: '' },
      regime: { ma: 'sma', period: 3, confirmBars: 2, onBear: { blockEntry: true } },
      technicals: { useOnlyWithinMin: 2, ifExpires: 'do-not-buy', intervals: [] },
    });
    const out = trailingTrade.tick(
      buildInput({
        config,
        state: trailingTrade.initialState(config),
        currentPrice: '95',
        dailyCloses: BEAR,
        openOrders: [
          restingBuy(),
          restingBuy({ orderId: 4243, clientOrderId: 'tt-old-entry-2', price: '88' }),
          restingBuy({ orderId: 99, clientOrderId: 'tt-eth', symbol: 'ETHUSDT' }),
        ],
      }),
    );
    const cancels = out.decisions.filter((d) => d.type === 'cancel-order');
    // Exactly the two BTCUSDT BUYs — the ETHUSDT one (orderId 99) is excluded.
    expect(cancels).toHaveLength(2);
    expect(cancels).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          type: 'cancel-order',
          orderId: 4242,
          symbol: 'BTCUSDT',
          reason: 'tt-regime-entry-block',
        }),
        expect.objectContaining({
          type: 'cancel-order',
          orderId: 4243,
          symbol: 'BTCUSDT',
          reason: 'tt-regime-entry-block',
        }),
      ]),
    );
    // Still never places an order — the block only frees capital, never buys.
    expect(out.decisions.every((d) => d.type !== 'place-order')).toBe(true);
  });

  it('does NOT cancel a resting SELL when blockEntry fires (only entry BUYs)', () => {
    const config = TTConfigSchema.parse({
      symbol: 'BTCUSDT',
      buy: {
        enabled: true,
        entrySizing: { mode: 'fixed', amount: '50' },
        avgEntryPriceRemoveThreshold: '0',
      },
      sell: { enabled: true, stopLossPercentage: '', triggerPercentage: '' },
      regime: { ma: 'sma', period: 3, confirmBars: 2, onBear: { blockEntry: true } },
      technicals: { useOnlyWithinMin: 2, ifExpires: 'do-not-buy', intervals: [] },
    });
    const out = trailingTrade.tick(
      buildInput({
        config,
        state: trailingTrade.initialState(config),
        currentPrice: '95',
        dailyCloses: BEAR,
        openOrders: [restingBuy({ orderId: 7, clientOrderId: 'tt-stop', side: 'SELL' })],
      }),
    );
    expect(out.decisions.every((d) => d.type !== 'cancel-order')).toBe(true);
  });

  it('does NOT cancel resting BUYs when the regime is flat (no block)', () => {
    const config = TTConfigSchema.parse({
      symbol: 'BTCUSDT',
      buy: {
        enabled: true,
        entrySizing: { mode: 'fixed', amount: '50' },
        avgEntryPriceRemoveThreshold: '0',
      },
      sell: { enabled: true, stopLossPercentage: '', triggerPercentage: '' },
      regime: { ma: 'sma', period: 3, confirmBars: 2, onBear: { blockEntry: true } },
      technicals: { useOnlyWithinMin: 2, ifExpires: 'do-not-buy', intervals: [] },
    });
    const out = trailingTrade.tick(
      buildInput({
        config,
        state: trailingTrade.initialState(config),
        currentPrice: '100',
        dailyCloses: FLAT,
        openOrders: [restingBuy()],
      }),
    );
    expect(out.decisions.every((d) => d.type !== 'cancel-order')).toBe(true);
  });

  it('blockEntry NEVER force-sells a held position in a bear (the key distinction from exitToCash)', () => {
    const config = TTConfigSchema.parse({
      symbol: 'BTCUSDT',
      buy: {
        enabled: true,
        entrySizing: { mode: 'fixed', amount: '50' },
        avgEntryPriceRemoveThreshold: '0',
      },
      sell: { enabled: true, stopLossPercentage: '', triggerPercentage: '' },
      regime: { ma: 'sma', period: 3, confirmBars: 2, onBear: { blockEntry: true } },
      technicals: { useOnlyWithinMin: 2, ifExpires: 'do-not-buy', intervals: [] },
    });
    const out = trailingTrade.tick(
      buildInput({ config, state: heldState(config), currentPrice: '95', dailyCloses: BEAR }),
    );
    // No SELL (unlike exitToCash) — the held position is retained.
    expect(out.decisions.every((d) => d.type !== 'place-order')).toBe(true);
    expect(out.nextState.avgEntryPrice).toBe('100');
    expect(out.nextState.heldQuantity).toBe('0.2');
  });

  it('defaults the regime block to all-off with confirmBars 3 when omitted', () => {
    // Pins the opt-in invariant (every action off → existing configs unaffected)
    // and the confirmBars default, neither of which any other test asserts.
    const parsed = TTConfigSchema.parse({
      symbol: 'SOLUSDT',
      candleInterval: '1h',
      buy: {
        enabled: true,
        entrySizing: { mode: 'fixed', amount: '50' },
        avgEntryPriceRemoveThreshold: '0',
      },
      sell: { enabled: true, stopLossPercentage: '', triggerPercentage: '' },
      technicals: { useOnlyWithinMin: 60, ifExpires: 'do-not-buy', intervals: [] },
    });
    expect(parsed.regime).toEqual({
      ma: 'ema',
      period: 200,
      confirmBars: 3,
      exposure: { enabled: false, neutralScalar: '0.5' },
      onBear: {
        exitToCash: false,
        blockEntry: false,
        suppressPromotion: false,
        rearm: { enabled: false, interval: '4h', minRecommendation: 'STRONG_BUY' },
      },
      onBull: {
        hold: { enabled: false, room: 'normal' },
        pyramid: { enabled: false, stepPercentage: '0.05', maxAdds: 3, maxPurchaseAmount: '15' },
        requireEntry: false,
      },
    });
  });
});

describe('trailingTrade tick — regime re-arm (Technicals override of the bear entry block)', () => {
  const rearmConfig = (over: {
    exitToCash?: boolean;
    blockEntry?: boolean;
    rearmEnabled?: boolean;
    minRecommendation?: 'BUY' | 'STRONG_BUY';
  }): TTConfig =>
    TTConfigSchema.parse({
      symbol: 'BTCUSDT',
      buy: {
        enabled: true,
        entrySizing: { mode: 'fixed', amount: '50' },
        avgEntryPriceRemoveThreshold: '0',
      },
      sell: { enabled: true, stopLossPercentage: '', triggerPercentage: '' },
      regime: {
        ma: 'sma',
        period: 3,
        confirmBars: 2,
        onBear: {
          exitToCash: over.exitToCash ?? false,
          blockEntry: over.blockEntry ?? false,
          rearm: {
            enabled: over.rearmEnabled ?? false,
            interval: '4h',
            minRecommendation: over.minRecommendation ?? 'STRONG_BUY',
          },
        },
      },
      // The 4h row must exist in the technicals config so the bundle's 1:1
      // signals↔intervals contract holds when we inject a 4h signal.
      technicals: {
        useOnlyWithinMin: 60,
        ifExpires: 'do-not-buy',
        intervals: [{ interval: '4h' }],
      },
    });

  const sig4h = (recommendation: TechnicalsRecommendation): TechnicalsIntervalSignal => ({
    interval: '4h',
    signal: {
      symbol: 'BTCUSDT',
      recommendation,
      maRecommendation: null,
      oscRecommendation: null,
      receivedAtMs: NOW,
      indicators: null,
    },
  });

  const runFlat = (config: TTConfig, signals: readonly TechnicalsIntervalSignal[]) =>
    trailingTrade.tick(
      buildInput({
        config,
        state: trailingTrade.initialState(config),
        currentPrice: '95',
        dailyCloses: BEAR,
        technicalsSignals: signals,
      }),
    );

  it('lifts the bear entry block on a fresh 4h STRONG_BUY (blockEntry mode)', () => {
    const out = runFlat(rearmConfig({ blockEntry: true, rearmEnabled: true }), [
      sig4h('STRONG_BUY'),
    ]);
    expect(out.metrics.every((m) => m.name !== 'tt_regime_exit_entry_block')).toBe(true);
    expect(out.logs.some((l) => l.message === 'tt-regime-rearm')).toBe(true);
  });

  it('control: the same bear + STRONG_BUY stays blocked while re-arm is disabled', () => {
    const out = runFlat(rearmConfig({ blockEntry: true, rearmEnabled: false }), [
      sig4h('STRONG_BUY'),
    ]);
    expect(out.metrics).toEqual(
      expect.arrayContaining([expect.objectContaining({ name: 'tt_regime_exit_entry_block' })]),
    );
    expect(out.logs.some((l) => l.message === 'tt-regime-rearm')).toBe(false);
  });

  it('never re-arms while exitToCash is on, even on a fresh STRONG_BUY (scoped to blockEntry)', () => {
    const out = runFlat(rearmConfig({ exitToCash: true, rearmEnabled: true }), [
      sig4h('STRONG_BUY'),
    ]);
    expect(out.metrics).toEqual(
      expect.arrayContaining([expect.objectContaining({ name: 'tt_regime_exit_entry_block' })]),
    );
    expect(out.logs.some((l) => l.message === 'tt-regime-rearm')).toBe(false);
  });

  it('stays blocked on a sub-threshold rating (BUY when STRONG_BUY is required)', () => {
    const out = runFlat(rearmConfig({ blockEntry: true, rearmEnabled: true }), [sig4h('BUY')]);
    expect(out.metrics).toEqual(
      expect.arrayContaining([expect.objectContaining({ name: 'tt_regime_exit_entry_block' })]),
    );
    expect(out.logs.some((l) => l.message === 'tt-regime-rearm')).toBe(false);
  });

  it('lets a resting entry BUY survive when re-arm fires, but cancels it when re-arm is off', () => {
    // The behavioural distinction re-arm exists to create: a confirmed bear
    // normally retracts resting entry BUYs; a re-arm leaves them so the entry
    // can resume. Asserted both ways so a regression that wrongly cancelled on
    // re-arm (or stopped cancelling when blocked) fails here.
    const restingBuy: OpenOrder = {
      orderId: 4242,
      clientOrderId: 'tt-old-entry',
      symbol: 'BTCUSDT',
      side: 'BUY',
      type: 'LIMIT',
      status: 'NEW',
      price: '90',
      origQty: '0.5',
      executedQty: '0',
      cummulativeQuoteQty: '0',
      transactTimeMs: NOW - 60_000,
      updateTimeMs: NOW - 60_000,
    };
    const isEntryBlockCancel = (d: { type: string; reason?: string }) =>
      d.type === 'cancel-order' && d.reason === 'tt-regime-entry-block';

    const rearmed = trailingTrade.tick(
      buildInput({
        config: rearmConfig({ blockEntry: true, rearmEnabled: true }),
        state: trailingTrade.initialState(rearmConfig({ blockEntry: true, rearmEnabled: true })),
        currentPrice: '95',
        dailyCloses: BEAR,
        openOrders: [restingBuy],
        technicalsSignals: [sig4h('STRONG_BUY')],
      }),
    );
    expect(rearmed.decisions.some(isEntryBlockCancel)).toBe(false);

    const blockedConfig = rearmConfig({ blockEntry: true, rearmEnabled: false });
    const blocked = trailingTrade.tick(
      buildInput({
        config: blockedConfig,
        state: trailingTrade.initialState(blockedConfig),
        currentPrice: '95',
        dailyCloses: BEAR,
        openOrders: [restingBuy],
        technicalsSignals: [sig4h('STRONG_BUY')],
      }),
    );
    expect(blocked.decisions.some(isEntryBlockCancel)).toBe(true);
  });
});

// ───────── integration: require-uptrend entry gate (onBull.requireEntry) ─────────

describe('trailingTrade tick — require-uptrend entry gate (onBull.requireEntry)', () => {
  const BULL = ['80', '82', '84', '90', '92'];
  const NEUTRAL = ['100', '100', '100', '101', '99'];

  const requireConfig = (requireEntry: boolean): TTConfig =>
    TTConfigSchema.parse({
      symbol: 'BTCUSDT',
      buy: {
        enabled: true,
        entrySizing: { mode: 'fixed', amount: '50' },
        avgEntryPriceRemoveThreshold: '0',
      },
      sell: { enabled: true, stopLossPercentage: '', triggerPercentage: '' },
      regime: { ma: 'sma', period: 3, confirmBars: 2, onBull: { requireEntry } },
      technicals: { useOnlyWithinMin: 60, ifExpires: 'do-not-buy', intervals: [] },
    });

  const restingBuy = (over?: Partial<OpenOrder>): OpenOrder => ({
    orderId: 7001,
    clientOrderId: 'tt-entry',
    symbol: 'BTCUSDT',
    side: 'BUY',
    type: 'LIMIT',
    status: 'NEW',
    price: '90',
    origQty: '0.5',
    executedQty: '0',
    cummulativeQuoteQty: '0',
    transactTimeMs: NOW - 60_000,
    updateTimeMs: NOW - 60_000,
    ...over,
  });

  it('blocks the first entry in a neutral regime and labels it regime-not-uptrend', () => {
    const config = requireConfig(true);
    const out = trailingTrade.tick(
      buildInput({
        config,
        state: trailingTrade.initialState(config),
        currentPrice: '100',
        dailyCloses: NEUTRAL,
      }),
    );
    expect(out.decisions.every((d) => d.type !== 'place-order')).toBe(true);
    expect(out.nextState.entryBlocker?.reason).toBe('regime-not-uptrend');
    expect(out.logs.some((l) => l.message === 'tt-regime-require-uptrend-blocked')).toBe(true);
  });

  it('retracts a resting first-entry BUY while the require-uptrend gate is blocking', () => {
    const config = requireConfig(true);
    const out = trailingTrade.tick(
      buildInput({
        config,
        state: trailingTrade.initialState(config),
        currentPrice: '100',
        dailyCloses: NEUTRAL,
        openOrders: [restingBuy()],
      }),
    );
    expect(
      out.decisions.some(
        (d) =>
          d.type === 'cancel-order' && d.orderId === 7001 && d.reason === 'tt-regime-entry-block',
      ),
    ).toBe(true);
  });

  it('does not block in a confirmed bull (the gate allows)', () => {
    const config = requireConfig(true);
    const out = trailingTrade.tick(
      buildInput({
        config,
        state: trailingTrade.initialState(config),
        currentPrice: '90',
        dailyCloses: BULL,
      }),
    );
    expect(out.nextState.entryBlocker?.reason).not.toBe('regime-not-uptrend');
    expect(out.logs.some((l) => l.message === 'tt-regime-require-uptrend-blocked')).toBe(false);
  });

  it('control: with requireEntry off, a neutral regime does not block on this gate', () => {
    const config = requireConfig(false);
    const out = trailingTrade.tick(
      buildInput({
        config,
        state: trailingTrade.initialState(config),
        currentPrice: '100',
        dailyCloses: NEUTRAL,
      }),
    );
    expect(out.nextState.entryBlocker?.reason).not.toBe('regime-not-uptrend');
  });
});
