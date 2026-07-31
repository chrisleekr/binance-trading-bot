import type { MarketSnapshot } from '@app/strategy-core';
import { Decimal } from '@app/money';
import type { TTConfig, TTIndicatorGate } from './schema.js';

/**
 * Veto reasons keep the indicator-gate "no buy" branches distinguishable
 * downstream so observers can tell missing indicator data apart from each
 * threshold rejection. The names are part of the log contract; once
 * dashboards key on them they are expensive to rename. `indicator-rsi`,
 * `-sma`, `-ema` each correspond to one config knob; `indicator-unavailable`
 * covers the cold-boot / short-window case where the gate is armed but the
 * indicator value it needs has not been computed yet.
 */
export type IndicatorGateVeto =
  | 'indicator-unavailable'
  | 'indicator-rsi'
  | 'indicator-sma'
  | 'indicator-ema'
  | 'indicator-mean-reversion';

/** Extra fields merged into the veto LogEntry context so triage sees the values that drove the rejection. */
export type IndicatorGateContext = Readonly<Record<string, unknown>>;

/** Tagged-union result of {@link evaluateIndicatorGate}; preserves the veto reason and context so the caller emits the log without re-deriving it. */
export type IndicatorGateResult =
  | { readonly ok: true }
  | {
      readonly ok: false;
      readonly reason: IndicatorGateVeto;
      readonly context: IndicatorGateContext;
    };

/** The RSI knob is disabled by an empty string or `'0'` (mirrors the other string-decimal config knobs); a single predicate keeps the schema intent and the runtime check from drifting. */
const rsiArmed = (rsiMaxBuy: string): boolean => rsiMaxBuy !== '' && rsiMaxBuy !== '0';

/** True when at least one knob is armed; the all-disabled case short-circuits so a non-opted-in profile never touches the indicator cache. */
const isArmed = (gate: TTIndicatorGate): boolean =>
  rsiArmed(gate.rsiMaxBuy) || gate.smaBias !== 'off' || gate.emaBias !== 'off';

const safeDecimal = (raw: string): Decimal | null => {
  try {
    return new Decimal(raw);
  } catch {
    return null;
  }
};

/**
 * Operator-owned indicator gate for trailing-trade buys. Mirrors
 * {@link evaluateTechnicalsGate}: returns a discriminated union so the caller emits
 * the right `tt-indicator-gate-veto` log per veto path.
 *
 * Fail-closed: when a knob is armed but the indicator value it needs is
 * absent (cold worker, or a candle window shorter than the indicator
 * period) the gate vetoes with `indicator-unavailable` rather than letting
 * the buy through unchecked. The operator opted into the precondition, so
 * blocking until the data exists respects that intent. On a cold worker
 * this veto persists until the candle window reaches the indicator period
 * (e.g. 20 closed candles for SMA/EMA-20, 14 for RSI-14), not merely one
 * candle.
 *
 * All knobs default to disabled, so a profile that has not opted in
 * short-circuits to `{ ok: true }` and the price-only entry behaviour is
 * unchanged.
 */
export const evaluateIndicatorGate = (
  market: MarketSnapshot,
  config: TTConfig,
): IndicatorGateResult => {
  // `indicatorGate` is schema-defaulted, but a profile config row or replay
  // fixture serialised before the field existed can reach here without it.
  // Treat a missing gate as fully disabled — same tolerance the
  // `trailingStopPercentage` handling in tick.ts applies.
  const gate: TTIndicatorGate | undefined = config.buy.indicatorGate;
  if (gate === undefined || !isArmed(gate)) return { ok: true };

  const interval = config.candleInterval;
  const snap = market.indicatorsByInterval?.[interval];
  if (snap === undefined) {
    return {
      ok: false,
      reason: 'indicator-unavailable',
      context: { interval, missing: 'snapshot' },
    };
  }
  const price = safeDecimal(market.currentPrice);
  if (price === null) {
    return {
      ok: false,
      reason: 'indicator-unavailable',
      context: { interval, missing: 'currentPrice' },
    };
  }

  // RSI ceiling: buy only when the market is at or below the configured
  // oversold threshold.
  if (rsiArmed(gate.rsiMaxBuy)) {
    if (snap.rsi14 === null) {
      return {
        ok: false,
        reason: 'indicator-unavailable',
        context: { interval, missing: 'rsi14' },
      };
    }
    // `rsi14` is worker-supplied and can genuinely be a corrupt string;
    // `rsiMaxBuy` is schema-validated, so its parse is belt-and-braces
    // against an upstream skip of validation — kept symmetric for the same
    // reason maybeClearAvgEntryPrice in tick.ts guards its parsed config.
    const rsi = safeDecimal(snap.rsi14);
    const ceiling = safeDecimal(gate.rsiMaxBuy);
    if (rsi === null || ceiling === null) {
      return {
        ok: false,
        reason: 'indicator-unavailable',
        context: { interval, missing: 'rsi14-parse' },
      };
    }
    if (rsi.gt(ceiling)) {
      return {
        ok: false,
        reason: 'indicator-rsi',
        context: { interval, rsi14: snap.rsi14, rsiMaxBuy: gate.rsiMaxBuy },
      };
    }
  }

  if (gate.smaBias !== 'off') {
    const result = checkMaBias(price, snap.sma20, gate.smaBias, 'sma20');
    if (result.kind === 'unavailable') {
      return {
        ok: false,
        reason: 'indicator-unavailable',
        context: { interval, missing: result.missing },
      };
    }
    if (result.kind === 'veto') {
      return { ok: false, reason: 'indicator-sma', context: { interval, ...result.context } };
    }
  }

  if (gate.emaBias !== 'off') {
    const result = checkMaBias(price, snap.ema20, gate.emaBias, 'ema20');
    if (result.kind === 'unavailable') {
      return {
        ok: false,
        reason: 'indicator-unavailable',
        context: { interval, missing: result.missing },
      };
    }
    if (result.kind === 'veto') {
      return { ok: false, reason: 'indicator-ema', context: { interval, ...result.context } };
    }
  }

  return { ok: true };
};

type MaBiasResult =
  | { readonly kind: 'ok' }
  | { readonly kind: 'unavailable'; readonly missing: string }
  | { readonly kind: 'veto'; readonly context: IndicatorGateContext };

/**
 * Shared moving-average bias check for SMA and EMA — the two knobs differ
 * only in which cached value they read. A `price-below-*` bias is satisfied
 * when price is strictly below the MA; `price-above-*` when strictly above.
 * Equality satisfies neither and vetoes, an acceptable edge for a gate the
 * operator armed deliberately.
 */
const checkMaBias = (
  price: Decimal,
  maRaw: string | null,
  bias: 'price-below-sma' | 'price-above-sma' | 'price-below-ema' | 'price-above-ema',
  label: 'sma20' | 'ema20',
): MaBiasResult => {
  if (maRaw === null) return { kind: 'unavailable', missing: label };
  const ma = safeDecimal(maRaw);
  if (ma === null) return { kind: 'unavailable', missing: `${label}-parse` };
  const wantBelow = bias === 'price-below-sma' || bias === 'price-below-ema';
  const satisfied = wantBelow ? price.lt(ma) : price.gt(ma);
  if (satisfied) return { kind: 'ok' };
  return { kind: 'veto', context: { [label]: maRaw, currentPrice: price.toString(), bias } };
};
