import { describe, it, expect } from 'vitest';
import {
  trailingTrade,
  TTConfigSchema,
  TTStateSchema,
  TTBundleSchema,
  type TTConfig,
  type TTState,
  type TTBundle,
} from '../src/index.js';
import type { OpenOrder, TickInput } from '@app/strategy-core';
import { gridBuyClientOrderId } from '../src/client-order-id.js';
import { Decimal } from '@app/money';

// An amount-mode account cap from a legacy quote string ('' / '0' = off).
const amountCap = (v: string) =>
  v === '' || v === '0' ? { mode: 'off' as const } : { mode: 'amount' as const, amount: v };

const cfg = (overrides?: Partial<{ checkTechnicals: boolean; buyEnabled: boolean }>): TTConfig => {
  const raw: Record<string, unknown> = {
    symbol: 'BTCUSDT',
    buy: {
      enabled: overrides?.buyEnabled ?? true,
      entrySizing: { mode: 'fixed', amount: '50' },
      avgEntryPriceRemoveThreshold: '0',
    },
    sell: { enabled: true, stopLossPercentage: '0.97', triggerPercentage: '1.05' },
  };
  if (overrides?.checkTechnicals !== undefined) {
    raw.forceBuyOverride = { checkTechnicals: overrides.checkTechnicals };
  }
  return TTConfigSchema.parse(raw);
};

type Sig = NonNullable<TTBundle['technicals']['signals'][number]['signal']>;

const bundleWith = (signal: Sig | null): TTBundle =>
  TTBundleSchema.parse({
    technicals: {
      config: {
        useOnlyWithinMin: 2,
        ifExpires: 'do-not-buy',
        intervals: [
          {
            interval: '1m',
            whenStrongBuy: true,
            whenBuy: true,
            whenSell: false,
            whenStrongSell: false,
            whenNeutral: false,
          },
        ],
      },
      signals: [{ interval: '1m', signal }],
    },
    override: null,
  });

const baseInput = (overrides?: {
  bundle?: TTBundle;
  state?: TTState;
  nowMs?: number;
  config?: TTConfig;
  openOrders?: readonly OpenOrder[];
}): TickInput<TTConfig, TTState, TTBundle> => {
  const c = overrides?.config ?? cfg();
  return {
    clock: { nowMs: () => overrides?.nowMs ?? 0 },
    rng: { next: () => 0 },
    trigger: { kind: 'tick' },
    profile: {
      id: 'p1',
      userId: 'u1',
      binanceMode: 'test',
      status: 'running',
      strategyVersion: '2.0.0',
    },
    config: c,
    state: overrides?.state ?? trailingTrade.initialState(c),
    market: {
      symbol: 'BTCUSDT',
      currentPrice: '50000.00',
      candlesByInterval: {},
      symbolInfo: {
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
      },
    },
    account: { balances: {}, readable: true },
    openOrders: overrides?.openOrders ?? [],
    bundle: overrides?.bundle ?? bundleWith(null),
    limits: { weightUsed1m: 0, weightLimit1m: 1200, headroomBps: 10000 },
  };
};

describe('@app/strategy-trailing-trade contract', () => {
  it('exposes a Strategy with name and capabilities', () => {
    expect(trailingTrade.name).toBe('trailing-trade');
    expect(trailingTrade.version).toBe('2.0.0');
    expect(trailingTrade.capabilities.candleIntervals).toEqual([
      '1m',
      '5m',
      '15m',
      '30m',
      '1h',
      '4h',
      '1d',
    ]);
    expect(trailingTrade.capabilities.needsUserDataStream).toBe(true);
    expect(trailingTrade.capabilities.bundleProviders).toEqual([
      'technicals',
      'override',
      'entry-hint',
    ]);
  });

  it('initialState returns a defaulted state', () => {
    const state = trailingTrade.initialState(cfg());
    expect(state.schemaVersion).toBe('2.0.0');
    expect(state.avgEntryPrice).toBeNull();
    expect(TTStateSchema.parse(state)).toEqual(state);
  });

  it('config schema defaults forceBuyOverride.checkTechnicals to true', () => {
    const parsed = cfg();
    expect(parsed.forceBuyOverride.checkTechnicals).toBe(true);
  });

  it('config schema defaults autoTriggerBuy off with a 20-minute delay', () => {
    expect(cfg().buy.autoTriggerBuy).toEqual({
      enabled: false,
      triggerAfterMinutes: 20,
      rescheduleWhileDisabled: false,
    });
  });

  it('config schema rejects a negative or fractional triggerAfterMinutes', () => {
    const withDelay = (triggerAfterMinutes: number): unknown =>
      TTConfigSchema.parse({
        symbol: 'BTCUSDT',
        buy: {
          enabled: true,
          entrySizing: { mode: 'fixed', amount: '15' },
          avgEntryPriceRemoveThreshold: '0',
          autoTriggerBuy: { enabled: true, triggerAfterMinutes },
        },
        sell: { enabled: true, stopLossPercentage: '0.97', triggerPercentage: '1.05' },
      });
    // 0 re-arms on the next tick after a sell; only negatives are rejected.
    expect(() => withDelay(0)).not.toThrow();
    expect(() => withDelay(-5)).toThrow();
    // A fractional value would round to a sub-window delay; the .int() rejects it.
    expect(() => withDelay(0.5)).toThrow();
    expect(() => withDelay(30)).not.toThrow();
  });

  it('config schema accepts autoTriggerBuy enabled together with a grid ladder', () => {
    // The re-armed buy is grid-aware (routes through evaluateGridBuy at
    // level 0), so the pairing is a valid config — no longer refused.
    const withGrid = (autoTriggerBuyEnabled: boolean): unknown =>
      TTConfigSchema.parse({
        symbol: 'BTCUSDT',
        buy: {
          enabled: true,
          entrySizing: { mode: 'fixed', amount: '15' },
          avgEntryPriceRemoveThreshold: '0',
          autoTriggerBuy: { enabled: autoTriggerBuyEnabled },
          gridLevels: [{ triggerPercentage: '1', maxPurchaseAmount: '15' }],
        },
        sell: { enabled: true, stopLossPercentage: '0.97', triggerPercentage: '1.05' },
      });
    expect(() => withGrid(true)).not.toThrow();
    expect(() => withGrid(false)).not.toThrow();
  });

  it('state schema defaults autoTriggerBuyAtMs to null for a pre-field snapshot', () => {
    // A state row serialised before autoTriggerBuyAtMs joined the schema
    // must still parse — the default fills the gap, no migration needed.
    const legacy = {
      schemaVersion: '2.0.0',
      avgEntryPrice: null,
      disabledUntilMs: null,
      triggers: { override: null },
      highSinceBuy: null,
      currentGridTradeIndex: null,
    };
    expect(TTStateSchema.parse(legacy).autoTriggerBuyAtMs).toBeNull();
  });

  it('initialState seeds autoTriggerBuyAtMs to null', () => {
    expect(trailingTrade.initialState(cfg()).autoTriggerBuyAtMs).toBeNull();
  });
});

describe('@app/strategy-trailing-trade migrateState', () => {
  it('is defined on the strategy', () => {
    expect(typeof trailingTrade.migrateState).toBe('function');
  });

  it('hops a 1.0.0 state row up to a 1.1.0 intermediate shape, seeding heldQuantity', () => {
    const legacy = {
      schemaVersion: '1.0.0',
      // Legacy 1.x rows stored the cost basis under `lastBuyPrice`; the
      // rename to `avgEntryPrice` lands at the live (2.0.0) schema, so the
      // pre-cutover blob keeps the old key to mirror real on-disk state.
      lastBuyPrice: '50000',
      disabledUntilMs: null,
      triggers: { override: null },
      highSinceBuy: null,
      currentGridTradeIndex: 0,
      autoTriggerBuyAtMs: null,
    };
    const migrated = trailingTrade.migrateState?.({ fromVersion: '1.0.0', state: legacy }) as
      | Record<string, unknown>
      | undefined;
    // 1.0.0 → 1.1.0 is the intermediate hop the runner loops through on
    // its way to 2.0.0; the schemaVersion stamp is what the runner reads
    // to dispatch the next branch. The carried field keeps its legacy key.
    expect(migrated?.['schemaVersion']).toBe('1.1.0');
    expect(migrated?.['heldQuantity']).toBeNull();
    expect(migrated?.['lastBuyPrice']).toBe('50000');
  });

  it('resets the slice on the 1.1.0 → 2.0.0 hop (per-symbol storage cutover)', () => {
    // Cutover hop cannot safely slice the legacy flat blob (no symbol
    // input). The boot reconciler rehydrates the per-symbol avgEntryPrice
    // from the ledger; the strategy returns the initial slice here. The
    // 1.1.0 row still carries the cost basis under the legacy `lastBuyPrice`.
    const legacy = {
      schemaVersion: '1.1.0',
      lastBuyPrice: '50000',
      heldQuantity: '0.001',
      disabledUntilMs: null,
      triggers: { override: null },
      highSinceBuy: '52000',
      currentGridTradeIndex: 0,
      autoTriggerBuyAtMs: null,
    };
    const migrated = trailingTrade.migrateState?.({ fromVersion: '1.1.0', state: legacy }) as
      | Record<string, unknown>
      | undefined;
    expect(migrated?.['schemaVersion']).toBe('2.0.0');
    expect(migrated?.['avgEntryPrice']).toBeNull();
    expect(migrated?.['heldQuantity']).toBeNull();
    expect(migrated?.['highSinceBuy']).toBeNull();
    expect(migrated?.['currentGridTradeIndex']).toBeNull();
    // Round-trip through the live schema so the migrated row is valid.
    expect(() => TTStateSchema.parse(migrated)).not.toThrow();
  });

  it('throws a clear error for an unknown prior schema version', () => {
    expect(() => trailingTrade.migrateState?.({ fromVersion: '0.9.0', state: {} })).toThrow(
      /no migration path from schema version "0\.9\.0"/,
    );
  });
});

describe('@app/strategy-trailing-trade tick — indicator metrics', () => {
  const indicators = {
    windowSize: 200,
    lowestLow: '40000',
    highestHigh: '60000',
    sma20: '50000',
    ema20: '50500',
    rsi14: '55.5',
    lastCandleCloseTimeMs: 1_700_000_000_000,
  };

  it('emits indicator gauges when the cache is populated for the configured interval', () => {
    const input = baseInput();
    const out = trailingTrade.tick({
      ...input,
      market: { ...input.market, indicatorsByInterval: { '1h': indicators } },
    });
    const byName = new Map(out.metrics.map((m) => [m.name, m.value]));
    expect(byName.get('tt_indicator_rsi14')).toBe(55.5);
    expect(byName.get('tt_indicator_sma20')).toBe(50000);
    expect(byName.get('tt_indicator_ema20')).toBe(50500);
  });

  it('emits no indicator metrics when the cache is absent', () => {
    const out = trailingTrade.tick(baseInput());
    expect(out.metrics.some((m) => m.name.startsWith('tt_indicator_'))).toBe(false);
  });

  it('treats a persisted state body missing avgEntryPrice as flat (no force-sell parse-fail)', () => {
    // A persisted row can omit a nullable key with no schema default (the body
    // is re-parsed only across a schemaVersion hop), so `state.avgEntryPrice`
    // can arrive `undefined`. The `!== null` guards would mis-read it as a live
    // position, entering the force-sell path and spamming a parse failure every
    // tick. The tick must normalize it to the contract `null` instead.
    const seed = trailingTrade.initialState(cfg({ buyEnabled: false }));
    const { avgEntryPrice: _omitted, ...keyless } = seed;
    const out = trailingTrade.tick(
      baseInput({ config: cfg({ buyEnabled: false }), state: keyless as unknown as TTState }),
    );
    expect(out.nextState.avgEntryPrice).toBeNull();
    expect(out.logs.some((l) => l.message === 'tt-sell-gate-parse-failed')).toBe(false);
  });

  it('keeps a missing-avgEntryPrice flat symbol eligible for its first buy', () => {
    // The flip side of the guard fix: once `undefined` normalizes to `null`, the
    // first-buy gate (avgEntryPrice === null) must still fire. Before the fix an
    // undefined avgEntryPrice was mis-read as a held position and the entry was
    // skipped, so the symbol never bought.
    const gridCfg = TTConfigSchema.parse({
      symbol: 'BTCUSDT',
      forceBuyOverride: { checkTechnicals: false },
      buy: {
        enabled: true,
        entrySizing: { mode: 'fixed', amount: '50' },
        avgEntryPriceRemoveThreshold: '0',
        gridLevels: [{ triggerPercentage: '1.0', maxPurchaseAmount: '50' }],
      },
      sell: { enabled: true, stopLossPercentage: '0.97', triggerPercentage: '1.05' },
    });
    const seed = trailingTrade.initialState(gridCfg);
    const { avgEntryPrice: _omitted, ...keyless } = seed;
    const out = trailingTrade.tick(
      baseInput({ config: gridCfg, state: keyless as unknown as TTState }),
    );
    expect(out.decisions.some((d) => d.type === 'place-order')).toBe(true);
    expect(out.logs.some((l) => l.message === 'tt-sell-gate-parse-failed')).toBe(false);
  });

  it('omits a gauge whose underlying indicator value is null', () => {
    const input = baseInput();
    const out = trailingTrade.tick({
      ...input,
      market: {
        ...input.market,
        indicatorsByInterval: { '1h': { ...indicators, rsi14: null } },
      },
    });
    expect(out.metrics.some((m) => m.name === 'tt_indicator_rsi14')).toBe(false);
    expect(out.metrics.some((m) => m.name === 'tt_indicator_sma20')).toBe(true);
  });

  it('omits a gauge whose cached value is not a finite number', () => {
    const input = baseInput();
    const out = trailingTrade.tick({
      ...input,
      market: {
        ...input.market,
        indicatorsByInterval: { '1h': { ...indicators, sma20: 'corrupt' } },
      },
    });
    expect(out.metrics.some((m) => m.name === 'tt_indicator_sma20')).toBe(false);
    expect(out.metrics.some((m) => m.name === 'tt_indicator_rsi14')).toBe(true);
  });

  it('emits indicator gauges even on an early-return tick path', () => {
    const input = baseInput({
      state: { ...trailingTrade.initialState(cfg()), disabledUntilMs: 10_000 },
      nowMs: 0,
    });
    const out = trailingTrade.tick({
      ...input,
      market: { ...input.market, indicatorsByInterval: { '1h': indicators } },
    });
    // The disabled path returns before any outcome metric is built; the
    // tick wrapper must still attach indicator gauges.
    expect(out.decisions).toEqual([{ type: 'noop' }]);
    expect(out.metrics.some((m) => m.name === 'tt_indicator_rsi14')).toBe(true);
  });
});

