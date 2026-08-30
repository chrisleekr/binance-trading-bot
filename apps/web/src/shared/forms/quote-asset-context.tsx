import { createContext, useContext, type ReactNode } from 'react';

// A money field in a generated form has no way to say what unit it is in: the JSON Schema carries a type and a description, never the profile's quote asset. Typing "0.01" into a daily-loss limit means one thing on a USDT profile and something ~100,000x larger on a BTC-quoted one, so the unit has to reach the control itself rather than living in prose the operator may not read.
//
// Kept generic and defaulted to `null` so the widget registry stays strategy-agnostic: a form that does not mount the provider renders exactly as before, with no unit decoration and no layout change.

const QuoteAssetContext = createContext<string | null>(null);

/**
 * Supplies the quote asset that money-shaped fields inside `children` are denominated in.
 *
 * @param quoteAsset - Ticker of the profile's quote asset, e.g. `USDT` or `BTC`. Pass `null` when it is not yet known so controls fall back to no decoration rather than guessing a unit.
 * @param children - The form subtree the unit applies to.
 * @returns The provider element.
 */
export function QuoteAssetProvider({
  quoteAsset,
  children,
}: {
  readonly quoteAsset: string | null;
  readonly children: ReactNode;
}): React.JSX.Element {
  return <QuoteAssetContext.Provider value={quoteAsset}>{children}</QuoteAssetContext.Provider>;
}

/**
 * The quote asset money fields in this form are denominated in.
 *
 * @returns The ticker, or `null` when no provider is mounted or the asset is not yet known — callers render undecorated rather than guessing a unit.
 */
export function useQuoteAsset(): string | null {
  return useContext(QuoteAssetContext);
}
