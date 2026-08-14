import { isRestingSell } from '@app/contracts';
import { Decimal, roundToStep, toFixedStep } from '@app/money';
import type { OpenOrder, PercentPriceBySideFilter, TickInput } from './contract.js';
import type { Decision } from './decision.js';
import { sizableBase } from './balances.js';
import { finalise, type SizeFilters } from './sizing.js';

// `new Decimal` throws on malformed input; an unreadable order field must never
// crash a tick, so parse defensively and treat a failure as "unknown".
const safeDecimal = (value: string | undefined): Decimal | null => {
  if (value === undefined) return null;
  try {
    return new Decimal(value);
  } catch {
    return null;
  }
};

/**
 * Base-asset quantity the strategy's OWN resting protective stop still locks on
 * Binance — the unfilled remainder (`origQty - executedQty`) of every live SELL
 * carrying our deterministic `clientOrderId`. A PARTIALLY_FILLED stop has already
 * moved its executed base out of the wallet, so only the remainder is reclaimable.
 *
 * This is the quantity a stop-arm may credit back on top of the wallet's `free`:
 * our own resting stop is cancelled in the same batch that replaces it, so the
 * base it holds is ours to re-commit. Without the credit, `free` reads zero the
 * moment our stop rests and the arm cancels / re-places itself every tick.
 */
export const ownRestingSellBase = (
  openOrders: readonly OpenOrder[],
  ourClientOrderId: string,
  symbol: string,
): Decimal => {
  let sum = new Decimal(0);
  for (const order of openOrders) {
    if (
      order.symbol !== symbol ||
      order.clientOrderId !== ourClientOrderId ||
      !isRestingSell(order)
    ) {
      continue;
    }
    const orig = safeDecimal(order.origQty);
    const done = safeDecimal(order.executedQty) ?? new Decimal(0);
    const remaining = orig === null ? null : orig.minus(done);
    if (remaining !== null && remaining.gt(0)) sum = sum.add(remaining);
  }
  return sum;
};

/**
 * A resting SELL on this symbol that is NOT ours — an order left behind by a
 * deleted profile, adopted from Binance, or placed by hand. It locks base coins
 * whose release we do not control, which is why it matters: a stop sized past the
 * free balance is then unfundable no matter how often we re-send it.
 *
 * `isRestingSell` is the ONE predicate the api's adoption guard and the web's
 * adopt list also use — three copies is how one of them drifts and re-admits the
 * order the other two refuse.
 */
export const findForeignRestingSell = (
  openOrders: readonly OpenOrder[],
  ourClientOrderId: string,
  symbol: string,
): OpenOrder | undefined =>
  // Symbol-scoped by construction: a SELL on another pair locks a different base
  // asset and can neither fund nor starve this pair's stop.
  openOrders.find(
    (o) => o.symbol === symbol && isRestingSell(o) && o.clientOrderId !== ourClientOrderId,
  );

/**
 * Base actually available to arm a protective stop: `min(held, free + ownLocked)`.
 *
 * A foreign resting SELL shrinks `free` below the tracked position, so this is
 * what the exchange will really accept — sizing above it is a guaranteed -2010.
 * Sizing on the remainder still protects most of the position, which beats
 * protecting none of it.
 *
 * `free === undefined` means the wallet is UNREADABLE, not "zero free". Only
 * `freeBalance` produces that sentinel, and only when `!account.readable` (a cold
 * or malformed account-info); an asset merely absent from a readable snapshot is a
 * KNOWN zero and arrives here as `Decimal(0)`. Fail OPEN on the tracked quantity:
 * declining to protect an open position needs proof, and the executor's funding
 * pre-flight is the backstop for the one rejection this can cost.
 *
 * `ownLocked` must likewise be wallet-corroborated (see `sizableBase`) — crediting
 * a resting stop the wallet no longer backs arms an unfundable order.
 */
export const armableBaseQuantity = (
  held: Decimal,
  free: Decimal | undefined,
  ownLocked: Decimal,
): Decimal => (free === undefined ? held : Decimal.min(held, free.add(ownLocked)));

/**
 * Why an open position has no exchange-side protective stop, or none at the
 * level it should have. One vocabulary, so every strategy's refusal glosses the
 * same way. Declared as a value first so a strategy's attribution map can be
 * checked against the real vocabulary instead of a hand-copied list that silently
 * stops covering it.
 */