describe('@app/strategy-trailing-trade tick — override + disabled gates', () => {
  // Reusable UUIDs for override-action stamping. The clientOrderId folds
  // the first 8 hex chars in, so the suffix is predictable for assertions.
  // RFC 4122 v4: third group starts with `4`, fourth group with `8`/`9`/`a`/`b`.
  const OVERRIDE_ID = '01234567-89ab-4cde-89ab-cdef01234567';

  it('emits MARKET BUY place-order for a manual-order override (quoteAmount)', () => {
    const bundle = TTBundleSchema.parse({
      technicals: {
        config: {
          useOnlyWithinMin: 2,
          ifExpires: 'do-not-buy',
          intervals: [
            {
              interval: '1m',
              whenStrongBuy: true,
              whenBuy: true,
              whenSell: false,
              whenStrongSell: false,
              whenNeutral: false,
            },
          ],
        },
        signals: [{ interval: '1m', signal: null }],
      },
      override: {
        kind: 'manual-order',
        overrideActionId: OVERRIDE_ID,
        payload: { side: 'BUY', type: 'MARKET', quoteAmount: '50' },
      },
    });
    const out = trailingTrade.tick(baseInput({ bundle }));
    expect(out.decisions).toHaveLength(1);
    expect(out.decisions[0]).toMatchObject({
      type: 'place-order',
      intent: {
        symbol: 'BTCUSDT',
        side: 'BUY',
        reason: 'manual',
        clientOrderId: 'tt-01234567-m',
      },
      params: { type: 'MARKET', quantity: '0.0010' },
    });
  });

  it('emits LIMIT place-order for a manual-order override with operator-typed price', () => {
    const bundle = TTBundleSchema.parse({
      technicals: {
        config: {
          useOnlyWithinMin: 2,
          ifExpires: 'do-not-buy',
          intervals: [
            {
              interval: '1m',
              whenStrongBuy: true,
              whenBuy: true,
              whenSell: false,
              whenStrongSell: false,
              whenNeutral: false,
            },
          ],
        },
        signals: [{ interval: '1m', signal: null }],
      },
      override: {
        kind: 'manual-order',
        overrideActionId: OVERRIDE_ID,
        payload: { side: 'BUY', type: 'LIMIT', quantity: '0.001', price: '10000' },
      },
    });
    const out = trailingTrade.tick(baseInput({ bundle }));
    expect(out.decisions[0]).toMatchObject({
      type: 'place-order',
      params: { type: 'LIMIT', quantity: '0.0010', price: '10000', timeInForce: 'GTC' },
    });
  });

  it('bypasses disabledUntilMs for manual-order overrides', () => {
    // disabledUntilMs is the kill-switch; manual-order is operator intent
    // and should still emit even when the strategy is paused.
    const state: TTState = {
      schemaVersion: '2.0.0',
      avgEntryPrice: null,
      disabledUntilMs: 9_999_999_999,
      triggers: { override: null },
    };
    const bundle = TTBundleSchema.parse({
      technicals: {
        config: {
          useOnlyWithinMin: 2,
          ifExpires: 'do-not-buy',
          intervals: [
            {
              interval: '1m',
              whenStrongBuy: true,
              whenBuy: true,
              whenSell: false,
              whenStrongSell: false,
              whenNeutral: false,
            },
          ],
        },
        signals: [{ interval: '1m', signal: null }],
      },
      override: {
        kind: 'manual-order',
        overrideActionId: OVERRIDE_ID,
        payload: { side: 'BUY', type: 'MARKET', quoteAmount: '50' },
      },
    });
    const out = trailingTrade.tick(baseInput({ bundle, state, nowMs: 1_000 }));
    expect(out.decisions[0]?.type).toBe('place-order');
  });

  it('skips manual-order when quantity falls below the symbol min-notional', () => {
    const bundle = TTBundleSchema.parse({
      technicals: {
        config: {
          useOnlyWithinMin: 2,
          ifExpires: 'do-not-buy',
          intervals: [
            {
              interval: '1m',
              whenStrongBuy: true,
              whenBuy: true,
              whenSell: false,
              whenStrongSell: false,
              whenNeutral: false,
            },
          ],
        },
        signals: [{ interval: '1m', signal: null }],
      },
      override: {
        kind: 'manual-order',
        overrideActionId: OVERRIDE_ID,
        // quoteAmount $1 / price 50000 → qty 0.00002 → below minQty 0.0001
        payload: { side: 'BUY', type: 'MARKET', quoteAmount: '1' },
      },
    });
    const out = trailingTrade.tick(baseInput({ bundle }));
    expect(out.decisions).toEqual([{ type: 'noop' }]);
    expect(out.logs[0]?.message).toBe('tt-manual-order-skipped');
  });

  it('emits first-buy via trigger-buy override even when TV signal is null', () => {
    // First-buy normally vetoes when no TV signal exists; trigger-buy
    // forces the gate open. Still honors open-BUY de-dup + disabledUntilMs.
    const bundle = TTBundleSchema.parse({
      technicals: {
        config: {
          useOnlyWithinMin: 2,
          ifExpires: 'do-not-buy',
          intervals: [
            {
              interval: '1m',
              whenStrongBuy: true,
              whenBuy: true,
              whenSell: false,
              whenStrongSell: false,
              whenNeutral: false,
            },
          ],
        },
        signals: [{ interval: '1m', signal: null }],
      },
      override: { kind: 'trigger-buy', overrideActionId: OVERRIDE_ID },
    });
    const out = trailingTrade.tick(baseInput({ bundle }));
    expect(out.decisions[0]).toMatchObject({
      type: 'place-order',
      intent: { side: 'BUY', reason: 'grid-buy' },
      params: { type: 'MARKET' },
    });
  });

  it('honors disabledUntilMs for trigger-buy overrides', () => {
    const state: TTState = {
      schemaVersion: '2.0.0',
      avgEntryPrice: null,
      disabledUntilMs: 9_999_999_999,
      triggers: { override: null },
    };
    const bundle = TTBundleSchema.parse({
      technicals: {
        config: {
          useOnlyWithinMin: 2,
          ifExpires: 'do-not-buy',
          intervals: [
            {
              interval: '1m',
              whenStrongBuy: true,
              whenBuy: true,
              whenSell: false,
              whenStrongSell: false,
              whenNeutral: false,
            },
          ],
        },
        signals: [{ interval: '1m', signal: null }],
      },
      override: { kind: 'trigger-buy', overrideActionId: OVERRIDE_ID },
    });
    const out = trailingTrade.tick(baseInput({ bundle, state, nowMs: 1_000 }));
    expect(out.decisions).toEqual([{ type: 'noop' }]);
    expect(out.logs[0]?.context).toMatchObject({ reason: 'disabled-until' });
  });

  it('refuses trigger-buy when an open BUY already exists', () => {
    const bundle = TTBundleSchema.parse({
      technicals: {
        config: {
          useOnlyWithinMin: 2,
          ifExpires: 'do-not-buy',
          intervals: [
            {
              interval: '1m',
              whenStrongBuy: true,
              whenBuy: true,
              whenSell: false,
              whenStrongSell: false,
              whenNeutral: false,
            },
          ],
        },
        signals: [{ interval: '1m', signal: null }],
      },
      override: { kind: 'trigger-buy', overrideActionId: OVERRIDE_ID },
    });
    const openBuy: OpenOrder = {
      id: 1,
      symbol: 'BTCUSDT',
      side: 'BUY',
      type: 'LIMIT',
      price: '40000',
      origQty: '0.001',
      executedQty: '0',
      status: 'NEW',
      clientOrderId: 'pre-existing',
      timeInForce: 'GTC',
      stopPrice: undefined,
      icebergQty: undefined,
      isWorking: true,
    } as unknown as OpenOrder;
    const out = trailingTrade.tick(baseInput({ bundle, openOrders: [openBuy] }));
    expect(out.decisions).toEqual([{ type: 'noop' }]);
    expect(out.logs[0]?.context).toMatchObject({ reason: 'open-buy' });
  });

  it('trigger-sell with no held balance emits a noop with a debug-level skipped log (#265)', () => {
    // No `account.balances[BTC]` in baseInput → free defaults to '0' →
    // `computeSellQuantity` skips with `no-balance`. This is the
    // expected idle path on a no-position profile and must NOT spam
    // the operator-alert WARN channel.
    const bundle = TTBundleSchema.parse({
      technicals: {
        config: {
          useOnlyWithinMin: 2,
          ifExpires: 'do-not-buy',
          intervals: [
            {
              interval: '1m',
              whenStrongBuy: true,
              whenBuy: true,
              whenSell: false,
              whenStrongSell: false,
              whenNeutral: false,
            },
          ],
        },
        signals: [{ interval: '1m', signal: null }],
      },
      override: { kind: 'trigger-sell', overrideActionId: OVERRIDE_ID },
    });
    const out = trailingTrade.tick(baseInput({ bundle }));
    expect(out.decisions).toEqual([{ type: 'noop' }]);
    expect(out.logs[0]?.message).toBe('tt-trigger-sell-skipped');
    expect(out.logs[0]?.level).toBe('debug');
    expect(out.logs[0]?.context).toMatchObject({ reason: 'no-balance' });
  });

  it('trigger-sell with a held balance emits MARKET SELL and resets state', () => {
    const bundle = TTBundleSchema.parse({
      technicals: {
        config: {
          useOnlyWithinMin: 2,
          ifExpires: 'do-not-buy',
          intervals: [
            {
              interval: '1m',
              whenStrongBuy: true,
              whenBuy: true,
              whenSell: false,
              whenStrongSell: false,
              whenNeutral: false,
            },
          ],
        },
        signals: [{ interval: '1m', signal: null }],
      },
      override: { kind: 'trigger-sell', overrideActionId: OVERRIDE_ID },
    });
    const stateWithBuy: TTState = {
      ...trailingTrade.initialState(cfg()),
      avgEntryPrice: '50000.00',
      highSinceBuy: '52000.00',
    };
    const out = trailingTrade.tick({
      ...baseInput({ bundle, state: stateWithBuy }),
      account: {
        balances: { BTC: { asset: 'BTC', free: new Decimal('0.5'), locked: new Decimal(0) } },
        readable: true,
      },
    });
    expect(out.decisions[0]).toMatchObject({
      type: 'place-order',
      intent: { side: 'SELL', reason: 'manual' },
      params: { type: 'MARKET' },
    });
    expect(out.nextState.avgEntryPrice).toBeNull();
    expect(out.nextState.highSinceBuy).toBeNull();
  });

  it('returns noop when state is disabled and not yet expired', () => {
    const state: TTState = {
      schemaVersion: '2.0.0',
      avgEntryPrice: null,
      disabledUntilMs: 1_000,
      triggers: { override: null },
    };
    const out = trailingTrade.tick(baseInput({ state, nowMs: 500 }));
    expect(out.decisions).toEqual([{ type: 'noop' }]);
    expect(out.nextState.disabledUntilMs).toBe(1_000);
  });

  it('clears stale disabledUntilMs once expired then falls through', () => {
    const state: TTState = {
      schemaVersion: '2.0.0',
      avgEntryPrice: null,
      disabledUntilMs: 1_000,
      triggers: { override: null },
    };
    const out = trailingTrade.tick(baseInput({ state, nowMs: 2_000 }));
    expect(out.nextState.disabledUntilMs).toBeNull();
    // signal=null + default checkTechnicals=true → TV gate blocks the buy,
    // so we still land on the snapshot path.
    expect(out.decisions[0]?.type).toBe('emit-event');
  });
});

describe('@app/strategy-trailing-trade tick — TV gate + first-buy emission', () => {
  it('emits tick-snapshot when TV signal is null (safe default)', () => {
    const out = trailingTrade.tick(baseInput({ bundle: bundleWith(null) }));
    expect(out.decisions).toHaveLength(1);
    expect(out.decisions[0]).toMatchObject({
      type: 'emit-event',
      eventType: 'tick-snapshot',
    });
  });

  it('blocks the buy when TV says SELL', () => {
    const bundle = bundleWith({
      symbol: 'BTCUSDT',
      recommendation: 'SELL',
      receivedAtMs: 0,
    });
    const out = trailingTrade.tick(baseInput({ bundle }));
    expect(out.decisions).toHaveLength(1);
    expect(out.decisions[0]?.type).toBe('emit-event');
    expect(out.decisions.some((d) => d.type === 'place-order')).toBe(false);
  });

  it('blocks the buy when TV says STRONG_SELL', () => {
    const bundle = bundleWith({
      symbol: 'BTCUSDT',
      recommendation: 'STRONG_SELL',
      receivedAtMs: 0,
    });
    const out = trailingTrade.tick(baseInput({ bundle }));
    expect(out.decisions).toHaveLength(1);
    expect(out.decisions[0]?.type).toBe('emit-event');
    expect(out.decisions.some((d) => d.type === 'place-order')).toBe(false);
  });

  it.each(['BUY', 'STRONG_BUY', 'NEUTRAL'] as const)(
    'emits a place-order MARKET BUY when TV says %s',
    (recommendation) => {
      // ageMs===0: signal arrives at the same instant the clock reports, so
      // the freshness gate (`useOnlyWithinMin` window) never trips and the
      // recommendation check below is the only thing under test.
      const NOW_MS = 1_700_000_000_000;
      const bundle = bundleWith({
        symbol: 'BTCUSDT',
        recommendation,
        receivedAtMs: NOW_MS,
      });
      const out = trailingTrade.tick(baseInput({ bundle, nowMs: NOW_MS }));
      expect(out.decisions).toHaveLength(1);
      expect(out.decisions[0]).toMatchObject({
        type: 'place-order',
        intent: {
          symbol: 'BTCUSDT',
          side: 'BUY',
          reason: 'grid-buy',
          clientOrderId: 'tt-57638a9b-b',
        },
        params: { type: 'MARKET' },
      });
      expect(out.metrics[0]).toMatchObject({ name: 'tt_tick_buy_path' });
    },
  );

  it('uses the same clientOrderId across retries of the same logical first buy', () => {
    const bundle = bundleWith({ symbol: 'BTCUSDT', recommendation: 'BUY', receivedAtMs: 0 });
    const a = trailingTrade.tick(baseInput({ bundle, nowMs: 1 }));
    const b = trailingTrade.tick(baseInput({ bundle, nowMs: 9_999 }));
    if (a.decisions[0]?.type !== 'place-order' || b.decisions[0]?.type !== 'place-order') {
      throw new Error('expected place-order on both ticks');
    }
    expect(a.decisions[0].intent.clientOrderId).toBe(b.decisions[0].intent.clientOrderId);
  });

  it('produces a clientOrderId within Binance length and charset', () => {
    const bundle = bundleWith({ symbol: 'BTCUSDT', recommendation: 'BUY', receivedAtMs: 0 });
    const out = trailingTrade.tick(baseInput({ bundle }));
    if (out.decisions[0]?.type !== 'place-order') {
      throw new Error('expected place-order');
    }
    const coid = out.decisions[0].intent.clientOrderId;
    expect(coid.length).toBeLessThanOrEqual(36);
    expect(coid).toMatch(/^[A-Za-z0-9._:/-]+$/);
  });

  it('emits a place-order even when TV says SELL if forceBuyOverride.checkTechnicals=false (covers #46-D)', () => {
    const bundle = bundleWith({
      symbol: 'BTCUSDT',
      recommendation: 'SELL',
      receivedAtMs: 0,
    });
    const out = trailingTrade.tick(
      baseInput({
        bundle,
        config: cfg({ checkTechnicals: false }),
        nowMs: 1_700_000_000_000,
      }),
    );
    expect(out.decisions[0]).toMatchObject({
      type: 'place-order',
      intent: { side: 'BUY', reason: 'grid-buy' },
      params: { type: 'MARKET' },
    });
  });

  it('blocks the buy when buy.enabled=false even with permissive TV', () => {
    const bundle = bundleWith({ symbol: 'BTCUSDT', recommendation: 'BUY', receivedAtMs: 0 });
    const out = trailingTrade.tick(baseInput({ bundle, config: cfg({ buyEnabled: false }) }));
    expect(out.decisions).toHaveLength(1);
    expect(out.decisions[0]?.type).toBe('emit-event');
    expect(out.decisions.some((d) => d.type === 'place-order')).toBe(false);
  });

  it('blocks the buy when avgEntryPrice is already set', () => {
    const bundle = bundleWith({ symbol: 'BTCUSDT', recommendation: 'BUY', receivedAtMs: 0 });
    const state: TTState = {
      schemaVersion: '2.0.0',
      avgEntryPrice: '49000.00',
      disabledUntilMs: null,
      triggers: { override: null },
    };
    const out = trailingTrade.tick(baseInput({ bundle, state }));
    expect(out.decisions).toHaveLength(1);
    expect(out.decisions[0]?.type).toBe('emit-event');
    expect(out.decisions.some((d) => d.type === 'place-order')).toBe(false);
  });

  it('blocks the buy when an open BUY order already exists for the symbol', () => {
    const bundle = bundleWith({ symbol: 'BTCUSDT', recommendation: 'BUY', receivedAtMs: 0 });
    const openOrders: readonly OpenOrder[] = [
      {
        orderId: 1,
        clientOrderId: 'existing',
        symbol: 'BTCUSDT',
        side: 'BUY',
        type: 'LIMIT',
        status: 'NEW',
        price: '49000',
        origQty: '0.0001',
        executedQty: '0',
        cummulativeQuoteQty: '0',
        transactTimeMs: 0,
        updateTimeMs: 0,
      },
    ];
    const out = trailingTrade.tick(baseInput({ bundle, openOrders }));
    expect(out.decisions).toHaveLength(1);
    expect(out.decisions[0]?.type).toBe('emit-event');
    expect(out.decisions.some((d) => d.type === 'place-order')).toBe(false);
  });

  it('does NOT block the buy on an open SELL order for the same symbol', () => {
    const bundle = bundleWith({ symbol: 'BTCUSDT', recommendation: 'BUY', receivedAtMs: 0 });
    const openOrders: readonly OpenOrder[] = [
      {
        orderId: 2,
        clientOrderId: 'sell-1',
        symbol: 'BTCUSDT',
        side: 'SELL',
        type: 'LIMIT',
        status: 'NEW',
        price: '52000',
        origQty: '0.0001',
        executedQty: '0',
        cummulativeQuoteQty: '0',
        transactTimeMs: 0,
        updateTimeMs: 0,
      },
    ];
    const out = trailingTrade.tick(baseInput({ bundle, openOrders }));
    expect(out.decisions[0]?.type).toBe('place-order');
  });

  it.each([
    ['min-notional', { minNotional: '1000000' }],
    ['min-qty', { minQty: '1000', minNotional: '0' }],
    ['invalid-filters', { stepSize: '0' }],
  ] as const)(
    'emits tick-snapshot + tt_first_buy_skipped reason=%s when filters reject the buy',
    (reason, filterOverride) => {
      const bundle = bundleWith({ symbol: 'BTCUSDT', recommendation: 'BUY', receivedAtMs: 0 });
      const input = baseInput({ bundle });
      const out = trailingTrade.tick({
        ...input,
        market: {
          ...input.market,
          symbolInfo: {
            ...input.market.symbolInfo,
            filters: { ...input.market.symbolInfo.filters, ...filterOverride },
          },
        },
      });
      expect(out.decisions[0]?.type).toBe('emit-event');
      expect(out.metrics).toContainEqual({
        name: 'tt_first_buy_skipped',
        value: 1,
        tags: { symbol: 'BTCUSDT', reason },
      });
    },
  );

  it('skips the no-grid entry with reason=sizing-unconfigured when the unparsed config lacks entrySizing', () => {
    const bundle = bundleWith({ symbol: 'BTCUSDT', recommendation: 'BUY', receivedAtMs: 0 });
    const input = baseInput({ bundle });
    // The live worker hands tick() raw stored config; a config saved before
    // entrySizing existed has no such field — the entry must fail safe.
    const { entrySizing: _drop, ...buyNoSizing } = input.config.buy;
    const out = trailingTrade.tick({
      ...input,
      config: { ...input.config, buy: buyNoSizing } as typeof input.config,
    });
    expect(out.metrics).toContainEqual({
      name: 'tt_first_buy_skipped',
      value: 1,
      tags: { symbol: 'BTCUSDT', reason: 'sizing-unconfigured' },
    });
    expect(out.nextState.entryBlocker?.reason).toBe('sizing-unconfigured');
  });

  it('skips the no-grid entry with reason=cap-reached when already at the reserve cap', () => {
    const bundle = bundleWith({ symbol: 'BTCUSDT', recommendation: 'BUY', receivedAtMs: 0 });
    const input = baseInput({ bundle });
    const out = trailingTrade.tick({
      ...input,
      config: {
        ...input.config,
        buy: { ...input.config.buy, accountCap: { mode: 'amount', amount: '100' } },
      } as typeof input.config,
      account: { ...input.account, deployedQuoteAcrossProfiles: '100' },
    });
    expect(out.metrics).toContainEqual({
      name: 'tt_first_buy_skipped',
      value: 1,
      tags: { symbol: 'BTCUSDT', reason: 'cap-reached' },
    });
    expect(out.nextState.entryBlocker?.reason).toBe('cap-reached');
  });

  it('rounds quantity down to stepSize', () => {
    const bundle = bundleWith({ symbol: 'BTCUSDT', recommendation: 'BUY', receivedAtMs: 0 });
    const input = baseInput({ bundle });
    // budget=50 / price=50000 = 0.001 BTC exactly; stepSize=0.0001 → unchanged.
    const out = trailingTrade.tick(input);
    expect(out.decisions[0]).toMatchObject({
      type: 'place-order',
      params: { type: 'MARKET', quantity: '0.0010' },
    });
  });

  it('is deterministic for identical inputs', () => {
    const a = trailingTrade.tick(baseInput());
    const b = trailingTrade.tick(baseInput());
    expect(a).toEqual(b);
  });
});

