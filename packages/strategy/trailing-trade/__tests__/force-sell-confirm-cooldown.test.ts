// Two opt-in force-sell knobs (issue #450), tested against the pure tick():
//   - forceSellConfirmMinutes: the STRONG_SELL/SELL trigger must be present
//     continuously for >= the window before the force-sell emits. The
//     first-seen timestamp persists on TTState.forceSellFirstSeenAtMs and
//     clears when the trigger goes absent.
//   - forceSellReentryCooldownMinutes: emitting a force-sell stamps
//     TTState.forceSellCooldownUntilMs; every first-entry path is suppressed
//     (with a tt-force-sell-cooldown-blocked log) until the clock passes it.
// Both default to 0 (behaviour unchanged). These read off the parsed
// config.technicals.* block, not the bundle's technicals config.

import { describe, expect, it } from 'vitest';
import {
  trailingTrade,
  TTBundleSchema,
  TTConfigSchema,
  type TTBundle,
  type TTConfig,
  type TTState,
} from '../src/index.js';
import type { OpenOrder, TickInput } from '@app/strategy-core';
import { Decimal } from '@app/money';

const NOW_MS = 1_700_000_000_000;
const MIN_MS = 60_000;
const OVERRIDE_ID = '11111111-1111-4111-8111-111111111111';

// A single 1m row that fires force-sell on STRONG_SELL, plus the two new
// knobs. Both guards default to an EXPLICIT 0 here so each case isolates the
// knob under test against the old zero-window/zero-cooldown behaviour: the
// schema no longer ships a 0 default (an omitted guard now resolves to a safe
// non-zero default whenever a sub-1h force-sell trigger is armed, which this
// 1m row is), so the prior implicit-0 cases must opt into 0 explicitly.
const cfg = (o?: {
  forceSellConfirmMinutes?: number;
  forceSellReentryCooldownMinutes?: number;
}): TTConfig =>
  TTConfigSchema.parse({
    symbol: 'BTCUSDT',
    buy: {
      enabled: true,
      entrySizing: { mode: 'fixed', amount: '50' },
      avgEntryPriceRemoveThreshold: '0',
    },
    sell: { enabled: true, stopLossPercentage: '0.97', triggerPercentage: '1.05' },
    technicals: {
      useOnlyWithinMin: 2,
      ifExpires: 'do-not-buy',
      intervals: [
        {
          interval: '1m',
          whenStrongBuy: false,
          whenBuy: false,
          whenSell: false,
          whenStrongSell: true,
          whenNeutral: false,
        },
      ],
      forceSellConfirmMinutes: o?.forceSellConfirmMinutes ?? 0,
      forceSellReentryCooldownMinutes: o?.forceSellReentryCooldownMinutes ?? 0,
    },
  });

type Sig = NonNullable<TTBundle['technicals']['signals'][number]['signal']>;

const strongSellSig = (nowMs: number): Sig => ({
  symbol: 'BTCUSDT',
  recommendation: 'STRONG_SELL',
  maRecommendation: null,
  oscRecommendation: null,
  receivedAtMs: nowMs,
  indicators: null,
});

// Bundle carrying a live 1m signal (or none). `config` mirrors the profile's
// technicals so the freshness window matches; force-sell reads its trigger
// knobs off the parsed config, not this bundle config.
const bundleWith = (c: TTConfig, signal: Sig | null, override?: TTBundle['override']): TTBundle =>
  TTBundleSchema.parse({
    technicals: {
      config: {
        useOnlyWithinMin: c.technicals.useOnlyWithinMin,
        ifExpires: c.technicals.ifExpires,
        intervals: c.technicals.intervals,
      },
      signals: [{ interval: '1m', signal }],
    },
    override: override ?? null,
  });

const heldState = (c: TTConfig): TTState => ({
  ...trailingTrade.initialState(c),
  avgEntryPrice: '100',
});

