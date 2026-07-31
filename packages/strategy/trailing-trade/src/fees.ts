import { Decimal } from '@app/money';
import { safeDecimal } from './branches/safe-decimal.js';
import type { TTConfig } from './schema.js';

/**
 * Round-trip fee as a price fraction (e.g. 0.002 for a 10 bp/leg taker fee: 10 bp
 * on the buy plus 10 bp on the sell). In the default `market` entry mode the
 * strategy enters and exits with market orders, so both legs are taker. In
 * `maker` entry mode the buy rests a passive limit, so the buy leg pays the
 * maker fee and only the sell leg is taker (round trip = makerBps + takerBps).
 * Modelling exits as taker is the safe direction for a "never book a net loss"
 * floor: a resting protective stop that happens to fill as maker only makes the
 * real cost lower than the floor assumes.
 *
 * Reads `config.fees` and `config.execution` defensively because the worker
 * passes RAW stored config: an older row without a fees/execution block, or a
 * corrupt value, reads as 0 / market mode — byte-identical to the pre-fee
 * behaviour (golden-replay diff = 0).
 */
export const roundTripFeeFraction = (config: TTConfig): Decimal => {
  const taker = safeDecimal(config.fees?.takerBps ?? '0');
  if (config.execution?.entryMode === 'maker') {
    // Buy leg is a maker limit, sell leg is taker. A missing / invalid leg reads
    // as 0 so an un-set fee never inflates the floor.
    const makerLeg = safeDecimal(config.fees?.makerBps ?? '0');
    const buy = makerLeg !== null && makerLeg.gt(0) ? makerLeg : new Decimal(0);
    const sell = taker !== null && taker.gt(0) ? taker : new Decimal(0);
    return buy.plus(sell).div(10_000);
  }
  if (taker === null || taker.lte(0)) return new Decimal(0);
  return taker.times(2).div(10_000);
};

/**
 * Round-trip fee in PERCENT units (0.2 for a 10 bp/leg taker), matching the
 * units of `sell.forceSellMinProfitPercent`.
 */
export const roundTripFeePercent = (config: TTConfig): Decimal =>
  roundTripFeeFraction(config).times(100);

/**
 * Minimum gross-profit percent a discretionary technicals sell must clear: the
 * larger of the operator's `forceSellMinProfitPercent` and the round-trip fee.
 * Floors the discretionary exit at break-even-after-fees without the operator
 * having to manually pad the value. With fees unset it returns the configured
 * value verbatim (golden-replay diff = 0).
 */
export const effectiveForceSellMinProfitPercent = (config: TTConfig): string => {
  const configured = safeDecimal(config.sell.forceSellMinProfitPercent) ?? new Decimal(0);
  return Decimal.max(configured, roundTripFeePercent(config)).toFixed();
};
