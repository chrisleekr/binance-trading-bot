import { isRestingSell } from '@app/contracts';
import { Decimal, roundToStep, toFixedStep } from '@app/money';
import type {
  ConfigDiagnostic,
  MetricEntry,
  OpenOrder,
  PercentPriceBySideFilter,
  ProtectiveStopBandSettings,
  TickInput,
  TrailingDeltaFilter,
} from './contract.js';
import type { Decision } from './decision.js';
import { metric } from './emit.js';
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
  // Nobody to blame: the wallet holds less base than the bot thinks it does (reconciliation drift, an operator withdrawal, or coins locked by an order this profile did not place and cannot see). Split the two so the gloss can tell "there is nothing there" from "there is too little to trade".
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
 * The deepest stop, as a fraction below the reference price, that Binance's
 * `PERCENT_PRICE_BY_SIDE` band still accepts for a stop whose limit leg sits at
 * `limitOffset × trigger`. Inverting `price ≥ ref × askMultiplierDown` on the
 * lower (limit) leg gives `1 − askMultiplierDown ÷ limitOffset`.
 *
 * `null` on every ambiguity — no band, a band that is not an object, an
 * unparseable multiplier, an unusable offset — and a null MUST read as "no
 * constraint", never as zero, or an unreadable band would refuse every stop.
 *
 * The single owner of that algebra. The tick-time refusal, the bind-time warning
 * and the operator gloss all quote this one number; a second derivation would
 * let two surfaces name two different maxima for the same symbol.
 */
export const maxStopDistancePct = (
  band: PercentPriceBySideFilter | null | undefined,
  limitOffset: Decimal,
): Decimal | null => {
  // Cast, not parsed: the cached symbol blob is revived with a bare `as`, so
  // this slot can hold any JSON value, `null` included.
  if (typeof band !== 'object' || band === null) return null;
  if (!limitOffset.isFinite() || limitOffset.lte(0)) return null;
  const down = positiveDecimal(band.askMultiplierDown);
  return down === null ? null : new Decimal(1).minus(down.div(limitOffset));
};

// Percent for an operator, not for a machine: two places is enough to compare
// against a stop-loss field and never renders in exponential notation.
const asPercent = (value: Decimal): string => `${value.mul(100).toDecimalPlaces(2).toString()}%`;

// What the profile will actually do when the exchange refuses the stop. Named
// with the same words the settings form uses, so the operator can find the knob.
const ON_BAND_BLOCK_CONSEQUENCE: Readonly<
  Record<ProtectiveStopBandSettings['onBandBlock'], string>
> = {
  notify:
    '"If Binance rejects the backup stop" is set to notify, so the bot will alert you and the position will sit with no resting stop behind it.',
  clamp:
    '"If Binance rejects the backup stop" is set to clamp, so the bot will raise the resting stop to the deepest level Binance accepts — closer to the market than you asked for.',
  'native-trail':
    '"If Binance rejects the backup stop" is set to native-trail, so the bot will rest a Binance trailing stop instead, which this price band does not apply to.',
};

// Once the maximum drops to the margin's own headroom the clamp escape has
// nothing to clamp to: `clampStopToExchangeFloor` returns the level untouched
// rather than rest a trigger that fires on contact, so the profile behaves
// exactly like `notify`.
// Promising the raise anyway is worse than the ordinary warning, because it tells
// the operator a fallback is covering them when none is.
const CLAMP_SPENT =
  '"If Binance rejects the backup stop" is set to clamp, but there is no level to clamp to while the limit price sits this far under the trigger, so the bot will alert you and the position will sit with no resting stop behind it.';

// The trail escape has its own way of being spent, and it is not the clamp's.
// `TRAILING_DELTA` bounds are published per symbol, so a distance outside them
// yields no delta, the arm falls through to the refusal, and nothing rests —
// while the ordinary sentence promises a trailing stop is covering the position.
// Same failure as the spent clamp: the escape the operator selected is the one
// that cannot run.
const NATIVE_TRAIL_UNAVAILABLE =
  '"If Binance rejects the backup stop" is set to native-trail, but this symbol will not accept a trailing stop at this distance, so the bot will alert you and the position will sit with no resting stop behind it.';

