import Decimal from 'decimal.js';

/**
 * How an operator-facing percent maps to the stored decimal-string the strategy
 * config carries. The stored value is NEVER a 0-100 percent; it is a multiplier
 * or fraction the strategy consumes directly. These converters are the single
 * exact bridge so the SPA can show a plain percent while the wire format stays
 * unchanged.
 *
 *  - `above`    multiplier on a reference price, >= 1. percent p ⇄ 1 + p/100.
 *               (e.g. a buy stop 1% above current price: shown 1, stored 1.01)
 *  - `below`    multiplier on a reference price, in (0, 1]. percent p ⇄ 1 - p/100.
 *               (e.g. a stop-loss 3% below entry: shown 3, stored 0.97)
 *  - `fraction` a drawdown fraction in (0, 1), stored verbatim. percent p ⇄ p/100.
 *               (e.g. a 5% trailing pullback: shown 5, stored 0.05)
 */
export type PercentMode = 'above' | 'below' | 'fraction';

const HUNDRED = new Decimal(100);
const ONE = new Decimal(1);

/**
 * Convert an operator-typed percent to the stored decimal-string. Exact via
 * decimal.js so a value that feeds an order never carries IEEE-754 drift (the
 * reason `apps/web` is barred from raw `number` money math and calls this
 * instead). Empty passes through as the "blank / inherit" sentinel; the caller
 * guarantees a finite decimal-shaped string otherwise.
 */
export const percentToStored = (percent: string, mode: PercentMode): string => {
  if (percent === '') return '';
  const p = new Decimal(percent).div(HUNDRED);
  switch (mode) {
    case 'above':
      return ONE.plus(p).toString();
    case 'below':
      return ONE.minus(p).toString();
    case 'fraction':
      return p.toString();
  }
};

/**
 * Convert a stored decimal-string back to the operator-facing percent for
 * display in the form. Inverse of {@link percentToStored}; empty passes through.
 */
export const storedToPercent = (stored: string, mode: PercentMode): string => {
  if (stored === '') return '';
  const m = new Decimal(stored);
  switch (mode) {
    case 'above':
      return m.minus(ONE).times(HUNDRED).toString();
    case 'below':
      return ONE.minus(m).times(HUNDRED).toString();
    case 'fraction':
      return m.times(HUNDRED).toString();
  }
};
