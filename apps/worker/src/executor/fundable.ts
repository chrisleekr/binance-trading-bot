// Funding pre-flight for a placement: can the wallet actually pay for this order?
//
// WHY: a resting order LOCKS the balance it needs. An order sized from the wallet
// TOTAL (free + locked) is rejected by Binance with -2010 every time it is sent,
// and a strategy that re-derives the same order each tick re-sends it forever —
// a rejection storm that never converges. The wallet is readable before the call,
// so the executor refuses such an order without touching the wire.
//
// Pure: no IO, no clock. The account snapshot is passed in.

import { Decimal, isPlainDecimalString } from '@app/money';
import type { AccountSnapshot, OrderParams } from '@app/strategy-core';

export interface FundingCheckInput {
  readonly side: 'BUY' | 'SELL';
  readonly symbol: string;
  /** The profile's quote asset, e.g. 'USDT'. The base asset is the symbol minus it. */
  readonly quoteAsset: string;
  readonly params: OrderParams;
  readonly account: AccountSnapshot;
  /**
   * What cancels EARLIER IN THIS BATCH provably handed back in the asset this
   * order spends. The cached wallet snapshot is refreshed asynchronously, so a
   * cancel-then-place batch (the exit sell, the stop re-price) still reads its own
   * just-cancelled order's base as locked. `null` = something was released but its
   * size is unknown, which makes the check decline to judge (fail open).
   */
  readonly releasedInBatch?: (asset: string) => Decimal | null;
}

export type FundingVerdict =
  | { readonly kind: 'fundable' }
  /** The check could not be made (unknown asset pair, no snapshot, no price). Never blocks. */
  | { readonly kind: 'unknown'; readonly why: string }
  | {
      readonly kind: 'shortfall';
      readonly asset: string;
      readonly required: string;
      readonly free: string;
    };

/**
 * The asset an order spends: a SELL spends the base coin, a BUY spends the quote.
 * Returns null when the symbol does not end with the profile's quote asset — a
 * pair we cannot decompose is one we must not guess at.
 */
export const baseAssetOf = (symbol: string, quoteAsset: string): string | null => {
  if (quoteAsset.length === 0 || !symbol.endsWith(quoteAsset)) return null;
  const base = symbol.slice(0, -quoteAsset.length);
  return base.length > 0 ? base : null;
};

/**
 * What the order must be able to spend, in the asset it spends it from. A BUY's
 * cost is quantity x price; a MARKET BUY carries no price, so its cost is not
 * knowable here — that is an `unknown`, not a shortfall.
 */
const requirementOf = (
  input: FundingCheckInput,
): FundingVerdict | { readonly asset: string; readonly need: Decimal } => {
  const base = baseAssetOf(input.symbol, input.quoteAsset);
  if (base === null) {
    return { kind: 'unknown', why: `symbol ${input.symbol} does not end with ${input.quoteAsset}` };
  }
  if (!isPlainDecimalString(input.params.quantity)) {
    return { kind: 'unknown', why: `unparseable quantity ${input.params.quantity}` };
  }
  const qty = new Decimal(input.params.quantity);
  if (input.side === 'SELL') return { asset: base, need: qty };

  // A MARKET BUY's cost is set by the book, not by us: unknowable pre-call.
  const price = input.params.price;
  if (price === undefined || !isPlainDecimalString(price)) {
    return { kind: 'unknown', why: `${input.params.type} BUY carries no usable price` };
  }
  return { asset: input.quoteAsset, need: qty.times(new Decimal(price)) };
};

/**
 * Verdict on whether the wallet's FREE balance can fund this placement.
 *
 * Fails OPEN in every ambiguity — an absent snapshot (cold Redis), an unknown
 * balance line, an undecomposable symbol, a priceless MARKET BUY. A funding check
 * that cannot read the wallet must never be the thing that silently halts trading;
 * a wrong `unknown` costs one Binance rejection, a wrong `shortfall` costs every
 * order the profile would ever place.
 */
export const fundable = (input: FundingCheckInput): FundingVerdict => {
  const req = requirementOf(input);
  if ('kind' in req) return req;
  const { asset, need } = req;

  if (need.lte(0)) return { kind: 'unknown', why: 'non-positive requirement' };

  const balance = input.account.balances[asset];
  if (balance === undefined) {
    return { kind: 'unknown', why: `no ${asset} balance in the account snapshot` };
  }

  // `null` is the ledger's "released, size unknown" — distinct from "no release",
  // so it must not be collapsed with `??`.
  const credit =
    input.releasedInBatch === undefined ? new Decimal(0) : input.releasedInBatch(asset);
  if (credit === null) {
    return { kind: 'unknown', why: `a cancel released an unknown amount of ${asset} this batch` };
  }
  const free = balance.free.plus(credit);
  if (free.gte(need)) return { kind: 'fundable' };
  return { kind: 'shortfall', asset, required: need.toString(), free: free.toString() };
};