/**
 * The sentence for a selected escape that cannot run on this symbol, or `null`
 * when it can. Each escape is judged against the filter that governs it, never
 * against the other's, so neither can inherit the other's availability.
 */
const spentEscape = (
  settings: ProtectiveStopBandSettings,
  max: Decimal,
  trailing: TrailingDeltaFilter | null | undefined,
): string | null => {
  if (settings.onBandBlock === 'clamp' && max.lte(CLAMP_SPENT_AT_OR_BELOW)) return CLAMP_SPENT;
  if (
    settings.onBandBlock === 'native-trail' &&
    nativeTrailingDelta({ stopDistancePct: settings.stopDistancePct, filter: trailing }) === null
  ) {
    return NATIVE_TRAIL_UNAVAILABLE;
  }
  return null;
};

/**
 * The tick-time counterpart of {@link protectiveStopBandWarning}: one metric
 * entry when the price band moved this tick's stop off the configured one, empty
 * when it did not.
 *
 * Both `onBandBlock` escapes silently substitute something for the level the
 * operator set — a clamp rests the stop nearer the market, a native trail rests
 * a different ORDER TYPE with a market fill — and neither leaves a blocker
 * behind, because from the strategy's side nothing was refused. Without a series
 * of its own an operator has no way to learn their stop is not the one they
 * configured, on any symbol, for as long as the band binds.
 *
 * One name across strategies, distinguished by the drained `strategy` label, so
 * an alert rule covers every profile rather than one per plugin. Only `symbol`
 * and `reason` are carried: the metrics sink drops every other tag.
 *
 * The two causes are mutually exclusive by construction — a clamp is applied
 * only under `onBandBlock: 'clamp'` and a trail only under `'native-trail'` —
 * so this never has to rank them.
 *
 * EVENT semantics, and every caller owes them: emit only on a tick that actually
 * sends the adjusted order, never on every tick spent holding one. A caller that
 * emits per held tick makes this name mean two things at once, so summing it
 * across strategies means nothing and a `rate(...) > 0` rule reads a settled,
 * still-clamped stop as resolved. "Is this stop clamped right now" is a state
 * question and belongs on the operator surfaces, not on a counter.
 */
export const protectiveStopBandAdjustment = (params: {
  readonly symbol: string;
  readonly floorClamped: boolean;
  readonly nativeTrailed: boolean;
}): MetricEntry[] => {
  const { symbol, floorClamped, nativeTrailed } = params;
  const reason = nativeTrailed ? 'native-trail' : floorClamped ? 'floor-clamped' : null;
  return reason === null ? [] : [metric('protective_stop_band_adjusted', { symbol, reason })];
};

/**
 * Advisory warning for a stop the symbol's price band cannot hold, for a caller
 * that has the config and the filters but no position yet — a symbol bind, a
 * settings save. Names the achievable maximum and what the profile will do
 * instead, so the operator can widen the stop or switch the fallback knowingly.
 *
 * Never a `block`: a stop deeper than the band is a legitimate choice, and under
 * `native-trail` it works exactly as configured. Rejecting the bind would refuse
 * a working setup.
 *
 * `null` — fail OPEN — whenever the profile rests no stop or the band imposes no
 * readable constraint. A symbol that publishes no band must bind unimpeded.
 *
 * Takes the `TRAILING_DELTA` filter alongside the band because neither escape
 * can be promised without the filter that governs it: the band decides whether
 * the priced stop is refused at all, and the trailing bounds decide whether the
 * trail the operator picked can carry this distance on this symbol.
 */
