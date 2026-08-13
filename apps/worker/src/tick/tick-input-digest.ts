// The inputs a tick's decision was actually taken on, flattened for the audit.
//
// A log row that records only the decision answers "what did the bot do" but
// never "why that price, why that size, why nothing at all" — the questions
// that send an operator digging through pino. This digest is the smallest set
// of facts that answers them.
//
// It is paid for on EVERY tick, in Redis stream memory, so it stays a digest:
// only the two assets this symbol trades rather than the whole wallet, and open
// orders reduced to the fields that decide a cancel-replace. `Decimal` values
// are stringified at this boundary, matching how every other snapshot
// serialises money.

import type { TickInput } from '@app/strategy-core';

/** Balance as the audit carries it, or null when the wallet had no row for the asset. */
interface BalanceDigest {
  readonly free: string;
  readonly locked: string;
}

export interface TickInputDigest {
  readonly price: string;
  /**
   * False when the account snapshot could not be read. Load-bearing for triage:
   * a fail-closed tick looks identical to a tick that simply decided not to act,
   * and only this flag separates them.
   */
  readonly accountReadable: boolean;
  readonly balances: Readonly<Record<string, BalanceDigest | null>>;
  readonly openOrders: readonly {
    readonly orderId: number;
    readonly clientOrderId: string;
    readonly side: string;
    readonly status: string;
    readonly price: string;
    readonly origQty: string;
    readonly executedQty: string;
  }[];
  /** Remaining Binance request-weight headroom, in basis points of the limit. */
  readonly headroomBps: number;
}

export const tickInputDigest = (
  input: TickInput<unknown, unknown, Readonly<Record<string, unknown>>>,
): TickInputDigest => {
  const { baseAsset, quoteAsset } = input.market.symbolInfo;
  const balanceOf = (asset: string): BalanceDigest | null => {
    const b = input.account.balances[asset];
    return b ? { free: b.free.toString(), locked: b.locked.toString() } : null;
  };
  return {
    price: input.market.currentPrice,
    accountReadable: input.account.readable,
    balances: { [baseAsset]: balanceOf(baseAsset), [quoteAsset]: balanceOf(quoteAsset) },
    openOrders: input.openOrders.map((o) => ({
      orderId: o.orderId,
      clientOrderId: o.clientOrderId,
      side: o.side,
      status: o.status,
      price: o.price,
      origQty: o.origQty,
      executedQty: o.executedQty,
    })),
    headroomBps: input.limits.headroomBps,
  };
};
