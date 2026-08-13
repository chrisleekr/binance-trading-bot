// Per-account Binance REST resolution and the exchange-info refresher.
//
// Credentials + environment are per-ACCOUNT (one key pair, one binance_mode
// shared by every profile under the account), so resolution is keyed by
// accountId. `resolveBinanceFull` is the single ownership-checking resolve
// shared by the user-stream open path and the cold-load REST fallback;
// `resolveBinanceClient` drops the mode for callers that only need the client.

import type { Logger } from 'pino';
import type { Redis } from 'ioredis';

import { AccountNotOwnedError, accountRepo, type Database } from '@app/db';
import type { AccountId, UserId } from '@app/contracts';
import {
  createOrderRateGovernor,
  type BinanceMode,
  type OrderRateGovernor,
  type WeightGovernor,
} from '@app/binance';

import { buildBinanceClient } from 'profile-bindings/binance-client.js';
import {
  combineExchangeInfoRefresh,
  createExchangeInfoRefresh,
  type ExchangeInfoRefreshResult,
} from 'crons/exchange-info-refresh.js';

export type BinanceClient = ReturnType<typeof buildBinanceClient>;

export interface ResolvedBinance {
  readonly rest: BinanceClient;
  readonly mode: 'live' | 'test';
  /**
   * The account's ORDERS governor, shared with `rest` so both see one tally.
   * Exposed so a caller can PEEK before attempting order flow it would rather
   * defer than block on; the accounting itself happens inside `rest`.
   */
  readonly orderGovernor: OrderRateGovernor;
}

export type ResolveBinanceFull = (
  operatorId: UserId,
  accountId: AccountId,
) => Promise<ResolvedBinance | null>;

export type ResolveBinanceClient = (
  operatorId: UserId,
  accountId: AccountId,
) => Promise<BinanceClient | null>;

export interface BinanceResolverDeps {
  readonly db: Database;
  readonly redis: Redis;
  readonly logger: Logger;
  readonly weightGovernor: WeightGovernor;
}

/** The account's ORDERS governor for a Binance environment, created on demand. */
export type OrderGovernorFor = (accountId: AccountId, mode: BinanceMode) => OrderRateGovernor;

export interface BinanceResolver {
  readonly resolveBinanceFull: ResolveBinanceFull;
  readonly resolveBinanceClient: ResolveBinanceClient;
  readonly exchangeInfoRefresh: () => Promise<unknown>;
  /**
   * Exposed because the EXECUTOR builds its own REST client (fresh credentials
   * per order, see `profile-bindings`) rather than reusing `resolveBinanceFull`'s.
   * Both must charge the same bucket or the account's order budget is counted
   * twice over.
   */
  readonly orderGovernorFor: OrderGovernorFor;
}