export const PROTECTIVE_STOP_BLOCKER_REASONS = [
  'base-locked-by-foreign-order',
  'base-below-exchange-minimum',
  'base-short-of-tracked-position',
  'price-outside-exchange-band',
] as const;

export type ProtectiveStopBlockerReason = (typeof PROTECTIVE_STOP_BLOCKER_REASONS)[number];

/** A refusal record persisted on strategy state: `{ reason, detail }`, read by the api projection and the web gloss. */
export interface ProtectiveStopBlocker {
  readonly reason: ProtectiveStopBlockerReason;
  readonly detail: Readonly<Record<string, unknown>>;
}

/**
 * Classify a stop-arm refusal — i.e. why NOTHING could be armed after the
 * available base was sized through the exchange filters. Every branch produces a
 * blocker: an open position with no stop and no explanation is the silent failure
 * this exists to prevent, whether the base is held by a foreign order or the
 * wallet simply no longer backs the tracked position.
 *
 * `free` is the wallet's readable free base (an unreadable wallet never reaches
 * here — it fails open on the tracked quantity), `required` the fully-sized stop
 * quantity, `available` the base the arm could actually commit.
 */
export const classifyProtectiveStopRefusal = (params: {
  readonly symbol: string;
  readonly openOrders: readonly OpenOrder[];
  readonly ourClientOrderId: string;
  readonly free: Decimal;
  readonly required: string;
  readonly available: Decimal;
}): ProtectiveStopBlocker => {
  const { symbol, openOrders, ourClientOrderId, free, required, available } = params;
  const base = { symbol, required, free: free.toString(), available: available.toString() };
  const foreign = findForeignRestingSell(openOrders, ourClientOrderId, symbol);
  if (foreign !== undefined) {
    return {
      reason: 'base-locked-by-foreign-order',
      detail: {
        ...base,
        foreignClientOrderId: foreign.clientOrderId,
        foreignOrderId: foreign.orderId,
      },
    };
  }
  // Nobody to blame: the wallet holds less base than the bot thinks it does
  // (reconciliation drift, an operator withdrawal, or an operator base reserve
  // the worker subtracts before the strategy sees `free`). Split the two so the
  // gloss can tell "there is nothing there" from "there is too little to trade".
  return available.lte(0)
    ? { reason: 'base-short-of-tracked-position', detail: base }
    : { reason: 'base-below-exchange-minimum', detail: base };
};

// A band multiplier or reference price is usable only when it parses to a
// positive finite number. Anything else means the band cannot be evaluated, and
// an unevaluable band must impose NO constraint: `0` would otherwise collapse
// the window to a point and refuse every stop on the symbol.
const positiveDecimal = (value: unknown): Decimal | null => {
  if (typeof value !== 'string') return null;
  const parsed = safeDecimal(value);
  return parsed !== null && parsed.isFinite() && parsed.gt(0) ? parsed : null;
};

/**
 * Whether Binance's `PERCENT_PRICE_BY_SIDE` band makes this stop unplaceable,
 * as a blocker, or `null` when it is placeable or the band is unknown.
 *
 * Judged on the limit `price` alone, which is what the filter definition bounds:
 * `PRICE_FILTER` spells out that it covers `price` AND `stopPrice`, while
 * `PERCENT_PRICE_BY_SIDE` names only the order price, and the contrast is the
 * evidence. Banding the trigger too would be conservative in the wrong
 * direction on the ceiling — the trigger is the higher of the two legs, so it
 * alone can breach a ceiling the limit clears, and a stop deferred there is a
 * naked position waiting on a rule the exchange does not enforce.
 *
 * `reference` is the price the caller already holds for this tick, NOT Binance's
 * own reference: for `avgPriceMins > 0` the exchange bands against a volume
 * weighted average over that window. The two drift apart in a fast market, in
 * opposite directions with opposite costs. Spot above the average overstates the
 * floor, so a placeable stop is deferred one tick and nothing resting is touched.
 * Spot below it understates the floor, so an order goes out and comes back -1013,
 * which is what already happens today. Neither direction cancels protection that
 * the exchange would have let us replace.
 *
 * Fails OPEN on every ambiguity — no band published, a band that is not an
 * object, an unparseable multiplier, an unreadable reference price. Refusing to
 * protect an open position needs proof. Each bound is judged on its own, so an
 * unreadable ceiling cannot disable the floor, which is the bound a protective
 * stop actually breaches.
 *
 * `terminal` marks the config-shaped case: an armable stop needs
 * `stop × offset ≥ ref × askMultiplierDown` while the trigger sits at or below
 * the reference, so `offset > askMultiplierDown` is necessary. When the ratio is
 * at or under the floor multiplier NO price movement can ever arm the stop and
 * the operator must widen the offset, which is the opposite of the advice the
 * ordinary case deserves. Read off the price ratio alone, so it holds for any
 * plugin's level formula, and only ever from a FLOOR breach: a ceiling breach is
 * transient by nature and raising the offset would push the price further into it.
 */
