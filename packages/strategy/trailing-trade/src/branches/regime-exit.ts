import type { TechnicalsBundle } from '@app/contracts';
import type { MarketSnapshot } from '@app/strategy-core';
import type { TTConfig, TTRegime } from '../schema.js';
import { classifyRegime } from './regime.js';

/**
 * Verdict from the daily regime gate, shared by two evaluators:
 *   - {@link evaluateRegimeExit} (sell side) — gated on `onBear.exitToCash`; exits
 *     the whole position to cash on a confirmed `bear`.
 *   - {@link evaluateRegimeEntryBlock} (entry side) — gated on `onBear.exitToCash`
 *     OR `onBear.blockEntry`; suppresses a fresh entry on a confirmed `bear`.
 *
 *   - `disabled`    : the consulting gate's toggle(s) are off, so it is inert
 *     (exit: `exitToCash` unset; entry-block: BOTH `exitToCash` and `blockEntry`
 *     unset).
 *   - `unavailable` : the daily window is too short to confirm. FAIL-SAFE — the
 *     caller neither sells nor blocks entry. This is the OPPOSITE of the
 *     promotion suppressor's fail-closed: for a safety exit, liquidating (or
 *     freezing entries) on missing data is the destructive direction, so the
 *     rotation stays fully inert until it has enough daily candles.
 *   - `bear`        : the last `confirmBars` CLOSED daily candles all closed
 *     below the regime MA — a confirmed higher-timeframe downtrend.
 *   - `ok`          : enabled and evaluated, regime not (yet) confirmed bear
 *     (a `bull` or `neutral` classification).
 */
export type RegimeExitVerdict =
  | { readonly kind: 'disabled' }
  | { readonly kind: 'unavailable'; readonly context: Readonly<Record<string, unknown>> }
  | { readonly kind: 'bear'; readonly context: Readonly<Record<string, unknown>> }
  | { readonly kind: 'ok'; readonly context: Readonly<Record<string, unknown>> };

/**
 * Opt-in cash-rotation regime gate. Confirms a daily downtrend via
 * {@link classifyRegime} (closes-only over `confirmBars`, whipsaw-resistant near
 * the line) and reports the verdict the sell gate and entry guard consume. Pure
 * and stateless.
 *
 * @param market the tick's market snapshot (reads `candlesByInterval['1d']`)
 * @param config the strategy config (reads the unified `regime` block)
 */
/**
 * Classify the daily regime into the gate verdict (the shared body of the two
 * gates below). Reads `candlesByInterval['1d']`; `bull` / `neutral` both fold to
 * `ok` ("not confirmed bear").
 */
const classifyForGate = (market: MarketSnapshot, regime: TTRegime): RegimeExitVerdict => {
  const { regime: verdict, context } = classifyRegime(market, {
    ma: regime.ma,
    period: regime.period,
    confirmBars: regime.confirmBars,
  });
  switch (verdict) {
    case 'unavailable':
      return { kind: 'unavailable', context };
    case 'bear':
      return { kind: 'bear', context };
    default:
      return { kind: 'ok', context };
  }
};

export const evaluateRegimeExit = (market: MarketSnapshot, config: TTConfig): RegimeExitVerdict => {
  // Read tolerantly: the live worker passes the RAW stored profile config to
  // tick() (build-tick-input.ts) without applying schema defaults. Treat a
  // missing block / toggle as disabled — the opt-in default — instead of
  // throwing on `.onBear.exitToCash`.
  const regime = config.regime as TTRegime | undefined;
  if (regime?.onBear?.exitToCash !== true) return { kind: 'disabled' };
  return classifyForGate(market, regime);
};

/**
 * Entry-block half of the regime gate. Reports a confirmed bear when EITHER
 * bear-side entry toggle is set:
 *   - `onBear.exitToCash` — the entry-suppression that rides with cash rotation
 *     (so enabling exitToCash blocks entries exactly as before).
 *   - `onBear.blockEntry` — a lighter-touch gate: sit out a confirmed downtrend
 *     by refusing fresh first entries, WITHOUT force-selling existing holdings.
 * The sell side stays gated on `exitToCash` alone (see {@link evaluateRegimeExit});
 * this evaluator never drives a sell. Same confirmed-bear signal and fail-safe
 * (`unavailable` → caller stays inert) as the exit.
 */
export const evaluateRegimeEntryBlock = (
  market: MarketSnapshot,
  config: TTConfig,
): RegimeExitVerdict => {
  const regime = config.regime as TTRegime | undefined;
  if (regime?.onBear?.exitToCash !== true && regime?.onBear?.blockEntry !== true) {
    return { kind: 'disabled' };
  }
  return classifyForGate(market, regime);
};

