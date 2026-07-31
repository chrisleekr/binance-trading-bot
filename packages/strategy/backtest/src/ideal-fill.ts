import { Decimal } from '@app/money';
import type { FillInput, FillModel, FillOutcome, FillReservation, ReserveInput } from './types.js';

/**
 * Frictionless reference fill model: an order fills in full at its requested
 * price (LIMIT) or the last price (MARKET), with zero latency and zero fee,
 * provided the account holds the funds. It deliberately ignores intra-candle
 * price path, slippage, and exchange filters — it is the sanity arm that
 * isolates strategy behaviour from execution realism. The realistic
 * OHLCV-with-fees model is a separate implementation of {@link FillModel}.
 *
 * Returning `rejected: insufficient-balance` rather than silently sizing
 * down keeps the executor's accounting exact: a fill it applies can never
 * drive a balance negative.
 *
 * Exchange filters (minNotional, stepSize, tickSize) are intentionally NOT
 * enforced — that realism belongs to the OHLCV model. A `qty` finer than
 * stepSize fills as-is here, so the ideal arm is strictly more permissive
 * than live. Balance sufficiency is the only constraint it applies.
 */
export class IdealFillModel implements FillModel {
  fill(input: FillInput): FillOutcome {
    const { intent, params, market, account, symbolInfo, clock } = input;
    const qty = new Decimal(params.quantity);
    const price = params.type === 'MARKET' ? market.lastPrice : new Decimal(params.price ?? '0');
    const tsMs = clock.nowMs();

    if (qty.lte(0) || price.lte(0)) {
      return { kind: 'rejected', reason: 'no-fill', latencyMs: 0 };
    }

    if (intent.side === 'BUY') {
      const cost = qty.mul(price);
      const quote = account.balances[symbolInfo.quoteAsset]?.free ?? new Decimal(0);
      if (quote.lt(cost)) {
        return { kind: 'rejected', reason: 'insufficient-balance', latencyMs: 0 };
      }
    } else {
      const base = account.balances[symbolInfo.baseAsset]?.free ?? new Decimal(0);
      if (base.lt(qty)) {
        return { kind: 'rejected', reason: 'insufficient-balance', latencyMs: 0 };
      }
    }

    return { kind: 'filled', fills: [{ price, qty, feeBps: 0, tsMs }], latencyMs: 0 };
  }

  // The ideal model fills at placement and never rests, so the executor never
  // calls this; implemented for interface completeness (zero fee, like fill).
  reserve(input: ReserveInput): FillReservation {
    const { intent, params, symbolInfo } = input;
    const qty = new Decimal(params.quantity);
    if (intent.side === 'SELL') return { asset: symbolInfo.baseAsset, amount: qty };
    return { asset: symbolInfo.quoteAsset, amount: new Decimal(params.price ?? '0').mul(qty) };
  }
}
