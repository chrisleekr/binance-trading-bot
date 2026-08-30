// equity-snapshot cron.
//
// Every 15 min, records one net-P/L point per active profile: cumulative
// realised net-of-fee profit (trade archive) + unrealised mark-to-market of open
// positions, plus a BTC benchmark price, so the dashboard can show a live
// "profit vs holding BTC" curve instead of a single number.
//
// Cross-symbol by nature (a profile-wide P/L sum), so it lives worker-side, not
// in the pure per-(profile,symbol) strategy.

import type { Job } from 'bullmq';
import type { Logger } from 'pino';
import type { EquitySnapshotPayload } from '@app/db';
import { profileRepo, GLOBAL_KEYS } from '@app/db';
import { fanOutBounded } from '@app/core/fan-out';
import type { AccountId, FeeBasis, ProfileId, UserId } from '@app/contracts';
import type { BootContext } from 'boot/boot-context.js';
import { defineCron, type CronDef } from './define.js';
import { QUEUE_NAMES } from 'queues/queue-names.js';
import type { ActiveProfile } from 'profile-manager/profile-manager.js';
import { computeEquitySnapshot, type SnapshotPosition } from './equity-snapshot.js';

const EQUITY_SNAPSHOT_CONCURRENCY = 4;
const BENCHMARK_ASSET = 'BTC';
const EPOCH = new Date(0);

export interface EquitySnapshotDeps {
  readonly logger: Logger;
  readonly listActive: () => readonly ActiveProfile[];
  /**
   * Gather everything one snapshot needs for a profile, or null when the
   * profile is gone. The quote cash is intentionally NOT read: per-profile cash
   * is undefined in this single-account model, so the curve is net P/L, not NAV.
   */
  readonly load: (
    operatorId: UserId,
    accountId: AccountId,
    profileId: ProfileId,
  ) => Promise<{
    readonly quoteAsset: string;
    readonly positions: readonly SnapshotPosition[];
    readonly realizedNetQuote: string;
    readonly feeBasis: FeeBasis;
  } | null>;
  /** Current price in quote terms for each given symbol, null when uncached. */
  readonly pricesOf: (symbols: readonly string[]) => Promise<ReadonlyMap<string, string>>;
  readonly record: (
    operatorId: UserId,
    accountId: AccountId,
    profileId: ProfileId,
    payload: EquitySnapshotPayload,
  ) => Promise<void>;
}

/**
 * Build the snapshot handler that records a comparison point, stamped with how well the realised input's fees were known.
 *
 * @param deps - Active-profile, archive, ticker, persistence, and logging dependencies.
 * @returns A bounded BullMQ handler that records one point per active profile at whatever tier its realised input supports, skipping only a profile that has gone away.
 */
