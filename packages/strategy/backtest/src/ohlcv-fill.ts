import { Decimal, meetsMinNotional, roundToStep, roundToTick } from '@app/money';
import type { Candle, OrderSide } from '@app/strategy-core';
import type {
  Fill,
  FillInput,
  FillModel,
  FillOutcome,
  FillReservation,
  ReserveInput,
} from './types.js';

const BPS = new Decimal(10_000);

/**
 * Refuse an order type this model cannot simulate.
 *
 * A `STOP_LOSS` carrying a `trailingDelta` has no price of any kind: Binance
 * tracks the high-water mark and derives the trigger itself, which is exchange
 * state this replay does not model. Every price path here falls back to `'0'` on
 * a missing price, so simulating it would fill at zero — a fictional, wildly
 * profitable exit that would make a backtest recommend the setting. Failing loud
 * is the only honest option until the model can trail.
 */
const assertSupportedType = (type: string): void => {
  if (type === 'STOP_LOSS') {
    throw new Error(
      'ohlcv-fill: STOP_LOSS (exchange-native trailing stop) is not supported by the backtest fill model — the trail is exchange-side state this replay does not simulate',
    );
  }
};

export interface OhlcvFillModelOptions {
  /** Fee on resting LIMIT fills (provides liquidity), basis points of notional. */
  readonly makerBps: number;
  /** Fee on MARKET / stop fills (takes liquidity), basis points of notional. */
  readonly takerBps: number;
  /** Slippage applied to MARKET / stop fills, basis points of the fill price. */
  readonly slippageBps: number;
  /**
   * Bid/ask spread in basis points. Half of it worsens MARKET and immediate stop fills. For a LIMIT it never moves the execution price, because an exchange limit cannot execute past its limit; it tightens the crossing test instead, so a resting order needs the bar to trade through the limit by the half-spread. Optional; defaults to 0.
   */
  readonly spreadBps?: number;
  /**
   * Volume-participation cap: a single fill may take at most this percentage of
   * the filling bar's base volume. The remainder rests and works across later
   * bars. Models that a large order cannot clear at one price on a thin bar; on
   * a zero-volume bar a LIMIT or activated stop keeps waiting and a MARKET is refused (`no-fill`). `null` or
   * omitted disables the cap, leaving small orders and existing runs unchanged.
   */
  readonly volumeCapPct?: number | null;
}

/**
 * Realistic candle-granularity fill model (Freqtrade-aligned).
 *
 * Timing: an order never fills on the candle it was placed on — `place`
 * returns `rest`, so the executor holds it and re-evaluates on later candles.
 * That gives the standard "signal on candle N, fill on candle N+1" rule and
 * keeps the strategy from acting on a candle it then fills against.
 *
 * Fills (evaluated against the candle's detail bars, in time order):
 *   - LIMIT  fills at exactly the limit price the first time a detail bar trades THROUGH
 *            it after the half-spread (BUY: low x spread < limit; SELL: high x spread > limit), not on a mere
 *            touch, modelling maker queue non-fill; maker fee.
 *   - MARKET fills at the candle open shifted by slippage; taker fee.
 *   - STOP_LOSS_LIMIT arms once a detail bar reaches the stop (SELL: low <= stop; BUY: high >= stop). The candidate price is the trigger (the stop, or the arming bar's open when it gapped past the stop) after slippage and the half-spread. A candidate inside the limit fills there as a taker. A candidate outside it is never clamped: the order rests as an activated LIMIT, and the same-bar high or low is ignored because the OHLC bar does not say whether that recovery came after the trigger. A later bar that trades through the limit fills it at exactly the limit as a maker, even one that recovered back past the stop, as Binance's already-activated limit would. The activation is remembered across evaluations (the executor passes `armed` back).
 *
 * Filters: stepSize/tickSize quantisation, minNotional and minQty are
 * enforced; a sub-notional order is rejected, not silently shrunk. A buy the
 * quote cannot fund at the ORDER price (or a sell larger than the held base) is
 * rejected whole, as Binance rejects an underfunded order (-2010) at placement;
 * the per-bar volume cap shrinks a funded order to a `partial`.
 *
 * Liquidity is finite only to the extent of the optional volume cap; absent it,
 * liquidity is assumed infinite at the fill price (the documented optimism of a
 * candle-level backtest). Latency is not modelled (it cannot change a fill
 * decided at a candle boundary), so outcomes report `latencyMs: 0`.
 *
 * A LIMIT fills at the limit price even when a bar gapped past it (Freqtrade's
 * convention: limit orders fill at the order rate, not the bar's actual
 * extreme). That is pessimistic for a BUY that gaps below its limit and
 * optimistic for a SELL that gaps above — both are inherent to candle-level
 * replay and surfaced in the operator-facing disclaimer.
 */
