// Shared boundary helpers for the trailing-trade web mirror. apps/web is barred
// from decimal.js, so the panels replay the strategy's threshold math in
// Number() space over the loosely-typed (config, state) payload. These two
// readers are the single home for that boundary — previously each mirror file
// redefined its own copy.

/** Narrow an unknown payload field to an object, or null. */
export const asRecord = (v: unknown): Record<string, unknown> | null =>
  typeof v === 'object' && v !== null ? (v as Record<string, unknown>) : null;

/**
 * Parse a config/state numeric field. Returns null for absent, empty/whitespace,
 * or non-finite values so callers read null as "missing or disabled". Stored TT
 * money fields are decimal-strings; counters/indices are numbers — both decode
 * here.
 */
export const parseNum = (v: unknown): number | null => {
  if (typeof v === 'number') return Number.isFinite(v) ? v : null;
  if (typeof v === 'string' && v.trim() !== '') {
    const n = Number(v);
    return Number.isFinite(n) ? n : null;
  }
  return null;
};
