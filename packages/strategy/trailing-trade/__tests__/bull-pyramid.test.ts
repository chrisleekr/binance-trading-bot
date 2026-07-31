// Buy-side bull pyramid (slice 3): on a CONFIRMED daily bull, add to a held
// position on strength above cost, bounded by maxAdds, step spacing, and the
// MANDATORY risk caps. Separate evaluator with its own state + clientOrderId
// namespace; default-off ⇒ no behaviour change (golden replay 0). These tests
// pin the fire/spacing/cap/maxAdds/regime/de-dup matrix plus the config safety
// gate and the state-reset-on-close invariant.

import { describe, expect, it } from 'vitest';
import { Decimal } from '@app/money';
import { evaluateBullPyramid } from '../src/branches/bull-pyramid.js';
import { pyramidBuyClientOrderId } from '../src/client-order-id.js';
import {
  trailingTrade,
  TTConfigSchema,
  TTBundleSchema,
  type TTConfig,
  type TTState,
  type TTBundle,
} from '../src/index.js';
import type { Candle, OpenOrder, TickInput } from '@app/strategy-core';

const NOW = 1_700_000_000_000;
const PROFILE_ID = 'p1';

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

const dayCandles = (closes: string[]): Candle[] =>
  closes.map((close, i) => ({
    openTimeMs: i * 86_400_000,
    closeTimeMs: i * 86_400_000 + 86_399_999,
    open: close,
    high: close,
    low: close,
    close,
    volume: '1',
    isClosed: true,
  }));

// last-3 SMA = (100+115+120)/3 = 111.67; last 2 closes both above ⇒ bull.
const BULL = ['100', '100', '100', '115', '120'];
// last-3 SMA = (100+115+105)/3 = 106.67; 105 below ⇒ neutral.
const NEUTRAL = ['100', '100', '100', '115', '105'];

interface CfgOpts {
  readonly enabled?: boolean;
  readonly step?: string;
  readonly maxAdds?: number;
  readonly addBudget?: string;
  readonly maxSymbolExposureQuote?: string;
  readonly maxPositionLossQuote?: string;
  readonly maxAccountExposureQuote?: string;
  readonly stopLossPercentage?: string;
}

// An amount-mode account cap from a legacy quote string ('' / '0' = off).
const amountCap = (v: string) =>
  v === '' || v === '0' ? { mode: 'off' as const } : { mode: 'amount' as const, amount: v };

const pyramidConfig = (o: CfgOpts = {}): TTConfig =>
  TTConfigSchema.parse({
    symbol: 'BTCUSDT',
    candleInterval: '1h',
    buy: {
      enabled: true,
      entrySizing: { mode: 'fixed', amount: '50' },
      avgEntryPriceRemoveThreshold: '0',
      // A cap must be armed for the pyramid superRefine to allow enabling it;
      // the high default never vetoes a small add.
      maxSymbolExposureQuote: o.maxSymbolExposureQuote ?? '100000',
      maxPositionLossQuote: o.maxPositionLossQuote ?? '',
      accountCap: amountCap(o.maxAccountExposureQuote ?? ''),
    },
    sell: { enabled: true, stopLossPercentage: o.stopLossPercentage ?? '', triggerPercentage: '' },
    regime: {
      ma: 'sma',
      period: 3,
      confirmBars: 2,
      onBull: {
        pyramid: {
          enabled: o.enabled ?? true,
          stepPercentage: o.step ?? '0.05',
          maxAdds: o.maxAdds ?? 3,
          maxPurchaseAmount: o.addBudget ?? '15',
        },
      },
    },
    technicals: { useOnlyWithinMin: 2, ifExpires: 'do-not-buy', intervals: [] },
  }) as TTConfig;

const heldState = (over?: Partial<TTState>): TTState => ({
  ...trailingTrade.initialState(pyramidConfig()),
  avgEntryPrice: '100',
  heldQuantity: '1',
  currentGridTradeIndex: 0,
  ...over,
});

const buildInput = (opts: {
  config: TTConfig;
  state: TTState;
  currentPrice: string;
  dailyCloses: string[];
  accountDeployedQuote?: string;
  openOrders?: readonly OpenOrder[];
}): TickInput<TTConfig, TTState, TTBundle> => {
  const { config } = opts;
  const bundle = TTBundleSchema.parse({
    technicals: { config: config.technicals, signals: [] },
    override: null,
  });
  return {
    clock: { nowMs: () => NOW },
    rng: { next: () => 0 },
    trigger: { kind: 'tick' },
    profile: {
      id: PROFILE_ID,
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
        USDT: { asset: 'USDT', free: new Decimal(10000), locked: new Decimal(0) },
        // A real held base balance so the dust-clear branch does not flatten the
        // position before the pyramid/sell paths run.
        BTC: { asset: 'BTC', free: new Decimal(1), locked: new Decimal(0) },
      },
      readable: true,
      ...(opts.accountDeployedQuote !== undefined
        ? { deployedQuoteAcrossProfiles: opts.accountDeployedQuote }
        : {}),
    },
    openOrders: opts.openOrders ?? [],
    bundle,
    limits: { weightUsed1m: 0, weightLimit1m: 1200, headroomBps: 10000 },
  };
};

