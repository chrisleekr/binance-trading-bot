import type { Decision, TickInput } from '@app/strategy-core';
import { buildFirstBuyDecision, hasOpenBuyForSymbol } from '../decisions.js';
import { computeFirstBuyQuantity, type FirstBuySkipReason } from '../quantity.js';
import { resolveEntryBudget, type EntrySizingSkip } from '../sizing.js';
import type { TTBundle, TTConfig, TTState } from '../schema.js';
import { evaluateGridBuy } from './grid-buy.js';

/** Outcome of a TV-gate-forced first buy: an emittable decision or a typed skip reason. */
export type FirstBuyForcedResult =
  | { readonly kind: 'emit'; readonly decision: Decision; readonly quantity: string }
  | {
      readonly kind: 'skip';
      readonly reason: 'disabled-until' | 'open-buy' | FirstBuySkipReason | EntrySizingSkip;
    };

/**
 * First-buy emission with the Technicals gate forced open, shared by the
 * `trigger-buy` operator override and the auto-trigger-buy re-arm. Honors
 * the kill-switch (`disabledUntilMs`) and the open-BUY de-dup so a double
 * fire cannot place two entry orders; filter rejection surfaces as a typed
 * skip. Callers own the log / metric naming so each path keeps its own
 * observability.
 */
export const emitFirstBuyTvForced = (
  input: TickInput<TTConfig, TTState, TTBundle>,
  state: TTState,
): FirstBuyForcedResult => {
  if (state.disabledUntilMs !== null) return { kind: 'skip', reason: 'disabled-until' };
  if (hasOpenBuyForSymbol(input.openOrders, input.market.symbol)) {
    return { kind: 'skip', reason: 'open-buy' };
  }
  const budget = resolveEntryBudget(
    input.config,
    input.account,
    input.market.symbolInfo.quoteAsset,
    input.account.deployedQuoteAcrossProfiles,
  );
  const result =
    'skip' in budget
      ? budget
      : computeFirstBuyQuantity(
          budget.budget,
          input.market.currentPrice,
          input.market.symbolInfo.filters,
        );
  if ('quantity' in result) {
    return {
      kind: 'emit',
      decision: buildFirstBuyDecision(input, result.quantity),
      quantity: result.quantity,
    };
  }
  return { kind: 'skip', reason: result.skip };
};

/**
 * Outcome of a grid-aware, TV-gate-forced first entry: an emittable set of
 * decisions plus the state to commit, or a typed skip reason.
 */
export type ForcedEntryResult =
  | {
      // The forced entry has not placed an order this tick but is NOT a
      // terminal skip: a `lowest-price` basis is still waiting for price to
      // return to the window low (or the entry order is already resting). The
      // auto-trigger-buy caller keeps its timer armed and re-checks next tick
      // rather than discarding the forced re-entry; the one-shot trigger-buy
      // override has nothing to keep, so it reports a skip.
      readonly kind: 'wait';
    }
  | {
      readonly kind: 'emit';
      readonly state: TTState;
      readonly decisions: readonly Decision[];
      // Grid emits carry their fired level and report no scalar quantity
      // (the quantity rides on the place-order decision); single-buy
      // emits carry the quantity and no level.
      readonly quantity: string | null;
      readonly level: number | null;
      // Stale lower-level open BUYs cancelled alongside this entry; always
      // 0 on the single-buy path. Surfaced so a forced re-entry logs the
      // cancellation the same way a normal grid entry does.
      readonly canceledStale: number;
    }
  | {
      readonly kind: 'skip';
      readonly reason: string;
      // Diagnostic context for the skip — e.g. the indicator-gate readouts
      // (rsi/sma/ema values) when an indicator-gate veto blocks a forced
      // entry. Propagated into the `tt-trigger-buy-skipped` /
      // `tt-auto-trigger-buy-skipped` log so operators can see WHY a force
      // buy was vetoed, not just THAT it was. Empty for skips with no
      // structured context (`disabled-until`, `open-buy`, `grid-not-flat`).
      readonly context?: Readonly<Record<string, unknown>>;
    };

/**
 * TV-gate-forced first entry, grid-aware. A grid profile (non-empty
 * `gridLevels`) re-enters at level 0 via {@link evaluateGridBuy} with the
 * TV gate forced open; a non-grid profile uses the single-buy emission.
 * Shared by the `trigger-buy` operator override and the auto-trigger-buy
 * re-arm so a forced re-entry is sized the same way the strategy's own
 * first entry would be. `disabledUntilMs` is honored: the trigger-buy
 * override relies on the guard here; the auto-trigger-buy re-arm is
 * already gated upstream by the reschedule-while-disabled branch, so the
 * guard is belt-and-braces for that caller. The grid path additionally
 * cancels any stale lower-level open BUYs.
 */
