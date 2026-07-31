// Shared state-adapter body guards. Every PositionStateAdapter / GridTradeState
// Adapter validates a persisted body is the strategy's current schema before
// reading or mutating it, and defers (returns null) otherwise, the contract's
// "silent-defer" protocol. Hoisted here so a strategy author maps field names
// over a validated body instead of re-copying the guard (a wrong copy fails
// silently: the adapter no-ops every fill/reconcile).

/**
 * Validate a persisted state body is the strategy's current schema, returning
 * the body for field reads or `null` to defer. A foreign or un-migrated
 * older-schema body reads as `null` so the worker no-ops rather than acting on
 * a body it cannot interpret.
 */
export const currentSchemaBody = (
  schemaVersion: string,
  state: unknown,
): Record<string, unknown> | null => {
  if (typeof state !== 'object' || state === null) return null;
  const body = state as Record<string, unknown>;
  return body['schemaVersion'] === schemaVersion ? body : null;
};

/**
 * Narrow a body field to `string | null`, or `undefined` when it is a
 * populated-but-malformed value (not string / null / undefined). Callers defer
 * on `undefined` rather than guess at a malformed position field.
 */
export const asStringOrNull = (value: unknown): string | null | undefined =>
  value === null || value === undefined || typeof value === 'string' ? (value ?? null) : undefined;
