// Sell-side bull hold (slice 2): on a CONFIRMED daily bull, widen the trailing
// stop via an ATR room multiplier so routine pullbacks do not scalp a winning
// trend; the moment the bull ends the trail snaps back to the normal distance
// (auto-tighten). Default-off ⇒ the existing trail path is byte-identical, so
// these tests pin the new behaviour AND the no-regression guarantee.
//
// Numbers used throughout (trade-interval candles have a constant true range of
// 2, so ATR(14) = 2 exactly):
//   highSinceBuy = 120
//   fixed-%   trail (0.98)      stop = 120 * 0.98      = 117.6
//   tight  (×2) ATR-room stop   = 120 - 2 * 2          = 116
//   normal (×3) ATR-room stop   = 120 - 3 * 2          = 114
//   loose  (×4) ATR-room stop   = 120 - 4 * 2          = 112

import { describe, expect, it } from 'vitest';
import { Decimal } from '@app/money';
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
const HOUR_MS = 3_600_000;

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

/** `n` closed 1h candles with a constant true range of 2 ⇒ ATR(period) = 2. */
const atrCandles = (n: number): Candle[] =>
  Array.from({ length: n }, (_, i) => ({
    openTimeMs: i * HOUR_MS,
    closeTimeMs: i * HOUR_MS + HOUR_MS - 1,
    open: '100',
    high: '101',
    low: '99',
    close: '100',
    volume: '1',
    isClosed: true,
  }));

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

// last-3 SMA = (100+115+120)/3 = 111.67; last 2 closes (115, 120) both above ⇒ bull.
const BULL = ['100', '100', '100', '115', '120'];
// last-3 SMA = (100+115+105)/3 = 106.67; 115 above, 105 below ⇒ neither ⇒ neutral.
const NEUTRAL = ['100', '100', '100', '115', '105'];

interface HoldOpts {
  readonly holdEnabled?: boolean;
  readonly room?: 'tight' | 'normal' | 'loose';
  readonly atrEnabled?: boolean;
  readonly atrMultiplier?: string;
  readonly stopLossPercentage?: string;
}

const holdConfig = (o: HoldOpts = {}): TTConfig =>
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
      stopLossPercentage: o.stopLossPercentage ?? '',
      triggerPercentage: '',
      // trailingStopPercentage defaults to '0.98'.
      atrTrailing: {
        enabled: o.atrEnabled ?? false,
        period: 14,
        multiplier: o.atrMultiplier ?? '3',
      },
    },
    regime: {
      ma: 'sma',
      period: 3,
      confirmBars: 2,
      onBull: { hold: { enabled: o.holdEnabled ?? false, room: o.room ?? 'normal' } },
    },
    technicals: { useOnlyWithinMin: 2, ifExpires: 'do-not-buy', intervals: [] },
  });

const heldState = (config: TTConfig): TTState => ({
  ...trailingTrade.initialState(config),
  avgEntryPrice: '100',
  highSinceBuy: '120',
  heldQuantity: '0.2',
  currentGridTradeIndex: 0,
});

const buildInput = (opts: {
  config: TTConfig;
  state: TTState;
  currentPrice: string;
  dailyCloses: string[];
  atrCandleCount?: number;
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
      candlesByInterval: {
        '1h': atrCandles(opts.atrCandleCount ?? 16),
        '1d': dayCandles(opts.dailyCloses),
      },
      symbolInfo: SYMBOL_INFO,
    },
    account: {
      balances: { BTC: { asset: 'BTC', free: new Decimal(1), locked: new Decimal(0) } },
      readable: true,
    },
    openOrders: [] as readonly OpenOrder[],
    bundle,
    limits: { weightUsed1m: 0, weightLimit1m: 1200, headroomBps: 10000 },
  };
};

const isSell = (out: ReturnType<typeof trailingTrade.tick>): boolean =>
  out.decisions.some((d) => d.type === 'place-order' && d.intent.side === 'SELL');