describe('evaluateBullPyramid', () => {
  it('adds on strength above cost: bumps count, sets lastBullAddPrice, pyr clientOrderId', () => {
    // price 105 >= anchor 100 (avgEntryPrice fallback) × (1 + 0.05).
    const config = pyramidConfig();
    const out = evaluateBullPyramid(
      buildInput({ config, state: heldState(), currentPrice: '105', dailyCloses: BULL }),
      heldState(),
    );
    expect(out.kind).toBe('add');
    if (out.kind !== 'add') throw new Error('expected add');
    expect(out.addIndex).toBe(1);
    expect(out.nextState.bullAddCount).toBe(1);
    expect(out.nextState.lastBullAddPrice).toBe('105');
    expect(out.decisions[0]).toMatchObject({
      type: 'place-order',
      intent: {
        side: 'BUY',
        reason: 'bull-pyramid',
        clientOrderId: pyramidBuyClientOrderId(PROFILE_ID, 'BTCUSDT', 1),
      },
      params: { type: 'MARKET' },
    });
  });

  it('spaces adds: a rise below the step from the last add is a noop', () => {
    const config = pyramidConfig();
    // lastBullAddPrice 105; threshold 105 × 1.05 = 110.25; price 109 below it.
    const state = heldState({ bullAddCount: 1, lastBullAddPrice: '105' });
    const noop = evaluateBullPyramid(
      buildInput({ config, state, currentPrice: '109', dailyCloses: BULL }),
      state,
    );
    expect(noop.kind).toBe('noop');
    // price 111 >= 110.25 ⇒ the second add fires.
    const add = evaluateBullPyramid(
      buildInput({ config, state, currentPrice: '111', dailyCloses: BULL }),
      state,
    );
    expect(add.kind).toBe('add');
    if (add.kind !== 'add') throw new Error('expected add');
    expect(add.addIndex).toBe(2);
  });

  it('stops at maxAdds', () => {
    const config = pyramidConfig({ maxAdds: 3 });
    const state = heldState({ bullAddCount: 3, lastBullAddPrice: '100' });
    const out = evaluateBullPyramid(
      buildInput({ config, state, currentPrice: '200', dailyCloses: BULL }),
      state,
    );
    expect(out.kind).toBe('noop');
  });

  it('is a noop when the daily regime is not a confirmed bull', () => {
    const config = pyramidConfig();
    const neutral = evaluateBullPyramid(
      buildInput({ config, state: heldState(), currentPrice: '105', dailyCloses: NEUTRAL }),
      heldState(),
    );
    expect(neutral.kind).toBe('noop');
    // Too short a daily window ⇒ classifyRegime unavailable ⇒ noop.
    const short = evaluateBullPyramid(
      buildInput({ config, state: heldState(), currentPrice: '105', dailyCloses: ['100'] }),
      heldState(),
    );
    expect(short.kind).toBe('noop');
  });

  it('never pyramids a discovery single-entry, even with a cap armed at an add price (#438)', () => {
    // A discovery position is a single entry: it must not average UP via the
    // pyramid (raising avgEntryPrice would also weaken its hard stop). Same
    // bull + spacing + cap that would fire a normal add, but discoveryEntry=true.
    const config = pyramidConfig({ maxSymbolExposureQuote: '100000' });
    const discovery = heldState({ discoveryEntry: true, entryAtMs: NOW });
    const out = evaluateBullPyramid(
      buildInput({ config, state: discovery, currentPrice: '105', dailyCloses: BULL }),
      discovery,
    );
    expect(out.kind).toBe('noop');
    // Control: the SAME position without the discovery marker DOES add, proving
    // the marker (not some other gate) is what suppressed the add.
    const normal = heldState();
    const ctl = evaluateBullPyramid(
      buildInput({ config, state: normal, currentPrice: '105', dailyCloses: BULL }),
      normal,
    );
    expect(ctl.kind).toBe('add');
  });

  it('is a noop when disabled or flat', () => {
    const disabled = evaluateBullPyramid(
      buildInput({
        config: pyramidConfig({ enabled: false }),
        state: heldState(),
        currentPrice: '105',
        dailyCloses: BULL,
      }),
      heldState(),
    );
    expect(disabled.kind).toBe('noop');
    const flat = heldState({ avgEntryPrice: null });
    const flatOut = evaluateBullPyramid(
      buildInput({ config: pyramidConfig(), state: flat, currentPrice: '105', dailyCloses: BULL }),
      flat,
    );
    expect(flatOut.kind).toBe('noop');
  });

  it('does not stack a second add while a BUY is already resting (de-dup)', () => {
    const config = pyramidConfig();
    const openBuy = { orderId: '1', symbol: 'BTCUSDT', side: 'BUY' } as unknown as OpenOrder;
    const out = evaluateBullPyramid(
      buildInput({
        config,
        state: heldState(),
        currentPrice: '105',
        dailyCloses: BULL,
        openOrders: [openBuy],
      }),
      heldState(),
    );
    expect(out.kind).toBe('noop');
  });

  it('is a noop and does not throw when the stored config predates the regime block', () => {
    const base = pyramidConfig();
    const config = { ...base, regime: undefined } as unknown as TTConfig;
    const out = evaluateBullPyramid(
      buildInput({ config, state: heldState(), currentPrice: '105', dailyCloses: BULL }),
      heldState(),
    );
    expect(out.kind).toBe('noop');
  });

  it('fails safe to a noop on malformed price / anchor / step values', () => {
    const config = pyramidConfig();
    // Malformed current price.
    expect(
      evaluateBullPyramid(
        buildInput({ config, state: heldState(), currentPrice: 'bad', dailyCloses: BULL }),
        heldState(),
      ).kind,
    ).toBe('noop');
    // Malformed anchor (last add price).
    const badAnchor = heldState({ bullAddCount: 1, lastBullAddPrice: 'bad' });
    expect(
      evaluateBullPyramid(
        buildInput({ config, state: badAnchor, currentPrice: '105', dailyCloses: BULL }),
        badAnchor,
      ).kind,
    ).toBe('noop');
    // Malformed step (bypasses schema validation via a raw config).
    const badStepCfg = {
      ...config,
      regime: {
        ...config.regime,
        onBull: {
          ...config.regime.onBull,
          pyramid: { ...config.regime.onBull.pyramid, stepPercentage: 'bad' },
        },
      },
    } as unknown as TTConfig;
    expect(
      evaluateBullPyramid(
        buildInput({
          config: badStepCfg,
          state: heldState(),
          currentPrice: '105',
          dailyCloses: BULL,
        }),
        heldState(),
      ).kind,
    ).toBe('noop');
  });

  it('treats a legacy state with bullAddCount undefined as count 0', () => {
    const config = pyramidConfig();
    const legacy = { ...heldState(), bullAddCount: undefined } as unknown as TTState;
    const out = evaluateBullPyramid(
      buildInput({ config, state: legacy, currentPrice: '105', dailyCloses: BULL }),
      legacy,
    );
    expect(out.kind).toBe('add');
    if (out.kind !== 'add') throw new Error('expected add');
    expect(out.addIndex).toBe(1);
  });

  it('fails closed (noop) when the pyramid is enabled but NO cap is armed', () => {
    // The live worker passes raw stored config without re-parsing, so the schema
    // superRefine cannot be relied on. A config that bypassed validation with
    // pyramid.enabled=true and no cap must never add (no money ceiling).
    const base = pyramidConfig({ maxSymbolExposureQuote: '1000' });
    const noCap = {
      ...base,
      buy: { ...base.buy, maxSymbolExposureQuote: '', accountCap: { mode: 'off' } },
    } as unknown as TTConfig;
    const out = evaluateBullPyramid(
      buildInput({ config: noCap, state: heldState(), currentPrice: '105', dailyCloses: BULL }),
      heldState(),
    );
    expect(out.kind).toBe('noop');
  });

  it('is a noop when the add is too small to size (below min-notional)', () => {
    const config = pyramidConfig({ addBudget: '1' }); // 1 / 105 ≈ 0.0095, notional ~1 < 10
    const out = evaluateBullPyramid(
      buildInput({ config, state: heldState(), currentPrice: '105', dailyCloses: BULL }),
      heldState(),
    );
    expect(out.kind).toBe('noop');
  });

  describe('risk caps (mandatory) veto the add', () => {
    it('per-symbol exposure cap', () => {
      // deployed 100 + add ~15 = ~115 > cap 10.
      const config = pyramidConfig({ maxSymbolExposureQuote: '10' });
      const out = evaluateBullPyramid(
        buildInput({ config, state: heldState(), currentPrice: '105', dailyCloses: BULL }),
        heldState(),
      );
      expect(out).toMatchObject({ kind: 'skip-cap', cap: 'exposure-cap' });
    });

    it('account-wide exposure cap', () => {
      // account 105 + add ~15 = ~120 > cap 110 (symbol cap high, so account bites).
      const config = pyramidConfig({ maxAccountExposureQuote: '110' });
      const out = evaluateBullPyramid(
        buildInput({
          config,
          state: heldState(),
          currentPrice: '105',
          dailyCloses: BULL,
          accountDeployedQuote: '105',
        }),
        heldState(),
      );
      expect(out).toMatchObject({ kind: 'skip-cap', cap: 'account-exposure-cap' });
    });

    it('per-position loss budget', () => {
      // No stop ⇒ full projected deployed (~115) at risk > budget 5.
      const config = pyramidConfig({ maxPositionLossQuote: '5' });
      const out = evaluateBullPyramid(
        buildInput({ config, state: heldState(), currentPrice: '105', dailyCloses: BULL }),
        heldState(),
      );
      expect(out).toMatchObject({ kind: 'skip-cap', cap: 'loss-budget' });
    });
  });
});