export const percentPriceBySideRefusal = (params: {
  readonly symbol: string;
  readonly reference: string;
  readonly band: PercentPriceBySideFilter | null | undefined;
  readonly desired: DesiredProtectiveStop;
  /** Whether the position is still covered by a working stop, so a refusal is not a naked position. */
  readonly guarded: boolean;
}): ProtectiveStopBlocker | null => {
  const { symbol, reference, band, desired, guarded } = params;
  // Cast, not parsed: the cached symbol blob is revived with `JSON.parse(...) as
  // SymbolInfo`, so this slot can hold any JSON value. A `null` in particular
  // would throw on the first property read, and a throw inside the pure tick
  // dead-letters the symbol every pass, leaving the position wholly unmanaged.
  if (typeof band !== 'object' || band === null) return null;

  const ref = positiveDecimal(reference);
  const stopPrice = positiveDecimal(desired.stopPrice);
  const price = positiveDecimal(desired.price);
  if (ref === null || stopPrice === null || price === null) return null;

  const down = positiveDecimal(band.askMultiplierDown);
  const up = positiveDecimal(band.askMultiplierUp);
  const floor = down === null ? null : ref.mul(down);
  const ceiling = up === null ? null : ref.mul(up);
  const belowFloor = floor !== null && price.lt(floor);
  const aboveCeiling = ceiling !== null && price.gt(ceiling);
  if (!belowFloor && !aboveCeiling) return null;

  const ratio = price.div(stopPrice);
  return {
    reason: 'price-outside-exchange-band',
    detail: {
      symbol,
      stopPrice: desired.stopPrice,
      price: desired.price,
      reference,
      // `toFixed` never switches to exponential notation, which `toString` does
      // below 1e-7: the operator is asked to compare this against a real price.
      floor: floor === null ? null : floor.toFixed(),
      ceiling: ceiling === null ? null : ceiling.toFixed(),
      askMultiplierDown: band.askMultiplierDown,
      askMultiplierUp: band.askMultiplierUp,
      avgPriceMins: band.avgPriceMins,
      limitOffsetRatio: ratio.toDecimalPlaces(6).toString(),
      terminal: belowFloor && down !== null && ratio.lte(down),
      // Which bound was actually breached, so the gloss never quotes a floor at
      // an operator whose stop is priced too HIGH. One price cannot breach both
      // unless the band itself is inverted, where the floor is the safer read.
      bound: belowFloor ? 'floor' : 'ceiling',
      guarded,
    },
  };
};

// Re-place the resting stop only when the recomputed trigger has moved by at
// least this fraction of itself (0.1%). Without the band a sub-tick wobble in
// the entry price / high-water mark would cancel + re-place every tick, churning
// exchange weight for no protection change. The DEFAULT: a plugin whose trail
// advances intraday may widen it to bound how many orders that costs.
const MIN_STOP_DRIFT = new Decimal('0.001');

// Same idea for the sized quantity (1%). A resting stop armed while a foreign
// order held part of the base protects only that partial quantity; once the lock
// clears, nothing else would ever resize it and the position stays permanently
// under-protected. The band is a whole percent — wide enough that a one-step
// rounding wobble in the free balance cannot churn the order, narrow enough that
// a materially undersized stop is always corrected.
const MIN_QTY_DRIFT = new Decimal('0.01');

