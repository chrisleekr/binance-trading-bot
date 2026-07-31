// Read-site validation for a URL search param whose value must be one of a
// fixed set.
//
// WHY this is needed at all: TanStack Router merges a route match's search over
// its PARENT match's search, and the parent's is the raw parsed query string. A
// child `validateSearch` that omits an unrecognised key therefore does not strip
// it — the parent's raw value survives and reaches the component. A tab whose
// value is `?section=nope` then matches no trigger, so every tab renders
// unselected rather than falling back to the default.
//
// Shared rather than inlined because two routes hit it (the profile History
// page's `?section=`, the Backtest workbench's `?view=`) and the failure is
// silent: nothing throws, the UI just renders with nothing selected.

/**
 * Return `value` when it is one of `allowed`, otherwise `fallback`.
 *
 * `allowed` is a readonly tuple of the literal union, so the return type is the
 * union rather than a widened string.
 */
export const oneOf = <T extends string>(value: unknown, allowed: readonly T[], fallback: T): T =>
  typeof value === 'string' && (allowed as readonly string[]).includes(value)
    ? (value as T)
    : fallback;

/** Type guard form, for a `validateSearch` that wants to omit rather than default. */
export const isOneOf =
  <T extends string>(allowed: readonly T[]) =>
  (value: unknown): value is T =>
    typeof value === 'string' && (allowed as readonly string[]).includes(value);
