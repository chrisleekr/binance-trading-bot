// Per-symbol admission facts, read from the symbol-info keyspace the
// exchange-info-refresh cron writes for one mode: the exchangeInfo `status`,
// and the permission sets that decide whether this account may trade it at all.
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
  /**
   * Absent when the cached entry predates permission-set capture or carries a
   * malformed value. Readers treat absent as "no constraint published", which
   * keeps the symbol.
   */
  readonly permissionSets?: readonly (readonly string[])[];
}

/**
 * Best-effort: a Redis error or an unprimed keyspace returns an empty map, and
 * `toDiscoveryTickers` then keeps the quote-matched universe unfiltered rather
 * than emptying it. Blinding the admission filters costs precision; emptying the
 * universe would look like a market with nothing in it.
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
              permissionSets?: unknown;
            };
            if (!info.symbol || !info.status) continue;
            const permissionSets = projectPermissionSets(info.permissionSets);
            admission.set(info.symbol, {
              status: info.status,
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
      `${logPrefix}: symbol-admission fetch failed; status filter skipped`,
    );
    return new Map();
  }
  if (admission.size === 0) {
    logger.warn(
      { mode },
      `${logPrefix}: symbol-admission map empty (exchangeInfo not primed?); status filter skipped`,
    );
  }
  return admission;
};
