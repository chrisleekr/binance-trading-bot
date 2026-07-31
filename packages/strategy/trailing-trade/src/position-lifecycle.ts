// Canonical position-lifecycle field sets. The TT position is cleared from six
// sites (three sell-side resets in tick.ts, the lbp-clear, and the two
// position-adapter resets); each previously hand-enumerated the same fields, so
// adding one position-scoped field (the bull-pyramid and discovery features each
// did) meant six synchronized edits and a missed site shipped the "undefined
// slips past a `=== null` guard" bug. These helpers + the key list are the single
// source those sites and the normalize/parity tests share.

import type { TTState } from './schema.js';

/**
 * Every position-scoped state key — i.e. every `TTState` field except the
 * `schemaVersion` literal and the `triggers` envelope. `normalizeTickState`
 * coerces exactly this set so a key absent from an at-version row reads as its
 * contract default instead of `undefined`; the key-parity test ties this list
 * to `TTStateSchema.shape` so a new state field cannot be added without being
 * routed through the normalize/reset machinery.
 */
export const POSITION_LIFECYCLE_KEYS = [
  'avgEntryPrice',
  'heldQuantity',
  'disabledUntilMs',
  'highSinceBuy',
  'breakEvenArmed',
  'currentGridTradeIndex',
  'autoTriggerBuyAtMs',
  'bullAddCount',
  'lastBullAddPrice',
  'discoveryEntry',
  'entryAtMs',
  'forceSellFirstSeenAtMs',
  'forceSellCooldownUntilMs',
  'lastLossExitAt',
  'lastLossExitReason',
  'entryConfirmCount',
  'entryBlocker',
  'protectiveStopBlocker',
] as const satisfies readonly (keyof TTState)[];

/**
 * The bull-pyramid + discovery position-tracking fields, reset together on every
 * full position close. Isolated because this is the group that churned across all
 * six reset sites; a new tracking field is now one edit here.
 */
export const clearedAddTracking = (): Pick<
  TTState,
  'bullAddCount' | 'lastBullAddPrice' | 'discoveryEntry' | 'entryAtMs'
> => ({
  bullAddCount: null,
  lastBullAddPrice: null,
  discoveryEntry: false,
  entryAtMs: null,
});

/**
 * Fields cleared on a sell-side full exit (technicals force-sell, sell gate,
 * regime exit). `heldQuantity` is deliberately excluded — the fill-adopter owns
 * that transition on the executionReport, and an optimistic clear would
 * under-size a follow-up sell in the partial-fill window. `autoTriggerBuyAtMs`
 * varies by exit: a re-arm timestamp after a timed exit, `null` after a regime
 * exit (re-entry waits for the regime to recover, not a fixed timer).
 */
export const clearedSellPosition = (
  autoTriggerBuyAtMs: number | null,
): Pick<
  TTState,
  | 'avgEntryPrice'
  | 'highSinceBuy'
  | 'breakEvenArmed'
  | 'currentGridTradeIndex'
  | 'bullAddCount'
  | 'lastBullAddPrice'
  | 'discoveryEntry'
  | 'entryAtMs'
  | 'autoTriggerBuyAtMs'
  | 'forceSellFirstSeenAtMs'
  | 'entryConfirmCount'
  | 'protectiveStopBlocker'
> => ({
  avgEntryPrice: null,
  // The stop-arm blocker is position-scoped: with the position gone there is
  // nothing left to protect, so a stale "unprotected" warning must not survive
  // the close.
  protectiveStopBlocker: null,
  highSinceBuy: null,
  // Mirrors highSinceBuy: a closed position must disarm the break-even stop so
  // a fresh entry re-arms from scratch.
  breakEvenArmed: false,
  currentGridTradeIndex: null,
  ...clearedAddTracking(),
  autoTriggerBuyAtMs,
  // The confirm-window tracker is position-scoped: with the position gone any
  // pending trigger is moot. The re-entry cooldowns (forceSellCooldownUntilMs,
  // lastLossExitAt / lastLossExitReason) deliberately survive the close — their
  // emit sites stamp them — so they are NOT reset here. entryConfirmCount is the
  // technicals-hysteresis streak: a closed position starts a fresh entry, so the
  // next first buy must re-confirm from zero.
  forceSellFirstSeenAtMs: null,
  entryConfirmCount: 0,
});
