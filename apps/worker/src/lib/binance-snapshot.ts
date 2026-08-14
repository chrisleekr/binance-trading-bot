// Adapters between Binance REST DTOs and the strategy-core snapshot
// shapes consumed by the tick handler. Both the pipeline-worker (hot
// path: prime on profile activation) and cold-load (safety net on
// cache miss) use these so the wire shape is identical regardless of
// which producer wrote it.

import type { AccountDto, OpenOrderDto } from '@app/binance';
import { reviveBalanceField, type BalanceParseWarn } from './balance-revive.js';
import type {
  AccountSnapshot,
  Balance,
  OpenOrder,
  OrderSide,
  OrderStatus,
  OrderType,
  TimeInForce,
} from '@app/strategy-core';

const ORDER_SIDES: readonly OrderSide[] = ['BUY', 'SELL'];
// STOP_LOSS is here because an exchange-native trailing protective stop rests as
// one. `narrowEnum` THROWS on an unknown type, and the throw lands inside the
// tick, so omitting it would dead-letter every tick on that symbol for as long as
// the order rests — the position would go wholly unmanaged.
const ORDER_TYPES: readonly OrderType[] = ['LIMIT', 'MARKET', 'STOP_LOSS', 'STOP_LOSS_LIMIT'];
const ORDER_STATUSES: readonly OrderStatus[] = [
  'NEW',
  'PARTIALLY_FILLED',
  'FILLED',
  'CANCELED',
  'PENDING_CANCEL',
  'REJECTED',
  'EXPIRED',
];
const TIME_IN_FORCES: readonly TimeInForce[] = ['GTC', 'IOC', 'FOK'];

// Throws on unknown enum values rather than coercing — a future
// Binance order-type addition (e.g. STOP_LOSS_LIMIT_MAKER) misread as
// LIMIT would have the strategy reason about it incorrectly. Better
// to DLQ the tick than to ship wrong state into the executor.
// Binance returns `'0'`, `'0.00000000'`, or sometimes the literal empty
// string for non-stop orders. A naive `=== '0'` check misclassifies
// the padded form as a real stop price; treat any "all zeros after
// optional decimal point" as absent.
const ZERO_DECIMAL = /^0(\.0+)?$/;
const isNonZeroDecimal = (s: string | undefined): s is string =>
  typeof s === 'string' && s.length > 0 && !ZERO_DECIMAL.test(s);

const narrowEnum = <T extends string>(allowed: readonly T[], value: string, field: string): T => {
  if ((allowed as readonly string[]).includes(value)) return value as T;
  throw new Error(`binance-snapshot: unknown ${field} "${value}" (allowed: ${allowed.join(',')})`);
};

// Strategy-core's `AccountSnapshot.balances` is keyed by asset; the WS
// `outboundAccountPosition` event and the REST `/account` response both
// arrive as an array. Reduce to the Record shape exactly once so every
// reader (snapshot-loader.parseAccountSnapshot, the chart, the executor)
// sees the same canonical form.
export { type BalanceParseWarn } from './balance-revive.js';

export const accountSnapshotFromDto = (
  dto: AccountDto,
  onWarn?: BalanceParseWarn,
): AccountSnapshot => {
  const balances: Record<string, Balance> = {};
  for (const b of dto.balances) {
    balances[b.asset] = {
      asset: b.asset,
      free: reviveBalanceField(b.asset, 'free', b.free, onWarn),
      locked: reviveBalanceField(b.asset, 'locked', b.locked, onWarn),
    };
  }
  return { balances, readable: true };
};

export const openOrdersFromDtos = (dtos: readonly OpenOrderDto[]): readonly OpenOrder[] =>
  dtos.map((o) => ({
    orderId: o.orderId,
    clientOrderId: o.clientOrderId,
    symbol: o.symbol,
    side: narrowEnum(ORDER_SIDES, o.side, 'side'),
    type: narrowEnum(ORDER_TYPES, o.type, 'type'),
    status: narrowEnum(ORDER_STATUSES, o.status, 'status'),
    price: o.price,
    origQty: o.origQty,
    executedQty: o.executedQty,
    cummulativeQuoteQty: o.cummulativeQuoteQty,
    ...(isNonZeroDecimal(o.stopPrice) ? { stopPrice: o.stopPrice } : {}),
    // Carried through so a resting trailing stop's distance is readable: it has
    // no trigger price, so this is the only field a re-arm can compare.
    ...(typeof o.trailingDelta === 'number' ? { trailingDelta: o.trailingDelta } : {}),
    ...(o.timeInForce
      ? { timeInForce: narrowEnum(TIME_IN_FORCES, o.timeInForce, 'timeInForce') }
      : {}),
    transactTimeMs: o.time,
    updateTimeMs: o.updateTime,
  }));