export const protectiveStopBandWarning = (params: {
  readonly settings: ProtectiveStopBandSettings | null;
  readonly band: PercentPriceBySideFilter | null | undefined;
  readonly trailing: TrailingDeltaFilter | null | undefined;
}): ConfigDiagnostic | null => {
  const { settings, band, trailing } = params;
  if (settings === null) return null;
  const max = maxStopDistancePct(band, settings.limitOffsetPct);
  if (max === null || settings.stopDistancePct.lte(max)) return null;
  // A non-positive maximum is the config-shaped case: the limit offset is at or
  // under the band's floor multiplier, so no stop distance at all is placeable
  // and quoting "no deeper than -0.5%" would read as a target to aim at.
  const ceiling = max.gt(0)
    ? `accepts a resting stop no deeper than ${asPercent(max)} below the market`
    : 'accepts no resting stop at all while the limit price sits this far under the trigger';
  const consequence =
    spentEscape(settings, max, trailing) ?? ON_BAND_BLOCK_CONSEQUENCE[settings.onBandBlock];
  return {
    level: 'warn',
    code: 'stop-outside-exchange-band',
    message: `This backup stop sits ${asPercent(settings.stopDistancePct)} below the market, but Binance's price band for this symbol ${ceiling}. ${consequence}`,
    path: [...settings.path],
  };
};

/**
 * Whether Binance's `PERCENT_PRICE_BY_SIDE` band makes this stop unplaceable,
 * as a blocker, or `null` when it is placeable or the band is unknown.
 *
 * Judged on BOTH legs of the order. The exchange bands the trigger as well as
 * the limit: a SELL `STOP_LOSS` carrying only a `stopPrice` outside the window
 * is refused `-1013 Filter failure: PERCENT_PRICE_BY_SIDE`, and so is a
 * `STOP_LOSS_LIMIT` whose `stopPrice` sits outside while its `price` sits
 * inside. That is measured behaviour, not a reading of which fields the filter
 * definition names. Because `stopPrice > price` on every protective stop, only
 * the limit can breach the floor and only the trigger can breach the ceiling —
 * so judging the limit alone left the entire ceiling side unguarded, passing an
 * order whose cancel half lands and whose replacement half cannot.
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
  // Both legs are banded, but they can only ever breach opposite ends: the limit
  // is the lower leg, so the floor is its alone, and the ceiling is the trigger's
  // alone. Testing the trigger against the floor as well would add nothing and
  // testing the limit against the ceiling costs nothing.
  const aboveCeiling = ceiling !== null && (stopPrice.gt(ceiling) || price.gt(ceiling));
  if (!belowFloor && !aboveCeiling) return null;

  const ratio = price.div(stopPrice);
  // The floor breach restated as the stop DISTANCE the operator is choosing:
  // `price < ref × down` is exactly `requiredStopDistancePct > maxDistance`.
  // Derived once so the worker alert and the web gloss quote the same two
  // numbers instead of each re-deriving the algebra from the raw multipliers.
  const maxDistance = maxStopDistancePct(band, ratio);
  const requiredStopDistancePct = new Decimal(1).minus(stopPrice.div(ref));
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
      maxStopDistancePct: maxDistance === null ? null : maxDistance.toDecimalPlaces(6).toString(),
      requiredStopDistancePct: requiredStopDistancePct.toDecimalPlaces(6).toString(),
      terminal: belowFloor && down !== null && ratio.lte(down),
      // Which bound was actually breached, so the gloss never quotes a floor at
      // an operator whose stop is priced too HIGH. One price cannot breach both
      // unless the band itself is inverted, where the floor is the safer read.
      bound: belowFloor ? 'floor' : 'ceiling',
      guarded,
    },
  };
};

// Absorbs the gap between the caller's last-trade `reference` and the 5-minute
// mean the exchange bands against. Measured drift is under 0.05%; the error that
// matters is last BELOW the mean during a fast fall, exactly when the stop must
// land. 1% is ~25x the observed drift and costs 1% of stop distance.
const EXCHANGE_FLOOR_MARGIN = new Decimal('1.01');

// The maximum stop distance at which the clamp still has somewhere to raise to.
// `clampStopToExchangeFloor` declines once the margin-lifted floor reaches the
// reference, and `floor / ref` is `(1 - maxStopDistancePct) x EXCHANGE_FLOOR_MARGIN`,
// so the clamp goes inert a hair BEFORE the maximum reaches zero. Derived from
// the margin the clamp actually applies, so one constant governs both the
// behaviour and the sentence describing it.
const CLAMP_SPENT_AT_OR_BELOW = new Decimal(1).minus(new Decimal(1).div(EXCHANGE_FLOOR_MARGIN));

/**
 * The exchange facts a stop-level resolver needs to apply the floor clamp: the
 * reference price the caller already holds and the symbol's published band.
 * Both nullable — a preview may carry neither and a symbol may publish no band —
 * which reads as "do not clamp", never as "clamp to zero".
 */