export class OhlcvFillModel implements FillModel {
  private readonly makerBps: number;
  private readonly takerBps: number;
  private readonly slippageBps: number;
  private readonly spreadBps: number;
  private readonly volumeCapPct: number | null;

  constructor(opts: OhlcvFillModelOptions) {
    this.makerBps = opts.makerBps;
    this.takerBps = opts.takerBps;
    this.slippageBps = opts.slippageBps;
    this.spreadBps = opts.spreadBps ?? 0;
    this.volumeCapPct = opts.volumeCapPct ?? null;
  }

  /**
   * Funds a resting order locks. Every order rests one candle in this model (`fill` returns `rest` on the place phase for all types), so the lock is sized by order type.
   *
   * A BUY locks its limit times quantity plus the larger of the maker and taker fee, because a stop-limit can fill either way and no fill executes past the limit, so a spread uplift would lock quote no fill can spend. A stop-limit that fills below its limit leaves excess lock, which returns on fill. A SELL locks the base it will deliver; a MARKET buy carries no price and locks nothing.
   *
   * @param input - The order being placed and the symbol it trades, which picks the locked asset.
   * @returns The asset and amount to move from free to locked while the order rests.
   */
  reserve(input: ReserveInput): FillReservation {
    const { intent, params, symbolInfo } = input;
    assertSupportedType(params.type);
    const qty = new Decimal(params.quantity);
    if (intent.side === 'SELL') return { asset: symbolInfo.baseAsset, amount: qty };
    const notional = new Decimal(params.price ?? params.stopPrice ?? '0').mul(qty);
    const feeBps = this.makerBps > this.takerBps ? this.makerBps : this.takerBps;
    const fee = notional.mul(feeBps).div(BPS);
    return { asset: symbolInfo.quoteAsset, amount: notional.add(fee) };
  }

  fill(input: FillInput): FillOutcome {
    assertSupportedType(input.params.type);
    // Placement never fills on the same candle — defer to the resting book.
    if ((input.phase ?? 'place') === 'place') return { kind: 'rest' };

    const { intent, params, market, symbolInfo, account, clock } = input;
    const tick = new Decimal(symbolInfo.filters.tickSize);
    const step = new Decimal(symbolInfo.filters.stepSize);
    const requestedQty = roundToStep(new Decimal(params.quantity), step);
    if (requestedQty.lte(0)) return { kind: 'rejected', reason: 'step-size', latencyMs: 0 };

    const bars =
      market.detailCandles && market.detailCandles.length > 0
        ? market.detailCandles
        : [market.lastCandle];

    const priced = this.resolveFillPrice(intent.side, params, bars, tick, input.armed === true);
    if (priced === null) return { kind: 'rest' }; // not crossed yet — keep resting
    if (priced === 'armed') return { kind: 'rest', armed: true };
    const { price, feeBps, bar } = priced;

    const minQty = new Decimal(symbolInfo.filters.minQty);
    const minNotional = new Decimal(symbolInfo.filters.minNotional);

    // Binance rejects (-2010) an order the balance cannot fund at its ORDER price, the notional it locks at placement. A buy's fill never executes above that price, so an all-in buy funded at its limit fills whole.
    if (
      !this.canFundAtOrderPrice(
        intent.side,
        requestedQty,
        params,
        price,
        feeBps,
        account,
        symbolInfo,
      )
    )
      return { kind: 'rejected', reason: 'insufficient-balance', latencyMs: 0 };

    // Cap by what the account can actually transact at the fill price, so rounding at the step or a fee difference shrinks to a partial rather than overdrawing.
    const affordable = this.affordableQty(
      intent.side,
      requestedQty,
      price,
      feeBps,
      account,
      symbolInfo,
      step,
    );
    if (affordable.lte(0))
      return { kind: 'rejected', reason: 'insufficient-balance', latencyMs: 0 };

    // A MARKET never works on the book, so a bar it cannot trade refuses it and the next tick re-decides. A limit or activated stop keeps waiting.
    const onThinBar: FillOutcome =
      params.type === 'MARKET'
        ? { kind: 'rejected', reason: 'no-fill', latencyMs: 0 }
        : params.type === 'STOP_LOSS_LIMIT'
          ? { kind: 'rest', armed: true }
          : { kind: 'rest' };
    if (affordable.lt(minQty)) return { kind: 'rejected', reason: 'step-size', latencyMs: 0 };
    if (!meetsMinNotional(affordable, price, minNotional))
      return { kind: 'rejected', reason: 'min-notional', latencyMs: 0 };
    const fillable = this.volumeCapped(affordable, bar, step);
    if (fillable.lte(0) || fillable.lt(minQty) || !meetsMinNotional(fillable, price, minNotional))
      return onThinBar;

    const fill: Fill = { price, qty: fillable, feeBps, tsMs: clock.nowMs() };
    if (fillable.lt(requestedQty)) {
      return {
        kind: 'partial',
        fills: [fill],
        remainingQty: requestedQty.sub(fillable),
        latencyMs: 0,
      };
    }
    return { kind: 'filled', fills: [fill], latencyMs: 0 };
  }

