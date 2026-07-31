import { createContext, useContext, type ReactNode } from 'react';

/**
 * Account equity available to the surrounding form, for widgets that translate
 * a percent-of-account input into a concrete quote figure (the Amount-or-%
 * control's "≈ N USDT" preview). `equityQuote` is a display-only Number —
 * apps/web is barred from decimal.js, and the worker re-derives equity in
 * Decimal at decision time, so this never feeds an order.
 */
export interface FormEquity {
  readonly quoteAsset: string;
  /** Quote cash (free + locked) + deployed cost-basis across the account. */
  readonly equityQuote: number;
}

// Default null: a form rendered without a provider (the symbol drawer, the
// create-profile wizard) has no equity context, and the widget falls back to
// its static gloss rather than showing a wrong number.
const FormEquityContext = createContext<FormEquity | null>(null);

/**
 * Provide account equity to the form subtree. Sits outside `AutoForm`'s
 * `FormProvider` (the two contexts are independent), so `AutoForm` stays a
 * generic schema renderer that knows nothing about money.
 */
export function FormEquityProvider({
  value,
  children,
}: {
  readonly value: FormEquity | null;
  readonly children: ReactNode;
}): React.JSX.Element {
  return <FormEquityContext.Provider value={value}>{children}</FormEquityContext.Provider>;
}

/** Read the surrounding form's account equity, or null when none is provided. */
export function useFormEquity(): FormEquity | null {
  return useContext(FormEquityContext);
}