export interface StopBandContext {
  readonly reference: string | null;
  readonly band: PercentPriceBySideFilter | null | undefined;
}

/**
 * Raise a stop trigger to the lowest level Binance's `PERCENT_PRICE_BY_SIDE`
 * band would still accept, or return it unchanged.
 *
 * Both legs are banded and the LOWER one binds, so an acceptable stop needs
 * `stop × limitOffset >= reference × askMultiplierDown`. Inverting that gives
 * the trigger floor, which {@link EXCHANGE_FLOOR_MARGIN} then lifts clear of the
 * exchange's own averaged reference.
 *
 * Identity on every ambiguity — no band, a band that is not an object, an
 * unparseable multiplier or reference, an unusable offset, no stop to raise, a
 * stop already at or above the floor. Identity ALSO when the floor is not
 * strictly below the reference: that is the config-shaped case where no price
 * movement can arm the stop, and a trigger resting at or above the market fires
 * on contact, which is a market sell wearing a stop's name.
 *
 * Tightening protection is the accepted cost. A clamped stop sits nearer the
 * market than the operator asked for, which is the tradeoff of having a resting
 * order at all versus having none.
 *
 * The returned stop tracks the caller's nullability: a resolver that already
 * holds a level gets a non-null one back, so it needs no unreachable fallback
 * branch to satisfy the type.
 */
export const clampStopToExchangeFloor = <TStop extends Decimal | null>(params: {
  readonly stop: TStop;
  readonly reference: string;
  readonly band: PercentPriceBySideFilter | null | undefined;
  readonly limitOffset: Decimal;
}): { readonly stop: TStop | Decimal; readonly clamped: boolean } => {
  const { stop, reference, band, limitOffset } = params;
  const identity = { stop, clamped: false };
  if (stop === null) return identity;
  // Cast, not parsed, exactly as in `percentPriceBySideRefusal`: the cached
  // symbol blob can hold any JSON value in this slot.
  if (typeof band !== 'object' || band === null) return identity;
  if (!limitOffset.isFinite() || limitOffset.lte(0)) return identity;

  const ref = positiveDecimal(reference);
  const down = positiveDecimal(band.askMultiplierDown);
  if (ref === null || down === null) return identity;

  const floor = ref.mul(down).div(limitOffset).mul(EXCHANGE_FLOOR_MARGIN);
  if (!floor.lt(ref) || stop.gte(floor)) return identity;
  return { stop: floor, clamped: true };
};

// A trailing delta is a whole number of basis points: 10000 = 100%.
const BIPS_PER_UNIT = new Decimal(10_000);

/**
 * What an exchange-native trailing protective stop is placed with: a size and a
 * trailing distance. No trigger and no limit — Binance derives the trigger from
 * the high-water mark it tracks itself, which is precisely why this order type
 * escapes the `PERCENT_PRICE_BY_SIDE` band that refuses a priced stop.
 */
export interface DesiredNativeTrailingStop {
  readonly quantity: string;
  readonly trailingDelta: number;
}

