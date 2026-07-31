// Discovery ADD / REAP storage mutations.
//
// The two write paths a discovery cycle applies to storage, decided against
// pre-mutation state so the audit outcome is exact. Both delegate the reap side
// to the shared `reapAutoBinding` leaf so the cron and the tick-handler
// self-heal cannot leave divergent discovery state.

import {
  reapAutoBinding,
  type DiscoveryHashWriter,
  type DiscoveryStorageKeys,
  type DiscoverySymbolStore,
} from '../discovery-reap.js';

/**
 * Outcome of applying a discovery ADD, decided before the storage mutation:
 * `created` (brand-new symbol), `readded` (row was gone but the added-at hash
 * still knew it — a silent membership loss healed by re-adding), or `existing`
 * (the binding row was already present, no audit line). `prevAddedAt` carries
 * the prior stamp so the re-add audit line can show how long it was missing.
 */
export type DiscoveryAddOutcome =
  | { outcome: 'created' }
  | { outcome: 'existing' }
  | { outcome: 'readded'; prevAddedAt: number };

/**
 * Apply a discovery ADD to storage: flip the symbol to `source='auto'`, stamp
 * the added-at hash, and clear any flat cooldown. The entry-hint hash is NOT
 * touched here: the per-cycle refresh pass in `runDiscoveryForProfile` owns it
 * for every desired symbol (#486), and the reap path clears it.
 *
 * Reads the binding row + added-at hash BEFORE mutating so the outcome
 * (`created` / `readded` / `existing`) is decided against pre-mutation state:
 * a row that was already present is `existing` (no audit), a missing row that
 * the added-at hash still knows is `readded` (silent membership loss, carries
 * `prevAddedAt`), and the rest is `created`.
 */
export const applyDiscoveryAdd = async (
  symbols: DiscoverySymbolStore,
  redis: DiscoveryHashWriter,
  keys: DiscoveryStorageKeys,
  symbol: string,
  baseAsset: string,
  at: number,
): Promise<DiscoveryAddOutcome> => {
  const existingRow = await symbols.findForSymbol(symbol);
  const prevAddedRaw = await redis.hget(keys.addedKey, symbol);
  let result: DiscoveryAddOutcome;
  if (existingRow) {
    result = { outcome: 'existing' };
  } else {
    const prev = Number(prevAddedRaw);
    result =
      prevAddedRaw !== null && Number.isFinite(prev)
        ? { outcome: 'readded', prevAddedAt: prev }
        : { outcome: 'created' };
  }

  await symbols.upsert(symbol, baseAsset, { overrideConfig: null });
  await symbols.setSource(symbol, 'auto');
  await redis.hset(keys.addedKey, symbol, String(at));
  await redis.hdel(keys.flatKey, symbol);
  return result;
};

/**
 * Apply a discovery REAP to storage. Thin boolean adapter over the shared
 * {@link reapAutoBinding} (the reap + flat-stamp + hash cleanup); the discovery
 * cron only needs "was it removed", so it collapses the outcome to a boolean.
 */
export const applyDiscoveryReap = async (
  symbols: DiscoverySymbolStore,
  redis: DiscoveryHashWriter,
  keys: DiscoveryStorageKeys,
  symbol: string,
  at: number,
): Promise<boolean> => (await reapAutoBinding(symbols, redis, keys, symbol, at)) === 'removed';
