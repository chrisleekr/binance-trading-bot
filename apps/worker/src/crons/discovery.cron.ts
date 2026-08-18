// discovery-run cron.
//
// Wires the pure discovery chain (@app/discovery) to the world: fetch the
// all-symbols 24h ticker once per tick, run the generator + filter chain per
// enabled profile, and apply the resulting add/remove diff to the live symbol
// set via the existing reconfigure-profile resync path. Default-off (a profile
// with no `discovery_config` or `enabled:false` is skipped) and fail-safe — any
// fetch/parse error for a profile is caught and the profile's symbol set is left
// untouched (no churn on bad data).
//
// The orchestration and pure helpers live in the `discovery/` leaf modules; this
// file is the cron wiring only — it builds the per-profile I/O port from
// BootContext and hands the leaves their dependencies.
//
// Discovery's per-(profile, symbol) ephemeral state (added-at, last-flatten)
// lives in Redis, not the DB: a discovery reap DELETEs the profile_symbols row,
// which would destroy a DB `last_flatten_at`, so the re-add cooldown reads a
// Redis hash that survives the delete. The DB `last_flatten_at` column covers
// the row-preserving manual-eject path; the cooldown takes the max of both.

import { unwrapId, type StoredDiscoveryConfig } from '@app/contracts';
import { Decimal } from '@app/money';
import {
  createBinanceRest,
  type BinanceMode,
  type ParsedKline,
  type Ticker24hrDto,
} from '@app/binance';
import { GLOBAL_KEYS, profileRepo, repo as dbRepo, scopeAccount } from '@app/db';
import type { Candle } from '@app/strategy-core';
import type { BootContext } from 'boot/boot-context.js';
import { resolveNotifiersFromRows } from 'notifiers/lookup.js';
import { isProfileEventEnabled } from 'notifiers/notify-event.js';
import { readAccountPermissions, writeAccountPermissions } from 'lib/account-permissions.js';
import { QUEUE_NAMES } from 'queues/queue-names.js';
import { createReconfigureEnqueue } from 'queues/reconfigure-enqueue.js';
import type { ActiveProfile } from 'profile-manager/profile-manager.js';
import { defineCron, type CronDef } from './define.js';
import type { DiscoveryStorageKeys } from './discovery-reap.js';
import { computeSiblingConflict, siblingQuoteAssets } from './sibling-conflict.js';
import { discoveryResyncRequest, parseDiscoveryConfig } from './discovery/config.js';
import { baseAssetHeld } from './discovery/held.js';
import { shouldRunProfile } from './discovery/gate.js';
import { persistSnapshotBestEffort } from './discovery/snapshot.js';
import { applyDiscoveryAdd, applyDiscoveryReap } from './discovery/apply.js';
import { discoveryMessage, notifyDiscovery, type ResolvedNotifiers } from './discovery/notify.js';
import { runDiscoveryForProfile, type DiscoveryProfilePort } from './discovery/run.js';
import {
  fetchSymbolAdmission as readSymbolAdmission,
  type SymbolAdmission,
} from './discovery/symbol-admission.js';
import {
  discoveryHandler,
  withTestModeFallback,
  type LoadedDiscovery,
  type ProfileWakeContext,
} from './discovery/handler.js';

// Re-exported so `discovery-health.cron` and the cron registry keep importing
// `parseDiscoveryConfig` from `discovery.cron` unchanged; the definition now
// lives in the `discovery/config` leaf.
export { parseDiscoveryConfig };

// Self-reschedule cadence. The cron wakes this often; each profile's own
// `refreshPeriodMs` (default 15 min) gates whether it actually runs that tick,
// via a Redis last-run key. A small base period keeps per-profile cadences
// honest without one global clock.
const BASE_PERIOD_MS = 60_000;

const klineToCandle = (k: ParsedKline): Candle => ({ ...k, isClosed: true });

const numericHash = (h: Record<string, string>): Record<string, number> => {
  const out: Record<string, number> = {};
  for (const [k, v] of Object.entries(h)) {
    const n = Number(v);
    if (Number.isFinite(n)) out[k] = n;
  }
  return out;
};

const mergeMaxMs = (
  a: Record<string, number>,
  b: Record<string, number>,
): Record<string, number> => {
  const out: Record<string, number> = { ...a };
  for (const [k, v] of Object.entries(b)) out[k] = Math.max(out[k] ?? 0, v);
  return out;
};

