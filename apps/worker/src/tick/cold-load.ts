import type { Logger } from 'pino';
import type { Redis } from 'ioredis';
import type { AccountId, ProfileId, UserId } from '@app/contracts';
import { type Database, type ProfileScope, profileRepoFromScope, repo } from '@app/db';
import type { BinanceRestClient } from '@app/binance';
import type { AccountSnapshot, OpenOrder } from '@app/strategy-core';

import { accountSnapshotFromDto, openOrdersFromDtos } from 'lib/binance-snapshot.js';
import { writeAccountInfo } from 'lib/account-info-writer.js';
import { writeAccountPermissions } from 'lib/account-permissions.js';

import type { SnapshotColdLoad, SymbolStateRowView } from './snapshot-loader.js';

/**
 * Dependencies for the production cold-load. `db` resolves the profile
 * row for state hydration; `resolveBinance` produces a mode-pinned REST
 * client so a tick can fetch `account-info` / `open-orders` from Binance
 * on a Redis miss and cache the result. The handlers fall through to
 * Binance ONLY on Redis miss; steady-state ticks read from Redis.
 */
export interface ColdLoadDeps {
  readonly db: Database;
  readonly redis: Redis;
  readonly logger: Logger;
  readonly resolveBinance: (
    operatorId: UserId,
    accountId: AccountId,
  ) => Promise<BinanceRestClient | null>;
}

/**
 * Production {@link SnapshotColdLoad} implementation. Only
 * `loadSymbolState` is a real read — strategies persist per-(profile,
 * symbol) state in the `symbol_states` Postgres table via the tick
 * handler and the cold-load falls back to that row when Redis has not
 * yet seen a tick for that (profile, symbol).
 *
 * `account` and `open-orders` are Redis caches filled on a miss by a REST
 * fetch here; both are written back through this cold-load (account-info via
 * {@link writeAccountInfo}, open-orders in `buildTickInput`) so the next tick
 * reads Redis instead of re-fetching. Their steady-state upkeep differs: the
 * event-router MERGES balance deltas into the account-info cache on
 * `balanceUpdate`, but for open-orders it only DELs the key on
 * every `executionReport` (and the executor DELs on place/cancel) — it
 * never repopulates it, so the next tick re-fetches over REST until the
 * write-through TTL. Both fallbacks LOG and REST-fetch on a miss (they do
 * not throw); only missing credentials throw. Symbol info has its own deep
 * module ({@link SymbolInfoCache}); it is not a per-profile fallback.
 */
export const createProductionColdLoad = (deps: ColdLoadDeps): SnapshotColdLoad => {
  return {
    loadSymbolState: async (
      scope: ProfileScope,
      symbol: string,
    ): Promise<SymbolStateRowView | null> => {
      // Ownership was already proven once at tick entry (`buildProfileTickContext`
      // resolves the `ProfileScope` this receives), so the cold-load reuses it
      // instead of re-running `scopeProfile` — one fewer ownership read per
      // tick (#397). A missing `symbol_states` row is normal: the first tick
      // for a new symbol returns `null` here and the tick handler seeds from
      // `strategy.initialState(profile.config)`. The `onDelete: cascade` FK
      // means a profile deleted after the scope was proven leaves no orphan
      // row — `findBySymbol` returns `null` and the seed/commit path handles it.
      const p = profileRepoFromScope(scope);
      const row = await p.symbolStates.findBySymbol(symbol);
      // Carry the row's `strategy_version` stamp alongside the body so the
      // tick read path can reconcile against PG by schemaVersion. Dropping
      // it (the prior `row?.state ?? null`) left the read unable to detect
      // a column-vs-body drift the mutate path already heals.
      return row === null
        ? null
        : { state: row.state, strategyVersion: row.strategyVersion, version: row.version };
    },
    loadProfileKv: async (scope: ProfileScope): Promise<Record<string, unknown>> => {
      // Cross-symbol KV (#267). Ownership already proven (same scope as the
      // symbol-state read); fold the profile's rows into one snapshot. Only
      // reached when the strategy sets `needsProfileKv`, so it never runs for
      // the per-symbol strategies. One small indexed read per KV-strategy symbol
      // tick (N/cycle); revisit with a Redis snapshot cache if a many-symbol KV
      // strategy ever makes the per-tick PG read hot.
      const p = profileRepoFromScope(scope);
      return p.profileKv.snapshotForProfile();
    },
    loadAccount: async (
      operatorId: UserId,
      accountId: AccountId,
      profileId: ProfileId,
    ): Promise<AccountSnapshot> => {
      const rest = await deps.resolveBinance(operatorId, accountId);
      if (!rest) {
        throw new Error('cold-load: account snapshot fallback unavailable (no credentials)');
      }
      deps.logger.info(
        { operatorId, accountId, profileId },
        'cold-load: account snapshot via REST fallback',
      );
      const dto = await rest.getAccount();
      const snapshot = accountSnapshotFromDto(dto, (info) =>
        deps.logger.warn(
          { operatorId, accountId, profileId, ...info },
          'cold-load: malformed Binance balance, degraded to 0',
        ),
      );
      // Fail-safe write-through: repopulate the account-info cache the WS
      // otherwise refills, so the next tick reads Redis instead of re-fetching
      // the weight-20 GET /account until the 5s safety cron catches up. Uses
      // the pristine wire `dto.balances` (upstream of buildTickInput's reserve
      // overlay / deployed-quote injection). A failed write must never abort
      // the tick — the next tick simply REST-fetches again.
      try {
        await writeAccountInfo(deps.redis, accountId, profileId, dto.balances);
        await writeAccountPermissions(deps.redis, accountId, dto.permissions);
      } catch (err) {
        deps.logger.warn(
          { operatorId, accountId, profileId, err: err },
          'cold-load: account write-through failed (next tick will REST again)',
        );
      }
      return snapshot;
    },
    loadAccountDeployedQuote: (accountId: AccountId, quoteAsset: string): Promise<string> =>
      // One indexed aggregate over the cost-basis ledger, scoped to this
      // account and quote asset. Read every tick to feed the account-wide
      // exposure cap and percent-of-account sizing; the result is a recent
      // snapshot, not a reservation (the cap is a best-effort backstop, see
      // schema doc). The account already pins one Binance environment, so the
      // sum needs no separate mode filter.
      repo.avgEntryPrices.sumDeployedQuoteForAccount(deps.db, accountId, quoteAsset),
    loadOpenOrders: async (
      operatorId: UserId,
      accountId: AccountId,
      profileId: ProfileId,
      symbol: string,
    ): Promise<readonly OpenOrder[]> => {
      const rest = await deps.resolveBinance(operatorId, accountId);
      if (!rest) {
        throw new Error('cold-load: open-orders fallback unavailable (no credentials)');
      }
      deps.logger.info(
        { operatorId, accountId, profileId, symbol },
        'cold-load: open-orders via REST fallback',
      );
      return openOrdersFromDtos(await rest.getOpenOrders(symbol));
    },
  };
};
