import { Decimal } from '@app/money';
import type { TTConfig, TTState } from '../schema.js';
import { resolveAccountCapQuote } from '../sizing.js';
import { safeDecimal } from './safe-decimal.js';

/**
 * Which opt-in risk cap vetoed opening a new grid level. Part of the log /
 * metric contract once dashboards key on it, so renaming is expensive.
 *   - `exposure-cap`: total quote deployed into the symbol would exceed
 *     `buy.maxSymbolExposureQuote`.
 *   - `loss-budget`: the worst-case loss (full position liquidated at the
 *     stop) would exceed `buy.maxPositionLossQuote`.
 *   - `account-exposure-cap`: the account-wide deployed total (this position
 *     across the account's same mode + quote profiles plus the new level)
 *     would exceed `buy.maxAccountExposureQuote`.
 */
export type RiskCap = 'exposure-cap' | 'loss-budget' | 'account-exposure-cap';

export interface RiskCapVeto {
  readonly cap: RiskCap;
  /** Merged into the veto LogEntry context so triage sees the numbers that drove the rejection. */
  readonly context: {
    readonly cap: RiskCap;
    readonly capQuote: string;
    readonly projectedDeployed: string;
    readonly projectedWorstCaseLoss?: string;
  };
}

/** A quote-cap knob is disabled by an empty string or `'0'` (mirrors the other string-decimal knobs). */
const armed = (raw: string): boolean => raw !== '' && raw !== '0';

/**
 * Opt-in position-sizing risk caps, evaluated when the strategy is about to
 * open a new grid level (entry or promotion). Both bound catastrophic loss
 * from a single symbol and gate the same decision — opening the level — so
 * they live together at one insertion point.
 *
 * Why quote-absolute, not a percent of equity: a cross-symbol or cross-profile
 * "% of account equity" base needs an account-level view that the per-(profile,
 * symbol) `tick()` deliberately does not have (core invariant #4). An absolute
 * quote budget is the equivalent that stays inside the pure single-symbol tick.
 * The percent-of-equity variant is deferred to the account-level-view work
 * (the cross-profile heat-cap design).
 *
 * Worst-case loss identity: when the stop fires, the realised loss is
 * `deployed × (1 − stopLossFraction)` — because the stop sits a fixed fraction
 * below the weighted-average cost and `deployed = held × avgCost`. With no
 * active stop (none configured, or `sell.enabled` off) the floor is price→0,
 * i.e. the full deployed quote.
 *
 * `projectedDeployed` is a mixed basis: the open position at its actual cost
 * (`avgEntryPrice × heldQuantity`) plus the new level at the current price. The
 * new level may fill at a stop-limit below current price, so its contribution
 * is an estimate, not the exact eventual cost — acceptable for an opt-in guard
 * that only refuses adds. `avgEntryPrice` and `heldQuantity` are written
 * together by the fill-adopter, so a null `heldQuantity` means no adopted
 * position (deployed = 0), not a sized position of unknown cost.
 *
 * Returns `null` when no cap is armed (the common path: an opted-out profile
 * never crosses the Decimal boundary), or when price / quantity is malformed
 * (the existing filter guards own that rejection). Otherwise returns the veto.
 *
 * @param config the strategy config (reads `buy` caps + `sell.stopLossPercentage`)
 * @param state the per-(profile, symbol) state (reads the open position)
 * @param addQuantity base-asset quantity of the level about to open
 * @param currentPrice current market price for the level's notional
 * @param accountDeployedQuote total quote deployed across the account's profiles
 *   in the same mode + quote asset (incl. this position) — supplied by the
 *   worker from the cost-basis ledger. Defaults to `'0'` for callers that do
 *   not enforce the account cap;
 *   consulted only when `buy.accountCap` is armed.
 * @param accountEquityQuote account equity (free+locked quote cash + deployed)
 *   used to resolve a `percent` account cap to a quote ceiling. Defaults to
 *   `'0'`; irrelevant for an `amount` cap or when the cap is off.
 */