describe('@app/strategy-trailing-trade tick — order intent contract', () => {
  it('first-buy emission uses an intent in TT`s declared vocabulary', () => {
    // Runtime guard so TT only ever emits one of its own `TTIntent` values.
    // The DB no longer constrains intent (it is an open strategy-owned
    // string), so this strategy-level check is the remaining safety net.
    const c = cfg();
    const buyState: TTState = { ...trailingTrade.initialState(c), avgEntryPrice: null };
    const buyBundle = TTBundleSchema.parse({
      technicals: {
        config: {
          useOnlyWithinMin: 2,
          ifExpires: 'do-not-buy',
          intervals: [
            {
              interval: '1m',
              whenStrongBuy: true,
              whenBuy: true,
              whenSell: false,
              whenStrongSell: false,
              whenNeutral: false,
            },
          ],
        },
        signals: [
          {
            interval: '1m',
            signal: { symbol: 'BTCUSDT', recommendation: 'BUY', receivedAtMs: 1_700_000_000_000 },
          },
        ],
      },
      override: null,
    });
    const ALLOWED = [
      'grid-buy',
      'grid-sell',
      'grid-stop-loss',
      'technicals-force-sell',
      'manual',
    ] as const;
    const out = trailingTrade.tick(
      baseInput({ state: buyState, bundle: buyBundle, nowMs: 1_700_000_000_000 }),
    );
    const placeOrders = out.decisions.filter((d) => d.type === 'place-order');
    // Without this `> 0` guard the for-loop would pass vacuously if the
    // strategy stopped emitting place-order on this input, hiding the
    // regression instead of catching it.
    expect(placeOrders.length).toBeGreaterThan(0);
    for (const d of placeOrders) {
      if (d.type === 'place-order') {
        expect(ALLOWED).toContain(d.intent.reason);
      }
    }
  });
});

describe('@app/strategy-trailing-trade tick — avgEntryPriceRemoveThreshold', () => {
  // Profile-shape: avgEntryPrice = 50000, threshold = 0.95 ⇒ clear-trigger
  // fires at price <= 47500. The reference tests below toggle the
  // remaining preconditions (open BUY, held balance) to pin each veto.
  const lbpConfig = (): TTConfig => {
    const raw: Record<string, unknown> = {
      symbol: 'BTCUSDT',
      buy: {
        enabled: true,
        entrySizing: { mode: 'fixed', amount: '50' },
        avgEntryPriceRemoveThreshold: '0.95',
      },
      sell: { enabled: true, stopLossPercentage: '0.97', triggerPercentage: '1.05' },
    };
    return TTConfigSchema.parse(raw);
  };
  const lbpState = (): TTState => ({
    schemaVersion: '2.0.0',
    avgEntryPrice: '50000.00',
    disabledUntilMs: null,
    triggers: { override: null },
  });

  it('does not clear when price equals lbp (boundary: price > lbp * threshold)', () => {
    // baseInput's currentPrice is 50000 (matches lbpState's avgEntryPrice).
    // 50000 > 50000 * 0.95 (47500), so the threshold does NOT trip.
    const out = trailingTrade.tick(baseInput({ state: lbpState(), config: lbpConfig() }));
    expect(out.nextState.avgEntryPrice).toBe('50000.00');
  });

  it('clears avgEntryPrice when price drops below threshold, no open BUY, no held balance', () => {
    const subThresholdInput = {
      ...baseInput({ state: lbpState(), config: lbpConfig() }),
      market: { ...baseInput().market, currentPrice: '47000.00' },
    };
    const out = trailingTrade.tick(subThresholdInput);
    expect(out.nextState.avgEntryPrice).toBeNull();
    // Clear should also emit the audit-trail log so the operator sees
    // why their entry was abandoned.
    const lbpLog = out.logs.find((l) => l.message === 'tt-lbp-cleared');
    expect(lbpLog).toBeDefined();
    expect(lbpLog?.context).toMatchObject({ symbol: 'BTCUSDT', threshold: '0.95' });
  });

  it('clears at the exact boundary price (price === lbp * threshold)', () => {
    // 50000 * 0.95 = 47500. price <= limit, so the gate fires.
    const boundaryInput = {
      ...baseInput({ state: lbpState(), config: lbpConfig() }),
      market: { ...baseInput().market, currentPrice: '47500.00' },
    };
    const out = trailingTrade.tick(boundaryInput);
    expect(out.nextState.avgEntryPrice).toBeNull();
  });

  it('re-enables first-buy in the SAME tick after lbp clear (TV gate permitting)', () => {
    // After the lbp clear, the first-buy gate evaluates `nextState.avgEntryPrice === null`
    // truthy in the same tick. With a fresh BUY signal the strategy emits a
    // place-order Decision, not just a snapshot. This is the escape-hatch
    // semantic: the operator wants the strategy to re-enter using the now-low
    // price as the fresh entry.
    const clearAndRebuyInput = {
      ...baseInput({ state: lbpState(), config: lbpConfig() }),
      market: { ...baseInput().market, currentPrice: '47000.00' },
      bundle: TTBundleSchema.parse({
        technicals: {
          config: {
            useOnlyWithinMin: 2,
            ifExpires: 'do-not-buy',
            intervals: [
              {
                interval: '1m',
                whenStrongBuy: true,
                whenBuy: true,
                whenSell: false,
                whenStrongSell: false,
                whenNeutral: false,
              },
            ],
          },
          signals: [
            {
              interval: '1m',
              signal: { symbol: 'BTCUSDT', recommendation: 'BUY', receivedAtMs: 1_700_000_000_000 },
            },
          ],
        },
        override: null,
      }),
      clock: { nowMs: () => 1_700_000_000_000 },
    };
    const out = trailingTrade.tick(clearAndRebuyInput);
    expect(out.nextState.avgEntryPrice).toBeNull();
    const placeOrders = out.decisions.filter((d) => d.type === 'place-order');
    expect(placeOrders.length).toBe(1);
    if (placeOrders[0]?.type === 'place-order') {
      expect(placeOrders[0].intent.side).toBe('BUY');
      expect(placeOrders[0].intent.reason).toBe('grid-buy');
    }
    // Audit log surfaces both events: lbp cleared + first-buy emit (the
    // first-buy decision itself; first-buy has no extra log entry today).
    expect(out.logs.some((l) => l.message === 'tt-lbp-cleared')).toBe(true);
  });

  it('refuses to clear when an open BUY exists for the symbol', () => {
    const openBuy = {
      orderId: 1,
      symbol: 'BTCUSDT',
      side: 'BUY',
      type: 'LIMIT',
      status: 'NEW',
      origQty: '0.001',
      executedQty: '0',
    } as unknown as OpenOrder;
    const subThresholdInput = {
      ...baseInput({ state: lbpState(), config: lbpConfig(), openOrders: [openBuy] }),
      market: { ...baseInput().market, currentPrice: '47000.00' },
    };
    const out = trailingTrade.tick(subThresholdInput);
    expect(out.nextState.avgEntryPrice).toBe('50000.00');
  });

  it('does not run lbp-clear path when held — sell-side stop-loss takes priority instead', () => {
    // With sell enabled + held balance + sub-threshold price, the
    // sell-side stop-loss branch (priority over lbp-clear) fires
    // BEFORE the lbp-clear check is even reached. State still
    // resets (lbp becomes null) but via a real SELL Decision, not
    // a silent state mutation.
    const subThresholdInput = {
      ...baseInput({ state: lbpState(), config: lbpConfig() }),
      market: { ...baseInput().market, currentPrice: '47000.00' },
      account: {
        balances: { BTC: { asset: 'BTC', free: new Decimal('0.5'), locked: new Decimal(0) } },
        readable: true,
      },
    };
    const out = trailingTrade.tick(subThresholdInput);
    expect(out.decisions[0]).toMatchObject({
      type: 'place-order',
      intent: { side: 'SELL', reason: 'grid-stop-loss' },
    });
    expect(out.nextState.avgEntryPrice).toBeNull();
    expect(out.logs.find((l) => l.message === 'tt-lbp-cleared')).toBeUndefined();
  });

  it('lbp-clear path runs only when sell is disabled AND no balance held', () => {
    // Isolate the lbp-clear gate by turning off sell. With held
    // balance the gate still refuses (the original semantic) — no
    // sell, no clear.
    const noSellConfig = TTConfigSchema.parse({
      symbol: 'BTCUSDT',
      buy: {
        enabled: true,
        entrySizing: { mode: 'fixed', amount: '50' },
        avgEntryPriceRemoveThreshold: '0.95',
      },
      sell: { enabled: false, stopLossPercentage: '0.97', triggerPercentage: '1.05' },
    });
    const subThresholdInput = {
      ...baseInput({ state: lbpState(), config: noSellConfig }),
      market: { ...baseInput().market, currentPrice: '47000.00' },
      account: {
        balances: { BTC: { asset: 'BTC', free: new Decimal('0.5'), locked: new Decimal(0) } },
        readable: true,
      },
    };
    const out = trailingTrade.tick(subThresholdInput);
    // Held balance refuses lbp-clear; sell disabled so no SELL emit.
    expect(out.nextState.avgEntryPrice).toBe('50000.00');
  });

  it('refuses to clear when threshold is zero (disabled) regardless of price', () => {
    const disabledThresholdConfig: TTConfig = TTConfigSchema.parse({
      symbol: 'BTCUSDT',
      buy: {
        enabled: true,
        entrySizing: { mode: 'fixed', amount: '50' },
        avgEntryPriceRemoveThreshold: '0',
      },
      sell: { enabled: true, stopLossPercentage: '0.97', triggerPercentage: '1.05' },
    });
    const subThresholdInput = {
      ...baseInput({ state: lbpState(), config: disabledThresholdConfig }),
      market: { ...baseInput().market, currentPrice: '1.00' },
    };
    const out = trailingTrade.tick(subThresholdInput);
    expect(out.nextState.avgEntryPrice).toBe('50000.00');
  });

  it('refuses to load a threshold outside (0, 1] via schema validation', () => {
    // Schema-layer guard: a > 1 threshold would trigger on price ABOVE
    // entry, which is never intended. The strategy never sees an
    // out-of-range value because the config refuses to parse.
    expect(() =>
      TTConfigSchema.parse({
        symbol: 'BTCUSDT',
        buy: {
          enabled: true,
          entrySizing: { mode: 'fixed', amount: '50' },
          avgEntryPriceRemoveThreshold: '1.5',
        },
        sell: { enabled: true, stopLossPercentage: '0.97', triggerPercentage: '1.05' },
      }),
    ).toThrow();
    expect(() =>
      TTConfigSchema.parse({
        symbol: 'BTCUSDT',
        buy: {
          enabled: true,
          entrySizing: { mode: 'fixed', amount: '50' },
          avgEntryPriceRemoveThreshold: '-0.5',
        },
        sell: { enabled: true, stopLossPercentage: '0.97', triggerPercentage: '1.05' },
      }),
    ).toThrow();
  });
});

describe('@app/strategy-trailing-trade config — candleInterval enum', () => {
  it('accepts the supported Binance intervals (1m through 1d) without 3m/2h/3d', () => {
    for (const iv of ['1m', '5m', '15m', '30m', '1h', '4h', '1d'] as const) {
      const parsed = TTConfigSchema.parse({
        symbol: 'BTCUSDT',
        candleInterval: iv,
        buy: {
          enabled: true,
          entrySizing: { mode: 'fixed', amount: '50' },
          avgEntryPriceRemoveThreshold: '0',
        },
        sell: { enabled: true, stopLossPercentage: '0.97', triggerPercentage: '1.05' },
      });
      expect(parsed.candleInterval).toBe(iv);
    }
  });

  it('rejects unsupported intervals (e.g. 3m, 2h, 1w)', () => {
    for (const bad of ['3m', '2h', '1w', '1M']) {
      expect(() =>
        TTConfigSchema.parse({
          symbol: 'BTCUSDT',
          candleInterval: bad,
          buy: {
            enabled: true,
            entrySizing: { mode: 'fixed', amount: '50' },
            avgEntryPriceRemoveThreshold: '0',
          },
          sell: { enabled: true, stopLossPercentage: '0.97', triggerPercentage: '1.05' },
        }),
      ).toThrow();
    }
  });

  it('defaults to 1h when candleInterval is omitted', () => {
    const parsed = TTConfigSchema.parse({
      symbol: 'BTCUSDT',
      buy: {
        enabled: true,
        entrySizing: { mode: 'fixed', amount: '50' },
        avgEntryPriceRemoveThreshold: '0',
      },
      sell: { enabled: true, stopLossPercentage: '0.97', triggerPercentage: '1.05' },
    });
    expect(parsed.candleInterval).toBe('1h');
  });
});

