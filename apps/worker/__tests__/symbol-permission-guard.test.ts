// Binance refuses an order on a symbol whose permission sets do not intersect the
// account's own permissions, with -2010 "This symbol is not permitted for this
// account". The refusal is PERMANENT: no wallet change, no market move, and no
// retry can ever satisfy it. Auto-discovery bound one such symbol (a tokenized
// equity) because `status === 'TRADING'` is the only tradability signal read
// today, and every tick re-derived the same entry order, so the account burned
// its whole 1200/min request-weight budget on placements that could not succeed
// and throttled every sibling profile.
//
// Binance publishes tradability as an AND-of-ORs: `permissionSets` is a list of
// sets, and the account must hold at least one permission from EVERY set. An
// account holding only LEVERAGED + TRD_GRP_025 therefore fails a symbol whose
// single published set is [SPOT, MARGIN, TRD_GRP_005 .. TRD_GRP_261], since the
// intersection is empty.
//
// Two independent surfaces must know this, because each alone leaves a hole: the
// discovery universe, so such a symbol is never bound in the first place, and the
// placement pre-flight, so a symbol bound before the filter existed, or added by
// hand, still cannot reach the wire. Both fail OPEN when the account permission
// list is unreadable, for the same reason the funding pre-flight does: a signal we
// cannot read is not a refusal, and blocking every order on a cold cache would
// halt trading.

import { describe, expect, it, vi } from 'vitest';
import { pino } from 'pino';
import type { Redis } from 'ioredis';
import type { BinanceRestClient, Ticker24hrDto } from '@app/binance';
import type { NotifyProviderRegistry } from '@app/notify';
import { createRegistry, type Decision, type ExecutorContext } from '@app/strategy-core';
import { asAccountId, asProfileId, asUserId } from '@app/contracts';
import { Decimal } from '@app/money';

import { toDiscoveryTickers } from '../src/crons/discovery/quote-price.js';
import type { AssetPolicy } from '../src/crons/discovery/asset-policy.js';
import type { SymbolAdmission } from '../src/crons/discovery/symbol-admission.js';
import { placeOrderHandler } from '../src/executor/decisions/place-order.js';
import {
  buildAccountInfoKey,
  buildAccountPermissionsKey,
  buildSymbolInfoKey,
} from '../src/executor/redis-namespace.js';
import { createCancelLedger } from '../src/executor/cancel-ledger.js';
import type { DecisionDeps } from '../src/executor/decisions/_types.js';
import type { ProfileExecutorBindings } from '../src/executor/live-executor.js';
import type { ProfilePersistence } from '../src/profile-bindings/persistence.js';

const USER = asUserId('00000000-0000-0000-0000-0000000000aa');
const PROFILE = asProfileId('00000000-0000-0000-0000-0000000000bb');
const ACCOUNT = asAccountId('00000000-0000-0000-0000-0000000000cc');
const CTX: ExecutorContext = {
  userId: USER,
  profileId: PROFILE,
  clock: { nowMs: () => 1_700_000_000_000 },
};

const BLOCKED = 'CRCLBUSDT';

/** The live account's own permission list, read from `/api/v3/account`. */
const ACCOUNT_PERMISSIONS = ['LEVERAGED', 'TRD_GRP_025'] as const;

/**
 * The tokenized equity's published sets, read from `/api/v3/exchangeInfo`. Note
 * the absence of TRD_GRP_025 and of SPOT: the account holds nothing in this set,
 * so the intersection is empty and the refusal is permanent.
 */
const BLOCKED_SETS = [['SPOT', 'MARGIN', 'TRD_GRP_005', 'TRD_GRP_006', 'TRD_GRP_261']] as const;

/** A normal pair's sets: TRD_GRP_025 is present, so the account may trade it. */
const PERMITTED_SETS = [['SPOT', 'MARGIN', 'TRD_GRP_004', 'TRD_GRP_025']] as const;

const ticker = (symbol: string): Ticker24hrDto => ({
  symbol,
  lastPrice: '1',
  priceChange: '0',
  priceChangePercent: '10',
  highPrice: '1',
  lowPrice: '1',
  openPrice: '1',
  volume: '1',
  quoteVolume: '1000000',
  bidPrice: '1',
  askPrice: '1',
});

const UNIVERSE = [ticker(BLOCKED), ticker('BTCUSDT'), ticker('ETHUSDT')];

