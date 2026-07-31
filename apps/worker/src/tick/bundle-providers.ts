import type { BundleProvider } from '@app/contracts';

// Named handles for the bundle-provider tokens the live tick bundle-builder and
// the backtest runner select on. The closed vocabulary is owned by
// `@app/contracts` (`BUNDLE_PROVIDERS`); typing each handle as `BundleProvider`
// makes a typo here a compile error, and the registry consistency test proves
// the strategy declarations only use members of the same set — so the two
// assembled bundles cannot drift and the golden-replay parity stays mechanical.
export const BUNDLE_PROVIDER_TECHNICALS: BundleProvider = 'technicals';
export const BUNDLE_PROVIDER_OVERRIDE: BundleProvider = 'override';
// Per-(profile, symbol) discovery entry hint (`enterOnAdd`). A strategy that
// declares it gets a non-destructive read of the discovery-written Redis hash
// injected as `bundle.entryHint`; a strategy that omits it pays no round-trip.
export const BUNDLE_PROVIDER_ENTRY_HINT: BundleProvider = 'entry-hint';