  /**
   * Fill price, fee, and the bar that produced the fill (its volume bounds the
   * participation cap), or null if the order has not crossed.
   *
   * @param side - Order side; decides which bar bound reaches the stop and crosses the limit.
   * @param params - The resting order's type and prices.
   * @param bars - Detail bars of this evaluation, in time order.
   * @param tick - Symbol tick size the stop and limit are rounded to.
   * @param armed - Whether an earlier evaluation already reached this stop-limit's stop, which skips the arm check.
   * @returns The fill, null when the order keeps resting unarmed, or `'armed'` when a stop-limit armed but its limit has not crossed.
   */
  private resolveFillPrice(
    side: OrderSide,
    params: FillInput['params'],
    bars: readonly Candle[],
    tick: Decimal,
    armed: boolean,
  ): { price: Decimal; feeBps: number; bar: Candle } | 'armed' | null {
    if (params.type === 'MARKET') {
      const bar = bars[0];
      const open = new Decimal(bar?.open ?? '0');
      if (!bar || open.lte(0)) return null;
      const price = open.mul(this.slippageFactor(side)).mul(this.spreadFactor(side));
      return { price, feeBps: this.takerBps, bar };
    }

    if (params.type === 'LIMIT') {
      const limit = roundToTick(new Decimal(params.price ?? '0'), tick);
      if (limit.lte(0)) return null;
      const bar = firstCrossBar(side, limit, bars, this.spreadFactor(side));
      if (bar === null) return null;
      return { price: limit, feeBps: this.makerBps, bar };
    }

    // On Binance the stop only activates a LIMIT at `params.price`, so a guaranteed stop-market fill would hide the tail risk of a stop that gaps through its limit and never protects. An already-activated order skips the stop check and waits for a bar trading through the limit, so bar-by-bar and multi-bar evaluation agree.
    const stop = roundToTick(new Decimal(params.stopPrice ?? params.price ?? '0'), tick);
    const limit = roundToTick(new Decimal(params.price ?? params.stopPrice ?? '0'), tick);
    if (stop.lte(0) || limit.lte(0)) return null;
    const spread = this.spreadFactor(side);
    const restingFill = (from: readonly Candle[]) => {
      const bar = firstCrossBar(side, limit, from, spread);
      return bar === null ? ('armed' as const) : { price: limit, feeBps: this.makerBps, bar };
    };
    if (armed) return restingFill(bars);
    const armBar = firstStopBar(side, stop, bars);
    if (armBar === null) return null;
    // A marketable limit executes at the book, not at its limit: a live 1.54 stop with a 1.509 limit filled at 1.540. The trigger is the stop, or the arming bar's open when that bar gapped past the stop.
    const open = new Decimal(armBar.open);
    const trigger = side === 'SELL' ? Decimal.min(stop, open) : Decimal.max(stop, open);
    const candidate = trigger.mul(this.slippageFactor(side)).mul(spread);
    if (respectsLimit(side, candidate, limit)) {
      return { price: candidate, feeBps: this.takerBps, bar: armBar };
    }
    // The arming bar is excluded: an OHLC bar does not say whether its favourable extreme came after the trigger.
    return restingFill(bars.slice(bars.indexOf(armBar) + 1));
  }

  /** Slippage multiplier for a market-style fill: BUY pays up, SELL receives less. */
  private slippageFactor(side: OrderSide): Decimal {
    const slip = new Decimal(this.slippageBps).div(BPS);
    return side === 'BUY' ? new Decimal(1).plus(slip) : new Decimal(1).minus(slip);
  }

  /** Half-spread multiplier: worsens a market-style fill and tightens a limit's crossing test (BUY pays up, SELL receives less). */
  private spreadFactor(side: OrderSide): Decimal {
    const half = new Decimal(this.spreadBps).div(BPS).div(2);
    return side === 'BUY' ? new Decimal(1).plus(half) : new Decimal(1).minus(half);
  }

