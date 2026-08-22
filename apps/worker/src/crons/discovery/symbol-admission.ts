// Per-symbol admission facts, read from the symbol-info keyspace the
// exchange-info-refresh cron writes for one mode: the exchangeInfo `status`,
// the authoritative base/quote split, and the permission sets that decide whether this account may trade it at all.
//
// Shared by the discovery cron and the diagnosis re-probe. The map decides which
// symbols `toDiscoveryTickers` keeps, so a probe reading it differently would
// report a universe the cron never saw — and the whole point of re-deriving the
// funnel live is that the two agree.
//
// Mode-scoped on purpose: a testnet profile admitted against the live universe
// binds symbols that do not exist on testnet, and every one of its ticks DLQs.

import type { Redis } from 'ioredis';
import type { Logger } from 'pino';
import type { BinanceMode } from '@app/binance';
import { projectPermissionSets } from '@app/contracts';
import { buildSymbolInfoKey } from 'executor/redis-namespace.js';

const SCAN_COUNT = 500;

/** What one cached symbol-info entry contributes to the admission decision. */
export interface SymbolAdmission {
  readonly status: string;
  /** exchangeInfo's own base asset. Required, because it is the only correct split: `AAABBB` cannot be cut into base and quote by string length once one listed quote is a proper suffix of another. */
  readonly baseAsset: string;
  /** exchangeInfo's own quote asset, the counterpart of {@link SymbolAdmission.baseAsset} and the value the quote-match filter compares against. */
  readonly quoteAsset: string;
  /**
   * Absent when the cached entry predates permission-set capture or carries a
   * malformed value. Readers treat absent as "no constraint published", which
   * keeps the symbol.
   */
  readonly permissionSets?: readonly (readonly string[])[];
}

/**
 * Read the whole mode-scoped admission map.
 *
 * Best-effort at THIS layer only: a Redis error or an unprimed keyspace returns an empty map rather than throwing, so the caller sees one uniform "nothing published" answer instead of two failure shapes. The caller does not fail open on it — an empty map aborts the cycle, because an unfiltered universe admits delisted symbols, symbols the account cannot trade, and (since the base/quote split lives here) symbols whose base was never classified.
 *
 * @param redis - Redis client, used only for the SCAN + MGET over the symbol-info keyspace.
 * @param logger - Where an unreadable or unprimed keyspace is reported; the cuts are otherwise silent.
 * @param mode - The Binance environment whose keyspace to read; a testnet profile admitted against the live universe binds symbols that do not exist on testnet.
 * @param logPrefix - Tag naming this READ in those warns rather than the consumer behind it: the memoizing resolver passes one construction-time value on behalf of every caller, because a shared sweep has no single caller to attribute.
 * @returns Symbol to admission facts; empty when the keyspace could not be read or has not been primed.
 */
export const fetchSymbolAdmission = async (
  redis: Pick<Redis, 'scan' | 'mget'>,
  logger: Logger,
  mode: BinanceMode,
  logPrefix: string,
): Promise<ReadonlyMap<string, SymbolAdmission>> => {
  const admission = new Map<string, SymbolAdmission>();
  try {
    let cursor = '0';
    do {
      const [next, batch] = await redis.scan(
        cursor,
        'MATCH',
        buildSymbolInfoKey('*', mode),
        'COUNT',
        SCAN_COUNT,
      );
      cursor = next;
      if (batch.length > 0) {
        const values = await redis.mget(...batch);
        for (const v of values) {
          if (v === null) continue;
          try {
            const info = JSON.parse(v) as {
              symbol?: string;
              status?: string;
              baseAsset?: string;
              quoteAsset?: string;
              permissionSets?: unknown;
            };
            // An entry missing the base/quote split is skipped rather than defaulted. Every refresh since the keyspace existed writes both, so this only fires on a corrupt value, and inventing a split there would silently mis-classify the asset it names. Typed rather than merely truthy, because `JSON.parse(...) as {...}` is an assertion and nothing has checked it: a cached object or array in `baseAsset` is truthy, survives to the ticker, and then misses `stablecoinOrFiatBases.has(...)` — which fails OPEN, admitting the one class of asset this whole path exists to refuse.
            if (
              typeof info.symbol !== 'string' ||
              typeof info.status !== 'string' ||
              typeof info.baseAsset !== 'string' ||
              typeof info.quoteAsset !== 'string'
            ) {
              continue;
            }
            if (!info.symbol || !info.status || !info.baseAsset || !info.quoteAsset) continue;
            const permissionSets = projectPermissionSets(info.permissionSets);
            admission.set(info.symbol, {
              status: info.status,
              baseAsset: info.baseAsset,
              quoteAsset: info.quoteAsset,
              ...(permissionSets === null ? {} : { permissionSets }),
            });
          } catch {
            // Skip one unparseable value; a single bad key must not blind the read.
          }
        }
      }
    } while (cursor !== '0');
  } catch (err) {
    logger.warn(
      { err: err, mode },
      `${logPrefix}: symbol-admission fetch failed; the caller decides whether it can proceed`,
    );
    return new Map();
  }
  if (admission.size === 0) {
    logger.warn({ mode }, `${logPrefix}: symbol-admission map empty (exchangeInfo not primed?)`);
  }
  return admission;
};

/**
 * How long one mode's admission snapshot is served before the keyspace is swept again.
 *
 * Above the 60s discovery wake, which is the weaker half of the claim: each profile also runs on its own refresh period, 15 minutes by default, and a wake where no profile is due never asks for the map at all, so most wakes prime nothing and a probe arriving at an arbitrary moment still sweeps for itself. The two wins that do hold are a probe landing within this window of a cycle that actually BUILT the map, which reuses that build, and repeated probes, which collapse onto one sweep. Below the 5-minute `exchange-info-refresh` cadence, so a snapshot can span at most one write of the symbol-info keys and a delisting cannot stay invisible for two consecutive writes.
 */
