import type { Decimal } from '@app/money';
import { parseFilters, sellableAtStop } from '@app/strategy-core';
import type { MarketSnapshot, SizeFilters } from '@app/strategy-core';
import { safeDecimal } from './branches/safe-decimal.js';
import type { ExitBlocker, TTConfig, TTState } from './schema.js';
import { ttStopSellPrice } from './stop-level.js';

/**
 * The exit rungs the sell ladder DECLINED to fire this tick, each carrying the
 * threshold the ladder already computed. Every field is filled from the gate's
 * own locals, never re-derived here: a second copy of a threshold would drift
 * from the one the worker actually trades on, and the whole point of this record
 * is that the operator can trust it.
 *
 * A rung absent from a config contributes `null`; a rung that FIRED short-circuits
 * the ladder, so it never reaches the resolver.
 */
export interface ExitCandidates {
  /** A rung fired but the quantity could not be sized (dust, exchange minimums). */
  unsellable: { readonly skip: string } | null;
  /** A configured threshold could not be parsed, so its rung is dead. */
  configInvalid: { readonly field: string } | null;
  /**
   * The ladder ratcheted the high-water mark this tick and stood down. The trail
   * level itself is computed by a LATER rung the ladder never reached, so the
   * high is all that is known here — reporting a lower rung instead would name a
   * threshold the position is not actually sitting on.
   */
  trailHighRaised: { readonly high: Decimal } | null;
  /** An armed trail whose level price has not been reached. */
  armedTrail: {
    readonly source: 'atr' | 'fixed';
    readonly trailPrice: Decimal;
    readonly high: Decimal;
  } | null;
  /** A trail is configured but has no running high yet; it starts at `armPrice`. */
  awaitingArm: { readonly armPrice: Decimal } | null;
  /** The break-even floor is armed and price is still above it. */
  breakEvenFloor: { readonly floorPrice: Decimal } | null;
  /** Break-even is enabled but has not armed; it arms at `armPrice`. */
  breakEvenArm: { readonly armPrice: Decimal } | null;
  /** The hard stop-loss level, not reached. */
  stopLoss: { readonly stopPrice: Decimal } | null;
  /** A time-stop is configured and the bar count is still short. */
  timeStop: { readonly closedBars: number; readonly requiredBars: number } | null;
}

/** All rungs unfilled — the starting point the ladder mutates as it declines each one. */
export const noExitCandidates = (): ExitCandidates => ({
  unsellable: null,
  configInvalid: null,
  trailHighRaised: null,
  armedTrail: null,
  awaitingArm: null,
  breakEvenFloor: null,
  breakEvenArm: null,
  stopLoss: null,
  timeStop: null,
});

export interface ExitBlockerContext extends ExitCandidates {
  /** The sell side is switched off, so no rung will ever fire. */
  readonly sellDisabled: boolean;
  /** A SELL for this symbol is already open, so the gate stood down this tick. */
  readonly openSellOrder: boolean;
  /** Price the rungs were compared against, echoed into `detail` for legibility. */
  readonly currentPrice: Decimal | null;
  /** True when any configured rule would exit this position below its entry, regardless of whether the available position evidence proves that exit sellable. */
  readonly hasDownsideExit: boolean;
  /** A configured stop can never sell the current step-rounded holding at its minimum notional. */
  readonly stopInfeasible: {
    readonly heldQuantity: string;
    readonly stopPrice: string;
    readonly minNotional: string;
  } | null;
}

/**
 * True when at least one configured rule can exit the position BELOW the sell
 * trigger — i.e. when a losing position has any way out other than the operator.
 * A profile with a sell trigger and a trail alone will hold a position that
 * drops forever, which is a legitimate choice but must never be an unnoticed one.
 *
 * Reads RAW config defensively: the live worker ticks stored config without a
 * schema parse, so a profile saved before any of these fields existed has the
 * block missing entirely.
 *
 * `discoveryEntry` selects which of the two time-stops can actually fire: the
 * sell ladder runs the discovery bar count only on a discovery entry and the
 * general one only on everything else, so counting the rung that is inert for
 * this position would suppress the warning for a position that genuinely has
 * no way down.
 */