/**
 * Whether a resting protective stop (matched by OUR clientOrderId, so it is our
 * live order placed with the trigger we chose) must be cancelled and re-placed to
 * match `desired`. True on a material move in EITHER the trigger price or the
 * sized quantity — comparing only the price leaves a partially-sized stop
 * un-resized forever.
 *
 * A resting order whose `stopPrice` or `origQty` reads back unparseable is LEFT
 * in place: some Binance open-orders snapshots return an empty stopPrice for a
 * resting STOP_LOSS_LIMIT, and treating that as "drifted" re-places an identical
 * stop every tick — a cancel/replace storm that never converges. A genuinely
 * stale stop is retracted by the position-close path, not re-armed per tick.
 */
export const protectiveStopNeedsRearm = (
  resting: OpenOrder,
  desiredStopPrice: string,
  desiredQuantity: string,
  minStopDrift: Decimal = MIN_STOP_DRIFT,
): boolean => {
  const restingStop = safeDecimal(resting.stopPrice);
  if (restingStop === null) return false;
  const desiredStop = new Decimal(desiredStopPrice);
  if (restingStop.minus(desiredStop).abs().gte(desiredStop.mul(minStopDrift))) return true;

  const orig = safeDecimal(resting.origQty);
  if (orig === null) return false;
  const restingQty = orig.minus(safeDecimal(resting.executedQty) ?? new Decimal(0));
  const desiredQty = new Decimal(desiredQuantity);
  return restingQty.minus(desiredQty).abs().gte(desiredQty.mul(MIN_QTY_DRIFT));
};

/**
 * The resting exchange-side protective stop for this (profile, symbol), or
 * undefined. Matched by the plugin's deterministic clientOrderId — passed in
 * because each strategy's scheme differs — and the canonical {@link isRestingSell}
 * denylist: any status the contract does not treat as off-book still locks base
 * (notably PENDING_CANCEL, a cancel in flight, and any status Binance adds later),
 * so it must not be missed and suppress a re-arm.
 */
export const findRestingProtectiveStop = (
  openOrders: readonly OpenOrder[],
  ourClientOrderId: string,
): OpenOrder | undefined =>
  openOrders.find((o) => o.clientOrderId === ourClientOrderId && isRestingSell(o));

// Statuses under which a stop is actually working on the book. An ALLOWLIST,
// deliberately narrower than the denylist above: that one answers "do these
// coins still count as locked?" and must fail CLOSED, so it reports a
// PENDING_CANCEL — a cancel already in flight — and every status Binance adds
// later as resting. The question here is the opposite-facing "is this position
// still covered?", where that same answer fails OPEN.
const GUARDING_STATUSES = new Set(['NEW', 'PARTIALLY_FILLED']);

/**
 * Whether `resting` still covers the position the strategy wants protected: it is
 * working on the book AND its unfilled remainder is not materially short of the
 * desired size. Existence alone is not coverage — a stop sized while a foreign
 * order held most of the base guards a fraction of the position, and calling that
 * guarded downgrades a naked position to a warning the operator can dismiss.
 *
 * One-sided, on the same 1% tolerance the re-arm test uses: anything reported as
 * covering is at least the desired size, so it is never re-armed for being too
 * small. An OVERSIZED resting stop still counts as covering even though its size
 * difference does trigger a re-arm — more coverage than asked for is coverage.
 * Anything unreadable reads as NOT covering: the claim is that the operator may
 * ignore an alert, and that needs proof.
 */
export const stillGuarding = (resting: OpenOrder | undefined, desiredQuantity: string): boolean => {
  if (resting === undefined || !GUARDING_STATUSES.has(resting.status.toUpperCase())) return false;
  const orig = safeDecimal(resting.origQty);
  const desired = safeDecimal(desiredQuantity);
  // An unreadable fill count is NOT read as zero fills here, unlike the sizing
  // helpers above: overstating the remainder would claim coverage the position
  // may not have.
  const executed = safeDecimal(resting.executedQty);
  if (orig === null || desired === null || executed === null || !desired.gt(0)) return false;
  const remaining = orig.minus(executed);
  return remaining.gte(desired.mul(new Decimal(1).minus(MIN_QTY_DRIFT)));
};

/** Stop trigger + limit price, sized to `quantity`, for the resting STOP_LOSS_LIMIT SELL. */
export interface DesiredProtectiveStop {
  readonly stopPrice: string;
  readonly price: string;
  readonly quantity: string;
}

