// An UNREADABLE wallet must never look like an empty one.
//
// The tick's account snapshot degrades to `readable: false` when Redis is cold
// or the cached value is malformed. Reading an unreadable wallet as "free = 0"
// caps every sell at zero, so `computeSellQuantity` skips with `no-balance` and
// the exit the operator is counting on — a stop-loss, a regime exit, a manual
// close — is silently suppressed because the bot could not read the wallet.
// Sizing from the tracked position instead costs at most one -2010; refusing to
// exit costs the position.
//
// The inverse is just as dangerous: an asset absent from a READABLE snapshot is
// Binance stating we hold none of it. Failing open there would market-sell a
// phantom position and be rejected every tick.

import { describe, expect, it } from 'vitest';
import { Decimal } from '@app/money';
import type { AccountSnapshot, Decision, OpenOrder, TickInput } from '@app/strategy-core';

import {
  trailingTrade,
  TTConfigSchema,
  TTBundleSchema,
  type TTState,
  type TTBundle,
  type TTConfig,
} from '../src/index.js';
import { evaluateProtectiveStop } from '../src/branches/protective-stop.js';
import { resolveHeldForSell } from '../src/branches/sell-gate.js';
import { protectiveStopClientOrderId } from '../src/client-order-id.js';

const NOW_MS = 1_700_000_000_000;
const PROFILE_ID = 'p1';
const SYMBOL = 'BTCUSDT';
const PROTECTIVE_ID = protectiveStopClientOrderId(PROFILE_ID, SYMBOL);

// The three snapshot states this module is about. Unreadability is an explicit
// flag now, never inferred from an empty balance map.
const UNREADABLE: AccountSnapshot = { balances: {}, readable: false };
const BASE_ABSENT: AccountSnapshot = {
  balances: { USDT: { asset: 'USDT', free: new Decimal('500'), locked: new Decimal(0) } },
  readable: true,
};
const baseFree = (free: string, locked = '0'): AccountSnapshot => ({
  balances: { BTC: { asset: 'BTC', free: new Decimal(free), locked: new Decimal(locked) } },
  readable: true,
});

interface BuildOpts {
  readonly account?: AccountSnapshot;
  readonly heldQuantity?: string | null;
  readonly avgEntryPrice?: string | null;
  readonly currentPrice?: string;
  readonly stopLossPercentage?: string;
  readonly openOrders?: readonly OpenOrder[];
  readonly regime?: TTConfig['regime'];
  readonly dailyCloses?: readonly string[];
  readonly override?: TTBundle['override'];
  readonly protectiveStop?: { enabled: boolean; limitOffsetPercentage?: string };
}

// Closed daily klines; the regime MA reads `close`.
const dayCandles = (closes: readonly string[]): unknown[] =>
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

