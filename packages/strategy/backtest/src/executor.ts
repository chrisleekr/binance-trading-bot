import { Decimal } from '@app/money';
import type {
  AccountSnapshot,
  Candle,
  Clock,
  Decision,
  DecisionResult,
  Executor,
  ExecutorContext,
  OpenOrder,
  OrderIntent,
  OrderParams,
  OrderSide,
  SymbolInfo,
  TickExecutorContext,
} from '@app/strategy-core';
import type { BacktestTrade, Fill, FillModel } from './types.js';

interface MutableBalance {
  free: Decimal;
  locked: Decimal;
}

interface MarketContext {
  readonly lastPrice: Decimal;
  readonly lastCandle: Candle;
  readonly detailCandles: readonly Candle[] | undefined;
}

/**
 * A live order on the simulated book. A realistic fill model defers fills to
 * candles after placement, so the order waits here and is re-evaluated each
 * time its symbol's market context advances. `params.quantity` shrinks as
 * partial fills reduce the outstanding amount.
 */
interface RestingOrder {
  readonly orderId: number;
  readonly symbol: string;
  readonly intent: OrderIntent;
  readonly params: OrderParams;
  readonly placedTsMs: number;
  /** Asset locked (free→locked) while this order rests, and the locked amount. */
  readonly reservedAsset: string;
  readonly reservedAmount: Decimal;
  /**
   * Original placed quantity (immutable) and the amount filled so far. `params.
   * quantity` shrinks to the remainder after a partial fill so the fill model
   * sizes the rest correctly, so these carry the true `origQty` / `executedQty`
   * a strategy reads off the book — e.g. the grid's "never re-price a partially
   * filled order" guard keys on `executedQty > 0`.
   */
  readonly originalQty: string;
  readonly filledQty: Decimal;
}

/**
 * A fill the executor produced since the last drain, in the minimal shape the
 * run loop needs to converge strategy state. The executor records the trade
 * and mutates balances itself; this is the separate channel the engine reads
 * to adopt the fill into the plugin's position state (mirroring the live
 * fill-adopter), so a stateful strategy sees its own position on the next
 * tick instead of re-buying every candle.
 */
export interface DrainedFill {
  readonly symbol: string;
  readonly side: OrderSide;
  readonly price: Decimal;
  readonly qty: Decimal;
}

const BPS = new Decimal(10_000);
const EVENT_RING_CAP = 1_000;
// Shared immutable zero, reused as the per-tick equity accumulator seed
// (decimal.js Decimals are immutable, so sharing one instance is safe).
const ZERO = new Decimal(0);

/**
 * In-memory exchange simulation that implements the same {@link Executor}
 * contract the live worker uses, so a strategy's decisions flow through one
 * code path in both worlds — the property that keeps backtest and live from
 * drifting. It owns a mutable account, routes `place-order` through the
 * injected {@link FillModel}, records each fill as a trade, drops
 * `cancel-order` targets, and ring-buffers `emit-event` payloads.
 *
 * Deliberate divergence from the live executor: `emit-event` payloads are
 * NOT schema-validated here. The live worker parses each payload against the
 * strategy's event map and the WsEvent contract because events drive the UI;
 * in a backtest events are off the determinism and P&L path (the report is
 * built from trades and equity, not events), so validating them would only
 * couple the strategy's event-map into the engine for no behavioural gain.
 * The buffer is a convenience for callers that want to inspect what a run
 * emitted, not a fidelity guarantee.
 */
export class BacktestExecutor implements Executor {
  private readonly balances = new Map<string, MutableBalance>();
  private readonly symbols = new Map<string, SymbolInfo>();
  private readonly market = new Map<string, MarketContext>();
  private readonly trades: BacktestTrade[] = [];
  private readonly events: { eventType: string; payload: unknown }[] = [];
  // In-memory cross-symbol KV. The live path persists to PG; the
  // backtest holds the same store in memory so a cross-symbol strategy
  // (rebalancing) replays its set-kv / delete-kv writes and reads them back via
  // `TickInput.profileKv`. Reset per run with the rest of the executor state.
  private readonly kv = new Map<string, unknown>();
  private restingOrders: RestingOrder[] = [];
  private pendingFills: DrainedFill[] = [];
  private nextOrderId = 1;

  constructor(
    private readonly fillModel: FillModel,
    initialBalances: Readonly<Record<string, string>>,
    symbolInfos: readonly SymbolInfo[],
  ) {
    for (const [asset, free] of Object.entries(initialBalances)) {
      this.balances.set(asset, { free: new Decimal(free), locked: new Decimal(0) });
    }
    for (const info of symbolInfos) this.symbols.set(info.symbol, info);
  }