const baseInput = (o: {
  config: TTConfig;
  state: TTState;
  bundle: TTBundle;
  nowMs?: number;
  currentPrice?: string;
  btcFree?: string;
  openOrders?: readonly OpenOrder[];
}): TickInput<TTConfig, TTState, TTBundle> => ({
  clock: { nowMs: () => o.nowMs ?? NOW_MS },
  rng: { next: () => 0 },
  trigger: { kind: 'tick' },
  profile: {
    id: 'p1',
    userId: 'u1',
    binanceMode: 'test',
    status: 'running',
    strategyVersion: '2.0.0',
  },
  config: o.config,
  state: o.state,
  market: {
    symbol: 'BTCUSDT',
    // Below the 105 trigger, above the 97 stop-loss, above cost: only the
    // force-sell branch can fire on a STRONG_SELL signal.
    currentPrice: o.currentPrice ?? '102.00',
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
  account: {
    balances: {
      BTC: { asset: 'BTC', free: new Decimal(o.btcFree ?? '1'), locked: new Decimal(0) },
    },
    readable: true,
  },
  openOrders: o.openOrders ?? [],
  bundle: o.bundle,
  limits: { weightUsed1m: 0, weightLimit1m: 1200, headroomBps: 10000 },
});

describe('@app/strategy-trailing-trade force-sell confirm window', () => {
  it('delays the force-sell until the trigger has persisted for the window', () => {
    const c = cfg({ forceSellConfirmMinutes: 5 });
    const first = trailingTrade.tick(
      baseInput({
        config: c,
        state: heldState(c),
        bundle: bundleWith(c, strongSellSig(NOW_MS)),
        nowMs: NOW_MS,
      }),
    );
    // First present tick: no emission yet, first-seen stamped, position kept.
    expect(first.decisions[0]?.type).not.toBe('place-order');
    expect(first.nextState.avgEntryPrice).toBe('100');
    expect(first.nextState.forceSellFirstSeenAtMs).toBe(NOW_MS);
    expect(first.logs.map((l) => l.message)).toContain('tt-force-sell-confirm-pending');

    // Past the window with the trigger still present: force-sell emits.
    const later = NOW_MS + 5 * MIN_MS;
    const out = trailingTrade.tick(
      baseInput({
        config: c,
        state: { ...first.nextState },
        bundle: bundleWith(c, strongSellSig(later)),
        nowMs: later,
      }),
    );
    expect(out.decisions[0]).toMatchObject({
      type: 'place-order',
      intent: { side: 'SELL', reason: 'technicals-force-sell' },
    });
    expect(out.nextState.avgEntryPrice).toBeNull();
  });

  it('clears forceSellFirstSeenAtMs when the trigger goes absent', () => {
    const c = cfg({ forceSellConfirmMinutes: 5 });
    const seeded: TTState = { ...heldState(c), forceSellFirstSeenAtMs: NOW_MS };
    // No matching signal this tick: the pending confirm window resets.
    const out = trailingTrade.tick(
      baseInput({
        config: c,
        state: seeded,
        bundle: bundleWith(c, null),
        nowMs: NOW_MS + MIN_MS,
      }),
    );
    expect(out.nextState.forceSellFirstSeenAtMs).toBeNull();
  });

  it('emits on the same tick when the confirm window is 0 (default behaviour)', () => {
    const c = cfg();
    const out = trailingTrade.tick(
      baseInput({
        config: c,
        state: heldState(c),
        bundle: bundleWith(c, strongSellSig(NOW_MS)),
        nowMs: NOW_MS,
      }),
    );
    expect(out.decisions[0]).toMatchObject({
      type: 'place-order',
      intent: { side: 'SELL', reason: 'technicals-force-sell' },
    });
  });
});

describe('@app/strategy-trailing-trade force-sell re-entry cooldown', () => {
  // Drive a force-sell emission with the cooldown configured, then reuse the
  // resulting nextState (which must carry forceSellCooldownUntilMs) to probe
  // each first-entry path while the clock is still inside the cooldown.
  const sellThenState = (cooldownMinutes: number): { c: TTConfig; cooledState: TTState } => {
    const c = cfg({ forceSellReentryCooldownMinutes: cooldownMinutes });
    const sold = trailingTrade.tick(
      baseInput({
        config: c,
        state: heldState(c),
        bundle: bundleWith(c, strongSellSig(NOW_MS)),
        nowMs: NOW_MS,
      }),
    );
    expect(sold.decisions[0]).toMatchObject({ type: 'place-order', intent: { side: 'SELL' } });
    return { c, cooledState: sold.nextState };
  };

  it('stamps forceSellCooldownUntilMs on a force-sell emission', () => {
    const { cooledState } = sellThenState(10);
    expect(cooledState.forceSellCooldownUntilMs).toBe(NOW_MS + 10 * MIN_MS);
  });

  it('cooldown blocks first entry', () => {
    // Authoritative RED repro: a flat profile inside the cooldown window must
    // refuse the normal first entry and log tt-force-sell-cooldown-blocked.
    const { c, cooledState } = sellThenState(10);
    const within = NOW_MS + 5 * MIN_MS;
    const out = trailingTrade.tick(
      baseInput({
        config: c,
        state: { ...cooledState, autoTriggerBuyAtMs: null },
        bundle: bundleWith(c, null),
        nowMs: within,
        currentPrice: '100',
        btcFree: '0',
      }),
    );
    expect(out.decisions.some((d) => d.type === 'place-order')).toBe(false);
    expect(out.logs.map((l) => l.message)).toContain('tt-force-sell-cooldown-blocked');
  });

  it('blocks the autoTriggerBuy timer fire while cooled down', () => {
    const c = cfg({ forceSellReentryCooldownMinutes: 10 });
    const within = NOW_MS + 5 * MIN_MS;
    const cooled: TTState = {
      ...trailingTrade.initialState(c),
      forceSellCooldownUntilMs: NOW_MS + 10 * MIN_MS,
      autoTriggerBuyAtMs: within,
    };
    const out = trailingTrade.tick(
      baseInput({ config: c, state: cooled, bundle: bundleWith(c, null), nowMs: within }),
    );
    // The timer must NOT fire a dead buy while cooled down.
    expect(out.decisions.some((d) => d.type === 'place-order')).toBe(false);
    expect(out.logs.map((l) => l.message)).toContain('tt-force-sell-cooldown-blocked');
  });

  it('blocks an override trigger-buy while cooled down', () => {
    const c = cfg({ forceSellReentryCooldownMinutes: 10 });
    const within = NOW_MS + 5 * MIN_MS;
    const cooled: TTState = {
      ...trailingTrade.initialState(c),
      forceSellCooldownUntilMs: NOW_MS + 10 * MIN_MS,
    };
    const out = trailingTrade.tick(
      baseInput({
        config: c,
        state: cooled,
        bundle: bundleWith(c, null, { kind: 'trigger-buy', overrideActionId: OVERRIDE_ID }),
        nowMs: within,
      }),
    );
    expect(out.decisions.some((d) => d.type === 'place-order')).toBe(false);
    expect(out.logs.map((l) => l.message)).toContain('tt-force-sell-cooldown-blocked');
  });

  it('allows first entry once the cooldown has expired', () => {
    const c = cfg({ forceSellReentryCooldownMinutes: 10 });
    const after = NOW_MS + 11 * MIN_MS;
    const cooled: TTState = {
      ...trailingTrade.initialState(c),
      forceSellCooldownUntilMs: NOW_MS + 10 * MIN_MS,
    };
    const out = trailingTrade.tick(
      baseInput({
        config: c,
        // STRONG_BUY would normally pass the gate; here the bundle has no
        // matching whenStrongSell trigger, so a plain present BUY-side signal
        // lets the entry through once cooldown is gone.
        state: cooled,
        bundle: TTBundleSchema.parse({
          technicals: {
            config: {
              useOnlyWithinMin: c.technicals.useOnlyWithinMin,
              ifExpires: c.technicals.ifExpires,
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
                signal: {
                  symbol: 'BTCUSDT',
                  recommendation: 'STRONG_BUY',
                  maRecommendation: null,
                  oscRecommendation: null,
                  receivedAtMs: after,
                  indicators: null,
                },
              },
            ],
          },
          override: null,
        }),
        nowMs: after,
        currentPrice: '100',
        btcFree: '0',
      }),
    );
    expect(out.decisions[0]).toMatchObject({ type: 'place-order', intent: { side: 'BUY' } });
    expect(out.logs.map((l) => l.message)).not.toContain('tt-force-sell-cooldown-blocked');
  });
});

