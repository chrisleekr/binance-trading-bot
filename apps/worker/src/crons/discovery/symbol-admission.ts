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
 * @param logPrefix - Caller tag for those warns, so the cron and the diagnosis probe are distinguishable in the log.
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
            // An entry missing the base/quote split is skipped rather than defaulted. Every refresh since the keyspace existed writes both, so this only fires on a corrupt value, and inventing a split there would silently mis-classify the asset it names.
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