describe('@app/strategy-trailing-trade tick — sell-side decisions', () => {
  // Sell-side fixture: lbp=50000, stopLoss=0.97 (sells at <=48500),
  // trigger=1.05 (arms trailing at >=52500), trailingStop=0.98 (sells
  // when price retraces 2% from highSinceBuy). Held balance is
  // injected via account.balances to satisfy the no-balance guard.
  const sellCfg = (): TTConfig =>
    TTConfigSchema.parse({
      symbol: 'BTCUSDT',
      buy: {
        enabled: true,
        entrySizing: { mode: 'fixed', amount: '50' },
        avgEntryPriceRemoveThreshold: '0',
      },
      sell: {
        enabled: true,
        stopLossPercentage: '0.97',
        triggerPercentage: '1.05',
        trailingStopPercentage: '0.98',
      },
    });
  const sellState = (highSinceBuy: string | null = null): TTState => ({
    ...trailingTrade.initialState(sellCfg()),
    avgEntryPrice: '50000.00',
    highSinceBuy,
  });
  const withHeld = (
    overrides: Parameters<typeof baseInput>[0] = {},
  ): TickInput<TTConfig, TTState, TTBundle> => ({
    ...baseInput(overrides),
    account: {
      balances: { BTC: { asset: 'BTC', free: new Decimal('0.5'), locked: new Decimal(0) } },
      readable: true,
    },
  });

  it('baseline (price === lbp) does not fire stop-loss', () => {
    const out = trailingTrade.tick(withHeld({ state: sellState(), config: sellCfg() }));
    expect(out.decisions[0]?.type).toBe('emit-event');
  });

  it('emits MARKET SELL with reason=grid-stop-loss at sub-stop-loss price', () => {
    // 47000 < 50000 * 0.97 = 48500 triggers stop-loss.
    const out = trailingTrade.tick({
      ...withHeld({ state: sellState(), config: sellCfg() }),
      market: { ...baseInput().market, currentPrice: '47000.00' },
    });
    expect(out.decisions[0]).toMatchObject({
      type: 'place-order',
      intent: { side: 'SELL', reason: 'grid-stop-loss' },
      params: { type: 'MARKET' },
    });
    expect(out.nextState.avgEntryPrice).toBeNull();
    expect(out.nextState.highSinceBuy).toBeNull();
  });

  it('arms highSinceBuy at trigger threshold; no place-order yet', () => {
    // Price at lbp*trigger = 52500. Trigger fires → highSinceBuy = 52500.
    const out = trailingTrade.tick({
      ...withHeld({ state: sellState(), config: sellCfg() }),
      market: { ...baseInput().market, currentPrice: '52500.00' },
    });
    // Normalized Decimal of the high-water reference (here the live price, as
    // this fixture has no closed candle to ratchet on): 52500.00 == 52500.
    expect(out.nextState.highSinceBuy).toBe('52500');
    // No SELL Decision yet — trailing window just armed.
    expect(out.decisions.find((d) => d.type === 'place-order')).toBeUndefined();
  });

  it('bumps highSinceBuy when price climbs higher post-trigger', () => {
    // Start with highSinceBuy=52500, price climbs to 55000 → bumped.
    const out = trailingTrade.tick({
      ...withHeld({ state: sellState('52500.00'), config: sellCfg() }),
      market: { ...baseInput().market, currentPrice: '55000.00' },
    });
    // 55000.00 == 55000 (normalized high-water reference; no closed candle here).
    expect(out.nextState.highSinceBuy).toBe('55000');
    expect(out.decisions.find((d) => d.type === 'place-order')).toBeUndefined();
  });

  it('trigger-arm seeds highSinceBuy from the closed-candle close, not a live wick', () => {
    // Trigger met on the live price (60000 >= 50000*1.05 = 52500), but the latest
    // closed candle closed at 52500. The high-water mark must seed from the
    // closed close (52500), NOT the live wick (60000), or a transient spike would
    // inflate the trail and clip the winner on the next pullback.
    const closedCandle = {
      openTimeMs: 0,
      closeTimeMs: 3_599_999,
      open: '52500.00',
      high: '52500.00',
      low: '52500.00',
      close: '52500.00',
      volume: '1',
      isClosed: true,
    };
    const out = trailingTrade.tick({
      ...withHeld({ state: sellState(), config: sellCfg() }),
      market: {
        ...baseInput().market,
        currentPrice: '60000.00',
        candlesByInterval: { '1h': [closedCandle] },
      },
    });
    expect(out.nextState.highSinceBuy).toBe('52500');
    expect(out.decisions.find((d) => d.type === 'place-order')).toBeUndefined();
  });

  it('emits MARKET SELL with reason=grid-sell when price retraces past trailingStop', () => {
    // highSinceBuy=55000, trailingStop=0.98 → trigger at <=55000*0.98=53900.
    const out = trailingTrade.tick({
      ...withHeld({ state: sellState('55000.00'), config: sellCfg() }),
      market: { ...baseInput().market, currentPrice: '53000.00' },
    });
    expect(out.decisions[0]).toMatchObject({
      type: 'place-order',
      intent: { side: 'SELL', reason: 'grid-sell' },
      params: { type: 'MARKET' },
    });
    expect(out.nextState.avgEntryPrice).toBeNull();
    expect(out.nextState.highSinceBuy).toBeNull();
  });

  it('skips SELL with a debug-level log when no balance is held (#265)', () => {
    // Same sub-stop-loss price but no balance → skip with `no-balance`.
    // Level must be debug; the no-balance path is the steady-state idle
    // tick for any profile without a position.
    const out = trailingTrade.tick({
      ...baseInput({ state: sellState(), config: sellCfg() }),
      market: { ...baseInput().market, currentPrice: '47000.00' },
    });
    expect(out.decisions.find((d) => d.type === 'place-order')).toBeUndefined();
    const skipLog = out.logs.find((l) => l.message === 'tt-stop-loss-skipped');
    expect(skipLog).toBeDefined();
    expect(skipLog?.level).toBe('debug');
    expect(skipLog?.context).toMatchObject({ reason: 'no-balance' });
  });

  // #265: every SellSkipReason maps to exactly one log level via
  // `sellSkipLogLevel`. `holdsBalance` toggles between `baseInput` (zero
  // free balance — drives `no-balance`) and `withHeld` (0.5 BTC free —
  // lets the gate reach the filter checks).
  it.each([
    { reason: 'no-balance', filters: {}, level: 'debug', holdsBalance: false },
    // wallet has balance, but rounded-to-stepSize quantity < minQty.
    { reason: 'min-qty', filters: { minQty: '1' }, level: 'info', holdsBalance: true },
    // quantity passes minQty but quantity*price < minNotional.
    {
      reason: 'min-notional',
      filters: { minNotional: '1000000' },
      level: 'info',
      holdsBalance: true,
    },
    // malformed exchangeInfo — operator must act.
    { reason: 'invalid-filters', filters: { stepSize: '0' }, level: 'warn', holdsBalance: true },
  ] as const)(
    'sell-skip reason=$reason logs at level=$level (#265)',
    ({ reason, filters, level, holdsBalance }) => {
      const setup = { state: sellState(), config: sellCfg() };
      const input = holdsBalance ? withHeld(setup) : baseInput(setup);
      const out = trailingTrade.tick({
        ...input,
        market: {
          ...input.market,
          currentPrice: '47000.00', // sub-stop-loss to drive the sell gate
          symbolInfo: {
            ...input.market.symbolInfo,
            filters: { ...input.market.symbolInfo.filters, ...filters },
          },
        },
      });
      const skipLog = out.logs.find((l) => l.message === 'tt-stop-loss-skipped');
      expect(skipLog).toBeDefined();
      expect(skipLog?.level).toBe(level);
      expect(skipLog?.context).toMatchObject({ reason });
    },
  );

  it('preserves state.heldQuantity across SELL emit — fill-adopter owns the clear (issue #243)', () => {
    // The strategy does NOT optimistically null heldQuantity on SELL
    // emit. The fill-adopter writes null (full fill) or remaining
    // (partial) on the executionReport. Locks this in so a future
    // refactor can't silently re-introduce the optimistic clear.
    const stateWithHeld: TTState = { ...sellState(), heldQuantity: '0.001' };
    const out = trailingTrade.tick({
      ...withHeld({ state: stateWithHeld, config: sellCfg() }),
      market: { ...baseInput().market, currentPrice: '47000.00' },
    });
    expect(out.decisions[0]).toMatchObject({ intent: { side: 'SELL' } });
    expect(out.nextState.heldQuantity).toBe('0.001');
    // Other post-sell fields are still cleared optimistically — they are
    // price / index bookkeeping, not sizing inputs.
    expect(out.nextState.avgEntryPrice).toBeNull();
    expect(out.nextState.highSinceBuy).toBeNull();
  });

  it('sells from state.heldQuantity when set (capped by wallet free) — issue #243', () => {
    // Wallet free 0.5 BTC but only 0.001 has been adopted into state.
    // Stop-loss must use the smaller of the two: state.heldQuantity.
    const stateWithHeld: TTState = { ...sellState(), heldQuantity: '0.001' };
    const out = trailingTrade.tick({
      ...withHeld({ state: stateWithHeld, config: sellCfg() }),
      market: { ...baseInput().market, currentPrice: '47000.00' },
    });
    expect(out.decisions[0]).toMatchObject({
      type: 'place-order',
      intent: { side: 'SELL', reason: 'grid-stop-loss' },
      params: { type: 'MARKET', quantity: '0.0010' },
    });
  });

  it('falls back to wallet.free when state.heldQuantity is null (legacy / pre-adopter row)', () => {
    // heldQuantity null → resolveHeldForSell returns wallet.free verbatim.
    // Wallet = 0.5 BTC, stepSize 0.0001 → quantity rounds to stepSize precision.
    const out = trailingTrade.tick({
      ...withHeld({ state: sellState(), config: sellCfg() }),
      market: { ...baseInput().market, currentPrice: '47000.00' },
    });
    expect(out.decisions[0]).toMatchObject({
      type: 'place-order',
      intent: { side: 'SELL', reason: 'grid-stop-loss' },
      params: { type: 'MARKET', quantity: '0.5000' },
    });
  });

  it('refuses SELL when an open SELL already exists for the symbol (de-dup)', () => {
    const openSell: OpenOrder = {
      orderId: 1,
      symbol: 'BTCUSDT',
      side: 'SELL',
      type: 'LIMIT',
      status: 'NEW',
      origQty: '0.001',
      executedQty: '0',
    } as unknown as OpenOrder;
    const out = trailingTrade.tick({
      ...withHeld({ state: sellState(), config: sellCfg(), openOrders: [openSell] }),
      market: { ...baseInput().market, currentPrice: '47000.00' },
    });
    expect(out.decisions.find((d) => d.type === 'place-order')).toBeUndefined();
    // avgEntryPrice survives — no SELL fired so the cycle stays.
    expect(out.nextState.avgEntryPrice).toBe('50000.00');
  });

  it('respects sell.enabled=false: no SELL emit regardless of conditions', () => {
    const noSellCfg = TTConfigSchema.parse({
      symbol: 'BTCUSDT',
      buy: {
        enabled: true,
        entrySizing: { mode: 'fixed', amount: '50' },
        avgEntryPriceRemoveThreshold: '0',
      },
      sell: {
        enabled: false,
        stopLossPercentage: '0.97',
        triggerPercentage: '1.05',
        trailingStopPercentage: '0.98',
      },
    });
    const out = trailingTrade.tick({
      ...withHeld({ state: sellState(), config: noSellCfg }),
      market: { ...baseInput().market, currentPrice: '47000.00' },
    });
    expect(out.decisions.find((d) => d.type === 'place-order')).toBeUndefined();
    expect(out.nextState.avgEntryPrice).toBe('50000.00');
  });
});

describe('@app/strategy-trailing-trade config — sell-side schema', () => {
  it('rejects sell.stopLossPercentage > 1 or < 0', () => {
    for (const bad of ['1.5', '-0.5', 'abc']) {
      expect(() =>
        TTConfigSchema.parse({
          symbol: 'BTCUSDT',
          buy: {
            enabled: true,
            entrySizing: { mode: 'fixed', amount: '50' },
            avgEntryPriceRemoveThreshold: '0',
          },
          sell: { enabled: true, stopLossPercentage: bad, triggerPercentage: '1.05' },
        }),
      ).toThrow();
    }
  });

  it('rejects sell.triggerPercentage <= 1', () => {
    for (const bad of ['0.95', '1.0', 'abc']) {
      expect(() =>
        TTConfigSchema.parse({
          symbol: 'BTCUSDT',
          buy: {
            enabled: true,
            entrySizing: { mode: 'fixed', amount: '50' },
            avgEntryPriceRemoveThreshold: '0',
          },
          sell: { enabled: true, stopLossPercentage: '0.97', triggerPercentage: bad },
        }),
      ).toThrow();
    }
  });

  it('rejects sell.trailingStopPercentage > 1 or < 0', () => {
    for (const bad of ['1.2', '-0.1']) {
      expect(() =>
        TTConfigSchema.parse({
          symbol: 'BTCUSDT',
          buy: {
            enabled: true,
            entrySizing: { mode: 'fixed', amount: '50' },
            avgEntryPriceRemoveThreshold: '0',
          },
          sell: {
            enabled: true,
            stopLossPercentage: '0.97',
            triggerPercentage: '1.05',
            trailingStopPercentage: bad,
          },
        }),
      ).toThrow();
    }
  });

  it('defaults trailingStopPercentage to 0.98 when omitted', () => {
    const parsed = TTConfigSchema.parse({
      symbol: 'BTCUSDT',
      buy: {
        enabled: true,
        entrySizing: { mode: 'fixed', amount: '50' },
        avgEntryPriceRemoveThreshold: '0',
      },
      sell: { enabled: true, stopLossPercentage: '0.97', triggerPercentage: '1.05' },
    });
    expect(parsed.sell.trailingStopPercentage).toBe('0.98');
  });
});