describe('@app/strategy-trailing-trade force-sell guard defaults on a raw stored config', () => {
  // A stored config written before the guard fields existed arrives at tick()
  // RAW (no full re-parse), so both fields are absent. With a sub-1h force-sell
  // trigger armed the tick must resolve the safe non-zero defaults itself:
  // confirm = one candle of the shortest sub-1h interval, cooldown = 60.
  const rawCfgWithoutGuards = (): TTConfig => {
    const parsed = cfg();
    // Strip the two guard fields to model a pre-#464 stored config; the cast
    // mirrors the worker handing the strategy a raw JSONB body.
    const technicals = { ...parsed.technicals } as Record<string, unknown>;
    delete technicals.forceSellConfirmMinutes;
    delete technicals.forceSellReentryCooldownMinutes;
    return { ...parsed, technicals } as unknown as TTConfig;
  };

  it('applies a non-zero confirm window so a single 1m print does not bail out', () => {
    const c = rawCfgWithoutGuards();
    const out = trailingTrade.tick(
      baseInput({
        config: c,
        state: heldState(c),
        bundle: bundleWith(c, strongSellSig(NOW_MS)),
        nowMs: NOW_MS,
      }),
    );
    // Confirm defaults to the 1m interval (1 minute), so the first present tick
    // is pending, not an emit.
    expect(out.decisions[0]?.type).not.toBe('place-order');
    expect(out.nextState.avgEntryPrice).toBe('100');
    expect(out.nextState.forceSellFirstSeenAtMs).toBe(NOW_MS);
    expect(out.logs.map((l) => l.message)).toContain('tt-force-sell-confirm-pending');
  });

  it('stamps a 60-minute cooldown on the force-sell emission', () => {
    const c = rawCfgWithoutGuards();
    // First tick stamps the confirm window; a tick one minute later (past the
    // 1m confirm default) emits the force-sell and stamps the 60m cooldown.
    const first = trailingTrade.tick(
      baseInput({
        config: c,
        state: heldState(c),
        bundle: bundleWith(c, strongSellSig(NOW_MS)),
        nowMs: NOW_MS,
      }),
    );
    const later = NOW_MS + MIN_MS;
    const out = trailingTrade.tick(
      baseInput({
        config: c,
        state: first.nextState,
        bundle: bundleWith(c, strongSellSig(later)),
        nowMs: later,
      }),
    );
    expect(out.decisions[0]).toMatchObject({
      type: 'place-order',
      intent: { side: 'SELL', reason: 'technicals-force-sell' },
    });
    expect(out.nextState.forceSellCooldownUntilMs).toBe(later + 60 * MIN_MS);
  });
});