const buildInput = (o: BuildOpts = {}): TickInput<TTConfig, TTState, TTBundle> => {
  const base = TTConfigSchema.parse({
    symbol: SYMBOL,
    buy: {
      enabled: true,
      entrySizing: { mode: 'fixed', amount: '50' },
      avgEntryPriceRemoveThreshold: '0',
    },
    sell: {
      enabled: true,
      stopLossPercentage: o.stopLossPercentage ?? '0.96',
      triggerPercentage: '1.05',
    },
    ...(o.regime ? { regime: o.regime } : {}),
  }) as TTConfig;

  const config = {
    ...base,
    sell: {
      ...base.sell,
      protectiveStop: o.protectiveStop ?? { enabled: false, limitOffsetPercentage: '0.995' },
    },
  } as unknown as TTConfig;

  const state: TTState = {
    ...trailingTrade.initialState(base),
    avgEntryPrice: o.avgEntryPrice === undefined ? '100' : o.avgEntryPrice,
    heldQuantity: o.heldQuantity === undefined ? '2' : o.heldQuantity,
    currentGridTradeIndex: 0,
  };

  const bundle = TTBundleSchema.parse({
    technicals: {
      config: { useOnlyWithinMin: 2, ifExpires: 'do-not-buy', intervals: [] },
      signals: [],
    },
    override: o.override ?? null,
  });

  return {
    clock: { nowMs: () => NOW_MS },
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
    state,
    market: {
      symbol: SYMBOL,
      currentPrice: o.currentPrice ?? '90.00',
      candlesByInterval: (o.dailyCloses ? { '1d': dayCandles(o.dailyCloses) } : {}) as TickInput<
        TTConfig,
        TTState,
        TTBundle
      >['market']['candlesByInterval'],
      symbolInfo: {
        symbol: SYMBOL,
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
    account: o.account ?? baseFree('2'),
    openOrders: o.openOrders ?? [],
    bundle,
    limits: { weightUsed1m: 0, weightLimit1m: 1200, headroomBps: 10000 },
  };
};

const restingProtectiveStop = (over: Partial<OpenOrder> = {}): OpenOrder => ({
  orderId: 9001,
  clientOrderId: PROTECTIVE_ID,
  symbol: SYMBOL,
  side: 'SELL',
  type: 'STOP_LOSS_LIMIT',
  status: 'NEW',
  price: '95.52',
  origQty: '2',
  executedQty: '0',
  cummulativeQuoteQty: '0',
  stopPrice: '96.00',
  timeInForce: 'GTC',
  transactTimeMs: NOW_MS - 60_000,
  updateTimeMs: NOW_MS - 60_000,
  ...over,
});

const st = (heldQuantity: string | null): TTState => ({ heldQuantity }) as unknown as TTState;

const marketSell = (decisions: readonly Decision[]): Extract<Decision, { type: 'place-order' }> => {
  const sell = decisions.find(
    (d) => d.type === 'place-order' && d.params.type === 'MARKET' && d.intent.side === 'SELL',
  );
  if (sell === undefined || sell.type !== 'place-order') {
    throw new Error('expected a MARKET SELL place-order');
  }
  return sell;
};

const hasMarketSell = (decisions: readonly Decision[]): boolean =>
  decisions.some(
    (d) => d.type === 'place-order' && d.params.type === 'MARKET' && d.intent.side === 'SELL',
  );

describe('resolveHeldForSell — unreadable wallet fails OPEN on the tracked position', () => {
  it('sizes from heldQuantity when the balance map is empty (snapshot unreadable)', () => {
    expect(resolveHeldForSell(st('2'), 'BTC', UNREADABLE)).toBe('2');
  });

  it('does not cap the tracked position at zero when the snapshot is unreadable', () => {
    // The whole bug: min(held, 0) = 0 -> `no-balance` -> the exit never sizes.
    expect(resolveHeldForSell(st('0.0545'), 'BTC', UNREADABLE)).not.toBe('0');
  });

  it('ignores reclaimable on an unreadable snapshot (held is already the full position)', () => {
    // `heldQuantity` is the tracked position, not a free-balance remainder;
    // crediting our own resting stop's base on top would double-count it.
    expect(resolveHeldForSell(st('2'), 'BTC', UNREADABLE, new Decimal(2))).toBe('2');
  });
});

describe('resolveHeldForSell — an absent line in a POPULATED map is a KNOWN zero', () => {
  it('caps the sell at zero when the base line is absent but the map is populated', () => {
    // Binance says we hold no BTC. Sizing from the stale tracked position would
    // market-sell a phantom holding and be rejected -2010 on every tick.
    expect(resolveHeldForSell(st('2'), 'BTC', BASE_ABSENT)).toBe('0');
  });

  it('still caps at zero when our own stop rests but the wallet holds no base', () => {
    // Binance reports free AND locked per asset, so base locked by our resting
    // stop would come back as a PRESENT line. An absent line therefore outranks
    // the TTL-cached openOrders view: that stop has already filled, and crediting
    // its quantity would sell coins that no longer exist.
    expect(resolveHeldForSell(st('2'), 'BTC', BASE_ABSENT, new Decimal(2))).toBe('0');
  });
});

describe('resolveHeldForSell — a present base line keeps the min(held, free + reclaimable) cap', () => {
  it('caps the tracked position at the readable free balance', () => {
    expect(resolveHeldForSell(st('5'), 'BTC', baseFree('2'))).toBe('2');
  });

  it('credits our own resting stop back into the cap', () => {
    expect(resolveHeldForSell(st('3'), 'BTC', baseFree('1', '2'), new Decimal(2))).toBe('3');
  });

  it('never sizes above the tracked position however much base the wallet holds', () => {
    expect(resolveHeldForSell(st('2'), 'BTC', baseFree('9'), new Decimal(2))).toBe('2');
  });

  it('reads a present-but-zero line as zero, not as an unreadable wallet', () => {
    expect(resolveHeldForSell(st('2'), 'BTC', baseFree('0'))).toBe('0');
  });

  it('credits nothing when a present line reads free:0 locked:0 despite a resting-stop reclaimable', () => {
    // getAccount includes zero balances, so a filled stop leaves a PRESENT line
    // with zero locked while a stale openOrders still lists the order (ownLocked
    // 2). Crediting it would size a sell of coins that are gone; the wallet's zero
    // locked overrides, so the size is 0 and the caller skips no-balance.
    expect(resolveHeldForSell(st('2'), 'BTC', baseFree('0', '0'), new Decimal(2))).toBe('0');
  });
});

describe('resolveHeldForSell — a null heldQuantity invents nothing', () => {
  it('returns zero on an unreadable snapshot (legacy row, no tracked position)', () => {
    // Neither source knows the quantity: state has none and the wallet is
    // unreadable. Skipping is the only honest answer.
    expect(resolveHeldForSell(st(null), 'BTC', UNREADABLE)).toBe('0');
  });

  it('returns zero on an unreadable snapshot even when our own stop rests', () => {
    // The resting stop's quantity is not a tracked position: an order left over
    // from a since-emptied holding would resurrect a sell out of nothing.
    expect(resolveHeldForSell(st(null), 'BTC', UNREADABLE, new Decimal(2))).toBe('0');
  });

  it('still falls back to the wallet when the snapshot IS readable', () => {
    expect(resolveHeldForSell(st(null), 'BTC', baseFree('0', '2'), new Decimal(2))).toBe('2');
  });
});

describe('trailingTrade.tick — an exit is never suppressed by an unreadable wallet', () => {
  it('emits the grid-stop-loss MARKET SELL sized from heldQuantity', () => {
    const out = trailingTrade.tick(
      buildInput({ account: UNREADABLE, currentPrice: '90.00', heldQuantity: '2' }),
    );
    const sell = marketSell(out.decisions);
    expect(sell.intent.reason).toBe('grid-stop-loss');
    expect(sell.params.quantity).toBe('2.0000');
    expect(out.logs.some((l) => l.message === 'tt-stop-loss-skipped')).toBe(false);
    // The emit log carries the trace that this quantity was sized off the tracked
    // position, not the wallet — the one boundary that knows the wallet was blind.
    expect(out.logs.find((l) => l.message === 'tt-stop-loss')?.context).toMatchObject({
      walletUnreadable: true,
    });
  });

  it('omits the walletUnreadable trace when the wallet is readable', () => {
    const out = trailingTrade.tick(
      buildInput({ account: baseFree('2'), currentPrice: '90.00', heldQuantity: '2' }),
    );
    const emit = out.logs.find((l) => l.message === 'tt-stop-loss');
    expect(emit?.context).not.toHaveProperty('walletUnreadable');
  });

  it('emits the regime-exit MARKET SELL sized from heldQuantity', () => {
    const out = trailingTrade.tick(
      buildInput({
        account: UNREADABLE,
        // Stop-loss disabled so only the cash-rotation exit can fire.
        stopLossPercentage: '',
        currentPrice: '95.00',
        heldQuantity: '2',
        regime: { ma: 'sma', period: 3, confirmBars: 2, onBear: { exitToCash: true } },
        dailyCloses: ['100', '100', '100', '90', '88'],
      }),
    );
    const sell = marketSell(out.decisions);
    expect(sell.intent.reason).toBe('regime-exit');
    expect(sell.params.quantity).toBe('2.0000');
  });

  it('still cancels the resting protective stop ahead of the fail-open close', () => {
    const out = trailingTrade.tick(
      buildInput({
        account: UNREADABLE,
        currentPrice: '90.00',
        heldQuantity: '2',
        openOrders: [restingProtectiveStop()],
      }),
    );
    const cancelIdx = out.decisions.findIndex((d) => d.type === 'cancel-order');
    const sellIdx = out.decisions.findIndex(
      (d) => d.type === 'place-order' && d.params.type === 'MARKET' && d.intent.side === 'SELL',
    );
    expect(cancelIdx).toBeGreaterThanOrEqual(0);
    expect(cancelIdx).toBeLessThan(sellIdx);
  });
});

describe('trailingTrade.tick — a phantom position is never sold', () => {
  it('skips with no-balance when the base line is absent from a populated map', () => {
    const out = trailingTrade.tick(
      buildInput({ account: BASE_ABSENT, currentPrice: '90.00', heldQuantity: '2' }),
    );
    expect(hasMarketSell(out.decisions)).toBe(false);
    const skip = out.logs.find((l) => l.message === 'tt-stop-loss-skipped');
    expect(skip?.context).toMatchObject({ reason: 'no-balance' });
  });

  it('skips when heldQuantity is null and the snapshot is unreadable', () => {
    const out = trailingTrade.tick(
      buildInput({ account: UNREADABLE, currentPrice: '90.00', heldQuantity: null }),
    );
    expect(hasMarketSell(out.decisions)).toBe(false);
    expect(out.logs.find((l) => l.message === 'tt-stop-loss-skipped')?.context).toMatchObject({
      reason: 'no-balance',
    });
  });

  it('skips when the base line reads free:0 locked:0 but our stop still rests (filled-stop phantom)', () => {
    // The coins are gone (present line, zero locked); the resting-stop credit must
    // not resurrect them into a MARKET SELL that Binance answers -2010 every tick.
    const out = trailingTrade.tick(
      buildInput({
        account: baseFree('0', '0'),
        currentPrice: '90.00',
        heldQuantity: '2',
        openOrders: [restingProtectiveStop()],
      }),
    );
    expect(hasMarketSell(out.decisions)).toBe(false);
    expect(out.logs.find((l) => l.message === 'tt-stop-loss-skipped')?.context).toMatchObject({
      reason: 'no-balance',
    });
  });
});

describe('trigger-sell override — credits the base our own protective stop locks', () => {
  const triggerSell: TTBundle['override'] = {
    kind: 'trigger-sell',
    overrideActionId: '01234567-89ab-4cde-89ab-cdef01234567',
  } as TTBundle['override'];

  it('emits the MARKET close when our resting stop holds the whole free balance', () => {
    // free reads 0 because OUR stop locks all 2 BTC; the same batch cancels it,
    // so that base is reclaimable and the operator's close must go out.
    const out = trailingTrade.tick(
      buildInput({
        account: baseFree('0', '2'),
        currentPrice: '105.00',
        heldQuantity: '2',
        openOrders: [restingProtectiveStop()],
        override: triggerSell,
      }),
    );
    const sell = marketSell(out.decisions);
    expect(sell.intent.reason).toBe('manual');
    expect(sell.params.quantity).toBe('2.0000');
    expect(out.logs.some((l) => l.message === 'tt-trigger-sell-skipped')).toBe(false);
  });

  it('emits the MARKET close sized from heldQuantity when the snapshot is unreadable', () => {
    const out = trailingTrade.tick(
      buildInput({
        account: UNREADABLE,
        currentPrice: '105.00',
        heldQuantity: '2',
        override: triggerSell,
      }),
    );
    expect(marketSell(out.decisions).params.quantity).toBe('2.0000');
  });

  it('still refuses when the base line is absent from a populated map', () => {
    const out = trailingTrade.tick(
      buildInput({
        account: BASE_ABSENT,
        currentPrice: '105.00',
        heldQuantity: '2',
        override: triggerSell,
      }),
    );
    expect(hasMarketSell(out.decisions)).toBe(false);
    expect(out.logs.find((l) => l.message === 'tt-trigger-sell-skipped')?.context).toMatchObject({
      reason: 'no-balance',
    });
  });
});

describe('evaluateProtectiveStop — arms through the same unknown-vs-zero trichotomy', () => {
  const armed = { enabled: true, limitOffsetPercentage: '0.995' };

  it('refuses to arm when the base line is absent from a populated map', () => {
    // A populated snapshot without a BTC line says the position is gone. Arming
    // the full tracked quantity would place an unfundable stop, rejected -2010.
    const input = buildInput({
      account: BASE_ABSENT,
      currentPrice: '105.00',
      heldQuantity: '2',
      protectiveStop: armed,
    });
    const out = evaluateProtectiveStop(input, input.state);
    expect(out.decisions).toEqual([]);
    expect(out.blocker?.reason).toBe('base-short-of-tracked-position');
  });

  it('still fails OPEN on the tracked position when the snapshot is unreadable', () => {
    const input = buildInput({
      account: UNREADABLE,
      currentPrice: '105.00',
      heldQuantity: '2',
      protectiveStop: armed,
    });
    const out = evaluateProtectiveStop(input, input.state);
    expect(out.blocker).toBeNull();
    expect(out.decisions).toHaveLength(1);
    const place = out.decisions[0];
    if (place?.type !== 'place-order') throw new Error('expected a place-order');
    expect(place.params.quantity).toBe('2.0000');
    expect(place.params.stopPrice).toBe('96.00');
  });
});