export const hasDownsideExitConfigured = (config: TTConfig, discoveryEntry: boolean): boolean => {
  const sell = config.sell;
  // Widened deliberately: a pre-feature row has no such key, and `undefined` is
  // neither '' nor '0', so reading it at its declared type would report a
  // stop-loss that does not exist.
  const stopLoss: string | undefined = sell.stopLossPercentage;
  // `undefined > 0` is false, so a missing bar count reads as disabled without a
  // nullish guard (matching how the sell gate reads the same field).
  return (
    (stopLoss !== undefined && stopLoss !== '' && stopLoss !== '0') ||
    sell.breakEven?.enabled === true ||
    sell.atrTrailing?.enabled === true ||
    sell.protectiveStop?.enabled === true ||
    (discoveryEntry ? sell.discoveryTimeStopBars > 0 : sell.timeStopBars > 0)
  );
};

/** Determine whether a configured downside exit is structurally sellable for the held position, so dust is reported before the stop fires rather than as a generic missing exit. The check is deliberately skipped when the live position, stop price, or filters are unavailable, preserving the configured answer until all required evidence exists; an infeasible stop also preserves that configured answer and carries infeasibility only in `stopInfeasible`. `stop-infeasible-dust` models only the fixed stop-loss; an ATR-from-entry trail or break-even stop that also sits below entry is not modelled because those exits move with the market, so the price they would sell at is not known at entry, while the fixed stop-loss level is known.
 * @param config - The raw trailing-trade configuration whose downside exits are enabled.
 * @param discoveryEntry - Whether the position uses the discovery-entry time-stop branch.
 * @param held - The tracked base-asset quantity, or null when it cannot be parsed.
 * @param stopSellPrice - The resolved stop-limit sell price, or null when it cannot be resolved.
 * @param filters - Parsed exchange quantity and notional filters, or null when unavailable.
 * @returns The configured downside-exit answer and, when proven infeasible, the details for the blocker rung.
 */
export const assessDownsideExit = (
  config: TTConfig,
  discoveryEntry: boolean,
  held: Decimal | null,
  stopSellPrice: Decimal | null,
  filters: SizeFilters | null,
): {
  hasDownsideExit: boolean;
  stopInfeasible: ExitBlockerContext['stopInfeasible'];
} => {
  const hasDownsideExit = hasDownsideExitConfigured(config, discoveryEntry);
  if (
    !hasDownsideExit ||
    held === null ||
    !held.gt(0) ||
    stopSellPrice === null ||
    !stopSellPrice.gt(0) ||
    filters === null
  ) {
    return { hasDownsideExit, stopInfeasible: null };
  }

  if (sellableAtStop(held, stopSellPrice, filters))
    return { hasDownsideExit, stopInfeasible: null };
  return {
    hasDownsideExit,
    stopInfeasible: {
      heldQuantity: held.toFixed(),
      stopPrice: stopSellPrice.toFixed(),
      minNotional: filters.minNotional.toFixed(),
    },
  };
};

/** Run {@link assessDownsideExit} on the live tick inputs, so every ladder site derives the held quantity, stop sell price and filters the same way.
 * @param config - The raw trailing-trade configuration whose downside exits are enabled.
 * @param state - The current trailing-trade state carrying the tracked position and entry price.
 * @param market - The symbol snapshot supplying the live price, band and exchange filters.
 * @returns The configured downside-exit answer and, when proven infeasible, the details for the blocker rung.
 */
export const assessHeldDownsideExit = (
  config: TTConfig,
  state: TTState,
  market: MarketSnapshot,
): ReturnType<typeof assessDownsideExit> =>
  assessDownsideExit(
    config,
    state.discoveryEntry === true,
    state.heldQuantity === null ? null : safeDecimal(state.heldQuantity),
    ttStopSellPrice(config, state, market),
    parseFilters(market.symbolInfo.filters),
  );

/**
 * Build the blocker for one rung: its reason, the threshold that rung compares
 * against, and the `changeKey` that decides whether this is the SAME blocker the
 * consumer already recorded.
 *
 * The key covers the reason and the THRESHOLD only. `currentPrice` moves every
 * tick and is carried for legibility, never for identity — keying on it would
 * turn a steady "waiting for the arm" into one log row per tick, which is the
 * exact flood the on-change record exists to prevent.
 */
const at = (
  ctx: ExitBlockerContext,
  reason: ExitBlocker['reason'],
  threshold: Readonly<Record<string, string | number>> = {},
): ExitBlocker => ({
  reason,
  changeKey: [reason, ...Object.entries(threshold).map(([k, v]) => `${k}=${String(v)}`)].join('|'),
  detail: {
    ...threshold,
    ...(ctx.currentPrice === null ? {} : { currentPrice: ctx.currentPrice.toFixed() }),
    hasDownsideExit: ctx.hasDownsideExit,
  },
});