/**
 * The `trailingDelta` (basis points) for the operator's CONFIGURED stop distance,
 * or null when the symbol will not accept that distance.
 *
 * Derived from the config fraction, never from `1 − stop / currentPrice`. The
 * exchange already measures the trail from its own high-water mark, so feeding it
 * a distance measured from the live price double-counts: the delta would then
 * differ every time price moved, and since the re-arm test compares deltas, the
 * stop would be cancelled and re-placed on a fraction of a percent of drift.
 * Every replacement restarts Binance's high-water mark, so that churn does not
 * merely cost order weight — it destroys the very tracking the trail exists for.
 *
 * Null on every ambiguity, exactly as {@link clampStopToExchangeFloor} is
 * identity on every ambiguity: no `TRAILING_DELTA` filter published, a filter
 * that is not an object, non-integer bounds, a distance outside `(0, 1)`, or a
 * distance outside the symbol's own bounds. The caller falls back to the ordinary
 * refusal, which is the honest outcome — a delta the exchange rejects would
 * otherwise be sent as an order the operator never asked for while reporting no
 * problem.
 *
 * Only the `Below` bounds are consulted: a SELL stop-loss trails DOWN from the
 * high-water mark, so the `Above` pair governs a different order entirely.
 */
export const nativeTrailingDelta = (params: {
  readonly stopDistancePct: Decimal;
  readonly filter: TrailingDeltaFilter | null | undefined;
}): number | null => {
  const { stopDistancePct, filter } = params;
  // Cast, not parsed, as everywhere else that reads the cached symbol blob.
  if (typeof filter !== 'object' || filter === null) return null;
  const { minTrailingBelowDelta: min, maxTrailingBelowDelta: max } = filter;
  if (!Number.isInteger(min) || !Number.isInteger(max)) return null;

  // A distance at or above 1 puts the trigger at or below zero, and one at or
  // below 0 is not a stop. Both read as "no usable delta" rather than clamping,
  // so a nonsense config falls back to the refusal instead of resting an order
  // nobody asked for.
  if (!stopDistancePct.isFinite() || stopDistancePct.lte(0) || stopDistancePct.gte(1)) return null;

  const bips = stopDistancePct.mul(BIPS_PER_UNIT).toDecimalPlaces(0).toNumber();
  return bips >= min && bips <= max ? bips : null;
};

/**
 * Operator-facing line for a protective stop that will rest as an exchange-native
 * trail, or null when the ordinary PRICED stop is what will actually rest.
 *
 * A preview row exists to name the level the tick acts on, and a native trailing
 * stop HAS no such level: Binance derives the trigger from a high-water mark that
 * begins at placement and moves on its own. Quoting the configured price would
 * print a number nothing ever acts on, and quoting it as a `trigger` row would
 * make the drift gate compare a static level against a moving one, which fails
 * the moment price advances. So the caller drops the price and shows this
 * instead.
 *
 * Null on the same terms the arm falls back on: the band accepts the priced stop,
 * the breach is the ceiling rather than the floor, or no usable delta could be
 * derived. The percentage quoted is read back OUT of the delta, so the sentence
 * cannot claim a distance the order does not carry.
 *
 * Takes the symbol's tick size because the arm judges the band against
 * tick-rounded legs, and rounding moves the limit leg across the floor on the
 * tick where the market sits on the boundary. Unrounded here, the two would
 * disagree exactly there — the arm resting a trail while this row printed a
 * fixed trigger price, which is the disagreement the drift gate exists to catch.
 * Null tick means the symbol published no step to round to, so both sides judge
 * the raw prices and still agree.
 */