/**
 * The stop level plus the tracked position and filters the sizing needs. A
 * plugin computes it (the level formula is the one genuine per-strategy seam),
 * or null when there is nothing to protect (flat / no tracked quantity), no stop
 * is configured, or an input does not parse.
 */
export interface ProtectiveStopLevel {
  readonly stop: Decimal;
  readonly limit: Decimal;
  readonly held: Decimal;
  readonly filters: SizeFilters;
  readonly tick: Decimal;
}

/**
 * The outcome of one arm evaluation: what to do, and — when nothing can be armed
 * — why, in the operator's language. The blocker is state the tick persists so
 * the dashboard can say "your stop is not armed, and here is what is holding it".
 * One shape across strategies, so a single api projection and web gloss read them
 * all; each plugin's `protectiveStopBlocker` state field is exactly this nullable
 * {@link ProtectiveStopBlocker}, so the blocker assigns straight into nextState.
 */
export interface ProtectiveStopArm {
  readonly decisions: Decision[];
  readonly blocker: ProtectiveStopBlocker | null;
}

/**
 * The per-strategy seams the shared arm consumes. The two plugins differ ONLY in
 * how they compute the level, where they source reclaimable own-locked base, how
 * they build the place/cancel decisions, and their clientOrderId scheme;
 * everything downstream — full/partial sizing, the foreign-lock refusal, and the
 * re-arm drift band — is identical and lives in {@link evaluateProtectiveStopArm}.
 */
export interface ProtectiveStopArmParams<C, S, B extends Readonly<Record<string, unknown>>> {
  readonly input: TickInput<C, S, B>;
  readonly enabled: boolean;
  readonly level: ProtectiveStopLevel | null;
  readonly reclaimableBase: Decimal;
  readonly ourClientOrderId: string;
  /**
   * `rearm` is true when a stop of ours is already resting and this placement
   * only re-prices it. It exists so a plugin can mark the replacement
   * `deferrable`: the old stop stays live until the cancel lands, so skipping the
   * pair costs a stale trigger, not protection. A FIRST arm is never deferrable —
   * nothing is resting behind it.
   */
  readonly buildPlace: (desired: DesiredProtectiveStop, rearm: boolean) => Decision;
  readonly buildCancel: (resting: OpenOrder) => Decision;
  /**
   * Trigger-drift band for the re-arm, as a fraction of the desired trigger.
   * Defaults to 0.1%. A plugin whose level advances intraday exposes this to the
   * operator, because it is the only knob that bounds order spend in a market
   * that keeps grinding one way.
   */
  readonly minStopDrift?: Decimal;
}

/**
 * Arm or re-arm the exchange-side protective stop from the plugin's resolved
 * seams. The outcome:
 *
 *   - feature off ⇒ [] and NO cancel: the operator disabled the feature, not the
 *     position, so a resting stop stays live to catch a gap while the bot is down.
 *   - no level (flat / unconfigured / unparseable) or the full size skips a filter
 *     ⇒ cancel any resting stop (or []): a now-mismatched order can't reject when
 *     it triggers.
 *   - part of the base locked by a FOREIGN resting SELL ⇒ arm on what is left:
 *     protecting most of the position beats protecting none of it.
 *   - NOTHING armable (the free remainder is zero / below minQty / below
 *     minNotional) ⇒ [] + a blocker. A stop Binance can only answer with -2010
 *     would otherwise be re-derived every tick, forever; the blocker names what
 *     the operator must cancel. The resting stop and any foreign order are LEFT
 *     untouched — `openOrders` is a TTL cache and cancelling a live stop we merely
 *     cannot resize strips real protection.
 *   - the priced order falls outside Binance's `PERCENT_PRICE_BY_SIDE` band ⇒
 *     [] + a blocker, again leaving anything resting alone. The exchange can only
 *     answer -1013, so cancelling to make room buys nothing and costs the
 *     protection already in place.
 *   - no resting stop ⇒ [place]; trigger OR sized quantity drifted materially ⇒
 *     [cancel, place]; within both bands ⇒ [] (no churn).
 *
 * Fail-OPEN: an unreadable wallet (`free === undefined`) skips the partial branch
 * and arms the full tracked `held` — refusing to protect an open position needs
 * proof the coins are gone. Position-preserving: this places / re-prices a resting
 * order, it never closes the position.
 */