export const equitySnapshotHandler = (deps: EquitySnapshotDeps) => {
  return async (_job: Job): Promise<void> => {
    const { errors } = await fanOutBounded<ActiveProfile, 'recorded' | 'skipped'>(
      deps.listActive(),
      async (profile) => {
        const loaded = await deps.load(profile.operatorId, profile.accountId, profile.profileId);
        if (!loaded) return 'skipped';
        // No tier gates the write, `unknown` included. The realised leg is `sumProfitInRange(quote, EPOCH, now)`, an all-time fold whose tier is the weakest cycle the profile ever closed, so one historical fill Binance billed in an asset nobody valued pins it at `unknown` and nothing on this forward path lifts it — closing further cycles can only weaken it. A skip on that tier is therefore not "wait for better evidence", it is a profile that never records another point. The tier is stamped onto the row instead and the curve is marked where it is drawn, which is the same argument the estimated case already rested on: refusing to record destroys the evidence rather than declining to plot it.
        // The stamp is sticky, which is this choice's real cost. `reconcile-fees` CAN lift an archive row out of `unknown`, but it rewrites the archive alone: nothing re-stamps a snapshot already recorded from it, so every point captured before a reconciliation pass keeps its old tier until retention drops it, and the card goes on warning across that window. It over-warns rather than over-certifies, so it is left alone deliberately — clearing it means recomputing the fold per point, at that point's own capture time, which is a repair job and not this handler's business.
        // Canonical before the symbol is built. Ticker keys carry Binance's upper casing while `profiles.quote_asset` may be stored lower or mixed case, so a raw concat yields `BTCusdt`, misses the cache, and flatlines the "vs holding" comparator at zero while every other leg of the same row is computed correctly.
        const quoteAsset = loaded.quoteAsset.toUpperCase();
        const benchmarkSymbol = `${BENCHMARK_ASSET}${quoteAsset}`;
        const wanted = [...loaded.positions.map((p) => p.symbol), benchmarkSymbol];
        const prices = await deps.pricesOf(wanted);
        const payload = computeEquitySnapshot({
          quoteAsset,
          positions: loaded.positions,
          priceOf: (symbol) => prices.get(symbol) ?? null,
          realizedNetQuote: loaded.realizedNetQuote,
          feeBasis: loaded.feeBasis,
          benchmarkAsset: BENCHMARK_ASSET,
          benchmarkPriceQuote: prices.get(benchmarkSymbol) ?? null,
        });
        await deps.record(profile.operatorId, profile.accountId, profile.profileId, payload);
        return 'recorded';
      },
      { concurrency: EQUITY_SNAPSHOT_CONCURRENCY, onError: 'collect' },
    );
    for (const { item, error } of errors) {
      deps.logger.warn(
        { profileId: item.profileId, err: error },
        'equity-snapshot: capture failed (will retry next tick)',
      );
    }
  };
};

/** Parse a `{ price }` ticker blob from Redis; null on absent/corrupt. */
const tickerPrice = (raw: string | null): string | null => {
  if (raw === null) return null;
  try {
    const v = (JSON.parse(raw) as { price?: unknown }).price;
    return typeof v === 'string' ? v : null;
  } catch {
    return null;
  }
};

export const buildEquitySnapshotCron = (ctx: BootContext): CronDef =>
  defineCron({
    name: 'equity-snapshot',
    queue: QUEUE_NAMES.equitySnapshot,
    pattern: '0 */15 * * * *',
    handler: equitySnapshotHandler({
      logger: ctx.logger,
      listActive: ctx.listActive,
      load: async (operatorId, accountId, profileId) => {
        const repo = await profileRepo(ctx.db, operatorId, accountId, profileId);
        const row = await repo.profile.findById();
        if (!row) return null;
        const [positions, realized] = await Promise.all([
          repo.avgEntryPrices.listForProfile(),
          // The realised leg MUST be counted in the same quote the positions are marked in: the snapshot adds the two, and an unfiltered sum let a profile's pre-quote-change USDT history land in a BTC-denominated row.
          repo.tradeArchive.sumProfitInRange(row.quoteAsset, EPOCH, new Date()),
        ]);
        return {
          quoteAsset: row.quoteAsset,
          positions: positions.map((p) => ({
            symbol: p.symbol,
            avgEntryPrice: p.avgEntryPrice,
            quantity: p.quantity,
          })),
          realizedNetQuote: realized.netProfit,
          feeBasis: realized.feeBasis,
        };
      },
      pricesOf: async (symbols) => {
        const out = new Map<string, string>();
        if (symbols.length === 0) return out;
        const raws = await ctx.redis.mget(...symbols.map((s) => GLOBAL_KEYS.ticker(s)));
        symbols.forEach((symbol, i) => {
          const price = tickerPrice(raws[i] ?? null);
          if (price !== null) out.set(symbol, price);
        });
        return out;
      },
      record: async (operatorId, accountId, profileId, payload) => {
        const repo = await profileRepo(ctx.db, operatorId, accountId, profileId);
        await repo.equitySnapshots.record(payload);
      },
    }),
  });