export const nativeTrailPreviewNote = (params: {
  readonly stop: Decimal;
  readonly limit: Decimal;
  readonly tick: Decimal | null;
  readonly reference: string | null;
  readonly stopDistancePct: Decimal;
  readonly band: PercentPriceBySideFilter | null | undefined;
  readonly trailing: TrailingDeltaFilter | null | undefined;
}): string | null => {
  const { stop, limit, tick, reference, stopDistancePct, band, trailing } = params;
  if (reference === null) return null;
  const onGrid = (value: Decimal): string =>
    tick === null ? value.toString() : toFixedStep(value, tick);
  const refused = percentPriceBySideRefusal({
    symbol: '',
    reference,
    band,
    desired: { stopPrice: onGrid(stop), price: onGrid(limit), quantity: '0' },
    guarded: false,
  });
  if (refused === null) return null;
  // Same bound the arm restricts the escape to. A ceiling breach falls through to
  // the refusal there and rests nothing, so printing the trail sentence on one
  // would promise the operator an order Binance is never asked for.
  if (refused.detail['bound'] !== 'floor') return null;
  const delta = nativeTrailingDelta({ stopDistancePct, filter: trailing });
  if (delta === null) return null;
  const pct = new Decimal(delta).div(100).toString();
  return `No fixed trigger price — Binance trails this stop ${pct}% below the highest price seen since it was placed, then sells at market.`;
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

// A floor-clamped level is pinned to the exchange floor, which is a fraction of
// the CURRENT price — so it moves whenever the market does, and the 0.1% default
// re-places the resting stop on almost every tick for as long as the band binds.
// A whole percent is the smallest band that makes that quiet, and it costs
// nothing: the clamped level never sinks below the configured stop, so the only
// thing a wider band delays is the floating portion following the market down.
const CLAMPED_STOP_DRIFT = new Decimal('0.01');

/**
 * The re-arm drift band for a stop the exchange floor is holding up, given
 * whatever band the plugin would otherwise use (`null` = the shared default).
 *
 * Always the wider of the two. A plugin that deliberately set a wider band did
 * so to bound its own order rate, and the clamp is a reason to send fewer
 * orders, never more.
 */
export const clampedStopDrift = (operatorBand: Decimal | null): Decimal =>
  operatorBand === null ? CLAMPED_STOP_DRIFT : Decimal.max(operatorBand, CLAMPED_STOP_DRIFT);

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
 *
 * The one exception is a resting order that carries a `trailingDelta` when the
 * caller wants a priced stop: that is a wrong order type rather than a stale
 * price, and it is re-armed unconditionally.
 *
 * `desiredTrailingDelta` switches the test to the exchange-native trailing stop,
 * which has no trigger to compare: the exchange owns the high-water mark and
 * moves the trigger with it. The ONLY thing that can drift is the configured
 * distance, and re-arming on anything else is actively harmful — a cancel and
 * replace restarts the trail from the current price, throwing away every bit of
 * high-water mark the resting order had accumulated.
 */
export const protectiveStopNeedsRearm = (
  resting: OpenOrder,
  desiredStopPrice: string,
  desiredQuantity: string,
  minStopDrift: Decimal = MIN_STOP_DRIFT,
  desiredTrailingDelta?: number,
): boolean => {
  if (desiredTrailingDelta !== undefined) {
    // A trail carries no trigger to drift, so distance replaces the price test —
    // but only that test. The SIZE of a trailing stop drifts exactly as a priced
    // one does, and the quantity band below is the only thing that ever corrects
    // an undersized stop.
    if (resting.trailingDelta !== desiredTrailingDelta) return true;
  } else if (resting.trailingDelta !== undefined) {
    // A trail is resting and the caller no longer wants one. That is a wrong
    // ORDER TYPE, not a drifted trigger, and no price comparison can detect it:
    // a trailing order reports no `stopPrice`, so the priced branch below reads
    // it as unparseable and leaves it alone — forever, silently, because the arm
    // reports no blocker either.
    return true;
  } else {
    const restingStop = safeDecimal(resting.stopPrice);
    if (restingStop === null) return false;
    const desiredStop = new Decimal(desiredStopPrice);
    if (restingStop.minus(desiredStop).abs().gte(desiredStop.mul(minStopDrift))) return true;
  }

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
   * The EXCHANGE-NATIVE trailing escape for a stop the price band refuses.
   * Present only when the operator chose `onBandBlock: 'native-trail'`; absent, a
   * banded stop is refused with a blocker as before.
   *
   * The tradeoff the operator accepted: the order keeps their full stop distance
   * and escapes the band, but it triggers a MARKET sell (no limit leg exists to
   * be banded) and it trails from the high-water mark SINCE PLACEMENT, not from
   * the entry price. That makes it a crash net rather than an entry-anchored stop.
   *
   * Builder and distance travel together so neither can be supplied alone. The
   * distance is the CONFIGURED fraction, not one measured against the live price:
   * see {@link nativeTrailingDelta} for why a price-derived delta re-arms the
   * order on every tick and resets the exchange's high-water mark each time.
   */
  readonly nativeTrail?: {
    readonly stopDistancePct: Decimal;
    readonly build: (desired: DesiredNativeTrailingStop, rearm: boolean) => Decision;
  };
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
 *     protection already in place. UNLESS `buildNativeTrailPlace` is supplied, in
 *     which case the same protection goes out as an exchange-native trailing
 *     `STOP_LOSS`, which the band does not reach.
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

  // The basis-point distance the operator's CONFIGURED stop maps to on this
  // symbol, or null when they did not choose native trailing or the symbol will
  // not accept that distance. Stable across ticks by construction: it is derived
  // from config, never from the moving price.
  const trailingDelta =
    params.nativeTrail === undefined
      ? null
      : nativeTrailingDelta({
          stopDistancePct: params.nativeTrail.stopDistancePct,
          filter: input.market.symbolInfo.filters.trailingDelta,
        });

  // A resting order carrying a delta is an exchange-native trail and is judged on
  // distance alone.
  //
  // Two different "no delta this tick" cases hide here and must NOT be conflated.
  // The symbol going quiet on its `TRAILING_DELTA` bounds is transient, and
  // treating the resting delta as unchanged keeps live protection rather than
  // tearing it down over a missing filter. The operator leaving `native-trail`
  // is not transient: holding the trail there would make the mode change a no-op
  // for the life of the position, silently, because the arm reports no blocker.
  // So an abandoned trail reports `undefined` and falls through to the priced
  // re-arm path, where the band check decides on its merits.
  const abandoningTrail = resting?.trailingDelta !== undefined && params.nativeTrail === undefined;
  const restingTrailDelta =
    abandoningTrail || resting?.trailingDelta === undefined
      ? undefined
      : (trailingDelta ?? resting.trailingDelta);

  // A stop that is already resting at the right level is settled: nothing is
  // sent, so no band applies. Tested BEFORE the band check because a blocker
  // here would be a lie the operator cannot ignore — every consumer reads the
  // field as "this position has no stop" and paints it red, and a static level
  // sits outside a tight band for most of a winning position's life.
  if (
    resting !== undefined &&
    !protectiveStopNeedsRearm(
      resting,
      desired.stopPrice,
      desired.quantity,
      params.minStopDrift,
      restingTrailDelta,
    )
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
    // Measured against FULL protection, not the quantity this tick could size.
    // A stop armed while a foreign order held most of the base covers a fraction
    // of the position; calling that guarded is exactly the dismissible-amber-chip
    // downgrade `stillGuarding` exists to refuse.
    guarded: stillGuarding(resting, full.quantity),
  });
  if (outsideBand !== null) {
    // The band refuses the PRICED stop, and the operator asked for the trailing
    // escape. Binance bands a trigger, not a distance, so a `STOP_LOSS` carrying
    // only a `trailingDelta` is accepted where the same protection expressed as a
    // price is not — and it keeps the distance the operator chose instead of
    // tightening it. A derivation that came back null (bounds unpublished, or the
    // distance outside them) falls through to the refusal rather than sending a
    // distance nobody asked for.
    //
    // Only a FLOOR breach. A ceiling breach means the desired trigger sits ABOVE
    // the market by more than the band allows, which a stop trailing DOWNWARD
    // from a high-water mark cannot express at any distance: it would rest a
    // far-below-market order in place of one meant to fire almost immediately.
    if (
      params.nativeTrail !== undefined &&
      trailingDelta !== null &&
      outsideBand.detail['bound'] === 'floor'
    ) {
      const place = params.nativeTrail.build(
        { quantity: desired.quantity, trailingDelta },
        resting !== undefined,
      );
      return {
        decisions: resting === undefined ? [place] : [buildCancel(resting), place],
        blocker: null,
      };
    }
    return { decisions: [], blocker: outsideBand };
  }

  if (resting === undefined) return { decisions: [buildPlace(desired, false)], blocker: null };
  // Our own stop is cancelled in the same batch, so the base it locks is released
  // before the replacement is sent: no funding check is owed here.
  return { decisions: [buildCancel(resting), buildPlace(desired, true)], blocker: null };
};