describe('@app/strategy-trailing-trade config — buy-side + symbol schema', () => {
  it('rejects a non-positive or non-numeric buy.entrySizing.amount', () => {
    for (const bad of ['', '0', '-5', 'abc']) {
      expect(() =>
        TTConfigSchema.parse({
          symbol: 'BTCUSDT',
          buy: {
            enabled: true,
            entrySizing: { mode: 'fixed', amount: bad },
            avgEntryPriceRemoveThreshold: '0',
          },
          sell: { enabled: true, stopLossPercentage: '0.97', triggerPercentage: '1.05' },
        }),
      ).toThrow();
    }
  });

  it('accepts a positive decimal buy.entrySizing.amount', () => {
    const parsed = TTConfigSchema.parse({
      symbol: 'BTCUSDT',
      buy: {
        enabled: true,
        entrySizing: { mode: 'fixed', amount: '15.5' },
        avgEntryPriceRemoveThreshold: '0',
      },
      sell: { enabled: true, stopLossPercentage: '0.97', triggerPercentage: '1.05' },
    });
    expect(parsed.buy.entrySizing.amount).toBe('15.5');
  });

  it('enforces entrySizing / accountCap cross-field rules', () => {
    const base = {
      symbol: 'BTCUSDT',
      sell: { enabled: true, stopLossPercentage: '0.97', triggerPercentage: '1.05' },
    };
    const mk = (buyExtra: Record<string, unknown>) =>
      TTConfigSchema.parse({
        ...base,
        buy: { enabled: true, avgEntryPriceRemoveThreshold: '0', ...buyExtra },
      });
    // percent-of-account sizing requires a percent.
    expect(() => mk({ entrySizing: { mode: 'percentOfAccount' } })).toThrow(/percent is required/);
    // a percent entry parses and keeps the fraction.
    expect(
      mk({ entrySizing: { mode: 'percentOfAccount', percent: '0.1' } }).buy.entrySizing,
    ).toEqual({
      mode: 'percentOfAccount',
      amount: '',
      percent: '0.1',
    });
    // accountCap amount/percent modes require their value; off is the default.
    expect(() =>
      mk({ entrySizing: { mode: 'fixed', amount: '10' }, accountCap: { mode: 'amount' } }),
    ).toThrow(/amount is required when the cap is a fixed amount/);
    expect(() =>
      mk({ entrySizing: { mode: 'fixed', amount: '10' }, accountCap: { mode: 'percent' } }),
    ).toThrow(/percent is required when the cap is a percent/);
    expect(
      mk({
        entrySizing: { mode: 'fixed', amount: '10' },
        accountCap: { mode: 'percent', percent: '0.5' },
      }).buy.accountCap,
    ).toEqual({ mode: 'percent', amount: '', percent: '0.5' });
  });

  it('rejects an empty, lowercase, whitespace, or out-of-bounds-length symbol', () => {
    // 'BTCUS' (5) and a 21-char value sit just outside the {6,20} bound.
    for (const bad of ['', 'btcusdt', 'BTC USDT', 'BTC-USDT', '123', 'BTCUS', 'A'.repeat(21)]) {
      expect(() =>
        TTConfigSchema.parse({
          symbol: bad,
          buy: {
            enabled: true,
            entrySizing: { mode: 'fixed', amount: '50' },
            avgEntryPriceRemoveThreshold: '0',
          },
          sell: { enabled: true, stopLossPercentage: '0.97', triggerPercentage: '1.05' },
        }),
      ).toThrow();
    }
  });

  it('accepts an uppercase alphanumeric symbol at both length bounds', () => {
    // 'ETHBTC' is the 6-char lower edge; the 20-char value the upper edge.
    for (const ok of ['ETHBTC', 'A'.repeat(20)]) {
      const parsed = TTConfigSchema.parse({
        symbol: ok,
        buy: {
          enabled: true,
          entrySizing: { mode: 'fixed', amount: '50' },
          avgEntryPriceRemoveThreshold: '0',
        },
        sell: { enabled: true, stopLossPercentage: '0.97', triggerPercentage: '1.05' },
      });
      expect(parsed.symbol).toBe(ok);
    }
  });
});

const gridCfg = (
  levels: readonly {
    triggerPercentage: string;
    maxPurchaseAmount: string;
  }[],
  overrides?: Partial<{ buyEnabled: boolean; sellEnabled: boolean }>,
): TTConfig =>
  TTConfigSchema.parse({
    symbol: 'BTCUSDT',
    // Disable the TV gate so the entry-level tests can fire without
    // having to fabricate a "buy"-recommending signal; promotion ticks
    // bypass the gate by design but level-0 entry still consults it.
    forceBuyOverride: { checkTechnicals: false },
    buy: {
      enabled: overrides?.buyEnabled ?? true,
      entrySizing: { mode: 'fixed', amount: '50' },
      avgEntryPriceRemoveThreshold: '0',
      gridLevels: levels,
    },
    sell: {
      enabled: overrides?.sellEnabled ?? false,
      stopLossPercentage: '0',
      triggerPercentage: '0',
    },
  });

describe('@app/strategy-trailing-trade tick: grid mode', () => {
  const threeLevelGrid = [
    { triggerPercentage: '1.0', maxPurchaseAmount: '50' },
    { triggerPercentage: '0.97', maxPurchaseAmount: '50' },
    { triggerPercentage: '0.94', maxPurchaseAmount: '50' },
  ];

  it('emits level 0 entry when grid configured and state is flat', () => {
    const out = trailingTrade.tick(
      baseInput({ config: gridCfg(threeLevelGrid), bundle: bundleWith(null) }),
    );
    expect(out.decisions).toHaveLength(1);
    const first = out.decisions[0];
    expect(first.type).toBe('place-order');
    if (first.type !== 'place-order') throw new Error('unexpected');
    expect(first.intent.reason).toBe('grid-buy');
    expect(first.intent.meta?.['gridTradeIndex']).toBe(0);
    expect(out.nextState.currentGridTradeIndex).toBe(0);
    expect(out.metrics[0]?.name).toBe('tt_grid_buy_emit');
    expect(out.metrics[0]?.tags?.level).toBe('0');
  });

  it('routes a trigger-buy override through grid level-0 entry', () => {
    // The trigger-buy override is grid-aware: a flat grid profile re-enters
    // at level 0 (recording currentGridTradeIndex) rather than the
    // maxPurchaseAmount-sized single buy.
    const bundle = TTBundleSchema.parse({
      technicals: {
        config: {
          useOnlyWithinMin: 2,
          ifExpires: 'do-not-buy',
          intervals: [
            {
              interval: '1m',
              whenStrongBuy: true,
              whenBuy: true,
              whenSell: false,
              whenStrongSell: false,
              whenNeutral: false,
            },
          ],
        },
        signals: [{ interval: '1m', signal: null }],
      },
      override: { kind: 'trigger-buy', overrideActionId: '01234567-89ab-4cde-89ab-cdef01234567' },
    });
    const out = trailingTrade.tick(baseInput({ config: gridCfg(threeLevelGrid), bundle }));
    expect(out.decisions).toHaveLength(1);
    const first = out.decisions[0];
    expect(first?.type).toBe('place-order');
    if (first?.type !== 'place-order') throw new Error('expected place-order');
    expect(first.intent.meta?.['gridTradeIndex']).toBe(0);
    expect(out.nextState.currentGridTradeIndex).toBe(0);
    expect(out.logs[0]).toMatchObject({ message: 'tt-trigger-buy', context: { gridLevel: 0 } });
    expect(out.metrics).toContainEqual({
      name: 'tt_trigger_buy_emit',
      value: 1,
      tags: { symbol: 'BTCUSDT' },
    });
  });

  it('skips a trigger-buy override on a grid profile that is already holding', () => {
    // A grid profile mid-ladder: a trigger-buy override is a level-0 entry
    // request, so it noops rather than placing an un-bookkept extra buy.
    const state: TTState = {
      schemaVersion: '2.0.0',
      avgEntryPrice: '50000.00',
      disabledUntilMs: null,
      triggers: { override: null },
      highSinceBuy: null,
      currentGridTradeIndex: 1,
    };
    const bundle = TTBundleSchema.parse({
      technicals: {
        config: {
          useOnlyWithinMin: 2,
          ifExpires: 'do-not-buy',
          intervals: [
            {
              interval: '1m',
              whenStrongBuy: true,
              whenBuy: true,
              whenSell: false,
              whenStrongSell: false,
              whenNeutral: false,
            },
          ],
        },
        signals: [{ interval: '1m', signal: null }],
      },
      override: { kind: 'trigger-buy', overrideActionId: '01234567-89ab-4cde-89ab-cdef01234567' },
    });
    const out = trailingTrade.tick(baseInput({ config: gridCfg(threeLevelGrid), state, bundle }));
    expect(out.decisions).toEqual([{ type: 'noop' }]);
    expect(out.logs[0]).toMatchObject({
      message: 'tt-trigger-buy-skipped',
      context: { reason: 'grid-not-flat' },
    });
  });

  it('promotes to level 1 when price drops to next trigger after level-0 fill', () => {
    const state: TTState = {
      schemaVersion: '2.0.0',
      avgEntryPrice: '50000.00',
      disabledUntilMs: null,
      triggers: { override: null },
      highSinceBuy: null,
      currentGridTradeIndex: 0,
    };
    const input = baseInput({ config: gridCfg(threeLevelGrid), state });
    // currentPrice = '50000.00' baseline; threshold = 50000 * 0.97 = 48500.
    // Need price <= threshold to promote; set to 48000.
    const out = trailingTrade.tick({
      ...input,
      market: { ...input.market, currentPrice: '48000.00' },
    });
    expect(out.decisions).toHaveLength(1);
    const d = out.decisions[0];
    expect(d.type).toBe('place-order');
    if (d.type !== 'place-order') throw new Error('unexpected');
    expect(d.intent.meta?.['gridTradeIndex']).toBe(1);
    expect(out.nextState.currentGridTradeIndex).toBe(1);
    expect(out.nextState.avgEntryPrice).toBe('50000.00');
  });

  it('does not promote while price stays above the next trigger', () => {
    const state: TTState = {
      schemaVersion: '2.0.0',
      avgEntryPrice: '50000.00',
      disabledUntilMs: null,
      triggers: { override: null },
      highSinceBuy: null,
      currentGridTradeIndex: 0,
    };
    const input = baseInput({ config: gridCfg(threeLevelGrid), state });
    // threshold = 50000 * 0.97 = 48500; price 49000 > threshold → no promotion.
    const out = trailingTrade.tick({
      ...input,
      market: { ...input.market, currentPrice: '49000.00' },
    });
    expect(out.decisions[0]?.type).toBe('emit-event');
    expect(out.nextState.currentGridTradeIndex).toBe(0);
  });

  it('does not promote past the final configured level', () => {
    const state: TTState = {
      schemaVersion: '2.0.0',
      avgEntryPrice: '48000.00',
      disabledUntilMs: null,
      triggers: { override: null },
      highSinceBuy: null,
      currentGridTradeIndex: 2,
    };
    const input = baseInput({ config: gridCfg(threeLevelGrid), state });
    // Even with a deep drop, level 2 is final so no further place-order.
    const out = trailingTrade.tick({
      ...input,
      market: { ...input.market, currentPrice: '40000.00' },
    });
    expect(out.decisions[0]?.type).toBe('emit-event');
    expect(out.nextState.currentGridTradeIndex).toBe(2);
  });

  it('emits cancel-order alongside the place-order when a stale open BUY exists', () => {
    const state: TTState = {
      schemaVersion: '2.0.0',
      avgEntryPrice: '50000.00',
      disabledUntilMs: null,
      triggers: { override: null },
      highSinceBuy: null,
      currentGridTradeIndex: 0,
    };
    const staleBuy: OpenOrder = {
      orderId: 999,
      clientOrderId: 'tt-deadbeef-other',
      symbol: 'BTCUSDT',
      side: 'BUY',
      type: 'LIMIT',
      status: 'NEW',
      price: '49500.00',
      origQty: '0.001',
      executedQty: '0',
      cummulativeQuoteQty: '0',
      transactTimeMs: 0,
      updateTimeMs: 0,
    };
    const input = baseInput({
      config: gridCfg(threeLevelGrid),
      state,
      openOrders: [staleBuy],
    });
    const out = trailingTrade.tick({
      ...input,
      market: { ...input.market, currentPrice: '48000.00' },
    });
    expect(out.decisions).toHaveLength(2);
    const [cancel, place] = out.decisions;
    expect(cancel?.type).toBe('cancel-order');
    if (cancel?.type !== 'cancel-order') throw new Error('unexpected');
    expect(cancel.orderId).toBe(999);
    expect(cancel.reason).toBe('tt-grid-promote-l1');
    expect(cancel.symbol).toBe('BTCUSDT');
    expect(place?.type).toBe('place-order');
    if (place?.type !== 'place-order') throw new Error('unexpected');
    expect(place.intent.meta?.['gridTradeIndex']).toBe(1);
  });

  it('does not emit when an open BUY matches the target levels clientOrderId', () => {
    const state: TTState = {
      schemaVersion: '2.0.0',
      avgEntryPrice: '50000.00',
      disabledUntilMs: null,
      triggers: { override: null },
      highSinceBuy: null,
      currentGridTradeIndex: 0,
    };
    // The target level on this tick is 1; compute its canonical id.
    const inFlightId = gridBuyClientOrderId('p1', 'BTCUSDT', 1);
    const inFlightBuy: OpenOrder = {
      orderId: 1234,
      clientOrderId: inFlightId,
      symbol: 'BTCUSDT',
      side: 'BUY',
      type: 'MARKET',
      status: 'NEW',
      price: '0',
      origQty: '0.001',
      executedQty: '0',
      cummulativeQuoteQty: '0',
      transactTimeMs: 0,
      updateTimeMs: 0,
    };
    const input = baseInput({
      config: gridCfg(threeLevelGrid),
      state,
      openOrders: [inFlightBuy],
    });
    const out = trailingTrade.tick({
      ...input,
      market: { ...input.market, currentPrice: '48000.00' },
    });
    expect(out.decisions[0]?.type).toBe('emit-event');
    expect(out.nextState.currentGridTradeIndex).toBe(0);
  });

  it('normalises legacy state: lbp set + currentGridTradeIndex null bumps to 0', () => {
    const legacyState: TTState = {
      schemaVersion: '2.0.0',
      avgEntryPrice: '50000.00',
      disabledUntilMs: null,
      triggers: { override: null },
      highSinceBuy: null,
      currentGridTradeIndex: null,
    };
    const input = baseInput({ config: gridCfg(threeLevelGrid), state: legacyState });
    // Price stays above next trigger → no promotion, but the normalisation
    // should still bump the index to 0 on nextState.
    const out = trailingTrade.tick({
      ...input,
      market: { ...input.market, currentPrice: '49000.00' },
    });
    expect(out.nextState.currentGridTradeIndex).toBe(0);
  });

  it('resets currentGridTradeIndex to null on SELL emit', () => {
    const state: TTState = {
      schemaVersion: '2.0.0',
      avgEntryPrice: '50000.00',
      disabledUntilMs: null,
      triggers: { override: null },
      highSinceBuy: null,
      currentGridTradeIndex: 2,
    };
    const config = TTConfigSchema.parse({
      symbol: 'BTCUSDT',
      buy: {
        enabled: true,
        entrySizing: { mode: 'fixed', amount: '50' },
        avgEntryPriceRemoveThreshold: '0',
        gridLevels: threeLevelGrid,
      },
      sell: {
        enabled: true,
        stopLossPercentage: '0.97',
        triggerPercentage: '0',
        trailingStopPercentage: '0.98',
      },
    });
    const input = baseInput({
      config,
      state,
      // freeBase needs to be non-zero so the sell quantity computes.
    });
    const inputWithBalance = {
      ...input,
      account: {
        balances: { BTC: { asset: 'BTC', free: new Decimal('0.001'), locked: new Decimal(0) } },
        readable: true,
      },
      market: { ...input.market, currentPrice: '48000.00' }, // 48000 <= 50000 * 0.97
    };
    const out = trailingTrade.tick(inputWithBalance);
    expect(out.decisions[0]?.type).toBe('place-order');
    expect(out.nextState.avgEntryPrice).toBeNull();
    expect(out.nextState.highSinceBuy).toBeNull();
    expect(out.nextState.currentGridTradeIndex).toBeNull();
  });

  it('lbp-clear also resets currentGridTradeIndex so grid mode does not orphan', () => {
    // State: 2 levels into a grid; price drops far below avgEntryPrice.
    // The lbp-clear escape hatch must reset BOTH lbp AND the grid index
    // or the strategy gets stuck in the (lbp=null, idx=N) orphan state.
    const state: TTState = {
      schemaVersion: '2.0.0',
      avgEntryPrice: '50000.00',
      disabledUntilMs: null,
      triggers: { override: null },
      highSinceBuy: null,
      currentGridTradeIndex: 2,
    };
    const config = TTConfigSchema.parse({
      symbol: 'BTCUSDT',
      forceBuyOverride: { checkTechnicals: false },
      buy: {
        enabled: true,
        entrySizing: { mode: 'fixed', amount: '50' },
        avgEntryPriceRemoveThreshold: '0.85',
        gridLevels: threeLevelGrid,
      },
      // Sell disabled so the stop-loss gate does not pre-empt lbp-clear.
      sell: { enabled: false, stopLossPercentage: '0', triggerPercentage: '0' },
    });
    const input = baseInput({
      config,
      state,
      // Zero base balance is required for lbp-clear; default already.
    });
    // Threshold 0.85 trips at price <= 50000 * 0.85 = 42500.
    const out = trailingTrade.tick({
      ...input,
      market: { ...input.market, currentPrice: '40000.00' },
    });
    // lbp cleared by the escape hatch. The same tick then re-enters
    // grid level 0 (intended behaviour); the lbp-clear path resets
    // BOTH lbp and idx so the L0 condition (lbp=null && idx=null)
    // matches. The post-L0-emit state then has idx=0 with lbp=null,
    // which the orphan-reset branch (scoped to idx>=1) leaves alone.
    expect(out.nextState.avgEntryPrice).toBeNull();
    expect(out.nextState.currentGridTradeIndex).toBe(0);
    expect(out.logs.some((l) => l.message === 'tt-lbp-cleared')).toBe(true);
    expect(out.decisions.some((d) => d.type === 'place-order')).toBe(true);
  });

  it('L0 emit does not re-fire on the following tick before fill adoption (issue #251)', () => {
    // Fresh state: no position, no grid index. First tick emits L0
    // and advances idx to 0, leaving lbp null for fill adoption to
    // fill in. Without the orphan-reset idx>=1 scope, the next tick
    // would reset idx to null and re-fire L0 forever.
    const initial: TTState = {
      schemaVersion: '2.0.0',
      avgEntryPrice: null,
      disabledUntilMs: null,
      triggers: { override: null },
      highSinceBuy: null,
      currentGridTradeIndex: null,
    };
    const firstInput = baseInput({
      config: gridCfg(threeLevelGrid),
      state: initial,
    });
    const first = trailingTrade.tick({
      ...firstInput,
      market: { ...firstInput.market, currentPrice: '50000.00' },
    });
    expect(first.decisions.some((d) => d.type === 'place-order')).toBe(true);
    expect(first.nextState.avgEntryPrice).toBeNull();
    expect(first.nextState.currentGridTradeIndex).toBe(0);

    // Second tick: post-emit state, fill not yet adopted. The orphan
    // reset must NOT fire on idx=0, and L0 must NOT re-fire.
    const second = trailingTrade.tick({
      ...baseInput({ config: gridCfg(threeLevelGrid), state: first.nextState }),
      market: { ...firstInput.market, currentPrice: '50050.00' },
    });
    expect(second.decisions.some((d) => d.type === 'place-order')).toBe(false);
    expect(second.logs.some((l) => l.message === 'tt-grid-state-orphan-reset')).toBe(false);
  });

  it('recovers from the orphan (lbp=null, idx!=null) state with a warn log', () => {
    // Construct the invalid state directly; assert that the grid branch
    // self-heals it instead of silently looping.
    const state: TTState = {
      schemaVersion: '2.0.0',
      avgEntryPrice: null,
      disabledUntilMs: null,
      triggers: { override: null },
      highSinceBuy: null,
      currentGridTradeIndex: 1,
    };
    const out = trailingTrade.tick(baseInput({ config: gridCfg(threeLevelGrid), state }));
    // After recovery, the grid branch sees flat state and emits level 0.
    expect(out.nextState.currentGridTradeIndex).toBe(0);
    expect(out.logs.some((l) => l.message === 'tt-grid-state-orphan-reset')).toBe(true);
  });

  it('emits cancel-order for every non-matching stale open BUY', () => {
    const state: TTState = {
      schemaVersion: '2.0.0',
      avgEntryPrice: '50000.00',
      disabledUntilMs: null,
      triggers: { override: null },
      highSinceBuy: null,
      currentGridTradeIndex: 0,
    };
    const stale = (orderId: number, cid: string): OpenOrder => ({
      orderId,
      clientOrderId: cid,
      symbol: 'BTCUSDT',
      side: 'BUY',
      type: 'LIMIT',
      status: 'NEW',
      price: '49500.00',
      origQty: '0.001',
      executedQty: '0',
      cummulativeQuoteQty: '0',
      transactTimeMs: 0,
      updateTimeMs: 0,
    });
    const input = baseInput({
      config: gridCfg(threeLevelGrid),
      state,
      openOrders: [stale(101, 'tt-stale1-x'), stale(102, 'tt-stale2-y')],
    });
    const out = trailingTrade.tick({
      ...input,
      market: { ...input.market, currentPrice: '48000.00' },
    });
    // 2 cancels + 1 place = 3 decisions total.
    expect(out.decisions).toHaveLength(3);
    const cancels = out.decisions.filter((d) => d.type === 'cancel-order');
    expect(cancels).toHaveLength(2);
    expect(cancels.map((c) => (c.type === 'cancel-order' ? c.orderId : -1)).sort()).toEqual([
      101, 102,
    ]);
    for (const c of cancels) {
      expect(c.type === 'cancel-order' ? c.symbol : undefined).toBe('BTCUSDT');
    }
  });

  it('single-buy path (empty gridLevels) preserves the pre-grid behaviour', () => {
    // Default cfg() has gridLevels === [] via schema default; emits a
    // first-buy decision using `firstBuyClientOrderId` and attaches no
    // `meta` to the intent (orders.meta stays NULL). TV gate disabled
    // so the buy actually fires.
    const out = trailingTrade.tick(
      baseInput({ bundle: bundleWith(null), config: cfg({ checkTechnicals: false }) }),
    );
    expect(out.decisions[0]?.type).toBe('place-order');
    if (out.decisions[0]?.type !== 'place-order') throw new Error('unexpected');
    expect(out.decisions[0].intent.reason).toBe('grid-buy');
    expect(out.decisions[0].intent.meta).toBeUndefined();
    expect(out.nextState.currentGridTradeIndex).toBeNull();
  });
});