export const buildBinanceResolver = ({
  db,
  redis,
  logger,
  weightGovernor,
}: BinanceResolverDeps): BinanceResolver => {
  // Latest ORDERS rows per environment, refreshed alongside the symbol cache.
  // Empty until the first SUCCESSFUL refresh, which is not guaranteed to have
  // happened before the first tick: prime-before-ticks catches a refresh failure
  // and falls back to the cron, and `combineExchangeInfoRefresh` downgrades a
  // test-mode failure to a warn. Hence the un-memoised inert path below.
  const orderRateLimits = new Map<BinanceMode, ExchangeInfoRefreshResult['orderRateLimits']>();

  // ORDERS is metered per Binance UID, so each account needs its own governor —
  // one shared bucket would throttle every account to 1/N of its allowance.
  // Memoised because `resolveBinanceFull` builds a fresh REST client on every
  // call; a governor built per call would forget its window on every call and
  // account nothing. Keyed by mode too: switching an account's environment
  // swaps the key pair, and therefore the UID the limits apply to.
  // Keyed on accountId rather than UID because the UID is not known locally.
  // Two account rows holding key pairs from the SAME Binance UID would each
  // reserve the full allowance; `observe` converges them from the response
  // headers on the next call rather than preventing the overlap.
  const orderGovernors = new Map<string, OrderRateGovernor>();
  const orderGovernorFor: OrderGovernorFor = (accountId, mode) => {
    const key = `${accountId}:${mode}`;
    const existing = orderGovernors.get(key);
    if (existing) return existing;
    const limits = orderRateLimits.get(mode);
    if (!limits || limits.windows.length === 0) {
      logger.warn(
        { accountId, mode },
        'binance-resolver: exchangeInfo published no ORDERS limits; order governor is inert',
      );
      // Deliberately NOT memoised. An inert governor accounts nothing, so it has
      // no state worth keeping, and caching one would pin the account to zero
      // order accounting for the life of the process even after a later refresh
      // publishes real limits. Rebuilding per call also keeps the warn recurring
      // rather than firing once and going quiet.
      return createOrderRateGovernor({ windows: [], headers: new Map() });
    }
    const governor = createOrderRateGovernor(limits);
    orderGovernors.set(key, governor);
    return governor;
  };

  const resolveBinanceFull: ResolveBinanceFull = async (operatorId, accountId) => {
    // `accountRepo` runs the single ownership check; a missing or unowned
    // account (deletion race) rejects with `AccountNotOwnedError` — fold that
    // into the `null` this function's callers already handle.
    let a;
    try {
      a = await accountRepo(db, operatorId, accountId);
    } catch (err) {
      if (err instanceof AccountNotOwnedError) return null;
      throw err;
    }
    const key = await a.apiKeys.findForAccount();
    if (!key) return null;
    const account = await a.account.get();
    if (!account) return null;
    const mode = account.binanceMode === 'live' ? 'live' : 'test';
    const orderGovernor = orderGovernorFor(accountId, mode);
    return {
      rest: buildBinanceClient({
        mode,
        apiKey: key.key,
        secretKey: key.secret,
        weightGovernor,
        orderGovernor,
      }),
      mode,
      orderGovernor,
    };
  };
  const resolveBinanceClient: ResolveBinanceClient = async (operatorId, accountId) => {
    const r = await resolveBinanceFull(operatorId, accountId);
    return r ? r.rest : null;
  };

  // Symbol filters are fetched per Binance mode: production for live profiles,
  // testnet for test profiles (their tickSize / lot filters differ, so pricing
  // an order off the wrong host's filters is rejected -1013). Both keyspaces
  // are refreshed here so prime-before-ticks and the recurring cron keep both
  // warm. `combineExchangeInfoRefresh` owns the load-bearing-vs-best-effort
  // branch (unit-tested there).
  // Each refresh also republishes that environment's ORDERS limits, which is
  // why the parsed rows are captured here rather than read back from Redis.
  const captureOrderLimits =
    (mode: BinanceMode, refresh: () => Promise<ExchangeInfoRefreshResult>) =>
    async (): Promise<ExchangeInfoRefreshResult> => {
      const result = await refresh();
      // Only a non-empty parse replaces. `parseOrderRateLimits` returns empty
      // windows for a missing or malformed `rateLimits` array rather than
      // throwing, so overwriting unconditionally would let one bad payload
      // silently drop rate protection for every account resolved afterwards.
      // An empty parse is a bad response, not a change of policy.
      if (result.orderRateLimits.windows.length > 0) {
        orderRateLimits.set(mode, result.orderRateLimits);
        // A governor is memoised per account and handed to REST clients by
        // reference, so a changed ceiling reaches nothing on its own: the
        // account would keep reserving against the old allowance for the life of
        // the process, and a LOWERED limit would show up only as avoidable -1015
        // rejections. Reconfigured rather than rebuilt so the rolling tally
        // survives. A fresh governor starts empty, and a tightened ceiling with
        // an empty tally is precisely when a burst gets admitted over the new
        // allowance. Unconditional because `reconfigure` on an unchanged set is
        // a no-op on the state that matters.
        // Only this environment's governors: the map holds both modes, and
        // live and testnet publish genuinely different ORDERS limits.
        for (const [key, governor] of orderGovernors) {
          if (key.endsWith(`:${mode}`)) governor.reconfigure(result.orderRateLimits.windows);
        }
      } else if (orderRateLimits.has(mode)) {
        logger.warn(
          { mode },
          'binance-resolver: exchangeInfo published no ORDERS limits; keeping the previous set',
        );
      }
      return result;
    };

  const exchangeInfoRefresh = combineExchangeInfoRefresh(
    captureOrderLimits('live', createExchangeInfoRefresh({ redis, logger })),
    captureOrderLimits('test', createExchangeInfoRefresh({ redis, logger, mode: 'test' })),
    logger,
  );

  return { resolveBinanceFull, resolveBinanceClient, exchangeInfoRefresh, orderGovernorFor };
};
