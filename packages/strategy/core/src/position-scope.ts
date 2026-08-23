/**
 * Strategy-body fields whose meaning is scoped to an OPEN position. Each one explains something about a position the strategy is holding, so none of them may outlive it: once the position is gone the field describes nothing, and a dashboard reading it reports a hazard against a symbol the operator no longer owns.
 *
 * Declared as a value rather than as prose in a comment so a plugin's suite derives its coverage from the real vocabulary instead of a hand-copied list that silently stops covering a field someone added. Same reason `PROTECTIVE_STOP_BLOCKER_REASONS` is a value.
 *
 * `entryBlocker` is deliberately NOT here. It explains why a FLAT profile did not buy, so it is scoped the other way round and dies when a position OPENS, which each plugin already handles on its held path.
 */
export const POSITION_SCOPED_STATE_FIELDS = ['protectiveStopBlocker', 'exitBlocker'] as const;

/** One of the field names in `POSITION_SCOPED_STATE_FIELDS`. */
export type PositionScopedField = (typeof POSITION_SCOPED_STATE_FIELDS)[number];

/**
 * Whether a body still carries any position-scoped field with a value.
 *
 * Exists for the "skip the write when it would change nothing" guards in the position adapters. Those guards test the position fields alone, so a body that is already flat but still carrying one of these reads as a no-op and is waved through unchanged — which is precisely the shape of a stranded row, and precisely the row a clear needs to reach.
 *
 * Own-property test, not `in`: `in` walks the prototype chain, so a polluted `Object.prototype` would make every momentum body report an `exitBlocker` it does not have and defeat the no-op guard on every empty fill. `!= null` rather than `!== null` so an explicit `undefined` reads as absent, matching how every consumer treats a missing key.
 *
 * @param state - Strategy body to inspect.
 * @returns True when at least one position-scoped field is an own key holding a non-nullish value.
 */
export const hasPositionScopedFieldSet = (state: object): boolean =>
  POSITION_SCOPED_STATE_FIELDS.some(
    (field) => Object.hasOwn(state, field) && (state as Record<string, unknown>)[field] != null,
  );

/**
 * Null every position-scoped field a body actually carries.
 *
 * Absent fields are skipped rather than written as null: momentum has no `exitBlocker`, and materialising one would put a key on its body that neither its schema nor its replay fixtures have ever seen. The skip is an own-property test for that reason — under a polluted prototype `in` would report the key as present and materialise exactly the key this guard exists to withhold.
 *
 * Returns the SAME reference when there was nothing to clear, so a steady flat tick allocates nothing and a caller may use identity to tell whether anything changed.
 *
 * @param state - Strategy body to normalise; never mutated. The constraint types these fields as `object | null` rather than `unknown` so a body declaring one as non-nullable is rejected here instead of silently receiving a `null` the return type denies.
 * @returns The body with its position-scoped fields nulled, or `state` itself when none were set.
 */
export const clearPositionScopedFields = <
  S extends object & Partial<Record<PositionScopedField, object | null>>,
>(
  state: S,
): S => {
  if (!hasPositionScopedFieldSet(state)) return state;
  const next: Record<string, unknown> = { ...(state as Record<string, unknown>) };
  for (const field of POSITION_SCOPED_STATE_FIELDS) {
    if (Object.hasOwn(next, field)) next[field] = null;
  }
  return next as S;
};
