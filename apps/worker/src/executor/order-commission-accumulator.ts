// Running total of the commission Binance charged across one order's fills.
//
// `z`/`Z` (cumulative filled qty / quote) are cumulative on every
// executionReport, but `n`/`N` (commission / commission asset) are PER TRADE.
// The fill-adopter only acts on the terminal FILLED report, so reading `n` off
// that report alone would see just the last trade's fee and under-net a
// multi-trade order. The event router is the only component that observes every
// partial, so the running sum lives beside it.
//
// Entries are ACCOUNT-scoped and the terminal read is NON-destructive. One
// Binance account has one user-data stream but N profiles, and every active
// profile is routed the same executionReport; until an `orders` row commits,
// the ownership gate answers `own` for all of them. A destructive read would
// hand the whole fee to whichever profile was routed first and leave the
// profile that actually owns the position folding a gross quantity.
//
// Bounded by an expiry on every entry, swept on each call: a terminal entry
// lives just long enough for that fan-out, and an entry whose terminal report
// never arrives (a user-stream gap) expires on its own instead of pinning
// memory for the life of the worker.

import { Decimal, isPlainDecimalString } from '@app/money';

/** The order's commission subtotals, or `null` when they cannot be stated honestly. */
export interface OrderCommission {
  readonly commissions: Readonly<Record<string, string>>;
}

export interface CommissionTrade {
  /** Binance `x` — only `TRADE` reports carry a commission. */
  readonly executionType: string;
  /** Binance `t`, the per-symbol trade id. */
  readonly tradeId: number;
  readonly commission: string;
  readonly commissionAsset: string;
}

export interface OrderCommissionAccumulator {
  /**
   * Fold one execution report's per-trade commission into its order's total.
   * Ignores non-`TRADE` reports and exact replays, so a Binance reconnect cannot
   * double-count regardless of frame order. A replay whose fee differs from the
   * original makes the order's commission unknown.
   */
  record(orderKey: string, trade: CommissionTrade): void;
  /**
   * Per-asset commission accumulated for the order. `null` when nothing was
   * accumulated or when the fee cannot be stated honestly. Repeatable: every
   * profile on the account is routed the same terminal report and each needs
   * the whole fee, so the read leaves the entry in place and only shortens its
   * expiry to the fan-out window.
   */
  take(orderKey: string): OrderCommission | null;
}

/** Wall clock, injected so the accumulator stays free of ambient time. */
export interface AccumulatorClock {
  nowMs(): number;
}

/**
 * How long a terminal entry survives its own read. The profile fan-out over one
 * account's report is a handful of awaits, so this only has to outlive that;
 * generous relative to the real gap so a slow ownership query cannot strand a
 * sibling's fee.
 */
const TERMINAL_TTL_MS = 60_000;

/**
 * How long an entry whose terminal report never arrived survives. A resting
 * order can fill in stages over a long window, so this is wide; when it does
 * lapse the order under-nets its fee, which folds the gross quantity — the same
 * conservative direction as every other fallback on this path.
 */
const IN_FLIGHT_TTL_MS = 24 * 60 * 60 * 1_000;

interface Entry {
  totals: Map<string, Decimal>;
  /**
   * Trade ids and fees already folded. A map rather than a monotonic watermark: the
   * user-stream pool dispatches handlers without awaiting, so partials can
   * reach here out of trade-id order and a watermark would discard the late
   * one as if it were a replay.
   */
  folded: Map<number, { readonly asset: string; readonly charged: Decimal }>;
  /**
   * Once any TRADE report is malformed or a replay conflicts with the original,
   * no subtotal can be presented as the complete fee for the order.
   */
  corrupt: boolean;
  expiresAtMs: number;
}

/** Order identity for the accumulator. Binance order ids are unique per SYMBOL, not per account. */
export const orderCommissionKey = (accountId: string, symbol: string, orderId: number): string =>
  `${accountId}:${symbol}:${orderId}`;

export const createOrderCommissionAccumulator = (
  clock: AccumulatorClock,
): OrderCommissionAccumulator => {
  const entries = new Map<string, Entry>();

  const sweep = (nowMs: number): void => {
    for (const [key, entry] of entries) {
      if (entry.expiresAtMs <= nowMs) entries.delete(key);
    }
  };

  return {
    record(orderKey, trade) {
      if (trade.executionType !== 'TRADE') return;
      const nowMs = clock.nowMs();
      sweep(nowMs);
      let entry = entries.get(orderKey);
      if (!entry) {
        entry = {
          totals: new Map(),
          folded: new Map(),
          corrupt: false,
          expiresAtMs: nowMs + IN_FLIGHT_TTL_MS,
        };
        entries.set(orderKey, entry);
      }

      if (
        !trade.commissionAsset ||
        !Number.isInteger(trade.tradeId) ||
        !isPlainDecimalString(trade.commission)
      ) {
        entry.corrupt = true;
        return;
      }
      const charged = new Decimal(trade.commission);
      if (!charged.isFinite() || charged.lt(0)) {
        entry.corrupt = true;
        return;
      }

      const original = entry.folded.get(trade.tradeId);
      if (original) {
        if (original.asset !== trade.commissionAsset || !original.charged.eq(charged)) {
          entry.corrupt = true;
        }
        return;
      }
      entry.folded.set(trade.tradeId, { asset: trade.commissionAsset, charged });
      if (charged.isZero()) return;
      const prior = entry.totals.get(trade.commissionAsset) ?? new Decimal(0);
      entry.totals.set(trade.commissionAsset, prior.plus(charged));
    },

    take(orderKey) {
      const nowMs = clock.nowMs();
      sweep(nowMs);
      const entry = entries.get(orderKey);
      if (!entry) return null;
      entry.expiresAtMs = nowMs + TERMINAL_TTL_MS;
      if (entry.corrupt || entry.totals.size === 0) return null;
      return {
        commissions: Object.fromEntries(
          [...entry.totals].map(([asset, total]) => [asset, total.toString()]),
        ),
      };
    },
  };
};