  /**
   * Advance a symbol's market context to a new candle and re-evaluate its
   * resting orders against it. Because an order placed on candle N rests
   * (the realistic model returns `rest` on placement), the first context it
   * is evaluated against is candle N+1 — the standard signal-N / fill-N+1
   * rule. `detailCandles` are the finer intra-candle bars for timeframe-detail
   * crossing; absent, the model uses `lastCandle` itself.
   */
  setMarketContext(
    symbol: string,
    lastPrice: Decimal,
    lastCandle: Candle,
    detailCandles?: readonly Candle[],
  ): void {
    this.market.set(symbol, { lastPrice, lastCandle, detailCandles });
    this.evaluateResting(symbol);
  }

  /** The account view handed to the strategy as `TickInput.account`. */
  snapshotAccount(): AccountSnapshot {
    const out: Record<string, { asset: string; free: Decimal; locked: Decimal }> = {};
    for (const [asset, bal] of this.balances) {
      out[asset] = { asset, free: bal.free, locked: bal.locked };
    }
    return { balances: out, readable: true };
  }

  /**
   * Live orders on the book, in the {@link OpenOrder} shape the strategy reads
   * from `TickInput.openOrders`. With an immediate-fill model nothing rests,
   * so this is empty; the realistic model populates it so the strategy sees
   * its own open grid orders (hasOpenBuy / hasOpenSell), exactly as live.
   *
   * Pass `symbol` to scope the book to one symbol — the per-tick view a
   * strategy must see in a portfolio run, where the executor holds the
   * resting orders of every symbol on one shared book.
   *
   * After a partial fill the order re-rests with `params.quantity` reduced to
   * the remainder, but `origQty` reports the immutable original and
   * `executedQty` the accumulated fill — matching a live `OpenOrder`, so a
   * strategy's `executedQty > 0` guard (e.g. the grid's "never re-price a
   * partially filled order") behaves the same in backtest as live.
   */
  openOrders(symbol?: string): readonly OpenOrder[] {
    const book = symbol
      ? this.restingOrders.filter((o) => o.symbol === symbol)
      : this.restingOrders;
    return book.map((o) => ({
      orderId: o.orderId,
      clientOrderId: o.intent.clientOrderId,
      symbol: o.symbol,
      side: o.intent.side,
      type: o.params.type,
      status: 'NEW' as const,
      price: o.params.price ?? '0',
      origQty: o.originalQty,
      executedQty: o.filledQty.toString(),
      cummulativeQuoteQty: '0',
      // stopPrice / timeInForce are exactOptional on OpenOrder — include only when set.
      ...(o.params.stopPrice !== undefined ? { stopPrice: o.params.stopPrice } : {}),
      ...(o.params.timeInForce !== undefined ? { timeInForce: o.params.timeInForce } : {}),
      transactTimeMs: o.placedTsMs,
      updateTimeMs: o.placedTsMs,
    }));
  }

  getTrades(): readonly BacktestTrade[] {
    return this.trades;
  }

  /**
   * Remove and return the fills produced for one symbol since the last drain.
   * The run loop drains after placement and after each resting re-evaluation,
   * then folds the fills into the plugin's position state — the engine's
   * analogue of the live fill-adopter. Scoped per symbol so a portfolio run
   * never adopts one symbol's fill into another's state; insertion order is
   * preserved so adoption is deterministic.
   */
  drainFills(symbol: string): readonly DrainedFill[] {
    const taken: DrainedFill[] = [];
    const rest: DrainedFill[] = [];
    for (const f of this.pendingFills) (f.symbol === symbol ? taken : rest).push(f);
    this.pendingFills = rest;
    return taken;
  }

  getEvents(): readonly { eventType: string; payload: unknown }[] {
    return this.events;
  }

  /**
   * Total equity valued in `quoteAsset`: the quote balance plus every other
   * asset marked at its symbol's last price. An asset with no live market
   * price is valued at zero rather than guessed, so a stray dust balance
   * cannot silently inflate equity.
   *
   * In a portfolio run an equity point recorded at one symbol's candle marks
   * the other symbols at their LAST seen close (the context persists across
   * candles), which may be several candles old — unavoidable in an
   * event-driven engine and the standard mark-to-last convention.
   */
  equityInQuote(quoteAsset: string): Decimal {
    let equity = ZERO;
    for (const [asset, bal] of this.balances) {
      const total = bal.free.add(bal.locked);
      if (asset === quoteAsset) {
        equity = equity.add(total);
        continue;
      }
      const price = this.markPriceForBase(asset, quoteAsset);
      if (price) equity = equity.add(total.mul(price));
    }
    return equity;
  }