/**
 * Resolve the single structured reason the held position did not exit this tick.
 * Total: a held tick that emitted nothing always has SOME rung it stopped at,
 * down to "no exit is configured at all". Pure: no I/O, no clock.
 *
 * Priority (highest first). The order answers "what is this position waiting
 * on", so a rung that CANNOT fire outranks one that simply has not:
 *
 *   1. sell-disabled — the sell side is off; no rung will ever fire.
 *   2. exit-order-open — an exit is already in flight; the gate stood down.
 *   3. exit-unsellable — a rung fired and could not be sized. The loudest case: the position is trapped until the operator acts.
 *   4. exit-config-invalid — a threshold is corrupt, so that rung is dead.
 *   5. stop-infeasible-dust — a configured stop can never sell the held dust, regardless of whether it has fired yet.
 *   6. trail-high-raised — the high-water mark moved this tick and the ladder stood down before pricing the trail; the trail is what holds the position.
 *   7. atr-trail-above-price / trail-above-price — the armed profit trail owns the position; its level is the live exit.
 *   8. awaiting-sell-arm — a trail is configured but unarmed. NO trailing exit exists at any price until the arm is reached; this is the gate.
 *   9. break-even-floor-not-hit — the armed break-even floor is the live exit.
 *  10. break-even-not-armed — break-even is the pending profit-protection rung.
 *  11. stop-loss-not-hit — only the hard stop stands below.
 *  12. time-stop-pending — only the bar-count exit stands.
 *  13. no-exit-configured — nothing configured would ever exit.
 *
 * `exit-unsellable` means an exit FIRED this tick and the ladder could not size it; `stop-infeasible-dust` means a configured stop could NEVER be sized for this holding, whether or not it has fired.
 *
 * The profit path outranks the protective path deliberately: a held position is
 * normally waiting to take profit, and the protective rungs are reported through
 * `detail.hasDownsideExit` on whichever reason wins. `stop-infeasible-dust` stays above those profit rungs alongside `exit-unsellable` and `exit-config-invalid` because the diagnosis consumer reads only the single winning reason, so ranking it below a profit rung would hide an unsellable dust fault behind a routine waiting-for-profit status while its trigger is still unarmed.
 */
export const resolveExitBlocker = (ctx: ExitBlockerContext): ExitBlocker => {
  if (ctx.sellDisabled) return at(ctx, 'sell-disabled');
  if (ctx.openSellOrder) return at(ctx, 'exit-order-open');
  if (ctx.unsellable !== null) return at(ctx, 'exit-unsellable', { skip: ctx.unsellable.skip });
  if (ctx.configInvalid !== null) {
    return at(ctx, 'exit-config-invalid', { field: ctx.configInvalid.field });
  }
  if (ctx.stopInfeasible !== null) {
    return at(ctx, 'stop-infeasible-dust', ctx.stopInfeasible);
  }
  if (ctx.trailHighRaised !== null) {
    return at(ctx, 'trail-high-raised', { highSinceBuy: ctx.trailHighRaised.high.toFixed() });
  }
  if (ctx.armedTrail !== null) {
    return at(
      ctx,
      ctx.armedTrail.source === 'atr' ? 'atr-trail-above-price' : 'trail-above-price',
      {
        trailPrice: ctx.armedTrail.trailPrice.toFixed(),
        highSinceBuy: ctx.armedTrail.high.toFixed(),
      },
    );
  }
  if (ctx.awaitingArm !== null) {
    return at(ctx, 'awaiting-sell-arm', { armPrice: ctx.awaitingArm.armPrice.toFixed() });
  }
  if (ctx.breakEvenFloor !== null) {
    return at(ctx, 'break-even-floor-not-hit', {
      floorPrice: ctx.breakEvenFloor.floorPrice.toFixed(),
    });
  }
  if (ctx.breakEvenArm !== null) {
    return at(ctx, 'break-even-not-armed', { armPrice: ctx.breakEvenArm.armPrice.toFixed() });
  }
  if (ctx.stopLoss !== null) {
    return at(ctx, 'stop-loss-not-hit', { stopPrice: ctx.stopLoss.stopPrice.toFixed() });
  }
  if (ctx.timeStop !== null) {
    return at(ctx, 'time-stop-pending', {
      closedBars: ctx.timeStop.closedBars,
      requiredBars: ctx.timeStop.requiredBars,
    });
  }
  return at(ctx, 'no-exit-configured');
};