export const ADMISSION_SNAPSHOT_MAX_AGE_MS = 120_000;

/**
 * How long an EMPTY read is remembered before another sweep is attempted.
 *
 * Far shorter than {@link ADMISSION_SNAPSHOT_MAX_AGE_MS}, because an empty map is the "unreadable or unprimed" sentinel rather than an answer: retaining it for the full snapshot age would keep aborting cycles long after a one-second Redis blip healed.
 *
 * What this buys is a bounded duration, not a promise about wakes. The stamp is taken when the sweep RESOLVES, and the discovery cron self-reschedules at `max(0, period - runtime)`, so a wake that overran its own period starts the next one immediately and can still be inside this window; the diagnosis probe stamps the memo from outside any wake at all. The guarantee is therefore the length itself: a sentinel is served for at most this long, so at most one subsequent wake can reuse it before the keyspace is swept again.
 *
 * Its real beneficiary is that probe rather than the cron. The discovery handler memoizes one admission promise per mode for the whole wake, so at most one cron call per mode ever reaches this resolver, while a probe is operator-triggered and can fire repeatedly with nothing above it to coalesce. The cost is honest: a probe inside the window answers from the stored sweep even if Redis has already recovered, and a wake reusing a probe-stamped empty counts and parks the alertable admission abort on the strength of it, which defers the tail of a real refusal by one wake rather than inventing one and clears on the next successful cycle.
 */
export const EMPTY_MEMO_MS = 30_000;

/** Log tag for the memoized read. One construction-time value, not a per-caller one: a shared sweep has no single caller to attribute, so the warn names the read and identifies no consumer. That attribution is given up deliberately, and the two consumers run concurrently in this process, so neighbouring log lines do not restore it. */
const RESOLVER_LOG_PREFIX = 'symbol-admission';

/** Injected dependencies of {@link createSymbolAdmissionResolver}. */
export interface SymbolAdmissionResolverDeps {
  /** Redis client, used only for the SCAN + MGET the sweep performs. */
  readonly redis: Pick<Redis, 'scan' | 'mget'>;
  /** Where an unreadable or unprimed keyspace is reported, once per sweep rather than once per caller. */
  readonly logger: Logger;
  /** Source of epoch-ms for the snapshot age, injected so the window is provable without waiting for it. */
  readonly clock: { nowMs: () => number };
}

/**
 * Build the per-process accessor for the mode-scoped admission map, holding one snapshot per mode for {@link ADMISSION_SNAPSHOT_MAX_AGE_MS}.
 *
 * The discovery cron and the diagnosis re-probe live in one process and each swept the whole ~1.4k-key symbol-info keyspace for itself, moments apart, to build the same map. Sharing the accessor makes that one SCAN + MGET. Lazy, like the asset-policy accessor beside it: a wake where no profile is due never touches Redis.
 *
 * Snapshots are per mode and never substituted for one another. A live map served to a test-mode caller binds symbols testnet does not list, and every tick for them then DLQs.
 *
 * An EMPTY result is memoized for the much shorter {@link EMPTY_MEMO_MS} and never promoted to a snapshot. `fetchSymbolAdmission` returns an empty map both for a Redis fault and for an unprimed keyspace, so an empty map is a sentinel, not a universe of zero symbols. Holding it for the full snapshot age would abort every cycle for two minutes after a blip that healed in one second; holding it briefly still spares the stampede of identical failing sweeps that one wake would otherwise fire.
 *
 * @param deps - Injected Redis, logger, and clock.
 * @returns An accessor resolving to that mode's admission map, no older than the window its content earns; empty when the keyspace could not be read or has not been primed, exactly as the underlying fetch reports it.
 */
export const createSymbolAdmissionResolver = (
  deps: SymbolAdmissionResolverDeps,
): ((mode: BinanceMode) => Promise<ReadonlyMap<string, SymbolAdmission>>) => {
  const memos = new Map<
    BinanceMode,
    { admission: ReadonlyMap<string, SymbolAdmission>; observedAtMs: number }
  >();
  // The cron's profile loop is sequential, but the diagnosis queue worker shares this accessor and runs concurrently in the same process, so the second reader routinely arrives while the first sweep is still out. Without this the sharing buys nothing in exactly the case it was built for.
  const inFlight = new Map<BinanceMode, Promise<ReadonlyMap<string, SymbolAdmission>>>();
  return async (mode) => {
    const memo = memos.get(mode);
    if (memo !== undefined) {
      const maxAgeMs = memo.admission.size === 0 ? EMPTY_MEMO_MS : ADMISSION_SNAPSHOT_MAX_AGE_MS;
      if (deps.clock.nowMs() - memo.observedAtMs < maxAgeMs) return memo.admission;
    }
    const pending = inFlight.get(mode);
    if (pending !== undefined) return pending;
    const sweep = refresh(mode);
    inFlight.set(mode, sweep);
    try {
      return await sweep;
    } finally {
      inFlight.delete(mode);
    }
  };

  async function refresh(mode: BinanceMode): Promise<ReadonlyMap<string, SymbolAdmission>> {
    const admission = await fetchSymbolAdmission(
      deps.redis,
      deps.logger,
      mode,
      RESOLVER_LOG_PREFIX,
    );
    // Stamped when the answer arrived, not when the sweep left: a slow scan of the whole keyspace must not spend part of its own window.
    memos.set(mode, { admission, observedAtMs: deps.clock.nowMs() });
    return admission;
  }
};
