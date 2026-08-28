// The single predicate that decides which of a profile's bindings discovery may touch.
//
// It lives in its own leaf module, and returns BOTH lists from one pass, so the cron's port has no filter expression of its own to drift. Two call sites reading the same rows with two hand-written predicates is exactly how `source` came to mean two things at once: whichever one a later edit touched, the other silently disagreed.
//
// The key is the PIN and never `source`. Provenance says who created a binding; it does not say whether the operator wants it kept. A binding the fill adopter re-created to recover an untracked position carries `source='unknown'` and nobody chose it, so it must count against the slot cap and fade out like any other — under a provenance-keyed split it was invisible to both.

/** The two fields of a `profile_symbols` row this split reads. Structural rather than the full row type so the helper stays a leaf with no `@app/db` import. */
export interface PinnablePartitionRow {
  readonly symbol: string;
  readonly pinned: boolean;
}

/** Symbols discovery may rotate, and symbols the operator has protected. */
export interface PinPartition {
  /** Unpinned bindings: counted against `maxAutoSymbols` and eligible for the fade-out reap, whatever created them. */
  readonly rotatable: readonly string[];
  /** Pinned bindings: never re-adopted as an add, never reaped. */
  readonly pinned: readonly string[];
}

/**
 * Split a profile's bindings into what discovery may rotate and what it must leave alone.
 *
 * @param rows - Every `profile_symbols` row bound to the profile, in any order.
 * @returns The two symbol lists, each preserving the input order.
 */
export const partitionByPin = (rows: readonly PinnablePartitionRow[]): PinPartition => {
  const rotatable: string[] = [];
  const pinned: string[] = [];
  for (const row of rows) (row.pinned ? pinned : rotatable).push(row.symbol);
  return { rotatable, pinned };
};
