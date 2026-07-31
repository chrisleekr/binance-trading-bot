// Per-symbol order-feasibility check for trailing-trade. Answers a question the
// schema cannot: given THIS symbol's exchange minimums, a reference price, and
// the quote balance, can the config actually place its orders and fund the whole
// grid? Reuses the same sizing epilogue `tick()` uses (parseFilters + finalise),
// so a `block` here means the live tick would skip the order for the same reason.
// Pure and deterministic; no I/O.

import { Decimal, roundToStep } from '@app/money';
import {
  finalise,
  parseFilters,
  type ConfigDiagnostic,
  type SymbolFilters,
} from '@app/strategy-core';
import type { TTConfig } from './schema.js';

/** One order the config would place, with its resolved quote budget. */
interface PlannedOrder {
  readonly quote: Decimal;
  readonly path: string[];
  readonly label: string;
}

/**
 * Resolve the orders whose quote budget is a fixed absolute amount: every grid
 * level (`gridLevels[].maxPurchaseAmount`), or the single no-grid `fixed` entry.
 * Returns `null` for `percentOfAccount` entries — those are risk-sized against
 * equity and the stop-loss, so resolving them to an absolute amount would mean
 * re-deriving the tick's risk math; they scale with balance and cannot
 * meaningfully under-fund a single order, so they are left unchecked here.
 */
const plannedOrders = (config: TTConfig): PlannedOrder[] | null => {
  const buy = config.buy;
  if (buy.gridLevels.length > 0) {
    return buy.gridLevels.map((lvl, i) => ({
      quote: new Decimal(lvl.maxPurchaseAmount),
      path: ['buy', 'gridLevels', String(i), 'maxPurchaseAmount'],
      label: `grid level ${i + 1}`,
    }));
  }
  if (buy.entrySizing.mode === 'fixed') {
    return [
      {
        quote: new Decimal(buy.entrySizing.amount),
        path: ['buy', 'entrySizing', 'amount'],
        label: 'entry buy',
      },
    ];
  }
  return null;
};

/**
 * Check a schema-valid TTConfig against one symbol's live order minimums and the
 * available quote balance. Emits `block` diagnostics when an order sizes below
 * the symbol's minimum, or when the balance cannot fund the full grid. Empty when
 * every order clears its minimum and the whole ladder fits. See the
 * `checkOrderFeasibility` contract member for how callers turn a `block` into a
 * hard rejection.
 */
export const checkTTOrderFeasibility = (input: {
  config: TTConfig;
  filters: SymbolFilters;
  price: string;
  availableQuote?: string;
}): readonly ConfigDiagnostic[] => {
  const parsed = parseFilters(input.filters);
  if (parsed === null) return [];

  let price: Decimal;
  // Undefined balance means "unknown" (no wallet snapshot): the funding check is
  // skipped, but the per-order minimums below still run off price + filters.
  let available: Decimal | null;
  try {
    price = new Decimal(input.price);
    available = input.availableQuote === undefined ? null : new Decimal(input.availableQuote);
  } catch {
    return [];
  }
  if (price.lte(0)) return [];

  const orders = plannedOrders(input.config);
  if (orders === null) return [];

  const out: ConfigDiagnostic[] = [];

  // Per-order minimum: size each order exactly as the tick would and reject the
  // config when even one order falls below the exchange's minimum at this price.
  for (const order of orders) {
    const sized = finalise(roundToStep(order.quote.div(price), parsed.step), price, parsed);
    if (!('skip' in sized)) continue;
    if (sized.skip === 'min-notional') {
      out.push({
        level: 'block',
        code: 'order-below-min-notional',
        message:
          `Your ${order.label} budget of ${order.quote.toString()} is below Binance's minimum ` +
          `order value for this coin (${parsed.minNotional.toString()}), so no order can be placed. ` +
          `Raise this amount to at least ${parsed.minNotional.toString()}.`,
        path: order.path,
      });
    } else {
      // min-qty: below the base-asset minimum at this price. Show the quote spend
      // it implies so the fix is in the same unit the operator typed.
      const minSpend = parsed.minQty.mul(price).toDecimalPlaces(2).toString();
      out.push({
        level: 'block',
        code: 'order-below-min-qty',
        message:
          `Your ${order.label} budget of ${order.quote.toString()} sizes below Binance's minimum ` +
          `order quantity for this coin at the current price. At ${price.toString()} you'd need to ` +
          `spend at least about ${minSpend} to place one order. Raise this amount.`,
        path: order.path,
      });
    }
  }

  // Full-grid funding: the account must be able to fund the WHOLE ladder, not
  // just the first order. Count how many levels the balance funds in sequence so
  // the operator sees exactly how short it is.
  const total = orders.reduce((sum, order) => sum.add(order.quote), new Decimal(0));
  if (available !== null && total.gt(available)) {
    let funded = 0;
    let cumulative = new Decimal(0);
    for (const order of orders) {
      const next = cumulative.add(order.quote);
      if (next.gt(available)) break;
      cumulative = next;
      funded += 1;
    }
    out.push({
      level: 'block',
      code: 'grid-underfunded',
      message:
        `This ${orders.length > 1 ? 'grid' : 'entry'} needs ${total.toString()} in total to place ` +
        `${orders.length > 1 ? `all ${orders.length} levels` : 'the buy'}, but the account balance ` +
        `is ${available.toString()} — only ${funded} of ${orders.length} can be funded. Add balance, ` +
        `or reduce the ${orders.length > 1 ? 'grid levels or per-level amounts' : 'entry amount'}.`,
      path: orders.length > 1 ? ['buy', 'gridLevels'] : ['buy', 'entrySizing', 'amount'],
    });
  }

  return out;
};
