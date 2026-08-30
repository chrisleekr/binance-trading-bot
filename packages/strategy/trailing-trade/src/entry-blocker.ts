import type { EntryBlocker } from './schema.js';
import type { FirstBuySkipReason } from './quantity.js';
import type { EntrySizingSkip } from './sizing.js';
import type { TVGateVeto } from './technicals-gate.js';
import type { IndicatorGateVeto } from './indicator-gate.js';
import type { RiskCap } from './branches/risk-caps.js';
import type { RegimeVeto } from './branches/regime-filter.js';
import type { ChaseGuardVeto, KnifeGuardVeto } from './branches/entry-guards.js';

/**
 * Every reason code a producer can emit through {@link resolveEntryBlocker}.
 * Kept assignable to the schema enum below so a future producer rename that
 * drifts from {@link EntryBlocker} fails to compile rather than silently
 * shipping a reason the schema rejects at parse time.
 */
type ProducedReason =
  | TVGateVeto
  | IndicatorGateVeto
  | RiskCap
  | RegimeVeto
  | FirstBuySkipReason
  | EntrySizingSkip
  | 'discovery-no-stop'
  | 'chase-guard'
  | 'knife-guard'
  | 'regime-exit-bear'
  | 'regime-not-uptrend'
  | 'force-sell-cooldown'
  | 'loss-cooldown'
  | 'technicals-confirming'
  | 'awaiting-trigger-price';

// Compile-time guard: the producer reason union must be a subset of the schema
// enum. Drift in either direction surfaces here as a type error.
type _ProducedReasonInSchema = ProducedReason extends EntryBlocker['reason'] ? true : never;
const _producedReasonInSchema: _ProducedReasonInSchema = true;
void _producedReasonInSchema;

/**
 * Detail carried out of the grid `wait` (lowest-price first-buy deferral) so the
 * resolver can emit `awaiting-trigger-price` with the numbers that explain the
 * wait. Prices are decimal-strings (the strategy boundary forbids `number` for
 * money); the trigger is the configured level-0 multiplier string.
 */
export interface AwaitingTriggerDetail {
  readonly windowLow: string;
  readonly triggerPercentage: string;
  readonly currentPrice: string;
}

/**
 * The collected buy-path veto locals plus the grid wait context. Every field is
 * the same value `buyAndSnapshotBranch` already accumulates; the resolver reads
 * them in a fixed priority and never re-evaluates a gate.
 */
export interface EntryBlockerContext {
  readonly forceSellCooled: boolean;
  readonly forceSellDetail?: Readonly<Record<string, unknown>> | undefined;
  readonly lossExitCooled: boolean;
  readonly lossDetail?: Readonly<Record<string, unknown>> | undefined;
  readonly regimeEntryBlock: Readonly<Record<string, unknown>> | null;
  /** When the block above is the require-uptrend gate, not the bear block. */
  readonly regimeRequireUptrend: boolean;
  readonly regimeVeto: {
    readonly reason: RegimeVeto;
    readonly context: Readonly<Record<string, unknown>>;
  } | null;
  readonly riskCapVeto: {
    readonly cap: RiskCap;
    readonly context: Readonly<Record<string, unknown>>;
  } | null;
  readonly guardrailVeto: {
    readonly reason: 'discovery-no-stop';
    readonly context: Readonly<Record<string, unknown>>;
  } | null;
  // Discovery anti-chase vetoes: the price is within the configured
  // distance of the 24h high (chase) or the window is still falling (knife).
  // Both are discovery-entry-only and pre-empt a bullish-technicals entry.
  readonly chaseGuardVeto: ChaseGuardVeto | null;
  readonly knifeGuardVeto: KnifeGuardVeto | null;
  readonly tvVeto: {
    readonly reason: TVGateVeto;
    readonly detail?: Readonly<Record<string, unknown>> | undefined;
  } | null;
  // The technicals gate ALLOWED this tick but the consecutive-allow streak has
  // not yet reached the configured `entryConfirmReads` threshold, so the first
  // buy waits for confirmation. detail carries { reads, required } for the gloss.
  readonly technicalsConfirming: {
    readonly detail: Readonly<Record<string, unknown>>;
  } | null;
  readonly indicatorVeto: {
    readonly reason: IndicatorGateVeto;
    readonly context: Readonly<Record<string, unknown>>;
  } | null;
  readonly awaitingTrigger: AwaitingTriggerDetail | null;
  readonly skipReason: FirstBuySkipReason | EntrySizingSkip | null;
}

