/**
 * Closed vocabulary of bundle-provider names a strategy lists in
 * `capabilities.bundleProviders`. Each token names an optional input channel the
 * worker injects into the strategy's per-tick `bundle`: `technicals` (the
 * computed rating window), `override` (the Redis operator-override the tick
 * consumes), `entry-hint` (the discovery `enterOnAdd` hash). A strategy declares
 * the subset it reads; the live tick bundle-builder and the backtest runner
 * select providers off these same tokens, so the two assembled bundles cannot
 * drift on a typo and the golden-replay parity stays mechanical.
 *
 * Worker-internal vocabulary — unlike {@link OPERATOR_ACTIONS} it is NOT
 * serialised onto the api descriptor, so there is no wire `z.enum` boundary. It
 * lives here so the strategy declaration and the two worker assemblers share one
 * source; the registry consistency test is the net that proves every declared
 * token is a member (mirroring how operatorActions is gated).
 */
export const BUNDLE_PROVIDERS = ['technicals', 'override', 'entry-hint'] as const;
/** TS type derived from {@link BUNDLE_PROVIDERS} so consumers don't re-run the index lookup. */
export type BundleProvider = (typeof BUNDLE_PROVIDERS)[number];
