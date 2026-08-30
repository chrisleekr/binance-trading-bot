// Shared reap-with-cleanup for UNPINNED (rotatable) symbol bindings.
//
// A leaf module (imports only @app/db types) so BOTH the discovery cron's
// `applyDiscoveryReap` and the tick-handler's delisted self-heal (wired in
// boot-context) delegate to ONE implementation. boot-context cannot import from
// `discovery.cron.ts` — that file imports `BootContext`, which would cycle — so
// the single source of truth lives here.

import type { ProfileRepo } from '@app/db';
import type { MetricsSink } from 'metrics/catalog.js';

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
  'upsert' | 'setSource' | 'removeUnpinnedIfFlat' | 'findForSymbol'
>;

/** Why a reap did or didn't happen; mirrors the db repo's `DiscoveryRemoveOutcome`. */
export type ReapOutcome = Awaited<ReturnType<DiscoverySymbolStore['removeUnpinnedIfFlat']>>;

/**
 * Every reason a discovery cycle's rotation attempt ends, as a runtime array so callers that must enumerate the outcomes (the counter zero-seed, above all) cannot silently miss one that a later change adds. A type-level union is erased before any of them runs and would enumerate nothing.
 *
 * The repo's four, plus the two refusals the cron decides for itself and never sends to the repo: the wallet still holds the coin, or the wallet balance could not be read at all. Those two are the discovery cron's own guard against abandoning a live position, so nothing downstream of `removeUnpinnedIfFlat` can name them.
 */
export const DISCOVERY_REAP_OUTCOMES = [
  'removed',
  'pinned',
  'held',
  'not-found',
  'wallet-held',
  'hold-unproven',
] as const;

/**
 * Why a discovery cycle's rotation attempt ended for one symbol, across BOTH guards: the repo's flat/pin verdict and the cron's own exchange-wallet check.
 *
 * `wallet-held` and `hold-unproven` are separated on purpose despite sharing a remedy at the branch (both refuse). They are opposite facts about the system: `wallet-held` is the guard working on evidence, keeping a real position safe, and a steady trickle is normal. `hold-unproven` is the guard refusing because it established nothing either way, which is a fault somewhere upstream of the verdict rather than a hold.
 *
 * `hold-unproven` is deliberately one bucket over four upstream faults — no credentials resolved, `getAccount` failed, the symbol-info cache is cold, or `minQty`/balance would not parse — because they are one fact at this layer: the position is unknown, so the coin must not be abandoned. The cron's own `held-guard` warns carry the specific cause, and that is where diagnosis belongs; splitting it here would put four label values in front of an operator whose next step is the same for all of them.
 */
export type DiscoveryReapOutcome = (typeof DISCOVERY_REAP_OUTCOMES)[number];

// The cron's two extra outcomes only make sense as a SUPERSET of the repo's. If the repo ever renames or adds one, this stops compiling here rather than silently dropping a reason on the floor at the tally.
const _reapOutcomesCoverRepo = (outcome: ReapOutcome): DiscoveryReapOutcome => outcome;
void _reapOutcomesCoverRepo;

/**
 * Reap an unpinned binding and, ONLY on a real removal, clear its discovery bookkeeping: stamp the flat cooldown anchor (survives the row delete), drop the added-at hash, and clear the enter-on-add hint so a later re-add re-evaluates fresh. The flat-guard rides inside `removeUnpinnedIfFlat`, so a held / open-order / pinned symbol is refused and no Redis mutation runs — the cleanup can never precede a successful delete.
 *
 * Keyed on the pin, not on provenance: a binding the system re-created to recover an untracked position is rotatable like any other, so the cleanup reaches it too.
 *
 * The single reap-with-cleanup both the discovery cron and the tick-handler delisted self-heal delegate to, so the two paths cannot leave divergent discovery state (a stale added-at / enter-on-add hash that would misread if the symbol re-lists and re-enters discovery).
 *
 * @param symbols - Scope-bound `profile_symbols` surface for the profile that owns the binding.
 * @param redis - Hash writer for the profile's three discovery bookkeeping hashes.
 * @param keys - The added-at / flat-cooldown / enter-on-add hash keys for this profile.
 * @param symbol - Trading pair whose binding is being reaped.
 * @param at - Epoch-ms stamped as the flatten anchor, which starts the re-add cooldown.
 * @returns Why the reap did or did not fire, verbatim from the repo guard.
 */
export const reapUnpinnedBinding = async (
  symbols: DiscoverySymbolStore,
  redis: DiscoveryHashWriter,
  keys: DiscoveryStorageKeys,
  symbol: string,
  at: number,
): Promise<ReapOutcome> => {
  const outcome = await symbols.removeUnpinnedIfFlat(symbol);
  if (outcome === 'removed') {
    await redis.hset(keys.flatKey, symbol, String(at));
    await redis.hdel(keys.addedKey, symbol);
    await redis.hdel(keys.enterOnAddKey, symbol);
  }
  return outcome;
};

/**
 * Build the per-profile sink callback the discovery cycle calls once per rotation verdict.
 *
 * Exported and testable rather than an inline lambda at the cron's port adapter, because that adapter has no test around it: the metric NAME, the increment VALUE, and the `profileId`/`outcome` label pair would otherwise be asserted nowhere. All three fail silently if wrong — the sink drops an unknown name, `inc(0)` never moves a series, and a mistyped label key resolves to `unknown` because `record`'s tags are a plain string record rather than a type derived from `labelNames`. A counter that reads a healthy flat zero forever is exactly the failure this counting exists to close, so the emission has to be pinned somewhere a test can reach.
 *
 * @param metrics - The process metrics sink; the profile's cycle owns no other route to it.
 * @param profileId - The unwrapped profile id used as the series label, bounded by the profiles the operator created.
 * @returns A callback taking one rotation verdict and incrementing that profile's counter for it by one.
 */
export const reapOutcomeRecorder =
  (metrics: MetricsSink, profileId: string) =>
  (outcome: DiscoveryReapOutcome): void => {
    metrics.record('discovery_reap_outcome_total', 1, { profileId, outcome });
  };
