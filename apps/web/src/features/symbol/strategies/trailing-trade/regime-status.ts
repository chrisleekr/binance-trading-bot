// Regime-exit "when will I be sold to cash" readout — the display-only mirror
// of the worker's `evaluateRegimeExit` (packages/strategy-trailing-trade).
//
// The worker is authoritative; this recomputes the verdict in Number math from
// the public daily candles so the operator sees a live countdown ("2 of 3
// closes below the line") instead of finding out only after the sell lands in
// Order History. Same decimal-barred-web pattern as the price targets in
// signal-panel.tsx — never feeds an order.

import type { CandleList } from '@app/contracts';

import { asRecord, parseNum } from './lib.js';

const DAY_MS = 86_400_000;

/** Simple moving average of the trailing `period` closes. Mirrors `@app/indicators` `sma`. */
const smaN = (closes: readonly number[], period: number): number => {
  const tail = closes.slice(closes.length - period);
  return tail.reduce((acc, c) => acc + c, 0) / period;
};

/**
 * EMA seeded from the SMA of the first `period` closes, then smoothed across
 * the rest with k = 2/(period+1). Mirrors `@app/indicators` `ema`. The value
 * converges to the worker's only with enough warm-up candles, so the caller
 * fetches several multiples of `period` (see REGIME_FRAMES).
 */
const emaN = (closes: readonly number[], period: number): number => {
  const k = 2 / (period + 1);
  let value = smaN(closes.slice(0, period), period);
  for (const c of closes.slice(period)) value = (c - value) * k + value;
  return value;
};

/**
 * Live regime-exit verdict for the operator readout.
 *
 *   - `disabled`    : cash rotation is off (the common path).
 *   - `unavailable` : too few CLOSED daily candles to confirm — the worker is
 *     inert here too (fail-safe: never sells / freezes on no data).
 *   - `watching`    : enabled and computable; `below` of `confirmBars` recent
 *     closes are under the line. `below === 0` is a healthy uptrend; `below`
 *     between 1 and confirmBars-1 is the countdown toward an exit.
 *   - `bear`        : all `confirmBars` recent closes are below the line — the
 *     worker sells the position to cash and blocks new entries until recovery.
 */
export type RegimeExitStatus =
  | { readonly kind: 'disabled' }
  | { readonly kind: 'unavailable'; readonly have: number; readonly need: number }
  | {
      readonly kind: 'watching';
      readonly below: number;
      readonly confirmBars: number;
      readonly ma: number;
      readonly maType: 'sma' | 'ema';
      readonly period: number;
    }
  | {
      readonly kind: 'bear';
      readonly below: number;
      readonly confirmBars: number;
      readonly ma: number;
      readonly maType: 'sma' | 'ema';
      readonly period: number;
    };

/**
 * How many daily candles to request so the EMA warms up close to the worker's
 * value. SMA only needs `period`, but EMA depends on history; ~5x period
 * converges within rounding. Capped at 500 to match the worker's daily ring
 * (`indicator-computer` ringSize), so the EMA seed/walk windows align and the
 * displayed `below` count cannot disagree with the worker near the line.
 */
export const REGIME_FRAMES = (period: number, confirmBars: number): number =>
  Math.min(500, Math.max(period * 5, period + confirmBars + 5));

/**
 * Parse and clamp the regime-exit knobs shared by the candle-query sizing and
 * the verdict computation, or null when the feature is disabled. `period` and
 * `confirmBars` are clamped to >= 1 because the web reads RAW stored config with
 * no schema validation: a stored `0` would otherwise make `period` produce a NaN
 * moving average, or make `confirmBars` report a false `bear` from an empty
 * confirmation window. One parse, one set of defaults, so the fetched window and
 * the verdict can never desync.
 */
export function parseRegimeExitParams(config: Record<string, unknown> | null): {
  readonly maType: 'sma' | 'ema';
  readonly period: number;
  readonly confirmBars: number;
} | null {
  const regime = asRecord(config?.['regime']);
  const onBear = asRecord(regime?.['onBear']);
  if (onBear?.['exitToCash'] !== true) return null;
  return {
    maType: regime?.['ma'] === 'sma' ? 'sma' : 'ema',
    period: Math.max(1, parseNum(regime?.['period']) ?? 200),
    confirmBars: Math.max(1, parseNum(regime?.['confirmBars']) ?? 3),
  };
}

/**
 * Recompute the regime-exit verdict from the daily candle window. `candles` is
 * the raw response from the candles endpoint (most-recent last) and MAY include
 * the still-forming daily bar — it is dropped here so the count matches the
 * worker's closed-candles-only confirmation.
 *
 * @param config the strategy config record (reads `regime.onBear.exitToCash`)
 * @param candles daily (`1d`) OHLCV bars, oldest first
 * @param nowMs current time, for the forming-bar cutoff
 */