/**
 * Resolve the single structured reason the buy path did not place an order this
 * tick, or null when nothing was blocking. Pure: no I/O, no clock.
 *
 * Priority (highest first), so the surfaced reason is the dominant cause when
 * several could apply this tick:
 *
 *   1. force-sell-cooldown — a prior force-sell suppresses any re-entry.
 *   2. loss-cooldown — a prior LOSS exit suppresses any re-entry.
 *   3. regime-exit-bear / regime-not-uptrend — a regime gate refuses a fresh
 *      entry: the bear block / cash rotation (confirmed bear) or the
 *      require-uptrend gate (no confirmed bull). Both ride the regimeEntryBlock
 *      slot; the regimeRequireUptrend flag picks the reason.
 *   4. regime (downtrend / unavailable) — a promotion halted by the daily trend.
 *   5. risk caps (exposure / account / loss budget) — an opted-in cap refused.
 *   6. discovery-no-stop — a discovery entry lacked the required hard stop.
 *   7. chase-guard — a discovery entry is within the configured % of the 24h high.
 *   8. knife-guard — a discovery entry's window is still falling past the drop %.
 *   9. technicals (sell > disallowed > stale > no-signal) — the TV gate vetoed the entry.
 *  10. technicals-confirming — the TV gate allowed but the confirm streak is short.
 *  11. indicator (rsi / sma / ema / unavailable) — the indicator gate vetoed.
 *  12. awaiting-trigger-price — lowest-price first-buy is waiting for a dip.
 *  13. qty skip (min-qty / min-notional / min-purchase / invalid-filters).
 *
 * detail stays sparse — only the values the gloss needs.
 */
export const resolveEntryBlocker = (ctx: EntryBlockerContext): EntryBlocker | null => {
  if (ctx.forceSellCooled) {
    return {
      reason: 'force-sell-cooldown',
      ...(ctx.forceSellDetail ? { detail: ctx.forceSellDetail } : {}),
    };
  }
  if (ctx.lossExitCooled) {
    return {
      reason: 'loss-cooldown',
      ...(ctx.lossDetail ? { detail: ctx.lossDetail } : {}),
    };
  }
  if (ctx.regimeEntryBlock !== null) {
    return {
      reason: ctx.regimeRequireUptrend ? 'regime-not-uptrend' : 'regime-exit-bear',
      detail: ctx.regimeEntryBlock,
    };
  }
  if (ctx.regimeVeto !== null) {
    return { reason: ctx.regimeVeto.reason, detail: ctx.regimeVeto.context };
  }
  if (ctx.riskCapVeto !== null) {
    return { reason: ctx.riskCapVeto.cap, detail: ctx.riskCapVeto.context };
  }
  if (ctx.guardrailVeto !== null) {
    return { reason: ctx.guardrailVeto.reason, detail: ctx.guardrailVeto.context };
  }
  if (ctx.chaseGuardVeto !== null) {
    return { reason: 'chase-guard', detail: { ...ctx.chaseGuardVeto } };
  }
  if (ctx.knifeGuardVeto !== null) {
    return { reason: 'knife-guard', detail: { ...ctx.knifeGuardVeto } };
  }
  if (ctx.tvVeto !== null) {
    return {
      reason: ctx.tvVeto.reason,
      ...(ctx.tvVeto.detail ? { detail: ctx.tvVeto.detail } : {}),
    };
  }
  if (ctx.technicalsConfirming !== null) {
    return { reason: 'technicals-confirming', detail: ctx.technicalsConfirming.detail };
  }
  if (ctx.indicatorVeto !== null) {
    return { reason: ctx.indicatorVeto.reason, detail: ctx.indicatorVeto.context };
  }
  if (ctx.awaitingTrigger !== null) {
    return { reason: 'awaiting-trigger-price', detail: { ...ctx.awaitingTrigger } };
  }
  if (ctx.skipReason !== null) {
    return { reason: ctx.skipReason };
  }
  return null;
};
