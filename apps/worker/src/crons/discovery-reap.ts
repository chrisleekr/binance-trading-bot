// Shared reap-with-cleanup for auto-discovered symbol bindings.
//
// A leaf module (imports only @app/db types) so BOTH the discovery cron's
// `applyDiscoveryReap` and the tick-handler's delisted self-heal (wired in
// boot-context) delegate to ONE implementation. boot-context cannot import from
// `discovery.cron.ts` — that file imports `BootContext`, which would cycle — so
// the single source of truth lives here.

import type { ProfileRepo } from '@app/db';

/** The three per-profile Redis hashes a discovery mutation stamps. */
export interface DiscoveryStorageKeys {
  readonly addedKey: string;
  readonly flatKey: string;
  readonly enterOnAddKey: string;
}

/** Minimal Redis surface the storage mutations need; keeps them unit-testable with a fake. */
export interface DiscoveryHashWriter {
  hget(key: string, field: string): Promise<string | null>;
  hset(key: string, field: string, value: string): Promise<unknown>;
  hdel(key: string, field: string): Promise<unknown>;
}

export type DiscoverySymbolStore = Pick<
  ProfileRepo['profileSymbols'],
  'upsert' | 'setSource' | 'removeAutoIfFlat' | 'findForSymbol'
>;

/** Why a reap did or didn't happen; mirrors the db repo's `DiscoveryRemoveOutcome`. */
export type ReapOutcome = Awaited<ReturnType<DiscoverySymbolStore['removeAutoIfFlat']>>;

/**
 * Reap an auto-discovered binding and, ONLY on a real removal, clear its
 * discovery bookkeeping: stamp the flat cooldown anchor (survives the row
 * delete), drop the added-at hash, and clear the enter-on-add hint so a later
 * re-add re-evaluates fresh. The flat-guard rides inside `removeAutoIfFlat`, so a
 * held / open-order / operator-pinned symbol is refused and no Redis mutation
 * runs — the cleanup can never precede a successful delete.
 *
 * The single reap-with-cleanup both the discovery cron and the tick-handler
 * delisted self-heal delegate to, so the two paths cannot leave divergent
 * discovery state (a stale added-at / enter-on-add hash that would misread if the
 * symbol re-lists and re-enters discovery).
 */
export const reapAutoBinding = async (
  symbols: DiscoverySymbolStore,
  redis: DiscoveryHashWriter,
  keys: DiscoveryStorageKeys,
  symbol: string,
  at: number,
): Promise<ReapOutcome> => {
  const outcome = await symbols.removeAutoIfFlat(symbol);
  if (outcome === 'removed') {
    await redis.hset(keys.flatKey, symbol, String(at));
    await redis.hdel(keys.addedKey, symbol);
    await redis.hdel(keys.enterOnAddKey, symbol);
  }
  return outcome;
};
