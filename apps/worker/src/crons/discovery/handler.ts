// The discovery cron handler.
//
// For each active profile, skip unless discovery is enabled and the per-profile
// refresh period has elapsed, then run its cycle. Per-wake work shared across
// profiles (the all-symbols ticker fetch, the per-mode exchangeInfo-status map,
// the per-account mode resolution) is memoized here. All I/O is injected via
// `DiscoveryHandlerDeps` so the loop is unit-testable without a real world.

import type { Job } from 'bullmq';
import type { Logger } from 'pino';
import { unwrapId, type StoredDiscoveryConfig } from '@app/contracts';
import type { BinanceMode, Ticker24hrDto } from '@app/binance';
import type { ActiveProfile } from 'profile-manager/profile-manager.js';
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
    getSymbolAdmission: () => Promise<ReadonlyMap<string, SymbolAdmission>>,
    getAccountPermissions: () => Promise<readonly string[]>,
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
  /** Resolves a profile's Binance environment, so its admission map is mode-correct. */
  readonly resolveBinanceMode: (p: ActiveProfile) => Promise<BinanceMode>;
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
    // empty map on failure), so an empty result caches and the wake fails open
    // on the status filter for that mode rather than re-scanning per profile.
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
        const accountKey = String(unwrapId(p.accountId));
        let mode = modeByAccount.get(accountKey);
        if (mode === undefined) {
          mode = await deps.resolveBinanceMode(p);
          modeByAccount.set(accountKey, mode);
        }
        // A test-mode profile's candidate universe is the live ticker feed, so
        // the mode-scoped status map is the only gate removing live-only symbols.
        // An empty map (testnet exchangeInfo unprimed) would fail open to the full
        // live universe and re-admit symbols absent on testnet, DLQ-ing every tick.
        // Fail closed: skip the profile this wake. Live profiles keep the #635
        // fail-open — their candidate universe is the same environment.
        if (mode === 'test' && (await getSymbolAdmission(mode)).size === 0) {
          deps.logger.warn(
            { profileId: unwrapId(p.profileId) },
            'cron discovery: testnet exchangeInfo not primed; skipping test-mode profile this wake (fail closed)',
          );
          continue;
        }
        const r = await deps.runForProfile(
          p,
          cfg,
          quoteAsset,
          name,
          nowMs,
          getAllTickers,
          () => getSymbolAdmission(mode),
          () => {
            let cached = permissionsByAccount.get(accountKey);
            if (cached === undefined) {
              cached = deps.fetchAccountPermissions(p);
              permissionsByAccount.set(accountKey, cached);
            }
            return cached;
          },
        );
        if (r.added > 0 || r.removed > 0) {
          deps.logger.info(
            { profileId: unwrapId(p.profileId), added: r.added, removed: r.removed },
            'cron discovery: rotated auto-set',
          );
        }
      } catch (err) {
        deps.logger.warn(
          { profileId: unwrapId(p.profileId), err: err },
          'cron discovery: profile cycle failed; symbol set left untouched',
        );
      }
    }
  };
