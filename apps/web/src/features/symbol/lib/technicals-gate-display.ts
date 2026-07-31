// Display-only Technicals gate evaluators. Pure, single-interval scope.
// The strategy (packages/strategy/trailing-trade/src/{technicals-gate,technicals-force-sell}.ts)
// remains the source of truth for trading decisions. Cross-interval priority
// and force-sell price/profit guards live there, not here.
//
// Invariants kept identical to the strategy, per CLAUDE.md:
//   1. NEUTRAL never vetoes; SELL/STRONG_SELL always veto.
//   2. Stale signal vetoes the buy unless ifExpires === 'allow-anyway'.
//   3. Sell side ignores stale unconditionally (ifExpires is buy-only).
//   4. An interval with an empty allow-buy set is non-participating in
//      the buy gate (force-sell pressure only).

import { allowBuySet, forceSellTriggers } from '@app/contracts';
import type {
  TechnicalsIntervalConfig,
  TechnicalsRecommendation,
  TechnicalsSignal,
} from '@app/contracts';

/** A signal that always passes the buy gate (NEUTRAL falls through). */
const NEVER_VETO: ReadonlySet<TechnicalsRecommendation> = new Set(['NEUTRAL']);
/** A signal that always vetoes the buy gate, regardless of toggles. */
const ALWAYS_VETO: ReadonlySet<TechnicalsRecommendation> = new Set(['SELL', 'STRONG_SELL']);

/** Tagged-union of the buy-gate's per-interval status, display-only. */
export type BuyGateStatus =
  | { readonly kind: 'inactive'; readonly reason: 'no-toggles' }
  | { readonly kind: 'pending'; readonly reason: 'no-signal' }
  | { readonly kind: 'pass'; readonly recommendation: TechnicalsRecommendation }
  | {
      readonly kind: 'block';
      readonly reason: 'stale' | 'sell' | 'not-allowed';
      readonly recommendation: TechnicalsRecommendation | null;
    };

/** Tagged-union of the force-sell branch's per-interval status, display-only. */
export type ForceSellStatus =
  | { readonly kind: 'inactive'; readonly reason: 'no-toggles' }
  | { readonly kind: 'pending'; readonly reason: 'no-signal' | 'stale' }
  | { readonly kind: 'armed'; readonly recommendation: TechnicalsRecommendation }
  | { readonly kind: 'idle'; readonly recommendation: TechnicalsRecommendation };

/**
 * Per-interval buy-gate status for the panel. `inactive` means the row
 * is configured for force-sell only; `pending` means the compute job
 * has not produced a signal yet for this interval; `pass`/`block` mirror
 * the strategy's first-veto decision restricted to this single row.
 */
export const evaluateBuyGateForInterval = (
  row: TechnicalsIntervalConfig,
  signal: TechnicalsSignal | null,
  useOnlyWithinMin: number,
  ifExpires: 'do-not-buy' | 'allow-anyway',
  nowMs: number,
): BuyGateStatus => {
  const allowed = allowBuySet(row);
  if (allowed.size === 0) return { kind: 'inactive', reason: 'no-toggles' };
  if (signal === null) return { kind: 'pending', reason: 'no-signal' };
  const maxAgeMs = useOnlyWithinMin * 60_000;
  const ageMs = Math.max(0, nowMs - signal.receivedAtMs);
  if (ageMs > maxAgeMs && ifExpires === 'do-not-buy') {
    return { kind: 'block', reason: 'stale', recommendation: signal.recommendation };
  }
  if (NEVER_VETO.has(signal.recommendation)) {
    return { kind: 'pass', recommendation: signal.recommendation };
  }
  if (ALWAYS_VETO.has(signal.recommendation)) {
    return { kind: 'block', reason: 'sell', recommendation: signal.recommendation };
  }
  if (allowed.has(signal.recommendation)) {
    return { kind: 'pass', recommendation: signal.recommendation };
  }
  return { kind: 'block', reason: 'not-allowed', recommendation: signal.recommendation };
};

/**
 * Per-interval force-sell status for the panel. `inactive` when the row
 * has no sell toggles; `pending` when the signal is missing or stale
 * (sell side ignores stale regardless of `ifExpires`); `armed`
 * when the current signal is in the row's force-sell trigger set; `idle`
 * otherwise. The display does not evaluate the strategy's profit /
 * below-trigger price guards — those live in the executor.
 */
export const evaluateForceSellForInterval = (
  row: TechnicalsIntervalConfig,
  signal: TechnicalsSignal | null,
  useOnlyWithinMin: number,
  nowMs: number,
): ForceSellStatus => {
  const triggers = forceSellTriggers(row);
  if (triggers.size === 0) return { kind: 'inactive', reason: 'no-toggles' };
  if (signal === null) return { kind: 'pending', reason: 'no-signal' };
  const maxAgeMs = useOnlyWithinMin * 60_000;
  const ageMs = Math.max(0, nowMs - signal.receivedAtMs);
  if (ageMs > maxAgeMs) return { kind: 'pending', reason: 'stale' };
  if (triggers.has(signal.recommendation)) {
    return { kind: 'armed', recommendation: signal.recommendation };
  }
  return { kind: 'idle', recommendation: signal.recommendation };
};
