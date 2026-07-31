// Held-position predicate, shared by the Postgres dashboard projection
// (`@app/db`) and the web display layer (`apps/web`). Both decide "is this
// symbol actually holding a position" and parse decimal-strings to display
// numbers, and both are barred from decimal.js on the dashboard read path, so
// the rule lived as a hand-synced byte-for-byte copy in each. Defining it once
// here (the package both already depend on) is what keeps the home-screen
// "Positions" count, the coin-grid badge, and the per-profile rollup provably
// equal instead of equal-by-comment. `Number` math is for the usability
// decision only; no value here feeds an order.

/**
 * Parse a decimal-string to a finite number, or `null` for an absent, blank,
 * whitespace, or malformed value. A blank price must read as "no price", not
 * `Number('') === 0`. A zero mark would fabricate a full cost-basis loss and
 * flag a zero-balance ledger row as a position.
 */
export const toFinite = (value: string | null | undefined): number | null => {
  if (value == null || typeof value !== 'string' || value.trim() === '') return null;
  const n = Number(value);
  return Number.isFinite(n) ? n : null;
};

/**
 * True when a symbol is actually holding a position: a recorded average entry
 * price AND a strictly positive held base-asset quantity. An entry-price-only
 * ledger row (a price marker with no base asset) is not a position.
 */
export const isHeldPosition = (
  avgEntryPrice: string | null | undefined,
  quantity: string | null | undefined,
): boolean => {
  const qty = toFinite(quantity);
  return avgEntryPrice != null && qty != null && qty > 0;
};