describe('trailingTrade — sell-side bull hold', () => {
  it.each(['tight', 'normal', 'loose'] as const)(
    'room=%s: a retrace breaching the normal trail but not the ATR-room stop does NOT sell',
    (room) => {
      // price 117 ≤ fixed stop 117.6 (would sell) but above every room stop (116/114/112).
      const config = holdConfig({ holdEnabled: true, room });
      const out = trailingTrade.tick(
        buildInput({ config, state: heldState(config), currentPrice: '117', dailyCloses: BULL }),
      );
      expect(isSell(out)).toBe(false);
    },
  );

  it.each([
    ['tight', '115'], // ≤ 116
    ['normal', '113'], // ≤ 114
    ['loose', '111'], // ≤ 112
  ] as const)('room=%s: a retrace breaching the ATR-room stop sells', (room, price) => {
    const config = holdConfig({ holdEnabled: true, room });
    const out = trailingTrade.tick(
      buildInput({ config, state: heldState(config), currentPrice: price, dailyCloses: BULL }),
    );
    expect(out.decisions[0]).toMatchObject({
      type: 'place-order',
      intent: { side: 'SELL', reason: 'grid-sell' },
    });
    // The bull-held widening is surfaced in the sell log for operator visibility.
    expect(out.logs.find((l) => l.message === 'tt-atr-trailing-stop')?.context).toMatchObject({
      trail: 'atr-bull',
    });
  });

  it('auto-tightens: bull→neutral with price unchanged re-applies the normal trail and fires', () => {
    // price 117 holds under a bull (above the room stop) ...
    const bullCfg = holdConfig({ holdEnabled: true, room: 'normal' });
    const held = trailingTrade.tick(
      buildInput({
        config: bullCfg,
        state: heldState(bullCfg),
        currentPrice: '117',
        dailyCloses: BULL,
      }),
    );
    expect(isSell(held)).toBe(false);

    // ... but the SAME price 117 sells once the regime is no longer a confirmed bull,
    // because the trail snaps back to the fixed-% distance (117.6).
    const neutral = trailingTrade.tick(
      buildInput({
        config: bullCfg,
        state: heldState(bullCfg),
        currentPrice: '117',
        dailyCloses: NEUTRAL,
      }),
    );
    expect(neutral.decisions[0]).toMatchObject({
      type: 'place-order',
      intent: { side: 'SELL', reason: 'grid-sell' },
    });
    expect(neutral.logs.some((l) => l.message === 'tt-trailing-stop')).toBe(true);
  });

  it('hold disabled: behaves byte-identically to the fixed-% trail (sells at the normal stop)', () => {
    // price 117 ≤ 117.6 fixed trail; with hold off the bull regime is ignored.
    const config = holdConfig({ holdEnabled: false });
    const out = trailingTrade.tick(
      buildInput({ config, state: heldState(config), currentPrice: '117', dailyCloses: BULL }),
    );
    const trailLog = out.logs.find((l) => l.message === 'tt-trailing-stop');
    expect(trailLog).toBeDefined();
    // No bull-hold context leaks onto the default-off path.
    expect(trailLog?.context).not.toHaveProperty('trail');
    expect(trailLog?.context).not.toHaveProperty('atrMultiplier');
  });

  it('hold disabled with operator ATR trailing: the existing ATR path is unchanged', () => {
    // atrTrailing on (mult 3 ⇒ stop 114), hold off. price 115 > 114 ⇒ noop (ATR owns).
    const config = holdConfig({ holdEnabled: false, atrEnabled: true, atrMultiplier: '3' });
    const noop = trailingTrade.tick(
      buildInput({ config, state: heldState(config), currentPrice: '115', dailyCloses: BULL }),
    );
    expect(isSell(noop)).toBe(false);
    // price 113 ≤ 114 ⇒ ATR trailing stop fires, with no bull-hold context.
    const sell = trailingTrade.tick(
      buildInput({ config, state: heldState(config), currentPrice: '113', dailyCloses: BULL }),
    );
    expect(sell.decisions[0]).toMatchObject({ intent: { side: 'SELL', reason: 'grid-sell' } });
    expect(sell.logs.find((l) => l.message === 'tt-atr-trailing-stop')?.context).not.toHaveProperty(
      'trail',
    );
  });

  it('falls back to the fixed-% trail when ATR is not yet computable in a bull', () => {
    // Only 5 closed 1h candles (< period+1 = 15) ⇒ ATR null ⇒ fixed-% trail.
    const config = holdConfig({ holdEnabled: true, room: 'loose' });
    const out = trailingTrade.tick(
      buildInput({
        config,
        state: heldState(config),
        currentPrice: '117', // ≤ 117.6 fixed stop
        dailyCloses: BULL,
        atrCandleCount: 5,
      }),
    );
    expect(out.decisions[0]).toMatchObject({ intent: { side: 'SELL', reason: 'grid-sell' } });
    expect(out.logs.some((l) => l.message === 'tt-trailing-stop')).toBe(true);
  });

  it('composes with an operator ATR trail: max(operator, bull) — never tightens', () => {
    // Operator mult 5 (stop 110) is WIDER than bull normal mult 3 (stop 114).
    // max ⇒ 5 ⇒ stop 110, so price 112 holds; a wrong "bull tightens" would
    // sell at 114.
    const config = holdConfig({
      holdEnabled: true,
      room: 'normal',
      atrEnabled: true,
      atrMultiplier: '5',
    });
    const out = trailingTrade.tick(
      buildInput({ config, state: heldState(config), currentPrice: '112', dailyCloses: BULL }),
    );
    expect(isSell(out)).toBe(false);
  });

  it('composes with an operator ATR trail: bull WIDENS a tighter operator multiplier', () => {
    // Operator mult 2 (stop 116) is tighter than bull loose mult 4 (stop 112).
    // max ⇒ 4 ⇒ stop 112, so price 114 holds (would have sold at the operator's 116).
    const config = holdConfig({
      holdEnabled: true,
      room: 'loose',
      atrEnabled: true,
      atrMultiplier: '2',
    });
    const out = trailingTrade.tick(
      buildInput({ config, state: heldState(config), currentPrice: '114', dailyCloses: BULL }),
    );
    expect(isSell(out)).toBe(false);
  });

  it('is inert (fixed-% trail) when the stored config predates the regime block', () => {
    // The live worker passes raw stored config; a row saved before the regime
    // block existed has `regime` undefined. Bull-hold must tolerate it (disabled).
    const base = holdConfig({ holdEnabled: true, room: 'loose' });
    const config = { ...base, regime: undefined } as unknown as TTConfig;
    const out = trailingTrade.tick(
      buildInput({ config, state: heldState(config), currentPrice: '117', dailyCloses: BULL }),
    );
    expect(out.decisions[0]).toMatchObject({ intent: { side: 'SELL', reason: 'grid-sell' } });
    expect(out.logs.some((l) => l.message === 'tt-trailing-stop')).toBe(true);
  });

  it('surfaces a warn and skips on a corrupted operator ATR multiplier', () => {
    // A multiplier that bypassed schema validation must not silently disable the
    // trail — the existing parse-warn path is preserved through selectTrailMultiplier.
    const base = holdConfig({ holdEnabled: true, atrEnabled: true });
    const config = {
      ...base,
      sell: { ...base.sell, atrTrailing: { ...base.sell.atrTrailing, multiplier: 'not-a-number' } },
    } as unknown as TTConfig;
    const out = trailingTrade.tick(
      buildInput({ config, state: heldState(config), currentPrice: '113', dailyCloses: BULL }),
    );
    expect(out.decisions.every((d) => d.type !== 'place-order')).toBe(true);
    expect(
      out.logs.some(
        (l) =>
          l.message === 'tt-sell-gate-parse-failed' &&
          l.context?.['field'] === 'atrTrailing.multiplier',
      ),
    ).toBe(true);
  });

  it('falls back to the normal room multiplier on an out-of-enum stored room value', () => {
    // The live worker passes raw stored config; a hand-edited row could carry a
    // room outside tight/normal/loose. It must behave like room=normal (×3 ⇒
    // stop 114), not skip the trail. price 113 ≤ 114 ⇒ sell; price 115 > 114 ⇒ hold.
    const base = holdConfig({ holdEnabled: true });
    const config = {
      ...base,
      regime: { ...base.regime, onBull: { hold: { enabled: true, room: 'bogus' } } },
    } as unknown as TTConfig;
    const sell = trailingTrade.tick(
      buildInput({ config, state: heldState(config), currentPrice: '113', dailyCloses: BULL }),
    );
    expect(sell.decisions[0]).toMatchObject({ intent: { side: 'SELL', reason: 'grid-sell' } });
    const hold = trailingTrade.tick(
      buildInput({ config, state: heldState(config), currentPrice: '115', dailyCloses: BULL }),
    );
    expect(isSell(hold)).toBe(false);
  });

  it('stop-loss still fires first under a confirmed bull (loss precedence preserved)', () => {
    // stop-loss 0.97 ⇒ 97; price 96 ≤ 97 fires stop-loss ahead of the trail.
    const config = holdConfig({ holdEnabled: true, room: 'loose', stopLossPercentage: '0.97' });
    const out = trailingTrade.tick(
      buildInput({ config, state: heldState(config), currentPrice: '96', dailyCloses: BULL }),
    );
    expect(out.decisions[0]).toMatchObject({ intent: { side: 'SELL', reason: 'grid-stop-loss' } });
  });
});
