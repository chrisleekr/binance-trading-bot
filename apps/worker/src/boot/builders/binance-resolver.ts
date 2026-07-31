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
import type { WeightGovernor } from '@app/binance';

import { buildBinanceClient } from 'profile-bindings/binance-client.js';
import {
  combineExchangeInfoRefresh,
  createExchangeInfoRefresh,
} from 'crons/exchange-info-refresh.js';

export type BinanceClient = ReturnType<typeof buildBinanceClient>;

export interface ResolvedBinance {
  readonly rest: BinanceClient;
  readonly mode: 'live' | 'test';
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

export interface BinanceResolver {
  readonly resolveBinanceFull: ResolveBinanceFull;
  readonly resolveBinanceClient: ResolveBinanceClient;
  readonly exchangeInfoRefresh: () => Promise<unknown>;
}

export const buildBinanceResolver = ({
  db,
  redis,
  logger,
  weightGovernor,
}: BinanceResolverDeps): BinanceResolver => {
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
    return {
      rest: buildBinanceClient({
        mode,
        apiKey: key.key,
        secretKey: key.secret,
        weightGovernor,
      }),
      mode,
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
  const exchangeInfoRefresh = combineExchangeInfoRefresh(
    createExchangeInfoRefresh({ redis, logger }),
    createExchangeInfoRefresh({ redis, logger, mode: 'test' }),
    logger,
  );

  return { resolveBinanceFull, resolveBinanceClient, exchangeInfoRefresh };
};
