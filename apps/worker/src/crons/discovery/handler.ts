// The discovery cron handler.
//
// For each active profile, skip unless discovery is enabled and the per-profile
// refresh period has elapsed, then run its cycle. Per-wake work shared across
// profiles (the all-symbols ticker fetch, the per-mode exchangeInfo-status map,
// the per-account mode resolution) is memoized here. All I/O is injected via
// `DiscoveryHandlerDeps` so the loop is unit-testable without a real world.

import type { Job } from 'bullmq';
import type { Logger } from 'pino';
import {
  ASSET_POLICY_ABORT_CAUSES,
  unwrapId,
  type AssetPolicyAbortCause,
  type StoredDiscoveryConfig,
} from '@app/contracts';
import type { BinanceMode, Ticker24hrDto } from '@app/binance';
import type { ActiveProfile } from 'profile-manager/profile-manager.js';
import type { MetricsSink } from 'metrics/catalog.js';
import { AssetPolicyAbortError, type AssetPolicy } from './asset-policy.js';
import type { SymbolAdmission } from './symbol-admission.js';

/**
 * A profile's loaded discovery settings: the stored config plus the profile's
 * first-class `quoteAsset` column. The quote is no longer inside the config, so
 * `loadConfig` reads both in one profile fetch and hands them on together.
 */
export interface LoadedDiscovery {
  readonly cfg: StoredDiscoveryConfig;
  readonly quoteAsset: string;
  /** The profile's display name, prefixed onto its discovery notifications so a
   * multi-profile operator can tell which profile rotated a symbol. */
  readonly name: string;
}

/** Default an unresolved account mode to the most-restrictive testnet universe, never live. */
export const withTestModeFallback = (mode: 'test' | 'live' | null): BinanceMode => mode ?? 'test';

/** The per-wake exchange facts one profile's cycle runs against, resolved by the handler and shared across profiles that need the same ones. */
export interface ProfileWakeContext {
  readonly admissionBySymbol: ReadonlyMap<string, SymbolAdmission>;
  readonly liveAdmission: ReadonlyMap<string, SymbolAdmission>;
  readonly assetPolicy: AssetPolicy;
  readonly accountPermissions: readonly string[];
}

/** Injected dependencies for {@link discoveryHandler} — all I/O behind functions. */
export interface DiscoveryHandlerDeps {
  readonly logger: Logger;
  readonly listActive: () => readonly ActiveProfile[];
  readonly loadConfig: (p: ActiveProfile) => Promise<LoadedDiscovery | null>;
  readonly shouldRun: (
    p: ActiveProfile,
    refreshPeriodMs: number,
    nowMs: number,
  ) => Promise<boolean>;
  readonly runForProfile: (
    p: ActiveProfile,
    cfg: StoredDiscoveryConfig,
    quoteAsset: string,
    profileName: string,
    nowMs: number,
    getAllTickers: () => Promise<readonly Ticker24hrDto[]>,
    ctx: ProfileWakeContext,
  ) => Promise<{ added: number; removed: number }>;
  /** All-symbols 24h ticker fetch (exchange-account-wide); shared once per wake. */
  readonly fetchAllTickers: () => Promise<readonly Ticker24hrDto[]>;
  /**
   * Symbol -> exchangeInfo admission facts for a given Binance environment. The
   * admission filter must be scoped to the profile-account mode; the handler
   * memoizes one fetch per distinct mode per wake.
   */
  readonly fetchSymbolAdmission: (
    mode: BinanceMode,
  ) => Promise<ReadonlyMap<string, SymbolAdmission>>;
  /**
   * Permission tags cached for an account. Empty means unknown, which leaves the
   * permission cut disabled for that account this wake.
   */
  readonly fetchAccountPermissions: (p: ActiveProfile) => Promise<readonly string[]>;
  /**
   * Binance's stablecoin/fiat classification, held behind a per-process snapshot so one wake fetches at most once and a fully-gated wake fetches not at all.
   */
  readonly getAssetPolicy: () => Promise<AssetPolicy>;
  /** Resolves a profile's Binance environment, so its admission map is mode-correct. */
  readonly resolveBinanceMode: (p: ActiveProfile) => Promise<BinanceMode>;
  /**
   * Required, not optional. The only thing it counts here is an asset-policy refusal, which is the one failure in this loop an operator has to act on rather than wait out, so a caller that forgets the sink turns a page-worthy abort into a log line nobody reads.
   */
  readonly metrics: MetricsSink;
  /**
   * Park the refusal where the profile's diagnosis can read it. A metric proves an abort happened somewhere; this is what lets the operator's own page name the cause, which is the only surface they look at when their coin list stops moving. Must not throw: this runs inside the per-profile catch, so a rejected diagnostic write would escape it and take the rest of the wake down with it.
   */
  readonly recordAssetPolicyAbort: (
    p: ActiveProfile,
    cause: AssetPolicyAbortCause,
    atMs: number,
  ) => Promise<void>;
  /**
   * Drop the parked refusal once a cycle ranks normally again. Called only on the success path: a cycle that failed for an unrelated reason has proven nothing about the classification, and clearing there would erase a live fault on the strength of a Binance timeout. Must not throw, for the same reason as its sibling: a failed clear would be reported as a failed cycle.
   */
  readonly clearAssetPolicyAbort: (p: ActiveProfile) => Promise<void>;
  readonly clock?: { nowMs(): number };
}