export const emitForcedFirstEntry = (
  input: TickInput<TTConfig, TTState, TTBundle>,
  state: TTState,
  now: number,
): ForcedEntryResult => {
  if (state.disabledUntilMs !== null) return { kind: 'skip', reason: 'disabled-until' };

  if (input.config.buy.gridLevels.length > 0) {
    // A forced re-entry is always a fresh level-0 entry: normalise any
    // orphaned grid index to null so evaluateGridBuy takes its entry branch
    // rather than the promotion branch, and clear any stale discovery marker.
    // The grid-buy emit only ever SETS the marker (when this entry is itself a
    // discovery add), never clears it, so without the reset an unfilled
    // discovery entry that is force-re-entered would carry a phantom
    // single-entry flag and silently suppress the new position's grid
    // promotions. The reset only persists when a fresh entry actually emits;
    // on a held position evaluateGridBuy returns noop and entryState is dropped.
    const entryState: TTState = {
      ...state,
      currentGridTradeIndex: null,
      discoveryEntry: false,
      entryAtMs: null,
    };
    const grid = evaluateGridBuy(input, entryState, now, true);
    switch (grid.kind) {
      case 'emit':
        return {
          kind: 'emit',
          state: grid.state,
          decisions: grid.decisions,
          quantity: null,
          level: grid.level,
          canceledStale: grid.decisions.filter((d) => d.type === 'cancel-order').length,
        };
      case 'skip-filter':
        return { kind: 'skip', reason: grid.skip };
      case 'skip-indicator':
        return { kind: 'skip', reason: grid.veto, context: grid.context };
      case 'skip-risk-cap':
        // A risk cap (exposure / loss budget) refused the forced re-entry: a
        // true terminal skip carrying the cap reason + the numbers that drove
        // it, so the trigger-buy / auto-trigger-buy log explains WHY.
        return { kind: 'skip', reason: grid.cap, context: grid.context };
      // Unreachable on this path: the regime filter only gates promotions
      // (avgEntryPrice set) and a forced re-entry is always a flat level-0
      // entry. Mapped defensively so the union stays exhaustive.
      /* v8 ignore next -- reason: regime filter gates only promotions (avgEntryPrice set); a forced re-entry is always a flat level-0 entry, so skip-regime never reaches this arm */
      case 'skip-regime':
        return { kind: 'skip', reason: grid.veto, context: grid.context };
      case 'wait':
        // evaluateGridBuy waits for two distinct reasons. If an entry order is
        // already resting on the book, the forced re-entry's job is done: that
        // is a true `open-buy` skip and the timer should clear. If instead a
        // `lowest-price` basis simply has not reached the window low yet,
        // surface a `wait` so the timer caller keeps re-checking rather than
        // discarding the forced re-entry and mislabelling it `open-buy`.
        return hasOpenBuyForSymbol(input.openOrders, input.market.symbol)
          ? { kind: 'skip', reason: 'open-buy' }
          : { kind: 'wait' };
      default:
        // `noop` — the entry branch was not taken because the profile is
        // already holding a grid position. (`skip-tv` cannot reach here:
        // `forceTvOpen` short-circuits the entry TV gate.)
        return { kind: 'skip', reason: 'grid-not-flat' };
    }
  }

  const singleBuy = emitFirstBuyTvForced(input, state);
  if (singleBuy.kind === 'emit') {
    return {
      kind: 'emit',
      state,
      decisions: [singleBuy.decision],
      quantity: singleBuy.quantity,
      level: null,
      canceledStale: 0,
    };
  }
  return { kind: 'skip', reason: singleBuy.reason };
};

/**
 * Re-arm timestamp for the auto-trigger-buy timer: `now` plus the
 * configured delay when the feature is enabled, `null` when it is off.
 * `triggerAfterMinutes` is an integer (schema `.int()`), so the ms
 * product is exact and satisfies the `TTState.autoTriggerBuyAtMs` int
 * schema without any rounding.
 */
export const armAutoTriggerBuy = (config: TTConfig, now: number): number | null => {
  const atb = config.buy.autoTriggerBuy;
  return atb.enabled ? now + atb.triggerAfterMinutes * 60_000 : null;
};
