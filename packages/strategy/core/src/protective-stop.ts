import { isRestingSell } from '@app/contracts';
import { Decimal, roundToStep, toFixedStep } from '@app/money';
import type { OpenOrder, TickInput } from './contract.js';
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

/** Why an open position has no exchange-side protective stop. One vocabulary, so every strategy's refusal glosses the same way. */
export type ProtectiveStopBlockerReason =
  | 'base-locked-by-foreign-order'
  | 'base-below-exchange-minimum'
  | 'base-short-of-tracked-position';

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

// Re-place the resting stop only when the recomputed trigger has moved by at
// least this fraction of itself (0.1%). Without the band a sub-tick wobble in
// the entry price / high-water mark would cancel + re-place every tick, churning
// exchange weight for no protection change.
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
): boolean => {
  const restingStop = safeDecimal(resting.stopPrice);
  if (restingStop === null) return false;
  const desiredStop = new Decimal(desiredStopPrice);
  if (restingStop.minus(desiredStop).abs().gte(desiredStop.mul(MIN_STOP_DRIFT))) return true;

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
  readonly buildPlace: (desired: DesiredProtectiveStop) => Decision;
  readonly buildCancel: (resting: OpenOrder) => Decision;
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
  const place = buildPlace(desired);
  const resting = findRestingProtectiveStop(input.openOrders, ourClientOrderId);
  if (resting === undefined) return { decisions: [place], blocker: null };
  if (!protectiveStopNeedsRearm(resting, desired.stopPrice, desired.quantity)) {
    return { decisions: [], blocker: null };
  }
  // Our own stop is cancelled in the same batch, so the base it locks is released
  // before the replacement is sent: no funding check is owed here.
  return { decisions: [buildCancel(resting), place], blocker: null };
};
