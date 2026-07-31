// Order-book price grouping — the Binance "group" control. The raw depth
// feed lists every tick-sized level; grouping aggregates them into coarser
// price buckets so the operator sees real liquidity walls instead of a wall
// of adjacent ticks.
//
// Number math is display-only — apps/web is barred from decimal.js and a
// grouped book never feeds an order; orders carry their own decimal handling.

import type { OrderBook, OrderBookLevel } from '@app/contracts';

/** Round to 8dp so float arithmetic never leaves a `…0001` price/qty artifact. */
const round8 = (n: number): number => Number(n.toFixed(8));

/**
 * Fixed-notation decimal string for a price/quantity — `String(1e-7)` would
 * emit `"1e-7"`, which is not the canonical decimal form the wire contract
 * uses. 8dp matches `round8`; trailing zeros are trimmed.
 */
const decimalStr = (n: number): string => n.toFixed(8).replace(/\.?0+$/, '') || '0';

/**
 * Round a positive number to one significant figure. Used to clean the
 * measured order-book tick: it kills float dust and sparse-book gap noise
 * while keeping a non-power-of-ten tick whose leading digit survives the
 * rounding (0.5, 0.05) as the finest step rather than coarsening it.
 */
const roundSig1 = (n: number): number => {
  if (n <= 0) return 0;
  const mag = 10 ** Math.floor(Math.log10(n));
  return round8(Math.round(n / mag) * mag);
};

/**
 * Aggregate raw levels into price buckets of size `step`. Asks round their
 * price up to the bucket ceiling, bids down to the floor, so each bucket's
 * price is the worst price within it — the level a taker sweeping that bucket
 * reaches. Quantities sum per bucket. `step <= 0` returns the levels unchanged.
 * Input is best-first; first-seen bucket order preserves that (bucketing is
 * monotonic over a best-first side).
 */
export function groupLevels(
  levels: readonly OrderBookLevel[],
  side: 'ask' | 'bid',
  step: number,
): OrderBookLevel[] {
  if (step <= 0) return [...levels];
  const qtyByBucket = new Map<number, number>();
  const bucketOrder: number[] = [];
  for (const level of levels) {
    const price = Number(level.price);
    // `price / step` carries float dust; a level sitting exactly on a bucket
    // edge must not be nudged into the neighbouring bucket, so a near-integer
    // quotient is snapped back to that integer before the ceil / floor.
    const raw = price / step;
    const nearest = Math.round(raw);
    const quotient = Math.abs(raw - nearest) < 1e-6 ? nearest : raw;
    const bucket = round8((side === 'ask' ? Math.ceil(quotient) : Math.floor(quotient)) * step);
    if (!qtyByBucket.has(bucket)) bucketOrder.push(bucket);
    qtyByBucket.set(bucket, (qtyByBucket.get(bucket) ?? 0) + Number(level.qty));
  }
  return bucketOrder.map((bucket) => ({
    price: decimalStr(bucket) as OrderBookLevel['price'],
    qty: decimalStr(round8(qtyByBucket.get(bucket) ?? 0)) as OrderBookLevel['qty'],
  }));
}

/**
 * Grouping step options for a book — the book's natural tick (the smallest
 * adjacent price gap) and three decades above it. The first option is the
 * tick itself, so selecting it leaves the ladder effectively raw. Falls back
 * to a tick derived from the mid-price magnitude when the book is too thin to
 * measure a gap.
 */
export function groupingSteps(book: OrderBook): number[] {
  let tick = 0;
  for (const side of [book.asks, book.bids]) {
    for (let i = 1; i < side.length; i += 1) {
      const gap = Math.abs(Number(side[i]?.price) - Number(side[i - 1]?.price));
      if (gap > 0 && (tick === 0 || gap < tick)) tick = gap;
    }
  }
  if (tick === 0) {
    // Thin book: a tick five orders of magnitude below the mid price is the
    // usual exchange convention (e.g. ~0.01 for a ~1000-priced asset).
    const prices = [...book.asks, ...book.bids].map((l) => Number(l.price)).filter(Number.isFinite);
    const mid = prices.length > 0 ? prices.reduce((a, b) => a + b, 0) / prices.length : 1;
    tick = 10 ** (Math.floor(Math.log10(mid)) - 5);
  }
  // One significant figure, not a power of ten: a 0.5 / 0.05 tick must
  // survive as the finest step, else the default view would silently merge
  // genuine adjacent levels. Floored at 1e-8 so a very-low-priced thin book
  // cannot collapse every option to a useless 0.
  const base = Math.max(roundSig1(tick), 1e-8);
  return [base, base * 10, base * 100, base * 1000].map(round8);
}