  async apply(ctx: TickExecutorContext, decision: Decision): Promise<DecisionResult> {
    switch (decision.type) {
      case 'noop':
        return { ok: true };
      case 'cancel-order': {
        const cancelled = this.restingOrders.find((o) => o.orderId === decision.orderId);
        if (cancelled) this.unlock(cancelled.reservedAsset, cancelled.reservedAmount);
        this.restingOrders = this.restingOrders.filter((o) => o.orderId !== decision.orderId);
        return { ok: true };
      }
      case 'emit-event':
        if (this.events.length >= EVENT_RING_CAP) this.events.shift();
        this.events.push({ eventType: decision.eventType, payload: decision.payload });
        return { ok: true };
      case 'set-kv':
        this.kv.set(decision.key, decision.value);
        return { ok: true };
      case 'delete-kv':
        this.kv.delete(decision.key);
        return { ok: true };
      case 'place-order':
        return this.placeOrder(ctx, decision);
    }
  }

  /** The current cross-symbol KV store as a snapshot, for `TickInput.profileKv`. */
  kvSnapshot(): Record<string, unknown> {
    return Object.fromEntries(this.kv);
  }

  private placeOrder(
    ctx: ExecutorContext,
    decision: Extract<Decision, { type: 'place-order' }>,
  ): DecisionResult {
    const { intent, params } = decision;
    const symbolInfo = this.symbols.get(intent.symbol);
    if (!symbolInfo) {
      return {
        ok: false,
        retryable: false,
        phase: 'pre-call',
        reason: `unknown symbol ${intent.symbol}`,
      };
    }
    const ctxMarket = this.market.get(intent.symbol);
    if (!ctxMarket) {
      return {
        ok: false,
        retryable: false,
        phase: 'pre-call',
        reason: `no market context for ${intent.symbol}`,
      };
    }

    const outcome = this.fillModel.fill({
      intent,
      params,
      market: ctxMarket,
      account: this.snapshotAccount(),
      symbolInfo,
      clock: ctx.clock,
      phase: 'place',
    });

    // `rest` (realistic model): hold on the book for later candles.
    // `filled`/`partial` (immediate model, e.g. ideal): apply the fills now.
    // A place-phase `partial` remainder is not re-rested — the only immediate
    // model (ideal) always fully fills, so there is no remainder in practice.
    if (outcome.kind === 'rest') {
      this.rest(intent, params, ctx.clock.nowMs(), symbolInfo);
    } else if (outcome.kind !== 'rejected') {
      for (const fill of outcome.fills)
        this.applyFill(intent.side, intent.reason, symbolInfo, fill);
    }
    return { ok: true };
  }

  private rest(
    intent: OrderIntent,
    params: OrderParams,
    placedTsMs: number,
    symbolInfo: SymbolInfo,
  ): void {
    // Lock the funds the order commits (free→locked), as a real exchange does,
    // so another symbol's tick cannot spend the same cash while this order rests.
    // Clamp to available free: you can only lock what you hold. An order the
    // balance cannot fund at its order price is rejected when it next crosses
    // (see OhlcvFillModel.canFundAtOrderPrice), not partial-filled.
    const { asset, amount } = this.fillModel.reserve({ intent, params, symbolInfo });
    const reservedAmount = this.lockUpTo(asset, amount);
    this.restingOrders.push({
      orderId: this.nextOrderId++,
      symbol: intent.symbol,
      intent,
      params,
      placedTsMs,
      reservedAsset: asset,
      reservedAmount,
      originalQty: params.quantity,
      filledQty: new Decimal(0),
    });
  }

