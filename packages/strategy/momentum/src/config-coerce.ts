import { Decimal } from '@app/money';

// Momentum stores config unparsed, so every numeric leaf arrives as an unknown
// and must be coerced to a safe default rather than trusted. These two helpers
// are the single parse-and-fallback machinery the strategy's config accessors
// (ATR stop, extension guard, EMA/timeframe periods) all delegate to, so the
// coercion cannot drift field to field.

/** A finite integer >= `min`, else `fallback`. */
export const coerceInt = (raw: unknown, opts: { min: number; fallback: number }): number => {
  const n = Number.parseInt(String(raw ?? opts.fallback), 10);
  return Number.isFinite(n) && n >= opts.min ? n : opts.fallback;
};

/** A positive Decimal, else `fallback` (also on non-parseable input). */
export const coerceDec = (raw: unknown, opts: { fallback: string }): Decimal => {
  const fallback = new Decimal(opts.fallback);
  try {
    const d = new Decimal(String(raw ?? opts.fallback));
    return d.gt(0) ? d : fallback;
  } catch {
    return fallback;
  }
};