// All three are TRADING, which is the whole point: the status filter cannot
// separate a tokenized equity from a real pair, so it must not be what keeps
// these assertions honest.
const ADMISSION = new Map<string, SymbolAdmission>([
  [
    BLOCKED,
    { status: 'TRADING', baseAsset: 'CRCLB', quoteAsset: 'USDT', permissionSets: BLOCKED_SETS },
  ],
  [
    'BTCUSDT',
    { status: 'TRADING', baseAsset: 'BTC', quoteAsset: 'USDT', permissionSets: PERMITTED_SETS },
  ],
  [
    'ETHUSDT',
    { status: 'TRADING', baseAsset: 'ETH', quoteAsset: 'USDT', permissionSets: PERMITTED_SETS },
  ],
]);

/** None of these three is a stablecoin or fiat, so the asset policy decides nothing here and the permission cut is the only thing that can move an assertion. */
const NO_PEGGED_ASSETS: AssetPolicy = {
  stablecoinOrFiatBases: new Set(),
  taggedStablecoinBases: new Set(),
  fiatQuoteAssets: new Set(),
  tradingSymbols: new Set(ADMISSION.keys()),
};

const PLACE: Extract<Decision, { type: 'place-order' }> = {
  type: 'place-order',
  intent: { symbol: BLOCKED, side: 'BUY', reason: 'tt-buy', clientOrderId: 'client-1' },
  // Priced LIMIT against an ample free quote balance, so the funding pre-flight
  // passes and the permission guard is the only thing that can refuse.
  params: { type: 'LIMIT', quantity: '1', price: '100', timeInForce: 'GTC' },
};

/** The `account-info` value, shaped as the account-snapshot cron writes it. */
const accountInfo = JSON.stringify({
  balances: { USDT: { free: '5000.00000000', locked: '0.00000000' } },
});

/** The `symbol-info` value, shaped as the exchange-info refresh writes it. */
const symbolInfo = JSON.stringify({
  symbol: BLOCKED,
  baseAsset: 'CRCLB',
  quoteAsset: 'USDT',
  status: 'TRADING',
  filters: {
    minPrice: '0.01',
    maxPrice: '1000',
    tickSize: '0.01',
    minQty: '0.001',
    maxQty: '10000',
    stepSize: '0.001',
    minNotional: '5',
  },
  permissionSets: BLOCKED_SETS,
});

// `permissions` is the account-permissions key, which is written only from a
// `/account` response. `undefined` models the cold cache the fail-open case needs.
const fakeRedis = (permissions?: readonly string[]): Redis =>
  ({
    set: vi.fn(async () => 'OK'),
    del: vi.fn(async () => 0),
    incr: vi.fn(async () => 1),
    eval: vi.fn(async () => null),
    get: vi.fn(async (key: string) => {
      if (key === buildAccountInfoKey(ACCOUNT, PROFILE)) return accountInfo;
      if (key === buildSymbolInfoKey(BLOCKED, 'live')) return symbolInfo;
      if (key === buildAccountPermissionsKey(ACCOUNT))
        return permissions === undefined ? null : JSON.stringify(permissions);
      return null;
    }),
    multi: vi.fn(() => {
      const pipeline = {
        publish: vi.fn(() => pipeline),
        xadd: vi.fn(() => pipeline),
        exec: vi.fn(async () => []),
      };
      return pipeline;
    }),
  }) as unknown as Redis;

const fakeBinance = (): BinanceRestClient =>
  ({
    placeOrder: vi.fn(async () => ({ orderId: 42, clientOrderId: 'client-1', status: 'NEW' })),
    cancelOrder: vi.fn(),
    ctx: () => ({ weightUsed1m: 50, mode: 'live' as const }),
  }) as unknown as BinanceRestClient;

const buildBindings = (binance: BinanceRestClient): ProfileExecutorBindings =>
  ({
    mode: 'live',
    binance,
    weightLimit1m: 1200,
    quoteAsset: 'USDT',
    persistence: {
      persistOrder: vi.fn(async () => undefined) as unknown as ProfilePersistence['persistOrder'],
      resolveOrderSlot: async () => null,
      persistTrackingOrder: vi.fn(async () => undefined),
      closeOrder: async () => undefined,
      recordBookkeepingFailure: vi.fn(async () => undefined),
      listEnabledNotifiers: vi.fn(async () => [
        { provider: 'slack', config: {}, secrets: {}, enabled: true },
      ]),
      recordNotifierGap: vi.fn(async () => undefined),
      setKv: vi.fn(async () => undefined),
      deleteKv: vi.fn(async () => undefined),
    },
  }) as ProfileExecutorBindings;

const buildDeps = (bindings: ProfileExecutorBindings, redis: Redis): DecisionDeps => {
  const registry: Partial<NotifyProviderRegistry> = { get: () => undefined, list: () => [] };
  return {
    redis,
    accountId: ACCOUNT,
    logger: pino({ level: 'silent' }),
    clock: { nowMs: () => 1_700_000_000_000 },
    weightTtlSeconds: 120,
    notifyRegistry: registry as NotifyProviderRegistry,
    resolveProfile: async () => bindings,
    cancelLedger: createCancelLedger(),
    strategies: createRegistry(),
  } as DecisionDeps;
};