describe('@app/strategy-trailing-trade gridLevels schema', () => {
  const baseBuy = {
    enabled: true,
    entrySizing: { mode: 'fixed', amount: '50' },
    avgEntryPriceRemoveThreshold: '0',
  };
  const baseSell = { enabled: false, stopLossPercentage: '0', triggerPercentage: '0' };

  it('defaults gridLevels to []', () => {
    const parsed = TTConfigSchema.parse({
      symbol: 'BTCUSDT',
      buy: baseBuy,
      sell: baseSell,
    });
    expect(parsed.buy.gridLevels).toEqual([]);
  });

  it('accepts repeated promotion triggers — each buys below the weighted-average cost basis', () => {
    // 0.97 / 0.97 is the canonical averaging-down ladder: every promotion
    // fires 3% below the running avgEntryPrice (the weighted-average cost
    // basis, re-averaged on each BUY fill — not the last fill), so equal
    // triggers are valid. The inter-level "descending" rule was a bug.
    expect(() =>
      TTConfigSchema.parse({
        symbol: 'BTCUSDT',
        buy: {
          ...baseBuy,
          gridLevels: [
            { triggerPercentage: '1.0', maxPurchaseAmount: '50' },
            { triggerPercentage: '0.97', maxPurchaseAmount: '50' },
            { triggerPercentage: '0.97', maxPurchaseAmount: '50' },
          ],
        },
        sell: baseSell,
      }),
    ).not.toThrow();
  });

  it('rejects a promotion trigger >= 1 — it would re-fire at/above the average cost basis', () => {
    expect(() =>
      TTConfigSchema.parse({
        symbol: 'BTCUSDT',
        buy: {
          ...baseBuy,
          gridLevels: [
            { triggerPercentage: '1.0', maxPurchaseAmount: '50' },
            { triggerPercentage: '1.0', maxPurchaseAmount: '50' },
          ],
        },
        sell: baseSell,
      }),
    ).toThrow();
  });

  it('rejects non-positive triggerPercentage / maxPurchaseAmount', () => {
    for (const bad of [
      { triggerPercentage: '0', maxPurchaseAmount: '50' },
      { triggerPercentage: '0.95', maxPurchaseAmount: '0' },
      { triggerPercentage: '0.95', maxPurchaseAmount: '-1' },
    ]) {
      expect(() =>
        TTConfigSchema.parse({
          symbol: 'BTCUSDT',
          buy: { ...baseBuy, gridLevels: [bad] },
          sell: baseSell,
        }),
      ).toThrow();
    }
  });

  it('accepts more than 10 levels (uncapped ladder)', () => {
    const eleven = Array.from({ length: 11 }, (_, i) => ({
      triggerPercentage: (1 - i * 0.01).toFixed(2),
      maxPurchaseAmount: '50',
    }));
    const parsed = TTConfigSchema.parse({
      symbol: 'BTCUSDT',
      buy: { ...baseBuy, gridLevels: eleven },
      sell: baseSell,
    });
    expect(parsed.buy.gridLevels).toHaveLength(11);
  });
});

describe('@app/strategy-trailing-trade tick: indicator gate', () => {
  // RSI 60 — above a ceiling of 30, below a ceiling of 70.
  const snap = {
    windowSize: 200,
    lowestLow: '40000',
    highestHigh: '60000',
    sma20: '50000',
    ema20: '50500',
    rsi14: '60',
    lastCandleCloseTimeMs: 1_700_000_000_000,
  };

  // Legacy single-buy config (empty gridLevels). TV gate disarmed so the
  // indicator gate is the only buy-side precondition under test.
  const legacyCfg = (indicatorGate: Record<string, unknown>): TTConfig =>
    TTConfigSchema.parse({
      symbol: 'BTCUSDT',
      forceBuyOverride: { checkTechnicals: false },
      buy: {
        enabled: true,
        entrySizing: { mode: 'fixed', amount: '50' },
        avgEntryPriceRemoveThreshold: '0',
        indicatorGate,
      },
      sell: { enabled: true, stopLossPercentage: '0.97', triggerPercentage: '1.05' },
    });

  it('config schema defaults the indicator gate to fully disabled', () => {
    const parsed = legacyCfg({});
    expect(parsed.buy.indicatorGate).toEqual({ rsiMaxBuy: '', smaBias: 'off', emaBias: 'off' });
  });

  it('non-grid first-buy: vetoes the buy when RSI exceeds the configured ceiling', () => {
    const input = baseInput({ config: legacyCfg({ rsiMaxBuy: '30' }) });
    const out = trailingTrade.tick({
      ...input,
      market: { ...input.market, indicatorsByInterval: { '1h': snap } },
    });
    expect(out.decisions[0]?.type).toBe('emit-event');
    expect(out.decisions.some((d) => d.type === 'place-order')).toBe(false);
    const veto = out.logs.find((l) => l.message === 'tt-indicator-gate-veto');
    expect(veto?.context).toMatchObject({ reason: 'indicator-rsi', symbol: 'BTCUSDT' });
    expect(veto?.level).toBe('info');
  });

  it('non-grid first-buy: emits the buy when RSI is within the ceiling', () => {
    const input = baseInput({ config: legacyCfg({ rsiMaxBuy: '70' }) });
    const out = trailingTrade.tick({
      ...input,
      market: { ...input.market, indicatorsByInterval: { '1h': snap } },
    });
    expect(out.decisions[0]?.type).toBe('place-order');
    expect(out.logs.some((l) => l.message === 'tt-indicator-gate-veto')).toBe(false);
  });

  it('non-grid first-buy: vetoes at debug level when the indicator cache is absent', () => {
    const out = trailingTrade.tick(baseInput({ config: legacyCfg({ rsiMaxBuy: '70' }) }));
    expect(out.decisions[0]?.type).toBe('emit-event');
    const veto = out.logs.find((l) => l.message === 'tt-indicator-gate-veto');
    expect(veto?.context).toMatchObject({ reason: 'indicator-unavailable' });
    expect(veto?.level).toBe('debug');
  });

  it('non-grid first-buy: disabled gate leaves the price-only path unchanged', () => {
    const input = baseInput({ config: legacyCfg({}) });
    const out = trailingTrade.tick({
      ...input,
      market: { ...input.market, indicatorsByInterval: { '1h': snap } },
    });
    expect(out.decisions[0]?.type).toBe('place-order');
  });

  it('grid entry: vetoes level-0 entry when the indicator gate fails', () => {
    const config = TTConfigSchema.parse({
      symbol: 'BTCUSDT',
      forceBuyOverride: { checkTechnicals: false },
      buy: {
        enabled: true,
        entrySizing: { mode: 'fixed', amount: '50' },
        avgEntryPriceRemoveThreshold: '0',
        gridLevels: [{ triggerPercentage: '1.0', maxPurchaseAmount: '50' }],
        indicatorGate: { rsiMaxBuy: '30' },
      },
      sell: { enabled: false, stopLossPercentage: '0', triggerPercentage: '0' },
    });
    const input = baseInput({ config });
    const out = trailingTrade.tick({
      ...input,
      market: { ...input.market, indicatorsByInterval: { '1h': snap } },
    });
    expect(out.decisions[0]?.type).toBe('emit-event');
    expect(out.nextState.currentGridTradeIndex).toBeNull();
    expect(out.logs.some((l) => l.message === 'tt-indicator-gate-veto')).toBe(true);
  });

  it('grid promotion: vetoes the promotion when the indicator gate fails', () => {
    const config = TTConfigSchema.parse({
      symbol: 'BTCUSDT',
      forceBuyOverride: { checkTechnicals: false },
      buy: {
        enabled: true,
        entrySizing: { mode: 'fixed', amount: '50' },
        avgEntryPriceRemoveThreshold: '0',
        gridLevels: [
          { triggerPercentage: '1.0', maxPurchaseAmount: '50' },
          { triggerPercentage: '0.97', maxPurchaseAmount: '50' },
        ],
        indicatorGate: { rsiMaxBuy: '30' },
      },
      sell: { enabled: false, stopLossPercentage: '0', triggerPercentage: '0' },
    });
    const state: TTState = {
      schemaVersion: '2.0.0',
      avgEntryPrice: '50000.00',
      disabledUntilMs: null,
      triggers: { override: null },
      highSinceBuy: null,
      currentGridTradeIndex: 0,
    };
    const input = baseInput({ config, state });
    // Price below the level-1 trigger (48500) — promotion would fire if the
    // indicator gate did not block it.
    const out = trailingTrade.tick({
      ...input,
      market: {
        ...input.market,
        currentPrice: '48000.00',
        indicatorsByInterval: { '1h': snap },
      },
    });
    expect(out.decisions[0]?.type).toBe('emit-event');
    expect(out.nextState.currentGridTradeIndex).toBe(0);
    expect(out.logs.some((l) => l.message === 'tt-indicator-gate-veto')).toBe(true);
  });

  it('non-grid first-buy: vetoes when an SMA bias is unsatisfied', () => {
    // price 50000 == sma 50000 — strict price-below-sma is not satisfied.
    const input = baseInput({ config: legacyCfg({ smaBias: 'price-below-sma' }) });
    const out = trailingTrade.tick({
      ...input,
      market: { ...input.market, indicatorsByInterval: { '1h': snap } },
    });
    expect(out.decisions[0]?.type).toBe('emit-event');
    const veto = out.logs.find((l) => l.message === 'tt-indicator-gate-veto');
    expect(veto?.context).toMatchObject({ reason: 'indicator-sma' });
  });

  it('non-grid first-buy: emits when an EMA bias is satisfied', () => {
    // price 50000 < ema 50500 — price-below-ema satisfied.
    const input = baseInput({ config: legacyCfg({ emaBias: 'price-below-ema' }) });
    const out = trailingTrade.tick({
      ...input,
      market: { ...input.market, indicatorsByInterval: { '1h': snap } },
    });
    expect(out.decisions[0]?.type).toBe('place-order');
  });

  it('grid: a momentum (price-above-sma) bias strands the ladder once price falls below SMA', () => {
    // Documented consequence: a promotion is an averaging-down add, so price
    // has dropped below the SMA — the momentum bias then vetoes every
    // promotion. This test pins that behaviour so the trade-off is explicit.
    const config = TTConfigSchema.parse({
      symbol: 'BTCUSDT',
      forceBuyOverride: { checkTechnicals: false },
      buy: {
        enabled: true,
        entrySizing: { mode: 'fixed', amount: '50' },
        avgEntryPriceRemoveThreshold: '0',
        gridLevels: [
          { triggerPercentage: '1.0', maxPurchaseAmount: '50' },
          { triggerPercentage: '0.97', maxPurchaseAmount: '50' },
        ],
        indicatorGate: { smaBias: 'price-above-sma' },
      },
      sell: { enabled: false, stopLossPercentage: '0', triggerPercentage: '0' },
    });
    const state: TTState = {
      schemaVersion: '2.0.0',
      avgEntryPrice: '50000.00',
      disabledUntilMs: null,
      triggers: { override: null },
      highSinceBuy: null,
      currentGridTradeIndex: 0,
    };
    const input = baseInput({ config, state });
    // price 48000 is below the level-1 trigger (48500) AND below sma 49000.
    const out = trailingTrade.tick({
      ...input,
      market: {
        ...input.market,
        currentPrice: '48000.00',
        indicatorsByInterval: { '1h': { ...snap, sma20: '49000' } },
      },
    });
    expect(out.decisions[0]?.type).toBe('emit-event');
    expect(out.nextState.currentGridTradeIndex).toBe(0);
    const veto = out.logs.find((l) => l.message === 'tt-indicator-gate-veto');
    expect(veto?.context).toMatchObject({ reason: 'indicator-sma' });
  });

  it('grid entry: a momentum (price-above-sma) bias passes when price is above SMA', () => {
    const config = TTConfigSchema.parse({
      symbol: 'BTCUSDT',
      forceBuyOverride: { checkTechnicals: false },
      buy: {
        enabled: true,
        entrySizing: { mode: 'fixed', amount: '50' },
        avgEntryPriceRemoveThreshold: '0',
        gridLevels: [{ triggerPercentage: '1.0', maxPurchaseAmount: '50' }],
        indicatorGate: { smaBias: 'price-above-sma' },
      },
      sell: { enabled: false, stopLossPercentage: '0', triggerPercentage: '0' },
    });
    const input = baseInput({ config });
    // price 50000 > sma 45000 — momentum bias satisfied at entry.
    const out = trailingTrade.tick({
      ...input,
      market: { ...input.market, indicatorsByInterval: { '1h': { ...snap, sma20: '45000' } } },
    });
    expect(out.decisions.some((d) => d.type === 'place-order')).toBe(true);
    expect(out.nextState.currentGridTradeIndex).toBe(0);
  });
});