export function deriveRegimeExit(
  config: Record<string, unknown> | null,
  candles: CandleList | undefined,
  nowMs: number = Date.now(),
): RegimeExitStatus {
  const params = parseRegimeExitParams(config);
  if (params === null) return { kind: 'disabled' };
  const { maType, period, confirmBars } = params;
  const need = Math.max(period, confirmBars);

  // Closed candles only: a 1d bar is closed once its open time + 1 day has
  // passed. Drops the in-progress daily bar the endpoint returns as the tail.
  const closed = (candles ?? []).filter((c) => {
    const openMs = Date.parse(c.time);
    return Number.isFinite(openMs) && openMs + DAY_MS <= nowMs;
  });
  const closes = closed.map((c) => Number(c.close)).filter((n) => Number.isFinite(n));
  if (closes.length < need) return { kind: 'unavailable', have: closes.length, need };

  const ma = maType === 'sma' ? smaN(closes, period) : emaN(closes, period);
  const recent = closes.slice(closes.length - confirmBars);
  const below = recent.filter((close) => close < ma).length;
  const base = { below, confirmBars, ma, maType, period } as const;
  return below === confirmBars ? { kind: 'bear', ...base } : { kind: 'watching', ...base };
}

// --- Bull hold (sell-side trail widening) --------------------------------
//
// Display mirror of the worker's bull-hold trail widening (sell-gate.ts). When
// the daily regime is a confirmed bull AND `regime.onBull.hold.enabled`, the
// worker widens the trailing stop (room-mapped) so a routine pullback the normal
// trail would scalp is held; the trail snaps back the moment the bull ends. The
// operator never sees "ATR" — only the plain `room` they chose. Recomputed in
// Number math from the SAME daily candles as the regime-exit readout; never
// feeds an order.

export type BullHoldRoom = 'tight' | 'normal' | 'loose';

/**
 *   - `disabled`    : bull hold is off (the common path).
 *   - `unavailable` : too few CLOSED daily candles to classify — the worker uses
 *     the normal trail here too.
 *   - `holding`     : the last `confirmBars` daily closes are ALL above the line
 *     (a confirmed bull) — the trail is widened to the chosen `room`.
 *   - `inactive`    : enabled but not a confirmed bull (`above` of `confirmBars`
 *     closes are over the line) — the normal trail is in effect.
 */
export type BullHoldStatus =
  | { readonly kind: 'disabled' }
  | { readonly kind: 'unavailable'; readonly have: number; readonly need: number }
  | {
      readonly kind: 'holding';
      readonly room: BullHoldRoom;
      readonly ma: number;
      readonly maType: 'sma' | 'ema';
      readonly period: number;
      readonly confirmBars: number;
    }
  | {
      readonly kind: 'inactive';
      readonly above: number;
      readonly confirmBars: number;
      readonly ma: number;
      readonly maType: 'sma' | 'ema';
      readonly period: number;
    };

const ROOMS: ReadonlySet<string> = new Set(['tight', 'normal', 'loose']);

/**
 * Parse the bull-hold knobs plus the shared regime MA definition, or null when
 * hold is disabled. Reads RAW stored config, so `period`/`confirmBars` clamp to
 * >= 1 exactly like {@link parseRegimeExitParams}; an unrecognised `room` falls
 * back to `normal` (the schema default).
 */
export function parseBullHoldParams(config: Record<string, unknown> | null): {
  readonly maType: 'sma' | 'ema';
  readonly period: number;
  readonly confirmBars: number;
  readonly room: BullHoldRoom;
} | null {
  const regime = asRecord(config?.['regime']);
  const hold = asRecord(asRecord(regime?.['onBull'])?.['hold']);
  if (hold?.['enabled'] !== true) return null;
  const room = hold['room'];
  return {
    maType: regime?.['ma'] === 'sma' ? 'sma' : 'ema',
    period: Math.max(1, parseNum(regime?.['period']) ?? 200),
    confirmBars: Math.max(1, parseNum(regime?.['confirmBars']) ?? 3),
    room: typeof room === 'string' && ROOMS.has(room) ? (room as BullHoldRoom) : 'normal',
  };
}

/**
 * Recompute the bull-hold verdict from the daily candle window. Bull = the last
 * `confirmBars` CLOSED daily closes are ALL strictly above the regime MA (the
 * exact mirror of the worker's `classifyRegime` bull branch).
 *
 * @param config the strategy config record (reads `regime.onBull.hold`)
 * @param candles daily (`1d`) OHLCV bars, oldest first
 * @param nowMs current time, for the forming-bar cutoff
 */
export function deriveBullHold(
  config: Record<string, unknown> | null,
  candles: CandleList | undefined,
  nowMs: number = Date.now(),
): BullHoldStatus {
  const params = parseBullHoldParams(config);
  if (params === null) return { kind: 'disabled' };
  const { maType, period, confirmBars, room } = params;
  const need = Math.max(period, confirmBars);

  const closed = (candles ?? []).filter((c) => {
    const openMs = Date.parse(c.time);
    return Number.isFinite(openMs) && openMs + DAY_MS <= nowMs;
  });
  const closes = closed.map((c) => Number(c.close)).filter((n) => Number.isFinite(n));
  if (closes.length < need) return { kind: 'unavailable', have: closes.length, need };

  const ma = maType === 'sma' ? smaN(closes, period) : emaN(closes, period);
  const recent = closes.slice(closes.length - confirmBars);
  const above = recent.filter((close) => close > ma).length;
  return above === confirmBars
    ? { kind: 'holding', room, ma, maType, period, confirmBars }
    : { kind: 'inactive', above, confirmBars, ma, maType, period };
}