/**
 * The cron handler: for each active profile, skip unless discovery is enabled
 * and the per-profile refresh period has elapsed, then run its cycle. Every
 * profile is wrapped in try/catch so one profile's fetch failure neither churns
 * its symbol set nor aborts the others (fail-safe, no silent total failure —
 * the catch logs at warn).
 */
export const discoveryHandler =
  (deps: DiscoveryHandlerDeps) =>
  async (_job: Job): Promise<void> => {
    const nowMs = (deps.clock ?? { nowMs: () => Date.now() }).nowMs();
    // One all-symbols 24h ticker fetch (weight 80) shared across every profile
    // this wake — the data is exchange-account-wide. Lazily cached on first
    // success: a fully-gated wake fetches nothing, and a transient failure
    // leaves the cache empty so the next profile retries (the loop is
    // sequential, so there is no race on the cache).
    let tickersCache: readonly Ticker24hrDto[] | null = null;
    const getAllTickers = async (): Promise<readonly Ticker24hrDto[]> =>
      (tickersCache ??= await deps.fetchAllTickers());
    // One exchangeInfo-status read per distinct Binance mode this wake. The
    // admission map is mode-scoped (a testnet profile must not be admitted
    // against live-only symbols), so profiles sharing a mode share one fetch.
    // The promise is memoized so each mode is fetched at most once even under
    // the sequential loop. `fetchSymbolAdmission` is best-effort (never throws;
    // empty map on failure), so an unreadable keyspace caches its empty map once rather than re-scanning per profile; the loop below then skips every profile on that mode.
    const admissionByMode = new Map<BinanceMode, Promise<ReadonlyMap<string, SymbolAdmission>>>();
    const getSymbolAdmission = (
      mode: BinanceMode,
    ): Promise<ReadonlyMap<string, SymbolAdmission>> => {
      let cached = admissionByMode.get(mode);
      if (cached === undefined) {
        cached = deps.fetchSymbolAdmission(mode);
        admissionByMode.set(mode, cached);
      }
      return cached;
    };
    // One mode resolution per account this wake — every profile on an account
    // shares its key pair and environment.
    const modeByAccount = new Map<string, BinanceMode>();
    // Same reasoning for the permission tags: they belong to the account's key
    // pair, so every profile on the account reads one cached value per wake.
    const permissionsByAccount = new Map<string, Promise<readonly string[]>>();
    for (const p of deps.listActive()) {
      try {
        const loaded = await deps.loadConfig(p);
        if (!loaded || !loaded.cfg.enabled) continue;
        const { cfg, quoteAsset, name } = loaded;
        if (!(await deps.shouldRun(p, cfg.refreshPeriodMs, nowMs))) continue;
        // Zero-seed every cause for a profile that is actually running a cycle, ahead of anything that can refuse. A prom-client child does not exist until its first write and is born holding that value, so an unseeded counter's first abort reads as a series that has always been 1, and `increase()` sees no rise. At the default 15-minute refresh a second abort would eventually make it visible; at the maximum legal period it would take a day, and the alert exists precisely to catch the case where discovery has silently stopped rotating.
        for (const cause of ASSET_POLICY_ABORT_CAUSES) {
          deps.metrics.record('discovery_asset_policy_abort_total', 0, {
            profileId: unwrapId(p.profileId),
            cause,
          });
        }
        const accountKey = String(unwrapId(p.accountId));
        let mode = modeByAccount.get(accountKey);
        if (mode === undefined) {
          mode = await deps.resolveBinanceMode(p);
          modeByAccount.set(accountKey, mode);
        }
        // One rule, not two. A profile whose exchangeInfo keyspace is unprimed has no status filter, no base/quote split, and no way to classify an asset, so its universe would be the raw ticker feed. That was already fail-closed for test mode (whose candidate universe is the LIVE feed, so an unfiltered run binds symbols testnet does not list and DLQs every tick); it is no less wrong for a live profile, and two spellings of one rule is how the live half stayed open.
        const admissionBySymbol = await getSymbolAdmission(mode);
        if (admissionBySymbol.size === 0) {
          deps.metrics.record('discovery_asset_policy_abort_total', 1, {
            profileId: unwrapId(p.profileId),
            cause: 'empty-admission-map',
          });
          await deps.recordAssetPolicyAbort(p, 'empty-admission-map', nowMs);
          deps.logger.warn(
            { profileId: unwrapId(p.profileId), mode },
            'cron discovery: exchangeInfo not primed; skipping profile this wake (fail closed)',
          );
          continue;
        }
        // The classification is cross-checked against LIVE exchangeInfo whatever the profile's own mode, so a test-mode wake still needs the live map.
        const liveAdmission =
          mode === 'live' ? admissionBySymbol : await getSymbolAdmission('live');
        let cachedPermissions = permissionsByAccount.get(accountKey);
        if (cachedPermissions === undefined) {
          cachedPermissions = deps.fetchAccountPermissions(p);
          permissionsByAccount.set(accountKey, cachedPermissions);
        }
        const r = await deps.runForProfile(p, cfg, quoteAsset, name, nowMs, getAllTickers, {
          admissionBySymbol,
          liveAdmission,
          // Lazy by construction: nothing above this line touches the network for the classification, so a wake where every profile is gated never fetches it.
          assetPolicy: await deps.getAssetPolicy(),
          accountPermissions: await cachedPermissions,
        });
        await deps.clearAssetPolicyAbort(p);
        if (r.added > 0 || r.removed > 0) {
          deps.logger.info(
            { profileId: unwrapId(p.profileId), added: r.added, removed: r.removed },
            'cron discovery: rotated auto-set',
          );
        }
      } catch (err) {
        // Separated from the generic failure by TYPE, not by message: this catch also receives Binance timeouts and Redis blips from every other stage of the cycle, and those say nothing about the classification. A typed abort does: the cycle could not establish which assets are pegs, so the veto is not protecting admission, and the cause says whether that is a dead route to chase at Binance, a cold local cache, or a feed that never answered. Only the typed ones raise the counter and park a finding the operator can read.
        if (err instanceof AssetPolicyAbortError) {
          deps.metrics.record('discovery_asset_policy_abort_total', 1, {
            profileId: unwrapId(p.profileId),
            cause: err.cause,
          });
          await deps.recordAssetPolicyAbort(p, err.cause, nowMs);
          deps.logger.warn(
            { profileId: unwrapId(p.profileId), cause: err.cause, err },
            'cron discovery: asset policy refused; profile cycle abandoned and symbol set left untouched',
          );
          continue;
        }
        deps.logger.warn(
          { profileId: unwrapId(p.profileId), err: err },
          'cron discovery: profile cycle failed; symbol set left untouched',
        );
      }
    }
  };
