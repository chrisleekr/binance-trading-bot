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
   * Bid/ask spread in basis points, charged as a HALF-spread haircut on every
   * fill — including LIMIT. A candle-level backtest otherwise fills a LIMIT at
   * exactly its price with no adverse selection or queue cost, which overstates
   * a maker strategy's edge. Optional; defaults to 0 so existing runs and tests
   * reproduce byte-for-byte.
   */
  readonly spreadBps?: number;
  /**
   * Volume-participation cap: a single fill may take at most this percentage of
   * the filling bar's base volume. The remainder rests and works across later
   * bars. Models that a large order cannot clear at one price on a thin bar; on
   * a zero-volume bar the order does not fill (rejected `liquidity`). `null` or
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
 *   - LIMIT  fills at the limit price the first time a detail bar trades THROUGH
 *            it (BUY: bar low < limit; SELL: bar high > limit), not on a mere
 *            touch — modelling maker queue non-fill; maker fee.
 *   - MARKET fills at the candle open shifted by slippage; taker fee.
 *   - STOP_LOSS_LIMIT arms once a detail bar reaches the stop (SELL: low <=
 *            stop; BUY: high >= stop), then behaves as a resting LIMIT at
 *            `params.price`: it fills at the limit the first time a bar (arming
 *            bar included) trades THROUGH it, and a bar that gaps PAST the limit
 *            leaves it resting UNFILLED — modelling the real tail risk that a
 *            protective stop can gap through its limit and never protect, or a
 *            grid stop-limit gap through and never enter. Taker fee.
 *
 * Every fill is then haircut by the half-spread (BUY pays up, SELL receives
 * less). Filters: stepSize/tickSize quantisation, minNotional and minQty are
 * enforced; a sub-notional order is rejected, not silently shrunk. A buy the
 * quote cannot fund at the ORDER price (or a sell larger than the held base) is
 * rejected whole, as Binance rejects an underfunded order (-2010) at placement;
 * the per-bar volume cap — or the spread haircut shaving the last sliver of an
 * all-in buy funded at its limit — shrinks a funded order to a `partial`.
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
   * Funds a resting order locks. Every order rests one candle in this model
   * (`fill` returns `rest` on the place phase for all types), so the lock is
   * sized by order type. A BUY locks the quote it will spend: the fill price the
   * `fill` path charges — the order price (its `price`, or a stop-limit's limit)
   * lifted by the same half-spread, since a maker/limit fill pays that haircut —
   * times the fee (maker for a LIMIT, taker otherwise). Matching the fill price
   * exactly is what lets an all-in buy fund its own fill: an under-lock would
   * leave `free` short of the spread-lifted cost and the affordability check
   * would then reject the whole order. A SELL locks the base it will deliver; a
   * MARKET buy carries no price and locks nothing.
   */
  reserve(input: ReserveInput): FillReservation {
    const { intent, params, symbolInfo } = input;
    assertSupportedType(params.type);
    const qty = new Decimal(params.quantity);
    if (intent.side === 'SELL') return { asset: symbolInfo.baseAsset, amount: qty };
    const price = new Decimal(params.price ?? params.stopPrice ?? '0').mul(
      this.spreadFactor('BUY'),
    );
    const notional = price.mul(qty);
    const feeBps = params.type === 'LIMIT' ? this.makerBps : this.takerBps;
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

    const priced = this.resolveFillPrice(intent.side, params, bars, tick);
    if (priced === null) return { kind: 'rest' }; // not crossed yet — keep resting
    const { price, feeBps, bar } = priced;

    const minQty = new Decimal(symbolInfo.filters.minQty);
    const minNotional = new Decimal(symbolInfo.filters.minNotional);

    // Binance rejects (-2010) an order the balance cannot fund at its ORDER price
    // — the notional it locks at placement — NOT at the spread/slippage-inflated
    // fill price. Checking the order price is what keeps an all-in buy (funds
    // committed at the limit) from being spuriously rejected: the haircut is a
    // fill-realism cost, so it shrinks such an order to a partial below, it does
    // not reject the whole order the way a genuine shortfall does.
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

    // Cap by what the account can actually transact at the fill price. When the
    // order is funded at its order price but the haircut lifts the fill cost past
    // free (an all-in buy), this shrinks it to a partial rather than overdrawing.
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

    // Then cap by the bar's available liquidity. A cap bite below the minimums is
    // a liquidity rejection (distinct from a too-small order), so the operator can
    // tell "thin bar" from "order below the exchange minimum".
    const fillable = this.volumeCapped(affordable, bar, step);
    const capBit = fillable.lt(affordable);
    if (fillable.lte(0)) return { kind: 'rejected', reason: 'liquidity', latencyMs: 0 };
    if (fillable.lt(minQty))
      return { kind: 'rejected', reason: capBit ? 'liquidity' : 'step-size', latencyMs: 0 };
    if (!meetsMinNotional(fillable, price, minNotional))
      return { kind: 'rejected', reason: capBit ? 'liquidity' : 'min-notional', latencyMs: 0 };

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
   * participation cap), or null if the order has not crossed. The half-spread
   * haircut is folded into the returned price.
   */
  private resolveFillPrice(
    side: OrderSide,
    params: FillInput['params'],
    bars: readonly Candle[],
    tick: Decimal,
  ): { price: Decimal; feeBps: number; bar: Candle } | null {
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
      const bar = firstCrossBar(side, limit, bars);
      if (bar === null) return null;
      return { price: limit.mul(this.spreadFactor(side)), feeBps: this.makerBps, bar };
    }

    // STOP_LOSS_LIMIT. On Binance the stop only ARMS a LIMIT order at
    // `params.price`; the fill is then a plain limit, so a bar that gaps PAST the
    // limit leaves it resting UNFILLED. Modelling it as a guaranteed stop-market
    // fill hides the dominant tail risk: a protective stop that gaps through its
    // limit never protects the position, and a grid stop-limit that gaps through
    // never enters. Model both phases from the bar bounds — arm once a bar
    // reaches the stop, then fill at the limit the first time a bar (the arming
    // bar included) trades THROUGH the limit; if none do, keep resting. Fill at
    // the limit like any LIMIT (no slippage — a limit fills at its rate, not
    // worse); a triggered stop still pays the taker fee.
    const stop = roundToTick(new Decimal(params.stopPrice ?? params.price ?? '0'), tick);
    const limit = roundToTick(new Decimal(params.price ?? params.stopPrice ?? '0'), tick);
    if (stop.lte(0) || limit.lte(0)) return null;
    const armBar = firstStopBar(side, stop, bars);
    if (armBar === null) return null; // stop not reached — keep resting
    const crossed = firstCrossBar(side, limit, bars.slice(bars.indexOf(armBar)));
    if (crossed === null) return null; // gapped past the limit — rests unfilled
    return { price: limit.mul(this.spreadFactor(side)), feeBps: this.takerBps, bar: crossed };
  }

  /** Slippage multiplier for a market-style fill: BUY pays up, SELL receives less. */
  private slippageFactor(side: OrderSide): Decimal {
    const slip = new Decimal(this.slippageBps).div(BPS);
    return side === 'BUY' ? new Decimal(1).plus(slip) : new Decimal(1).minus(slip);
  }

  /** Half-spread multiplier applied to every fill: BUY pays up, SELL receives less. */
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
   * Whether the balance covers the order at its ORDER price — Binance's -2010
   * placement check, run before the fill-realism haircut. A BUY needs quote for
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
 * First bar that trades THROUGH the LIMIT, or null. The bar's volume bounds the
 * participation cap, so this returns the bar itself rather than a boolean.
 * Strict cross — BUY on bar low < limit, SELL on bar high > limit — not a mere
 * touch: a resting maker order at the back of the queue is not guaranteed a fill
 * when price only kisses its level, so requiring price to trade past it models
 * queue non-fill rather than assuming a free fill (audit F6). A maker
 * backtest is then no longer optimistic about getting filled at every touch.
 */
function firstCrossBar(side: OrderSide, limit: Decimal, bars: readonly Candle[]): Candle | null {
  for (const b of bars) {
    if (side === 'BUY' && new Decimal(b.low).lt(limit)) return b;
    if (side === 'SELL' && new Decimal(b.high).gt(limit)) return b;
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