  /**
   * Re-evaluate every resting order for a symbol against its current context.
   * The fill timestamp is the candle's close time (deterministic, candle-
   * driven). Filled orders leave the book; a partial keeps resting with its
   * quantity reduced; a `rest` outcome stays; a `rejected` outcome is dropped.
   */
  private evaluateResting(symbol: string): void {
    const ctx = this.market.get(symbol);
    if (!ctx) return;
    const symbolInfo = this.symbols.get(symbol);
    if (!symbolInfo) return;
    // Nothing for this symbol on the book: skip the per-candle `next` array
    // allocation and the loop. The loop would only copy the other symbols'
    // orders straight back into `restingOrders`, so the early return is a
    // no-op on the book — the common per-candle case once a symbol is flat.
    // NOTE: `snapshotAccount()` is intentionally NOT hoisted out of the loop.
    // `applyFill` mutates `this.balances`, and the fill model reads
    // `account.balances` to cap the fillable quantity, so a second same-symbol
    // order filling in the same candle must see the first fill's depleted
    // balance. A hoisted snapshot would let it spend stale balance.
    if (!this.restingOrders.some((o) => o.symbol === symbol)) return;

    const clock: Clock = { nowMs: () => ctx.lastCandle.closeTimeMs };

    const next: RestingOrder[] = [];
    for (const ord of this.restingOrders) {
      if (ord.symbol !== symbol) {
        next.push(ord);
        continue;
      }
      // Release THIS order's reservation so the fill model sees its own committed
      // funds as spendable, while every OTHER resting order's reservation stays
      // locked — so a portfolio run can never spend the same cash twice.
      this.unlock(ord.reservedAsset, ord.reservedAmount);
      const outcome = this.fillModel.fill({
        intent: ord.intent,
        params: ord.params,
        market: ctx,
        account: this.snapshotAccount(),
        symbolInfo,
        clock,
        phase: 'resting',
      });
      if (outcome.kind === 'rest') {
        // Not filled: re-lock the same reservation and keep resting.
        this.lockUpTo(ord.reservedAsset, ord.reservedAmount);
        next.push(ord);
        continue;
      }
      // Rejected: leave the reservation released — the funds return to free.
      if (outcome.kind === 'rejected') continue;
      for (const fill of outcome.fills) {
        this.applyFill(ord.intent.side, ord.intent.reason, symbolInfo, fill);
      }
      if (outcome.kind === 'partial') {
        // Re-rest the remainder with a fresh reservation for the reduced qty, and
        // accumulate the just-filled amount so `executedQty` reflects it.
        const params = { ...ord.params, quantity: outcome.remainingQty.toString() };
        const { asset, amount } = this.fillModel.reserve({
          intent: ord.intent,
          params,
          symbolInfo,
        });
        const reservedAmount = this.lockUpTo(asset, amount);
        const filledNow = outcome.fills.reduce((sum, f) => sum.add(f.qty), new Decimal(0));
        next.push({
          ...ord,
          params,
          reservedAsset: asset,
          reservedAmount,
          filledQty: ord.filledQty.add(filledNow),
        });
      }
      // Filled: the released reservation minus the actual fill cost stays in free.
    }
    this.restingOrders = next;
  }

  private applyFill(
    side: OrderSide,
    reason: BacktestTrade['reason'],
    symbolInfo: SymbolInfo,
    fill: Fill,
  ): void {
    const notional = fill.price.mul(fill.qty);
    const fee = notional.mul(fill.feeBps).div(BPS);
    const quote = this.balanceOf(symbolInfo.quoteAsset);
    const base = this.balanceOf(symbolInfo.baseAsset);

    if (side === 'BUY') {
      quote.free = quote.free.sub(notional.add(fee));
      base.free = base.free.add(fill.qty);
    } else {
      base.free = base.free.sub(fill.qty);
      quote.free = quote.free.add(notional.sub(fee));
    }

    this.trades.push({
      symbol: symbolInfo.symbol,
      side,
      reason,
      price: fill.price.toString(),
      qty: fill.qty.toString(),
      feeQuote: fee.toString(),
      tsMs: fill.tsMs,
    });
    this.pendingFills.push({ symbol: symbolInfo.symbol, side, price: fill.price, qty: fill.qty });
  }

  private balanceOf(asset: string): MutableBalance {
    let bal = this.balances.get(asset);
    if (!bal) {
      bal = { free: new Decimal(0), locked: new Decimal(0) };
      this.balances.set(asset, bal);
    }
    return bal;
  }

  /**
   * Move up to `desired` of `asset` from free to locked; returns the amount
   * actually locked, clamped to available free (never negative). A resting order
   * the balance cannot fully back locks what there is and fills partially — the
   * same outcome as before locking, but the committed cash is now unspendable by
   * other orders.
   */
  private lockUpTo(asset: string, desired: Decimal): Decimal {
    const bal = this.balanceOf(asset);
    const amount = Decimal.max(new Decimal(0), Decimal.min(desired, bal.free));
    bal.free = bal.free.sub(amount);
    bal.locked = bal.locked.add(amount);
    return amount;
  }

  /** Move `amount` of `asset` from locked back to free (order filled/cancelled). */
  private unlock(asset: string, amount: Decimal): void {
    const bal = this.balanceOf(asset);
    bal.locked = bal.locked.sub(amount);
    bal.free = bal.free.add(amount);
  }

  /**
   * Last price for `base` expressed in `quoteAsset`, from the market context
   * of the `${base}${quoteAsset}` symbol. Returns null when no such symbol
   * is being tracked — the caller then values that balance at zero.
   */
  private markPriceForBase(base: string, quoteAsset: string): Decimal | null {
    const ctx = this.market.get(`${base}${quoteAsset}`);
    return ctx ? ctx.lastPrice : null;
  }
}