describe('@app/strategy-trailing-trade tick: risk caps', () => {
  // A two-level grid with the caps configurable. Level 1 promotes at
  // avgEntryPrice * 0.97; sized to maxPurchaseAmount '50'. forceBuyOverride
  // disables the TV gate so promotions are governed only by the caps.
  const riskCapGrid = (caps: {
    maxSymbolExposureQuote?: string;
    maxPositionLossQuote?: string;
    maxAccountExposureQuote?: string;
    stopLossPercentage?: string;
  }): TTConfig =>
    TTConfigSchema.parse({
      symbol: 'BTCUSDT',
      forceBuyOverride: { checkTechnicals: false },
      buy: {
        enabled: true,
        entrySizing: { mode: 'fixed', amount: '50' },
        avgEntryPriceRemoveThreshold: '0',
        gridLevels: [
          { triggerPercentage: '1.0', maxPurchaseAmount: '50' },
          { triggerPercentage: '0.97', maxPurchaseAmount: '50' },
        ],
        maxSymbolExposureQuote: caps.maxSymbolExposureQuote ?? '',
        maxPositionLossQuote: caps.maxPositionLossQuote ?? '',
        accountCap: amountCap(caps.maxAccountExposureQuote ?? ''),
      },
      sell: {
        enabled: false,
        stopLossPercentage: caps.stopLossPercentage ?? '0',
        triggerPercentage: '0',
      },
    });

  // Level-0 filled: avgEntryPrice + heldQuantity are written together by the
  // fill-adopter, so a real held position carries both. 0.001 BTC at 50000 = 50
  // quote deployed. At price 48000 the level-1 promotion sizes to ~0.001 BTC →
  // ~48 more quote, so projected deployed ≈ 98.
  const heldAtLevel0 = (heldQuantity = '0.001'): TTState => ({
    schemaVersion: '2.0.0',
    avgEntryPrice: '50000.00',
    heldQuantity,
    disabledUntilMs: null,
    triggers: { override: null },
    highSinceBuy: null,
    currentGridTradeIndex: 0,
  });

  const promoteTick = (config: TTConfig, state: TTState) => {
    const input = baseInput({ config, state });
    return trailingTrade.tick({
      ...input,
      market: { ...input.market, currentPrice: '48000.00' },
    });
  };

  it('vetoes a promotion that would exceed the per-symbol exposure cap', () => {
    const out = promoteTick(riskCapGrid({ maxSymbolExposureQuote: '10' }), heldAtLevel0());
    expect(out.decisions).toHaveLength(1);
    expect(out.decisions[0]?.type).toBe('emit-event');
    expect(out.nextState.currentGridTradeIndex).toBe(0);
    expect(out.metrics).toContainEqual({
      name: 'tt_risk_cap_veto',
      value: 1,
      tags: { symbol: 'BTCUSDT', cap: 'exposure-cap' },
    });
    expect(out.logs.at(-1)).toMatchObject({
      message: 'tt-risk-cap-veto',
      context: { reason: 'exposure-cap', symbol: 'BTCUSDT' },
    });
  });

  it('vetoes a promotion whose worst-case loss exceeds the loss budget', () => {
    const out = promoteTick(
      riskCapGrid({ maxPositionLossQuote: '0.5', stopLossPercentage: '0.97' }),
      heldAtLevel0(),
    );
    expect(out.decisions[0]?.type).toBe('emit-event');
    expect(out.nextState.currentGridTradeIndex).toBe(0);
    expect(out.metrics).toContainEqual({
      name: 'tt_risk_cap_veto',
      value: 1,
      tags: { symbol: 'BTCUSDT', cap: 'loss-budget' },
    });
  });

  it('allows a promotion that stays within the caps', () => {
    const out = promoteTick(riskCapGrid({ maxSymbolExposureQuote: '10000' }), heldAtLevel0());
    const placed = out.decisions.find((d) => d.type === 'place-order');
    expect(placed?.type).toBe('place-order');
    if (placed?.type !== 'place-order') throw new Error('expected place-order');
    expect(placed.intent.meta?.['gridTradeIndex']).toBe(1);
    expect(out.nextState.currentGridTradeIndex).toBe(1);
  });

  // Promotion at 48000 with an injected account-wide deployed total, so the
  // account exposure cap (#392) can be exercised through the full tick.
  const promoteTickWithAccount = (config: TTConfig, state: TTState, accountDeployed: string) => {
    const input = baseInput({ config, state });
    return trailingTrade.tick({
      ...input,
      market: { ...input.market, currentPrice: '48000.00' },
      account: { ...input.account, deployedQuoteAcrossProfiles: accountDeployed },
    });
  };

  it('vetoes a promotion that would breach the account-wide exposure cap', () => {
    // account total 900 (other profiles) + ~48 new level = ~948 > cap 920.
    // Per-symbol caps are off, so only the account cap can fire here.
    const out = promoteTickWithAccount(
      riskCapGrid({ maxAccountExposureQuote: '920' }),
      heldAtLevel0(),
      '900',
    );
    expect(out.decisions[0]?.type).toBe('emit-event');
    expect(out.nextState.currentGridTradeIndex).toBe(0);
    expect(out.metrics).toContainEqual({
      name: 'tt_risk_cap_veto',
      value: 1,
      tags: { symbol: 'BTCUSDT', cap: 'account-exposure-cap' },
    });
    expect(out.logs.at(-1)).toMatchObject({
      message: 'tt-risk-cap-veto',
      context: { reason: 'account-exposure-cap', symbol: 'BTCUSDT' },
    });
  });

  it('allows a promotion when the account-wide total stays within the cap', () => {
    // 900 + ~48 = ~948 < cap 10000 → the level promotes.
    const out = promoteTickWithAccount(
      riskCapGrid({ maxAccountExposureQuote: '10000' }),
      heldAtLevel0(),
      '900',
    );
    const placed = out.decisions.find((d) => d.type === 'place-order');
    expect(placed?.type).toBe('place-order');
    expect(out.nextState.currentGridTradeIndex).toBe(1);
  });

  it('counts the already-deployed quote of the open position against the cap', () => {
    // deployedSoFar = 50000 * 0.001 = 50; + ~48 new level → ~98 > cap 60.
    // Without the held position (deployed 0) the same ~48 add would pass 60.
    const out = promoteTick(riskCapGrid({ maxSymbolExposureQuote: '60' }), heldAtLevel0('0.001'));
    expect(out.decisions[0]?.type).toBe('emit-event');
    expect(out.nextState.currentGridTradeIndex).toBe(0);
    expect(out.metrics).toContainEqual({
      name: 'tt_risk_cap_veto',
      value: 1,
      tags: { symbol: 'BTCUSDT', cap: 'exposure-cap' },
    });
  });

  it('allows a promotion whose worst-case loss stays within the loss budget', () => {
    // sell disabled here, so worst case = full deployed ~98 <= budget 1000.
    const out = promoteTick(riskCapGrid({ maxPositionLossQuote: '1000' }), heldAtLevel0());
    const placed = out.decisions.find((d) => d.type === 'place-order');
    expect(placed?.type).toBe('place-order');
    expect(out.nextState.currentGridTradeIndex).toBe(1);
  });

  it('does not gate when no cap is armed (default off promotes normally)', () => {
    const out = promoteTick(riskCapGrid({}), heldAtLevel0());
    expect(out.decisions.some((d) => d.type === 'place-order')).toBe(true);
    expect(out.nextState.currentGridTradeIndex).toBe(1);
  });

  it('vetoes a forced re-entry (trigger-buy) whose level-0 notional breaches a cap', () => {
    // Flat profile + trigger-buy override → forced level-0 entry via
    // emitForcedFirstEntry. Level-0 notional ~50 (50/50000 at 50000) exceeds the
    // 10 cap, so the forced entry surfaces a typed skip rather than placing an
    // un-bookkept buy — covering the skip-risk-cap branch on the forced path.
    const bundle = TTBundleSchema.parse({
      technicals: {
        config: {
          useOnlyWithinMin: 2,
          ifExpires: 'do-not-buy',
          intervals: [
            {
              interval: '1m',
              whenStrongBuy: true,
              whenBuy: true,
              whenSell: false,
              whenStrongSell: false,
              whenNeutral: false,
            },
          ],
        },
        signals: [{ interval: '1m', signal: null }],
      },
      override: { kind: 'trigger-buy', overrideActionId: '01234567-89ab-4cde-89ab-cdef01234567' },
    });
    const out = trailingTrade.tick(
      baseInput({ config: riskCapGrid({ maxSymbolExposureQuote: '10' }), bundle }),
    );
    expect(out.decisions.some((d) => d.type === 'place-order')).toBe(false);
    expect(out.logs[0]).toMatchObject({
      message: 'tt-trigger-buy-skipped',
      context: { reason: 'exposure-cap' },
    });
  });
});

describe('@app/strategy-trailing-trade tick — ATR trailing stop', () => {
  // 16 identical candles with a true range of 100 (high−low=100, close mid)
  // → Wilder ATR(14) = 100 exactly. Absolute level is irrelevant to ATR; only
  // the per-candle range drives it.
  const flatRangeCandles = (count = 16) =>
    Array.from({ length: count }, (_, i) => ({
      openTimeMs: i * 3_600_000,
      closeTimeMs: i * 3_600_000 + 3_599_999,
      open: '55000.00',
      high: '55050.00',
      low: '54950.00',
      close: '55000.00',
      volume: '1',
      isClosed: true,
    }));

  const atrCfg = (atrTrailing: {
    enabled: boolean;
    period?: number;
    multiplier?: string;
  }): TTConfig =>
    TTConfigSchema.parse({
      symbol: 'BTCUSDT',
      candleInterval: '1h',
      buy: {
        enabled: true,
        entrySizing: { mode: 'fixed', amount: '50' },
        avgEntryPriceRemoveThreshold: '0',
      },
      sell: {
        enabled: true,
        stopLossPercentage: '0.97',
        triggerPercentage: '1.05',
        trailingStopPercentage: '0.98',
        atrTrailing: { period: 14, multiplier: '3', ...atrTrailing },
      },
    });

  const atrState = (highSinceBuy: string): TTState => ({
    ...trailingTrade.initialState(atrCfg({ enabled: true })),
    avgEntryPrice: '50000.00',
    heldQuantity: '0.5',
    highSinceBuy,
  });

  // ATR=100, multiplier 3 → trail stop = high − 300. high 55000 → stop 54700.
  const atrTrailTick = (config: TTConfig, currentPrice: string, candles = flatRangeCandles()) => {
    const base = baseInput({ config, state: atrState('55000.00') });
    return trailingTrade.tick({
      ...base,
      account: {
        balances: { BTC: { asset: 'BTC', free: new Decimal('0.5'), locked: new Decimal(0) } },
        readable: true,
      },
      market: { ...base.market, currentPrice, candlesByInterval: { '1h': candles } },
    });
  };

  it('fires SELL when price retraces past high − k×ATR', () => {
    // 54600 <= 54700 (high − 3×ATR), but 54600 > fixed-% stop 53900 — so only
    // the ATR trail can fire here, proving the ATR path is active.
    const out = atrTrailTick(atrCfg({ enabled: true }), '54600.00');
    expect(out.decisions[0]).toMatchObject({
      type: 'place-order',
      intent: { side: 'SELL', reason: 'grid-sell' },
      params: { type: 'MARKET' },
    });
    // ATR owns the trail: exactly one sell, via the ATR path (not fixed-%).
    expect(out.decisions.filter((d) => d.type === 'place-order')).toHaveLength(1);
    expect(out.logs.some((l) => l.message === 'tt-atr-trailing-stop')).toBe(true);
    expect(out.logs.some((l) => l.message === 'tt-trailing-stop')).toBe(false);
    expect(out.nextState.avgEntryPrice).toBeNull();
  });

  it('does not fire while price stays above high − k×ATR', () => {
    // 54800 > 54700 → ATR trail not breached; ATR mode owns the trail so the
    // fixed-% path does not fire either.
    const out = atrTrailTick(atrCfg({ enabled: true }), '54800.00');
    expect(out.decisions.find((d) => d.type === 'place-order')).toBeUndefined();
    // Position retained — no sell of any kind this tick.
    expect(out.nextState.avgEntryPrice).not.toBeNull();
  });

  it('falls back to fixed-% when a huge ATR would put the stop at or below zero', () => {
    // ATR=100, multiplier 600 → high − 60000 is negative. Degenerate ATR stop:
    // fall through to fixed-% (55000×0.98=53900). Price 53000 <= 53900 fires the
    // fixed trail, proving a position is never left with no protection.
    const out = atrTrailTick(atrCfg({ enabled: true, multiplier: '600' }), '53000.00');
    expect(out.decisions[0]).toMatchObject({
      type: 'place-order',
      intent: { side: 'SELL', reason: 'grid-sell' },
    });
    expect(out.logs.some((l) => l.message === 'tt-trailing-stop')).toBe(true);
  });

  it('falls back to fixed-% trailing when ATR is not computable (short window)', () => {
    // atrTrailing enabled but only 3 candles (< period+1) → ATR null → fixed-%
    // path runs: 53000 <= 55000×0.98=53900 fires the fixed trail.
    const out = atrTrailTick(atrCfg({ enabled: true }), '53000.00', flatRangeCandles(3));
    expect(out.decisions[0]).toMatchObject({
      type: 'place-order',
      intent: { side: 'SELL', reason: 'grid-sell' },
    });
    expect(out.logs.some((l) => l.message === 'tt-trailing-stop')).toBe(true);
  });

  it('default off: ATR trailing disabled leaves the fixed-% trail unchanged', () => {
    // atrTrailing disabled → 54600 > fixed stop 53900 → no sell, same as today.
    const out = atrTrailTick(atrCfg({ enabled: false }), '54600.00');
    expect(out.decisions.find((d) => d.type === 'place-order')).toBeUndefined();
  });
});