export const buildDiscoveryCron = (ctx: BootContext): CronDef => {
  // Unsigned public client: getAllTickers24hr + getKlines need no credentials.
  const rest = createBinanceRest({
    mode: 'live',
    credentials: { apiKey: '', secretKey: '' },
    weightGovernor: ctx.weightGovernor,
  });

  // exchangeInfo facts for every listed symbol, read from the symbol-info
  // keyspace the exchange-info-refresh cron writes for that mode. The admission
  // map must match the profile-account environment: a testnet profile admitted
  // against the live universe binds symbols that do not exist on testnet, and
  // every one of its ticks then DLQs. SCAN+MGET so a single Redis round of
  // batches covers the whole universe. An unreadable or unprimed keyspace yields an empty map, which the handler treats as a reason to skip the profile.
  const fetchSymbolAdmission = (mode: BinanceMode): Promise<ReadonlyMap<string, SymbolAdmission>> =>
    readSymbolAdmission(ctx.redis, ctx.logger, mode, 'cron discovery');

  const loadConfig = async (p: ActiveProfile): Promise<LoadedDiscovery | null> => {
    const repo = await profileRepo(ctx.db, p.operatorId, p.accountId, p.profileId);
    const profile = await repo.profile.findById();
    if (!profile) return null;
    const parsed = parseDiscoveryConfig((profile as { discoveryConfig?: unknown }).discoveryConfig);
    // A stored config that fails its own schema stops discovery outright, and
    // this is the only place that sees it. Record it before skipping, so the
    // profile reads as broken rather than as quiet.
    // Swallowed on purpose: this is a note about discovery, not part of it, and
    // a diagnostic write that aborts the scan inverts the whole point. Every
    // wake re-records unconditionally, so a failure self-heals next run rather
    // than leaving the state stuck behind an in-memory gate.
    try {
      await repo.conditionStates.recordCondition({
        condition: 'config-invalid',
        code: parsed.ok ? null : 'schema',
        ...(parsed.ok ? {} : { detail: { issues: parsed.issues } }),
        now: new Date(),
        msg: parsed.ok
          ? 'Discovery settings parse again.'
          : `Discovery settings do not match their schema, so discovery cannot run: ${parsed.issues.join('; ')}`,
      });
    } catch (err) {
      ctx.logger.warn(
        { err, profileId: p.profileId },
        'cron discovery: config-invalid condition write failed; scan continues',
      );
    }
    if (!parsed.ok) return null;
    const cfg = parsed.cfg;
    // The quote asset is now the profile's own column, the single source of
    // truth, re-read each tick so an operator change takes effect without a
    // restart. Uppercase at the read boundary so the suffix match is robust to
    // any writer that did not normalise (the API PATCH does; a seed / future
    // create path might not).
    return { cfg, quoteAsset: profile.quoteAsset.toUpperCase(), name: profile.name };
  };

  const shouldRun = (p: ActiveProfile, refreshPeriodMs: number, nowMs: number): Promise<boolean> =>
    shouldRunProfile(ctx.redis, unwrapId(p.profileId), refreshPeriodMs, nowMs, ctx.logger);

  const runForProfile = async (
    p: ActiveProfile,
    cfg: StoredDiscoveryConfig,
    quoteAsset: string,
    profileName: string,
    nowMs: number,
    getAllTickers: () => Promise<readonly Ticker24hrDto[]>,
    wake: ProfileWakeContext,
  ): Promise<{ added: number; removed: number }> => {
    const repo = await profileRepo(ctx.db, p.operatorId, p.accountId, p.profileId);
    const pid = unwrapId(p.profileId);
    const addedKey = GLOBAL_KEYS.discoveryAdded(pid);
    const flatKey = GLOBAL_KEYS.discoveryFlat(pid);
    const explainKey = GLOBAL_KEYS.discoveryExplain(pid);
    const storageKeys: DiscoveryStorageKeys = {
      addedKey,
      flatKey,
      enterOnAddKey: GLOBAL_KEYS.discoveryEnterOnAdd(pid),
    };

    // One profile_symbols read per cycle, reused for the auto list, manual
    // list, and DB last-flatten map (was three identical reads).
    let symbolRows: Awaited<ReturnType<typeof repo.profileSymbols.listForProfile>> | null = null;
    const listSymbolRows = async (): Promise<
      Awaited<ReturnType<typeof repo.profileSymbols.listForProfile>>
    > => (symbolRows ??= await repo.profileSymbols.listForProfile());

    // Resolve the profile's enabled notifiers lazily on the first add/remove
    // notification — most cycles rotate nothing, so this stays a zero-read path.
    let resolvedNotifiers: ResolvedNotifiers | null = null;
    const getResolvedNotifiers = async (): Promise<ResolvedNotifiers> =>
      (resolvedNotifiers ??= resolveNotifiersFromRows(
        await repo.profileNotifiers.listForProfile(),
      ));

    // Lazy, once-per-cycle signed wallet read for the reap held-guard. Only a
    // cycle with reap candidates ever fetches; the result is memoised so N
    // candidates share one `getAccount`. `undefined` = not yet fetched, `null`
    // = fetch failed (caller treats every symbol as held, refusing to reap).
    let walletByAsset: Record<string, Decimal> | null | undefined;
    const loadWallet = async (): Promise<Record<string, Decimal> | null> => {
      if (walletByAsset !== undefined) return walletByAsset;
      const client = await ctx.resolveBinanceClient(p.operatorId, p.accountId);
      if (!client) {
        ctx.logger.warn(
          { profileId: pid },
          'cron discovery: no credentials for held-guard; reaps deferred this cycle',
        );
        return (walletByAsset = null);
      }
      try {
        const account = await client.getAccount();
        const map: Record<string, Decimal> = {};
        for (const b of account.balances) map[b.asset] = new Decimal(b.free).plus(b.locked);
        walletByAsset = map;
        // Opportunistic refresh: this cycle already paid for the signed call, so
        // top up the permission cache the order pre-flight reads. Isolated from
        // the reap verdict above, which must not hinge on a cache write.
        try {
          await writeAccountPermissions(ctx.redis, p.accountId, account.permissions);
        } catch (err) {
          ctx.logger.warn(
            { profileId: pid, err: err },
            'cron discovery: account-permissions cache write failed',
          );
        }
        return walletByAsset;
      } catch (err) {
        ctx.logger.warn(
          { profileId: pid, err: err },
          'cron discovery: getAccount failed for held-guard; reaps deferred this cycle',
        );
        return (walletByAsset = null);
      }
    };

    // Sibling quote assets share this account's wallet. Resolved once per profile
    // per wake (lazily, only when a candidate is actually checked) and cached.
    // Account-scoped: `listForAccount` returns only this account's profiles, so a
    // profile in another binance_mode — necessarily a different account — never
    // appears, and self is dropped by `siblingQuoteAssets`.
    let siblingQuotesCache: readonly string[] | null = null;
    const getSiblingQuotes = async (): Promise<readonly string[]> => {
      if (siblingQuotesCache !== null) return siblingQuotesCache;
      const acctScope = await scopeAccount(ctx.db, p.operatorId, p.accountId);
      const profileRows = await dbRepo.profiles.listForAccount(acctScope);
      return (siblingQuotesCache = siblingQuoteAssets(profileRows, unwrapId(p.profileId)));
    };

    const port: DiscoveryProfilePort = {
      logger: ctx.logger,
      getAllTickers,
      getKlines: async (symbol, limit) =>
        (await rest.getKlines({ symbol, interval: '1h', limit })).map(klineToCandle),
      listAutoSymbols: async () =>
        (await listSymbolRows()).filter((r) => r.source === 'auto').map((r) => r.symbol),
      listManualSymbols: async () =>
        (await listSymbolRows()).filter((r) => r.source === 'manual').map((r) => r.symbol),
      addedAtBySymbol: async () => numericHash(await ctx.redis.hgetall(addedKey)),
      lastFlattenBySymbol: async () => {
        const redisFlat = numericHash(await ctx.redis.hgetall(flatKey));
        const dbFlat: Record<string, number> = {};
        for (const r of await listSymbolRows()) {
          if (r.lastFlattenAt) dbFlat[r.symbol] = r.lastFlattenAt.getTime();
        }
        return mergeMaxMs(redisFlat, dbFlat);
      },
      addSymbol: async (symbol, at) => {
        const { baseAsset } = await ctx.getSymbolInfo(symbol);
        return applyDiscoveryAdd(
          repo.profileSymbols,
          ctx.redis,
          storageKeys,
          symbol,
          baseAsset,
          at,
        );
      },
      siblingConflict: async (symbol) => {
        const { baseAsset } = await ctx.getSymbolInfo(symbol);
        const owner = await dbRepo.profileSymbols.findOwningSiblingByBase(
          ctx.db,
          p.accountId,
          baseAsset,
          p.profileId,
        );
        return computeSiblingConflict(baseAsset, owner !== null, await getSiblingQuotes());
      },
      refreshEntryHint: async (symbol, value) => {
        await ctx.redis.hset(storageKeys.enterOnAddKey, symbol, value);
      },
      heldOnExchange: async (symbol) => {
        const wallet = await loadWallet();
        if (wallet === null) return null;
        let info;
        try {
          info = await ctx.getSymbolInfo(symbol);
        } catch (err) {
          // Can't resolve the lot floor — fail safe (treat as held, don't reap).
          ctx.logger.warn(
            { profileId: pid, symbol, err: err },
            'cron discovery: symbolInfo unavailable for held-guard; not reaping',
          );
          return null;
        }
        try {
          return baseAssetHeld(wallet, info.baseAsset, info.filters.minQty);
        } catch (err) {
          // Unparseable minQty/balance — fail safe (treat as held, don't reap).
          ctx.logger.warn(
            { profileId: pid, symbol, err: err },
            'cron discovery: unparseable minQty for held-guard; not reaping',
          );
          return null;
        }
      },
      reapSymbol: (symbol, at) =>
        applyDiscoveryReap(repo.profileSymbols, ctx.redis, storageKeys, symbol, at),
      emit: async (symbol, action) => {
        await repo.actionLogs.append({
          time: new Date(nowMs),
          symbol,
          level: 'info',
          msg: `Discovery ${action === 'add' ? 'added' : 'removed'} ${symbol}`,
          ctx: { source: 'auto', action },
        });
      },
      emitReadd: async (symbol, prevAddedAt) => {
        await repo.actionLogs.append({
          time: new Date(nowMs),
          symbol,
          level: 'warn',
          msg: `Discovery re-added ${symbol}`,
          ctx: { source: 'auto', action: 'readded', prevAddedAt },
        });
      },
      emitMembershipLost: async (symbol, prevAddedAt) => {
        await repo.actionLogs.append({
          time: new Date(nowMs),
          symbol,
          level: 'warn',
          msg: `Discovery membership lost ${symbol}`,
          ctx: { source: 'auto', action: 'membership-lost', prevAddedAt },
        });
      },
      cleanupOrphanedAdded: async (symbol) => {
        await ctx.redis.hdel(addedKey, symbol);
        await ctx.redis.hdel(storageKeys.enterOnAddKey, symbol);
      },
      // Prefix the profile name so a multi-profile operator can tell which
      // profile rotated the symbol; the bare line carried no profile context.
      // Gated on the profile's `discovery` notify_events subscription (default
      // on) so an operator can mute rotation chatter without dropping notifiers.
      notify: async (action, symbol) => {
        if (
          !(await isProfileEventEnabled(
            ctx.db,
            p.operatorId,
            p.accountId,
            p.profileId,
            'discovery',
          ))
        )
          return;
        await notifyDiscovery(
          ctx.notifyProviders,
          await getResolvedNotifiers(),
          discoveryMessage(action, symbol, profileName),
          ctx.logger,
          ctx.liveDemo,
        );
      },
      persistExplain: async (candidates, at) => {
        await ctx.redis.set(explainKey, JSON.stringify({ computedAtMs: at, candidates }));
      },
      persistSnapshot: (snapshot) =>
        persistSnapshotBestEffort(
          (s) => repo.discoveryUniverseSnapshots.record(s),
          ctx.logger,
          pid,
          snapshot,
        ),
      enqueueResync: () =>
        createReconfigureEnqueue(ctx.queueSet.queues[QUEUE_NAMES.pipeline])(
          discoveryResyncRequest(p),
        ),
    };
    return runDiscoveryForProfile(port, cfg, quoteAsset, nowMs, wake);
  };

  return defineCron({
    name: 'discovery-run',
    queue: QUEUE_NAMES.discoveryRun,
    selfReschedulePeriodMs: BASE_PERIOD_MS,
    handler: discoveryHandler({
      logger: ctx.logger,
      listActive: ctx.listActive,
      loadConfig,
      shouldRun,
      runForProfile,
      fetchAllTickers: () => rest.getAllTickers24hr(),
      fetchSymbolAdmission,
      // The process-wide snapshot, not a cron-local one: the diagnosis re-probe reads the same accessor, and two snapshots could classify one asset two ways at the same instant.
      getAssetPolicy: ctx.getAssetPolicy,
      fetchAccountPermissions: (p) =>
        readAccountPermissions(ctx.redis, ctx.logger, p.accountId, 'cron discovery'),
      resolveBinanceMode: async (p) =>
        withTestModeFallback(await dbRepo.accounts.binanceModeById(ctx.db, p.accountId)),
    }),
  });
};
