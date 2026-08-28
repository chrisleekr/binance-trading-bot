// One fixture, shared by the two surfaces that render the same discovery gauge fields (Discovery page tiles and the Home scoped KPI strip). Both surfaces read `gauge.deployedQuote` / `gauge.maxAccountExposureQuote` from the same payload, so "they agree" is only pinned if both suites assert the SAME input against the SAME expected literal. Asserting each side against a locally-written expectation would let the two drift apart while both suites stayed green.
//
// The values are BTC-quoted (sub-unit) on purpose: that is the case where a hard 2-decimal formatter collapses a real balance to `0.00`.
//
// `toLocaleString(undefined, …)` is locale-sensitive for grouping; these values are all below 1, so no thousands separator can appear and the expected literals hold under any en-style locale — the same assumption `format.test.ts` states.

/** Deployed cost basis, BTC-quoted, small enough that 2dp would render it `0.00`. */
export const SUB_UNIT_DEPLOYED_QUOTE = '0.00453210';

/** Account exposure cap, BTC-quoted, with trailing zeros that must be dropped. */
export const SUB_UNIT_EXPOSURE_CAP_QUOTE = '0.01500000';

/** The one string BOTH surfaces must print for {@link SUB_UNIT_DEPLOYED_QUOTE}. */
export const SUB_UNIT_DEPLOYED_TEXT = '0.0045321';

/** The one string BOTH surfaces must print for {@link SUB_UNIT_EXPOSURE_CAP_QUOTE}. */
export const SUB_UNIT_EXPOSURE_CAP_TEXT = '0.015';