describe('symbol-permission guard', () => {
  it('excludes CRCLBUSDT from the discovery universe when the account holds only TRD_GRP_025', () => {
    const out = toDiscoveryTickers(UNIVERSE, 'USDT', new Decimal(1), {
      admissionBySymbol: ADMISSION,
      assetPolicy: NO_PEGGED_ASSETS,
      accountPermissions: ACCOUNT_PERMISSIONS,
      logger: { warn: vi.fn() },
    });

    expect(out.map((t) => t.symbol)).toEqual(['BTCUSDT', 'ETHUSDT']);
  });

  it('refuses a CRCLBUSDT placement pre-call without calling Binance', async () => {
    const binance = fakeBinance();
    const deps = buildDeps(buildBindings(binance), fakeRedis(ACCOUNT_PERMISSIONS));

    const out = await placeOrderHandler(deps, CTX, PLACE);

    // The request-weight assertion. Every one of these placements cost weight and
    // bought nothing; the account hit 1200/1200 and throttled its other profiles.
    // Refusing before the call is what makes the storm cost zero.
    expect(binance.placeOrder).not.toHaveBeenCalled();

    expect(out.ok).toBe(false);
    if (out.ok === false) {
      // Nothing was transmitted, so nothing can be live: `pre-call` is what lets an
      // override settle re-arm safely. Non-retryable because no retry can ever be
      // permitted, unlike a shortfall the operator can clear.
      expect(out.phase).toBe('pre-call');
      expect(out.retryable).toBe(false);
      expect(out.reason).toMatch(/permission|not permitted/i);
    }
  });

  it('keeps the symbol when the account permission list is unavailable', async () => {
    // A cold `/account` cache means we do not know what this account may trade.
    // Trimming the universe or vetoing an order on that basis would shrink the
    // tradable set on every Redis blip, so an unknown list decides nothing and
    // Binance stays the judge.
    const kept = toDiscoveryTickers(UNIVERSE, 'USDT', new Decimal(1), {
      admissionBySymbol: ADMISSION,
      assetPolicy: NO_PEGGED_ASSETS,
      accountPermissions: [],
      logger: { warn: vi.fn() },
    });
    expect(kept.map((t) => t.symbol)).toEqual([BLOCKED, 'BTCUSDT', 'ETHUSDT']);

    const binance = fakeBinance();
    const deps = buildDeps(buildBindings(binance), fakeRedis());

    const out = await placeOrderHandler(deps, CTX, PLACE);

    expect(out).toEqual({ ok: true });
    expect(binance.placeOrder).toHaveBeenCalledOnce();
  });

  // The pre-flight's own fail-open catch. Both surfaces below leave it unable to
  // read the symbol's sets, which must decide NOTHING: an unreadable signal that
  // vetoed the order would stop trading on every Redis hiccup, and the symbol's
  // real permissions have not changed just because we could not see them.
  it('places the order when the cached symbol-info is not valid JSON', async () => {
    const binance = fakeBinance();
    const redis = fakeRedis(ACCOUNT_PERMISSIONS);
    const realGet = redis.get as unknown as (key: string) => Promise<string | null>;
    (redis as unknown as { get: (key: string) => Promise<string | null> }).get = async (key) =>
      key === buildSymbolInfoKey(BLOCKED, 'live') ? '{not json' : realGet(key);

    const out = await placeOrderHandler(buildDeps(buildBindings(binance), redis), CTX, PLACE);

    expect(out).toEqual({ ok: true });
    expect(binance.placeOrder).toHaveBeenCalledOnce();
  });

  it('places the order when the symbol-info read stalls past its deadline', async () => {
    // A reachable-but-stalled Redis: the GET never settles. The deadline race
    // must reject into the fail-open path rather than hang the whole tick.
    const binance = fakeBinance();
    const redis = fakeRedis(ACCOUNT_PERMISSIONS);
    const realGet = redis.get as unknown as (key: string) => Promise<string | null>;
    (redis as unknown as { get: (key: string) => Promise<string | null> }).get = (key) =>
      key === buildSymbolInfoKey(BLOCKED, 'live') ? new Promise(() => {}) : realGet(key);

    const out = await placeOrderHandler(buildDeps(buildBindings(binance), redis), CTX, PLACE);

    expect(out).toEqual({ ok: true });
    expect(binance.placeOrder).toHaveBeenCalledOnce();
  });
});
