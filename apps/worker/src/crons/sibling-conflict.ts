// Account-level symbol exclusivity for discovery auto-admission.
//
// Sibling profiles under one Binance account share one wallet, so a base asset
// is a single balance line that at most one profile may size sells and arm stops
// against. Discovery must refuse a candidate that collides with a sibling in
// either direction:
//
//   - a sibling already TRADES the candidate's base (BTCUSDT vs a sibling's
//     BTCFDUSD — one BTC balance), or
//   - a sibling QUOTES in the candidate's base (a Momentum BTCUSDT candidate
//     while a TrailingTrade sibling settles in BTC — its sells move the same BTC
//     line this candidate would buy).
//
// The precedence and matching are a pure function of plain data so they are
// unit-testable without a DB; the worker port supplies the two DB-derived
// inputs.

import type { SiblingConflictDisposition } from '@app/discovery';

/** A sibling-exclusivity verdict, or null when the candidate is free to admit. */
export type SiblingConflict = SiblingConflictDisposition | null;

/**
 * Quote assets of the sibling profiles that share this account's wallet, with
 * the current profile excluded. Callers pass the account-scoped profile list
 * (`profiles.listForAccount`), so a profile in another `binance_mode` — which is
 * necessarily under another account, since one account owns exactly one mode —
 * is never in `profiles` to begin with; only self needs dropping here.
 *
 * Uppercased at this read boundary so the match against an exchangeInfo-derived
 * (always-uppercase) candidate base holds even if a writer stored the column
 * un-normalised (the API PATCH normalises; a seed / future create path might
 * not) — mirrors the same guard in the cron's config read.
 */
export const siblingQuoteAssets = (
  profiles: readonly { readonly id: string; readonly quoteAsset: string }[],
  selfProfileId: string,
): string[] =>
  profiles.filter((p) => p.id !== selfProfileId).map((p) => p.quoteAsset.toUpperCase());

/**
 * Resolve the account-level conflict for a candidate base asset. `ownedBySibling`
 * is whether a sibling already trades this base (the shared-wallet check); it
 * wins over a mere quote collision because it is the stronger form of the same
 * exclusivity. A base that equals any sibling's quote asset is a quote collision.
 * Otherwise the candidate is free.
 */
export const computeSiblingConflict = (
  candidateBaseAsset: string,
  ownedBySibling: boolean,
  siblingQuotes: readonly string[],
): SiblingConflict => {
  if (ownedBySibling) return 'sibling-owns-base';
  return siblingQuotes.includes(candidateBaseAsset) ? 'sibling-quotes-base' : null;
};