export const evaluateProtectiveStopArm = <C, S, B extends Readonly<Record<string, unknown>>>(
  params: ProtectiveStopArmParams<C, S, B>,
): ProtectiveStopArm => {
  const { input, enabled, level, reclaimableBase, ourClientOrderId, buildPlace, buildCancel } =
    params;

  const cancelResting = (): Decision[] => {
    const resting = findRestingProtectiveStop(input.openOrders, ourClientOrderId);
    return resting === undefined ? [] : [buildCancel(resting)];
  };

  if (!enabled) return { decisions: [], blocker: null };
  if (level === null) return { decisions: cancelResting(), blocker: null };
  const { stop, limit, held, filters, tick } = level;

  // What FULL protection costs, from the bot's tracked position. Sized first so a
  // refusal can still tell the operator what the stop needed.
  const full = finalise(roundToStep(held, filters.step), stop, filters);
  if ('skip' in full) return { decisions: cancelResting(), blocker: null };

  const symbol = input.market.symbol;
  // `sizableBase` decides unknown-vs-zero: an unreadable wallet (`!readable`)
  // fails OPEN on the tracked position, while a base absent from a readable
  // snapshot is Binance saying the coins are gone — arm nothing, and do not credit
  // a resting stop the wallet no longer backs.
  const { free, reclaimable } = sizableBase(
    input.account,
    input.market.symbolInfo.baseAsset,
    reclaimableBase,
  );
  const available = armableBaseQuantity(held, free, reclaimable);

  let sized = full;
  if (free !== undefined && available.lt(held)) {
    const partial = finalise(roundToStep(available, filters.step), stop, filters);
    if ('skip' in partial) {
      // NOTHING is armable. Refuse, and always say why: an open position with no
      // stop and no explanation is the silent failure this branch exists to end.
      // Emit no order (Binance could only answer -2010) and touch NOTHING resting.
      return {
        decisions: [],
        blocker: classifyProtectiveStopRefusal({
          symbol,
          openOrders: input.openOrders,
          ourClientOrderId,
          free,
          required: full.quantity,
          available,
        }),
      };
    }
    sized = partial;
  }

  const desired: DesiredProtectiveStop = {
    stopPrice: toFixedStep(stop, tick),
    price: toFixedStep(limit, tick),
    quantity: sized.quantity,
  };

  // Resolved before `buildPlace` so the plugin is told whether this placement is
  // a first arm or a re-price of a live stop.
  const resting = findRestingProtectiveStop(input.openOrders, ourClientOrderId);

  // A stop that is already resting at the right level is settled: nothing is
  // sent, so no band applies. Tested BEFORE the band check because a blocker
  // here would be a lie the operator cannot ignore — every consumer reads the
  // field as "this position has no stop" and paints it red, and a static level
  // sits outside a tight band for most of a winning position's life.
  if (
    resting !== undefined &&
    !protectiveStopNeedsRearm(resting, desired.stopPrice, desired.quantity, params.minStopDrift)
  ) {
    return { decisions: [], blocker: null };
  }

  // Checked on the exact bytes the executor would send, and gating BOTH halves
  // of the re-arm from ONE return so a later edit cannot let the cancel through
  // alone. Emitting the pair is what left a live position unguarded: the cancel
  // lands, the replacement comes back -1013, and the arm re-derives the same
  // impossible order every tick. Leaving the resting stop in place keeps the
  // protection that does exist while the band moves back.
  const outsideBand = percentPriceBySideRefusal({
    symbol,
    reference: input.market.currentPrice,
    band: input.market.symbolInfo.filters.percentPriceBySide,
    desired,
    guarded: stillGuarding(resting, desired.quantity),
  });
  if (outsideBand !== null) return { decisions: [], blocker: outsideBand };

  if (resting === undefined) return { decisions: [buildPlace(desired, false)], blocker: null };
  // Our own stop is cancelled in the same batch, so the base it locks is released
  // before the replacement is sent: no funding check is owed here.
  return { decisions: [buildCancel(resting), buildPlace(desired, true)], blocker: null };
};
