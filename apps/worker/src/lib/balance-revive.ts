// Strategy-boundary balance revival.
//
// `Balance.free` / `Balance.locked` are `Decimal` on the strategy contract
// but decimal-strings on every wire (Redis `account-info` blob, Binance
// REST DTOs, replay JSONL fixtures). This module is the single revival
// site each producer routes through so the wire-tolerance rules (degrade
// to zero on a malformed string + surface the degrade via `onWarn`) cannot
// drift between producers.

import { Decimal, isPlainDecimalString } from '@app/money';

/**
 * Optional callback fired when a wire balance string fails to parse as a
 * `Decimal`. The boundary degrades the asset to zero so the tick can still
 * run, but the caller logs the degrade so it does not pass silently
 * (CLAUDE.md: "no silent failures"). Tests omit the callback.
 */
export type BalanceParseWarn = (info: {
  readonly asset: string;
  readonly field: 'free' | 'locked';
  readonly raw: string;
}) => void;

/** Revive one wire-string balance field as a Decimal, degrading to 0 on parse failure. */
export const reviveBalanceField = (
  asset: string,
  field: 'free' | 'locked',
  raw: string,
  onWarn?: BalanceParseWarn,
): Decimal => {
  // Shares the canonical plain-decimal grammar with the persistence
  // boundary so the two sites cannot drift. Rejecting non-plain strings
  // (e.g. "Infinity", which `new Decimal` would otherwise accept as a
  // non-finite value and poison downstream math) degrades to zero + warn.
  if (!isPlainDecimalString(raw)) {
    onWarn?.({ asset, field, raw });
    return new Decimal(0);
  }
  return new Decimal(raw);
};