describe('trailingTrade tick — bull pyramid integration', () => {
  it('emits the add through the tick and resets the counters on a full sell', () => {
    const config = pyramidConfig();
    const addOut = trailingTrade.tick(
      buildInput({ config, state: heldState(), currentPrice: '105', dailyCloses: BULL }),
    );
    expect(addOut.decisions[0]).toMatchObject({ intent: { reason: 'bull-pyramid' } });
    expect(addOut.nextState.bullAddCount).toBe(1);
    expect(addOut.metrics).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          name: 'tt_bull_pyramid_add',
          tags: expect.objectContaining({ addIndex: '1' }),
        }),
      ]),
    );

    // A confirmed-bear regime exit (or any full sell) must null the pyramid
    // counters so the next position starts fresh. Use a stop-loss exit: price
    // far below cost with a stop configured.
    const sellConfig = pyramidConfig({ stopLossPercentage: '0.97' });
    const sellOut = trailingTrade.tick(
      buildInput({
        config: sellConfig,
        state: heldState({ bullAddCount: 2, lastBullAddPrice: '120' }),
        currentPrice: '90', // <= 100 × 0.97 ⇒ stop-loss
        dailyCloses: BULL,
      }),
    );
    expect(sellOut.decisions[0]).toMatchObject({ intent: { reason: 'grid-stop-loss' } });
    expect(sellOut.nextState.bullAddCount).toBeNull();
    expect(sellOut.nextState.lastBullAddPrice).toBeNull();
  });

  it('surfaces the risk-cap veto through the tick when a cap blocks the add', () => {
    // Tight per-symbol cap: deployed 100 + add ~15 exceeds 10 ⇒ skip-cap, which
    // the tick turns into the shared risk-cap veto (no place-order).
    const config = pyramidConfig({ maxSymbolExposureQuote: '10' });
    const out = trailingTrade.tick(
      buildInput({ config, state: heldState(), currentPrice: '105', dailyCloses: BULL }),
    );
    expect(out.decisions.every((d) => d.type !== 'place-order')).toBe(true);
    expect(out.metrics).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          name: 'tt_risk_cap_veto',
          tags: expect.objectContaining({ cap: 'exposure-cap' }),
        }),
      ]),
    );
    expect(out.logs.some((l) => l.message === 'tt-risk-cap-veto')).toBe(true);
  });
});

describe('TTConfigSchema — bull pyramid safety gate', () => {
  it('rejects enabling the pyramid without an exposure cap armed', () => {
    expect(() =>
      TTConfigSchema.parse({
        symbol: 'BTCUSDT',
        candleInterval: '1h',
        buy: {
          enabled: true,
          entrySizing: { mode: 'fixed', amount: '50' },
          avgEntryPriceRemoveThreshold: '0',
        },
        sell: { enabled: true, stopLossPercentage: '', triggerPercentage: '' },
        regime: { ma: 'sma', period: 3, confirmBars: 2, onBull: { pyramid: { enabled: true } } },
        technicals: { useOnlyWithinMin: 2, ifExpires: 'do-not-buy', intervals: [] },
      }),
    ).toThrow(/exposure cap/i);
  });

  it('allows enabling the pyramid with a per-symbol exposure cap armed', () => {
    expect(() => pyramidConfig({ maxSymbolExposureQuote: '1000' })).not.toThrow();
  });

  it('allows enabling the pyramid with an account exposure cap armed', () => {
    expect(() =>
      pyramidConfig({ maxSymbolExposureQuote: '', maxAccountExposureQuote: '1000' }),
    ).not.toThrow();
  });
});
