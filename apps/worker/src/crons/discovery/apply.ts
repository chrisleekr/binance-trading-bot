// Discovery ADD / REAP storage mutations.
//
// The two write paths a discovery cycle applies to storage, decided against
// pre-mutation state so the audit outcome is exact. Both delegate the reap side
// to the shared `reapUnpinnedBinding` leaf so the cron and the tick-handler
// self-heal cannot leave divergent discovery state.

import {
  reapUnpinnedBinding,
  type DiscoveryHashWriter,
  type DiscoveryStorageKeys,
  type DiscoverySymbolStore,
  type ReapOutcome,
} from '../discovery-reap.js';

/**
 * Outcome of applying a discovery ADD, decided before the storage mutation:
 * `created` (brand-new symbol), `readded` (row was gone but the added-at hash
 * still knew it — a silent membership loss healed by re-adding), or `existing`
 * (the binding row was already present, no audit line). `prevAddedAt` carries
 * the prior stamp so the re-add audit line can show how long it was missing.
 */
export type DiscoveryAddOutcome =
  { outcome: 'created' } | { outcome: 'existing' } | { outcome: 'readded'; prevAddedAt: number };

/**
 * Apply a discovery ADD to storage: bind an absent symbol at `source='auto'`, stamp the added-at hash, and clear any flat cooldown. The entry-hint hash is NOT touched here: the per-cycle refresh pass in `runDiscoveryForProfile` owns it for every desired symbol, and the reap path clears it.
 *
 * Reads the binding row + added-at hash BEFORE mutating so the outcome (`created` / `readded` / `existing`) is decided against pre-mutation state: a row that was already present is `existing` (no audit), a missing row that the added-at hash still knows is `readded` (silent membership loss, carries `prevAddedAt`), and the rest is `created`. That same pre-read is what gates the row write, so an `existing` row keeps its override and its provenance.
 *
 * @param symbols - Scope-bound `profile_symbols` surface for the profile taking the symbol on.
 * @param redis - Hash writer for the profile's discovery bookkeeping hashes.
 * @param keys - The added-at / flat-cooldown / enter-on-add hash keys for this profile.
 * @param symbol - Trading pair being bound.
 * @param baseAsset - The pair's base asset, needed by the binding row and only known to the caller's ticker feed.
 * @param at - Epoch-ms stamped as this cycle's added-at, which starts the min-hold clock.
 * @returns Which of the three add cases this was, decided against pre-mutation state.
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

  // Discovery writes the row only when it is the one creating it. `upsert`'s ON CONFLICT clause resets `override_config` to null, and `setSource` claims provenance, so running either against a row that was already there discards whatever per-symbol override the operator set AND relabels their own pick as discovery's. The guard keys on the ROW, not on the outcome tag: `created` and `readded` are both genuinely absent rows, and there `upsert` alone would leave `source` at the column default `manual`, which is the same false claim in the other direction.
  if (!existingRow) {
    await symbols.upsert(symbol, baseAsset, { overrideConfig: null });
    await symbols.setSource(symbol, 'auto');
  }
  // Unconditional: these two hashes are discovery's own bookkeeping, not the shared row. The added-at stamp and the flat-cooldown clear describe this cycle's membership decision, which is true whoever created the row.
  await redis.hset(keys.addedKey, symbol, String(at));
  await redis.hdel(keys.flatKey, symbol);
  return result;
};

/**
 * Apply a discovery REAP to storage: the shared {@link reapUnpinnedBinding} (reap + flat-stamp + hash cleanup), passing its verdict through unchanged.
 *
 * Kept as a wrapper even though it now adds nothing to {@link reapUnpinnedBinding}: it is the cron's single storage-mutation surface, the sibling of `applyDiscoveryAdd`, and the pass-through is deliberate. Anything this layer added would apply to the cron's reap and NOT to the tick-boundary self-heal, which calls the shared leaf directly — the exact divergence the shared leaf exists to prevent.
 *
 * The reason travels rather than a boolean. The repo already distinguishes a pin from a held position from a row that was never there, and those have three different remedies; collapsed to "was it removed", every refusal became one indistinguishable `false` and the only trace a coin had stopped rotating was a log line.
 *
 * @param symbols - Scope-bound `profile_symbols` surface for the profile that owns the binding.
 * @param redis - Hash writer for the profile's discovery bookkeeping hashes.
 * @param keys - The added-at / flat-cooldown / enter-on-add hash keys for this profile.
 * @param symbol - Trading pair whose binding is being reaped.
 * @param at - Epoch-ms stamped as the flatten anchor, which starts the re-add cooldown.
 * @returns Why the reap did or did not fire, verbatim from the repo guard.
 */
export const applyDiscoveryReap = async (
  symbols: DiscoverySymbolStore,
  redis: DiscoveryHashWriter,
  keys: DiscoveryStorageKeys,
  symbol: string,
  at: number,
): Promise<ReapOutcome> => reapUnpinnedBinding(symbols, redis, keys, symbol, at);