export const evaluateRiskCaps = (
  config: TTConfig,
  state: TTState,
  addQuantity: string,
  currentPrice: string,
  accountDeployedQuote = '0',
  accountEquityQuote = '0',
): RiskCapVeto | null => {
  const maxExposure = config.buy.maxSymbolExposureQuote;
  const maxLoss = config.buy.maxPositionLossQuote;
  // The account cap resolves to an absolute quote ceiling: an `amount` cap is
  // the amount; a `percent` cap is `pct × equity`. Null when off/absent.
  const accountCapQuote = resolveAccountCapQuote(
    config.buy.accountCap,
    safeDecimal(accountEquityQuote) ?? new Decimal(0),
  );
  if (!armed(maxExposure) && !armed(maxLoss) && accountCapQuote === null) return null;

  const price = safeDecimal(currentPrice);
  const addQty = safeDecimal(addQuantity);
  if (price === null || addQty === null) return null;
  const addNotional = addQty.mul(price);

  // Quote already committed to this position = cost basis = avg × held.
  // Either field null (no/partial position) means nothing is deployed yet.
  const avg = safeDecimal(state.avgEntryPrice ?? '');
  const heldQty = safeDecimal(state.heldQuantity ?? '');
  const deployedSoFar = avg !== null && heldQty !== null ? avg.mul(heldQty) : new Decimal(0);
  const projectedDeployed = deployedSoFar.add(addNotional);

  if (armed(maxExposure)) {
    const cap = safeDecimal(maxExposure);
    if (cap !== null && projectedDeployed.gt(cap)) {
      return {
        cap: 'exposure-cap',
        context: {
          cap: 'exposure-cap',
          capQuote: maxExposure,
          projectedDeployed: projectedDeployed.toString(),
        },
      };
    }
  }

  if (armed(maxLoss)) {
    const cap = safeDecimal(maxLoss);
    // The stop only bounds the loss if the sell side will actually act on it:
    // sell.enabled === false pauses the stop-loss (tick.ts sellGateBranch), so a
    // disabled sell side leaves the full deployed at risk (price→0), same as no
    // stop configured. Reading stopLossPercentage without the master switch would
    // under-count the worst case and let the budget pass adds it should veto.
    const stop = config.sell.enabled ? safeDecimal(config.sell.stopLossPercentage) : null;
    // A configured, active stop in (0,1] caps the loss to (1 − stop); anything
    // else (disabled sell / malformed / out of range) means the full deployed
    // is at risk.
    const lossFraction =
      stop !== null && stop.gt(0) && stop.lte(1) ? new Decimal(1).sub(stop) : new Decimal(1);
    const worstCaseLoss = projectedDeployed.mul(lossFraction);
    if (cap !== null && worstCaseLoss.gt(cap)) {
      return {
        cap: 'loss-budget',
        context: {
          cap: 'loss-budget',
          capQuote: maxLoss,
          projectedDeployed: projectedDeployed.toString(),
          projectedWorstCaseLoss: worstCaseLoss.toString(),
        },
      };
    }
  }

  if (accountCapQuote !== null) {
    // The account total already includes this position's cost basis (the
    // worker sums avg×qty over every profile, this one included), so only the
    // new level's notional is added on top — no double-count of the open
    // position. A malformed or absent account total degrades to 0, leaving the
    // cap off (unknown account context = not enforced). Intentionally distinct
    // from the per-symbol price/qty parse above, which returns null to skip the
    // buy: there a bad value means the order cannot be sized at all, whereas an
    // unknown account total just means this opt-in backstop has nothing to act on.
    const accountDeployed = safeDecimal(accountDeployedQuote) ?? new Decimal(0);
    const projectedAccountDeployed = accountDeployed.add(addNotional);
    if (projectedAccountDeployed.gt(accountCapQuote)) {
      return {
        cap: 'account-exposure-cap',
        context: {
          cap: 'account-exposure-cap',
          capQuote: accountCapQuote.toString(),
          // The figure compared against the cap: account-wide deployed + add.
          projectedDeployed: projectedAccountDeployed.toString(),
        },
      };
    }
  }

  return null;
};
