import { accountEquity, log } from '@app/strategy-core';
import type { Decision, LogEntry, TickInput } from '@app/strategy-core';
import { Decimal } from '@app/money';
import { readAccountExposureCap } from '@app/contracts';
import { computeFirstBuyQuantity } from '../quantity.js';
import { buildPyramidBuyDecision, hasOpenBuyForSymbol } from '../decisions.js';
import { evaluateRiskCaps, type RiskCap, type RiskCapVeto } from './risk-caps.js';
import { classifyRegime } from './regime.js';
import { safeDecimal } from './safe-decimal.js';
import type { TTBundle, TTConfig, TTState } from '../schema.js';

/**
 * Outcome of the bull-pyramid evaluator.
 *
 *   - `add`      : a strength-add fires — a MARKET BUY plus the bumped state.
 *   - `skip-cap` : a mandatory risk cap refused the add; the caller surfaces
 *     the same veto log/metric the grid uses.
 *   - `noop`     : nothing to do (disabled, not a confirmed bull, capped,
 *     not yet spaced, a BUY already resting, or unsizeable).
 */
export type BullPyramidResult =
  | {
      readonly kind: 'add';
      readonly decisions: readonly Decision[];
      readonly log: LogEntry;
      readonly nextState: TTState;
      readonly addIndex: number;
    }
  | { readonly kind: 'skip-cap'; readonly cap: RiskCap; readonly context: RiskCapVeto['context'] }
  | { readonly kind: 'noop' };

/** A quote-cap knob is armed by a non-empty, non-`'0'` value (mirrors risk-caps). */
const capArmed = (raw: string): boolean => raw !== '' && raw !== '0';

/**
 * Bull pyramid: on a CONFIRMED daily bull, deploy idle capital UP by adding to a
 * held position on strength above cost, bounded by `maxAdds`, step spacing, and
 * the existing risk caps. Entirely separate from the grid promotion path (which
 * only adds DOWN) — its own state (`bullAddCount` / `lastBullAddPrice`) and
 * `pyr-<n>` clientOrderId namespace. Pure: no IO, no clock, Decimal money math.
 *
 * Cost basis is maintained by the fill-adopter (a pyramid add is just another
 * BUY); each up-add therefore RAISES avgEntryPrice, which raises the stop-loss
 * and trail-arm levels. The first add is spaced from avgEntryPrice (the cost
 * basis) because `lastBullAddPrice` falls back to it when null, so no open-time
 * initialisation is needed.
 *
 * @param input the tick input (config / market / account / openOrders)
 * @param state the per-(profile, symbol) state; the position must be open
 */
export const evaluateBullPyramid = (
  input: TickInput<TTConfig, TTState, TTBundle>,
  state: TTState,
): BullPyramidResult => {
  const { config, market, account } = input;
  const regime = config.regime;
  const pyramid = regime?.onBull?.pyramid;
  // Opt-in and holding only. Tolerant of a missing regime block on raw configs.
  // A discovery single-entry never averages — up via this pyramid or down via
  // the grid. An up-add would also raise avgEntryPrice, weakening the
  // fail-closed hard stop that a discovery position depends on.
  if (
    regime === undefined ||
    pyramid?.enabled !== true ||
    state.avgEntryPrice === null ||
    state.discoveryEntry === true
  ) {
    return { kind: 'noop' };
  }

  // The exposure-cap safety ceiling is LOAD-BEARING at this boundary: the live
  // worker passes raw stored config to tick() without re-parsing, so the schema
  // superRefine that forbids enabling the pyramid without a cap never runs here.
  // Fail closed — refuse to add when no cap is armed, so a config that bypassed
  // validation can never deploy UP with no money ceiling. (evaluateRiskCaps
  // below returns NO veto when no cap is armed, so it cannot be the ceiling.)
  if (!capArmed(config.buy.maxSymbolExposureQuote) && !readAccountExposureCap(config).armed) {
    return { kind: 'noop' };
  }

  const { regime: verdict } = classifyRegime(market, {
    ma: regime.ma,
    period: regime.period,
    confirmBars: regime.confirmBars,
  });
  if (verdict !== 'bull') return { kind: 'noop' };

  // Hard cap on adds per position — the primary bound on size-into-a-top.
  const count = state.bullAddCount ?? 0;
  if (count >= pyramid.maxAdds) return { kind: 'noop' };

  // Spacing: price must be at least one step above the last add (or the entry
  // cost for the first add, via the lastBullAddPrice → avgEntryPrice fallback).
  const price = safeDecimal(market.currentPrice);
  const anchor = safeDecimal(state.lastBullAddPrice ?? state.avgEntryPrice);
  const step = safeDecimal(pyramid.stepPercentage);
  if (price === null || anchor === null || step === null) return { kind: 'noop' };
  if (price.lt(anchor.mul(new Decimal(1).add(step)))) return { kind: 'noop' };

  // Never stack a second add while a BUY (grid or pyramid) is still resting, so
  // a fast multi-candle rise cannot over-deploy before fills are adopted.
  if (hasOpenBuyForSymbol(input.openOrders, market.symbol)) return { kind: 'noop' };

  // Size the add against the per-add budget under the symbol filters.
  const sized = computeFirstBuyQuantity(
    pyramid.maxPurchaseAmount,
    market.currentPrice,
    market.symbolInfo.filters,
  );
  if (!('quantity' in sized)) return { kind: 'noop' };

  // Risk caps are MANDATORY here (the config superRefine forbids enabling the
  // pyramid without one armed). Reuses the same evaluator and account-wide
  // scalar as the grid so the safety contract is identical.
  const veto = evaluateRiskCaps(
    config,
    state,
    sized.quantity,
    market.currentPrice,
    account.deployedQuoteAcrossProfiles,
    accountEquity(account, market.symbolInfo.quoteAsset).toString(),
  );
  if (veto !== null) return { kind: 'skip-cap', cap: veto.cap, context: veto.context };

  const addIndex = count + 1;
  const nextState: TTState = {
    ...state,
    bullAddCount: addIndex,
    lastBullAddPrice: market.currentPrice,
  };
  return {
    kind: 'add',
    decisions: [buildPyramidBuyDecision(input, sized.quantity, addIndex)],
    log: log('info', 'tt-bull-pyramid-add', {
      symbol: market.symbol,
      addIndex,
      maxAdds: pyramid.maxAdds,
      quantity: sized.quantity,
      currentPrice: market.currentPrice,
    }),
    nextState,
    addIndex,
  };
};
