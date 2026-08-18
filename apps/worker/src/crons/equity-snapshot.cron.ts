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
import type { AccountId, ProfileId, UserId } from '@app/contracts';
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

export const equitySnapshotHandler = (deps: EquitySnapshotDeps) => {
  return async (_job: Job): Promise<void> => {
    const { errors } = await fanOutBounded<ActiveProfile, 'recorded' | 'skipped'>(
      deps.listActive(),
      async (profile) => {
        const loaded = await deps.load(profile.operatorId, profile.accountId, profile.profileId);
        if (!loaded) return 'skipped';
        const benchmarkSymbol = `${BENCHMARK_ASSET}${loaded.quoteAsset}`;
        const wanted = [...loaded.positions.map((p) => p.symbol), benchmarkSymbol];
        const prices = await deps.pricesOf(wanted);
        const payload = computeEquitySnapshot({
          quoteAsset: loaded.quoteAsset,
          positions: loaded.positions,
          priceOf: (symbol) => prices.get(symbol) ?? null,
          realizedNetQuote: loaded.realizedNetQuote,
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