/**
 * Outcome of the require-uptrend entry gate. `block` covers neutral, bear, AND
 * unavailable — the gate is the opposite fail-direction from the bear block: it
 * requires a POSITIVE bull confirmation to open, so absent/insufficient data
 * keeps the bot out rather than guessing (a long-only dip-buyer set to "only
 * trade uptrends" should not deploy when it cannot prove an uptrend exists).
 */
export type RegimeEntryRequireVerdict =
  | { readonly kind: 'disabled' }
  | { readonly kind: 'allow'; readonly context: Readonly<Record<string, unknown>> }
  | { readonly kind: 'block'; readonly context: Readonly<Record<string, unknown>> };

/**
 * Require-uptrend entry gate (opt-in via `onBull.requireEntry`). Permits a fresh
 * first entry only on a confirmed daily `bull`; neutral, bear, and unavailable
 * all block. Independent of the bear block and its re-arm: this is "only deploy
 * into a real uptrend", not "avoid a confirmed downtrend". Pure and stateless;
 * reads RAW config tolerantly like the gates above.
 */
export const evaluateRegimeEntryRequirement = (
  market: MarketSnapshot,
  config: TTConfig,
): RegimeEntryRequireVerdict => {
  const regime = config.regime as TTRegime | undefined;
  if (regime?.onBull?.requireEntry !== true) return { kind: 'disabled' };
  const { regime: verdict, context } = classifyRegime(market, {
    ma: regime.ma,
    period: regime.period,
    confirmBars: regime.confirmBars,
  });
  return verdict === 'bull' ? { kind: 'allow', context } : { kind: 'block', context };
};

/**
 * Outcome of the entry re-arm consult. Consulted ONLY when the entry-block gate
 * has already reported a confirmed bear, so `blocked` simply keeps that block.
 */
export type RegimeRearmVerdict =
  | { readonly kind: 'blocked' }
  | { readonly kind: 'rearmed'; readonly context: Readonly<Record<string, unknown>> };

/**
 * Entry re-arm override. A confirmed daily bear (the slow EMA/SMA line over
 * `confirmBars` closes) is whipsaw-resistant but lags the recovery: price only
 * reclaims a long daily MA well into the next up-leg. This optional override
 * lets entries resume earlier when a FASTER Technical Rating confirms the turn,
 * trading the asymmetry "slow to call bear, fast to re-arm" without loosening
 * the bear definition itself.
 *
 * Scope and fail-safes (all deliberate):
 *  - Opt-in: off unless `regime.onBear.rearm.enabled === true`.
 *  - blockEntry-only: never fires while `onBear.exitToCash` is on — re-arming an
 *    entry during cash rotation would buy straight back into the bear it just
 *    sold out of.
 *  - Fail-CLOSED on the signal (the opposite of the entry block's fail-safe):
 *    a missing, stale, or sub-threshold rating keeps the block. Overriding a
 *    downtrend protection on absent data is the destructive direction.
 *  - Freshness is enforced regardless of the bundle's `ifExpires` setting: a
 *    stale rating is not a reliable "turning now" read, so `allow-anyway` (which
 *    the buy gate honours) must not re-arm a bear entry. Clock-skew clamp mirrors
 *    the buy gate (a future-dated producer clock counts as fresh, not stale).
 *
 * Trust note: the rating comes from the worker-written Redis cache (single-tenant
 * threat model). Re-arm turns a forged rating into a downtrend-protection bypass,
 * not just a buy-filter pass, so it inherits that trust assumption — the risk rises
 * if the cache is ever exposed beyond the single host.
 *
 * Read tolerantly like the gates above: the live worker passes RAW stored config.
 */
export const evaluateRegimeRearm = (
  tv: TechnicalsBundle,
  config: TTConfig,
  nowMs: number,
): RegimeRearmVerdict => {
  const regime = config.regime as TTRegime | undefined;
  const rearm = regime?.onBear?.rearm;
  if (rearm?.enabled !== true || regime?.onBear?.exitToCash === true) {
    return { kind: 'blocked' };
  }
  const signal = tv.signals.find((s) => s.interval === rearm.interval)?.signal ?? null;
  if (signal === null) return { kind: 'blocked' };
  const maxAgeMs = tv.config.useOnlyWithinMin * 60_000;
  const rawAgeMs = nowMs - signal.receivedAtMs;
  const ageMs = rawAgeMs < 0 ? 0 : rawAgeMs;
  if (ageMs > maxAgeMs) return { kind: 'blocked' };
  // STRONG_BUY always confirms; a plain BUY confirms only when the operator
  // lowered the bar to BUY.
  const confirmed =
    signal.recommendation === 'STRONG_BUY' ||
    (rearm.minRecommendation === 'BUY' && signal.recommendation === 'BUY');
  if (!confirmed) return { kind: 'blocked' };
  return {
    kind: 'rearmed',
    context: {
      interval: rearm.interval,
      recommendation: signal.recommendation,
      minRecommendation: rearm.minRecommendation,
    },
  };
};