describe('@app/strategy-trailing-trade tick — regime filter (daily MA)', () => {
  // N daily candles all closing at `close` → SMA/EMA(period) = close exactly.
  const dailyCandlesAt = (close: string, count = 25) =>
    Array.from({ length: count }, (_, i) => ({
      openTimeMs: i * 86_400_000,
      closeTimeMs: i * 86_400_000 + 86_399_999,
      open: close,
      high: close,
      low: close,
      close,
      volume: '1',
      isClosed: true,
    }));

  const regimeCfg = (regimeFilter: {
    enabled: boolean;
    ma?: 'sma' | 'ema';
    period?: number;
  }): TTConfig =>
    TTConfigSchema.parse({
      symbol: 'BTCUSDT',
      candleInterval: '1h',
      forceBuyOverride: { checkTechnicals: false },
      buy: {
        enabled: true,
        entrySizing: { mode: 'fixed', amount: '50' },
        avgEntryPriceRemoveThreshold: '0',
        gridLevels: [
          { triggerPercentage: '1.0', maxPurchaseAmount: '50' },
          { triggerPercentage: '0.97', maxPurchaseAmount: '50' },
        ],
      },
      regime: {
        ma: regimeFilter.ma ?? 'sma',
        period: regimeFilter.period ?? 20,
        onBear: { suppressPromotion: regimeFilter.enabled },
      },
      sell: { enabled: false, stopLossPercentage: '0', triggerPercentage: '0' },
    });

  const promotionState = (): TTState => ({
    schemaVersion: '2.0.0',
    avgEntryPrice: '50000.00',
    heldQuantity: '0.001',
    disabledUntilMs: null,
    triggers: { override: null },
    highSinceBuy: null,
    currentGridTradeIndex: 0,
  });

  // Promote at price 48000 (<= 50000×0.97=48500 → level-1 trigger). dailyMa sets
  // the regime line via flat daily candles.
  const promoteWithRegime = (config: TTConfig, dailyMa: string) => {
    const base = baseInput({ config, state: promotionState() });
    return trailingTrade.tick({
      ...base,
      market: {
        ...base.market,
        currentPrice: '48000.00',
        candlesByInterval: { '1d': dailyCandlesAt(dailyMa) },
      },
    });
  };

  it('halts a promotion when price is below the daily regime MA', () => {
    // price 48000 < daily MA 49000 → downtrend → promotion vetoed.
    const out = promoteWithRegime(regimeCfg({ enabled: true }), '49000.00');
    expect(out.decisions.find((d) => d.type === 'place-order')).toBeUndefined();
    expect(out.nextState.currentGridTradeIndex).toBe(0);
    expect(out.metrics).toContainEqual({
      name: 'tt_regime_filter_veto',
      value: 1,
      tags: { symbol: 'BTCUSDT', reason: 'regime-downtrend' },
    });
    expect(out.logs.at(-1)).toMatchObject({
      message: 'tt-regime-filter-veto',
      context: { reason: 'regime-downtrend' },
    });
  });

  it('allows a promotion when price is above the daily regime MA', () => {
    // price 48000 > daily MA 47000 → uptrend → promotion proceeds.
    const out = promoteWithRegime(regimeCfg({ enabled: true }), '47000.00');
    const placed = out.decisions.find((d) => d.type === 'place-order');
    expect(placed?.type).toBe('place-order');
    expect(out.nextState.currentGridTradeIndex).toBe(1);
    // No spurious veto metric when the regime allows the add.
    expect(out.metrics.find((m) => m.name === 'tt_regime_filter_veto')).toBeUndefined();
  });

  it('halts the promotion (fail-closed) when daily candles are unavailable', () => {
    const base = baseInput({ config: regimeCfg({ enabled: true }), state: promotionState() });
    const out = trailingTrade.tick({
      ...base,
      market: { ...base.market, currentPrice: '48000.00', candlesByInterval: {} },
    });
    expect(out.decisions.find((d) => d.type === 'place-order')).toBeUndefined();
    expect(out.metrics).toContainEqual({
      name: 'tt_regime_filter_veto',
      value: 1,
      tags: { symbol: 'BTCUSDT', reason: 'regime-unavailable' },
    });
  });

  it('vetoes via the ema path and ignores an unclosed trailing candle', () => {
    // ma: 'ema' (the schema default) over 25 closed daily candles at 49000 → EMA
    // 49000. A trailing UNCLOSED candle at 40000 is filtered out, so it does not
    // drag the MA. price 48000 < 49000 → downtrend veto.
    const closed = dailyCandlesAt('49000.00');
    const withOpen = [
      ...closed,
      {
        openTimeMs: 99_000_000_000,
        closeTimeMs: 99_000_086_399_999,
        open: '40000.00',
        high: '40000.00',
        low: '40000.00',
        close: '40000.00',
        volume: '1',
        isClosed: false,
      },
    ];
    const base = baseInput({
      config: regimeCfg({ enabled: true, ma: 'ema' }),
      state: promotionState(),
    });
    const out = trailingTrade.tick({
      ...base,
      market: { ...base.market, currentPrice: '48000.00', candlesByInterval: { '1d': withOpen } },
    });
    expect(out.decisions.find((d) => d.type === 'place-order')).toBeUndefined();
    expect(out.metrics).toContainEqual({
      name: 'tt_regime_filter_veto',
      value: 1,
      tags: { symbol: 'BTCUSDT', reason: 'regime-downtrend' },
    });
  });

  it('halts the promotion (fail-closed) when a daily candle is malformed', () => {
    // Enough candles to clear the length guard, but a bad close in the MA's
    // window (the last `period`) makes the computation throw → fail-closed
    // regime-unavailable.
    const src = dailyCandlesAt('49000.00');
    const bad = src.map((c, i) => (i === src.length - 1 ? { ...c, close: 'x' } : c));
    const base = baseInput({ config: regimeCfg({ enabled: true }), state: promotionState() });
    const out = trailingTrade.tick({
      ...base,
      market: { ...base.market, currentPrice: '48000.00', candlesByInterval: { '1d': bad } },
    });
    expect(out.decisions.find((d) => d.type === 'place-order')).toBeUndefined();
    expect(out.metrics).toContainEqual({
      name: 'tt_regime_filter_veto',
      value: 1,
      tags: { symbol: 'BTCUSDT', reason: 'regime-unavailable' },
    });
  });

  it('does not gate the FIRST entry, only promotions', () => {
    // Flat state + regime enabled + deep downtrend: the entry still fires.
    const base = baseInput({ config: regimeCfg({ enabled: true }) });
    const out = trailingTrade.tick({
      ...base,
      market: {
        ...base.market,
        currentPrice: '48000.00',
        candlesByInterval: { '1d': dailyCandlesAt('60000.00') },
      },
    });
    const placed = out.decisions.find((d) => d.type === 'place-order');
    expect(placed?.type).toBe('place-order');
    if (placed?.type !== 'place-order') throw new Error('expected entry');
    expect(placed.intent.meta?.['gridTradeIndex']).toBe(0);
  });

  it('default off: regime filter disabled lets the promotion proceed', () => {
    const out = promoteWithRegime(regimeCfg({ enabled: false }), '60000.00');
    expect(out.decisions.find((d) => d.type === 'place-order')?.type).toBe('place-order');
    expect(out.nextState.currentGridTradeIndex).toBe(1);
  });
});

describe('@app/strategy-trailing-trade tick — entryBlocker (awaiting-trigger-price)', () => {
  // Flat profile, lowest-price first-buy basis, level-0 trigger 1. Window lows
  // are [100, 95, 98] → lowest = 95, so the entry arms only at price <= 95.
  // currentPrice 96 keeps the buy waiting (the silent XPL bug): no place-order
  // this tick, and nextState must explain WHY via the structured entryBlocker.
  const lowestPriceCfg = (): TTConfig =>
    TTConfigSchema.parse({
      symbol: 'BTCUSDT',
      candleInterval: '1h',
      forceBuyOverride: { checkTechnicals: false },
      buy: {
        enabled: true,
        entrySizing: { mode: 'fixed', amount: '15' },
        avgEntryPriceRemoveThreshold: '0',
        firstBuyTriggerBasis: 'lowest-price',
        candleLimit: 3,
        gridLevels: [{ triggerPercentage: '1', maxPurchaseAmount: '15' }],
      },
      sell: { enabled: true, stopLossPercentage: '0.97', triggerPercentage: '1.05' },
    });

  const candle = (low: string) => ({
    openTimeMs: 0,
    closeTimeMs: 0,
    open: low,
    high: low,
    low,
    close: low,
    volume: '1',
    isClosed: true,
  });

  const waitingInput = (): TickInput<TTConfig, TTState, TTBundle> => {
    const config = lowestPriceCfg();
    const base = baseInput({ config });
    return {
      ...base,
      market: {
        ...base.market,
        currentPrice: '96',
        candlesByInterval: { '1h': [candle('100'), candle('95'), candle('98')] },
      },
    };
  };

  it('entryBlocker is set to awaiting-trigger-price when the first-buy trigger waits for a dip', () => {
    const out = trailingTrade.tick(waitingInput());
    // The lowest-price wait must not place an order this tick.
    expect(out.decisions.some((d) => d.type === 'place-order')).toBe(false);
    // The not-yet-existing structured reason: nextState explains the silent wait.
    expect(out.nextState.entryBlocker).not.toBeNull();
    expect(out.nextState.entryBlocker?.reason).toBe('awaiting-trigger-price');
  });

  it('awaiting-trigger-price detail carries the explaining window numbers', () => {
    const out = trailingTrade.tick(waitingInput());
    expect(out.nextState.entryBlocker?.detail).toEqual({
      windowLow: '95',
      triggerPercentage: '1',
      currentPrice: '96',
    });
  });

  it('entryBlocker is null on a clean first-buy emit', () => {
    // Default config + gate forced open: a normal flat first buy places an order
    // and must clear any blocker, not leave a stale or spurious one.
    const cfgForceOpen = cfg({ checkTechnicals: false });
    const out = trailingTrade.tick(baseInput({ config: cfgForceOpen }));
    expect(out.decisions.some((d) => d.type === 'place-order')).toBe(true);
    expect(out.nextState.entryBlocker).toBeNull();
  });

  it('a stored state without entryBlocker normalizes to null through a full tick', () => {
    const cfgForceOpen = cfg({ checkTechnicals: false });
    const base = trailingTrade.initialState(cfgForceOpen);
    // Drop the key as an at-version row serialised before the field would load.
    const { entryBlocker: _omit, ...keyless } = base;
    const out = trailingTrade.tick(
      baseInput({ config: cfgForceOpen, state: keyless as unknown as TTState }),
    );
    // A clean buy emits; the absent key must not crash and resolves to null.
    expect(out.nextState.entryBlocker).toBeNull();
  });
});

describe('regime exposure scaling (no-grid first entry)', () => {
  const dayCandles = (closes: string[]) =>
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

  // checkTechnicals:false opens the buy gate; sma period 3 / confirmBars 2.
  const exposureCfg = (neutralScalar: string): TTConfig =>
    TTConfigSchema.parse({
      symbol: 'BTCUSDT',
      forceBuyOverride: { checkTechnicals: false },
      buy: {
        enabled: true,
        entrySizing: { mode: 'fixed', amount: '50' },
        avgEntryPriceRemoveThreshold: '0',
      },
      sell: { enabled: true, stopLossPercentage: '0.97', triggerPercentage: '1.05' },
      regime: { ma: 'sma', period: 3, confirmBars: 2, exposure: { enabled: true, neutralScalar } },
    });

  const tickWithDailies = (config: TTConfig, closes: string[]) => {
    const base = baseInput({ config });
    return trailingTrade.tick({
      ...base,
      market: { ...base.market, candlesByInterval: { '1d': dayCandles(closes) } },
    });
  };

  it('halves the first-entry size on a neutral regime and tags the metric', () => {
    // Full size = 50/50000 = 0.0010; neutral 0.5 → 0.0005.
    const out = tickWithDailies(exposureCfg('0.5'), ['6', '1', '5']);
    const buy = out.decisions.find((d) => d.type === 'place-order');
    expect(buy?.params.quantity).toBe('0.0005');
    expect(out.metrics.some((m) => m.name === 'tt_regime_exposure')).toBe(true);
  });

  it('places no entry on a confirmed bear (scalar 0 → sit in cash)', () => {
    const out = tickWithDailies(exposureCfg('0.5'), ['6', '2', '1']);
    expect(out.decisions.some((d) => d.type === 'place-order')).toBe(false);
  });

  it('keeps full size on a confirmed bull and tags the regime metric', () => {
    const out = tickWithDailies(exposureCfg('0.5'), ['1', '5', '6']);
    const buy = out.decisions.find((d) => d.type === 'place-order');
    expect(buy?.params.quantity).toBe('0.0010');
    expect(
      out.metrics.some((m) => m.name === 'tt_regime_exposure' && m.tags?.regime === 'bull'),
    ).toBe(true);
  });
});

/**
 * The whole override-outcome model rests on ONE fact this suite must pin: an
 * order the strategy emitted BECAUSE OF an override carries that override's id
 * on `intent.overrideActionId`.
 *
 * The worker settles the operator's `override_actions` row on what happened to
 * the orders carrying that id, and on nothing else — no positional or side-based
 * guess, because a tick that emits an unrelated order alongside the override's
 * would settle the wrong row. So if this stamp silently stopped being written,
 * production would settle every override as "the strategy did not act" while the
 * order was in fact live on Binance, and every OTHER test would still pass: they
 * only ever read the id off the INPUT bundle.
 *
 * The negative case is load-bearing too. A strategy-initiated order must NOT
 * carry an id, or the worker would attribute the strategy's own grid buy to
 * whatever override happened to be in flight.
 */
describe('trailing-trade — override attribution stamp', () => {
  const OVERRIDE_ID = '01234567-89ab-4cde-89ab-cdef01234567';

  const nullSignalBundle = (override: unknown): TTBundle =>
    TTBundleSchema.parse({
      technicals: {
        config: {
          useOnlyWithinMin: 2,
          ifExpires: 'do-not-buy',
          intervals: [
            {
              interval: '1m',
              whenStrongBuy: true,
              whenBuy: true,
              whenSell: false,
              whenStrongSell: false,
              whenNeutral: false,
            },
          ],
        },
        signals: [{ interval: '1m', signal: null }],
      },
      override,
    });

  /** The id stamped on the one place-order the tick emitted. */
  const stampOf = (out: ReturnType<typeof trailingTrade.tick>): string | undefined => {
    const order = out.decisions.find((d) => d.type === 'place-order');
    if (order?.type !== 'place-order') throw new Error('expected a place-order decision');
    return order.intent.overrideActionId;
  };

  it('stamps the override id on a manual-order BUY', () => {
    const bundle = nullSignalBundle({
      kind: 'manual-order',
      overrideActionId: OVERRIDE_ID,
      payload: { side: 'BUY', type: 'MARKET', quoteAmount: '50' },
    });
    expect(stampOf(trailingTrade.tick(baseInput({ bundle })))).toBe(OVERRIDE_ID);
  });

  it('stamps the override id on a trigger-buy first entry', () => {
    const bundle = nullSignalBundle({ kind: 'trigger-buy', overrideActionId: OVERRIDE_ID });
    expect(stampOf(trailingTrade.tick(baseInput({ bundle })))).toBe(OVERRIDE_ID);
  });

  it('stamps the override id on a trigger-sell MARKET close', () => {
    const bundle = nullSignalBundle({ kind: 'trigger-sell', overrideActionId: OVERRIDE_ID });
    const state: TTState = {
      ...trailingTrade.initialState(cfg()),
      avgEntryPrice: '50000.00',
      highSinceBuy: '52000.00',
    };
    const out = trailingTrade.tick({
      ...baseInput({ bundle, state }),
      account: {
        balances: { BTC: { asset: 'BTC', free: new Decimal('0.5'), locked: new Decimal(0) } },
        readable: true,
      },
    });
    expect(stampOf(out)).toBe(OVERRIDE_ID);
  });

  it('leaves a strategy-initiated grid buy UNSTAMPED', () => {
    // No override in the bundle at all: the strategy bought on its own signal.
    // A stamp here would let the worker settle someone else's override row on
    // the fate of an order that override never asked for.
    const NOW_MS = 1_700_000_000_000;
    const bundle = bundleWith({ symbol: 'BTCUSDT', recommendation: 'BUY', receivedAtMs: NOW_MS });
    expect(stampOf(trailingTrade.tick(baseInput({ bundle, nowMs: NOW_MS })))).toBeUndefined();
  });
});