  /** Shrink the quantity to the bar's volume-participation cap, if one is set. */
  private volumeCapped(qty: Decimal, bar: Candle, step: Decimal): Decimal {
    if (this.volumeCapPct === null) return qty;
    const cap = new Decimal(bar.volume).mul(this.volumeCapPct).div(100);
    return Decimal.min(qty, roundToStep(cap, step));
  }

  /**
   * Whether the balance covers the order at its ORDER price, Binance's -2010
   * placement check. A BUY needs quote for
   * `qty * orderPrice * (1 + fee)` (a MARKET buy has no order price, so it is
   * checked at the fill price); a SELL needs to hold `qty` of the base asset.
   */
  private canFundAtOrderPrice(
    side: OrderSide,
    qty: Decimal,
    params: FillInput['params'],
    fillPrice: Decimal,
    feeBps: number,
    account: FillInput['account'],
    symbolInfo: FillInput['symbolInfo'],
  ): boolean {
    if (side === 'SELL') {
      const base = account.balances[symbolInfo.baseAsset]?.free ?? new Decimal(0);
      return base.gte(qty);
    }
    const orderPx = params.price ?? params.stopPrice;
    const refPrice = orderPx !== undefined ? new Decimal(orderPx) : fillPrice;
    const cost = refPrice.mul(qty).mul(new Decimal(1).plus(new Decimal(feeBps).div(BPS)));
    const quote = account.balances[symbolInfo.quoteAsset]?.free ?? new Decimal(0);
    return quote.gte(cost);
  }

  /** Quantity the account can transact, possibly less than requested (→ partial). */
  private affordableQty(
    side: OrderSide,
    requestedQty: Decimal,
    price: Decimal,
    feeBps: number,
    account: FillInput['account'],
    symbolInfo: FillInput['symbolInfo'],
    step: Decimal,
  ): Decimal {
    if (side === 'BUY') {
      const quote = account.balances[symbolInfo.quoteAsset]?.free ?? new Decimal(0);
      const unitCost = price.mul(new Decimal(1).plus(new Decimal(feeBps).div(BPS)));
      if (unitCost.lte(0)) return new Decimal(0);
      const maxByBalance = roundToStep(quote.div(unitCost), step);
      return Decimal.min(requestedQty, maxByBalance);
    }
    const base = account.balances[symbolInfo.baseAsset]?.free ?? new Decimal(0);
    return Decimal.min(requestedQty, roundToStep(base, step));
  }
}

/**
 * Reject an execution price that would violate the submitted limit.
 *
 * @param side - Whether the limit caps the cost or floors the proceeds.
 * @param candidate - Proposed price after adverse execution costs.
 * @param limit - Tick-aligned submitted limit price.
 * @returns Whether the candidate may execute.
 */
function respectsLimit(side: OrderSide, candidate: Decimal, limit: Decimal): boolean {
  return side === 'BUY' ? candidate.lte(limit) : candidate.gte(limit);
}

/**
 * First bar that trades THROUGH the limit after the half-spread, not on a mere touch: an order at the back of the queue is not guaranteed a fill when price only reaches its level, and the spread decides whether the visible print actually crossed the far side of the book. The bar's volume bounds the participation cap, so this returns the bar rather than a boolean.
 *
 * @param side - BUY needs the adjusted low below the limit; SELL needs the adjusted high above it.
 * @param limit - Tick-aligned limit price.
 * @param bars - Detail bars to search, in time order.
 * @param spreadFactor - Half-spread multiplier for this side.
 * @returns The first crossing bar, or null when none crosses.
 */
function firstCrossBar(
  side: OrderSide,
  limit: Decimal,
  bars: readonly Candle[],
  spreadFactor: Decimal,
): Candle | null {
  for (const b of bars) {
    if (side === 'BUY' && new Decimal(b.low).mul(spreadFactor).lt(limit)) return b;
    if (side === 'SELL' && new Decimal(b.high).mul(spreadFactor).gt(limit)) return b;
  }
  return null;
}

/**
 * First bar that triggers the stop, or null. The bar's open is needed to price
 * a gap-through fill, so this returns the bar itself rather than a boolean.
 * SELL triggers on a bar low <= stop, BUY on a bar high >= stop.
 */
function firstStopBar(side: OrderSide, stop: Decimal, bars: readonly Candle[]): Candle | null {
  for (const b of bars) {
    if (side === 'SELL' && new Decimal(b.low).lte(stop)) return b;
    if (side === 'BUY' && new Decimal(b.high).gte(stop)) return b;
  }
  return null;
}
