// Decoder for Binance user-data WS frames (ws-api `userDataStream`).
//
// This is the user-data counterpart to the market-data kline/miniTicker
// frame decoders: it owns the single-letter Binance wire shape so a field
// rename in the Binance spec is a one-file change inside @app/binance
// rather than an edit in every consumer. The decoded event carries no
// transport/account envelope; callers attach their own identifiers.

/**
 * Account-stream event decoded from a Binance user-data frame. String money
 * fields stay strings so the consumer revives them as Decimal at its own
 * boundary; numeric ids/timestamps stay numbers.
 */
export type UserStreamEvent =
  | {
      readonly kind: 'execution-report';
      readonly symbol: string;
      readonly orderId: number;
      readonly clientOrderId: string;
      readonly orderStatus: string;
      readonly side: 'BUY' | 'SELL';
      readonly executionType: string;
      readonly priceLastFilled: string;
      readonly qtyLastFilled: string;
      readonly cumQty: string;
      readonly cumQuoteQty: string;
      readonly tradeId: number;
      readonly eventTimeMs: number;
    }
  | {
      readonly kind: 'balance-update';
      readonly asset: string;
      readonly delta: string;
      readonly eventTimeMs: number;
    }
  | {
      readonly kind: 'account-position';
      readonly balances: readonly {
        readonly asset: string;
        readonly free: string;
        readonly locked: string;
      }[];
      readonly eventTimeMs: number;
    };

/**
 * Decode one parsed user-data frame into a typed event, or `null` for any
 * frame that is not a recognised account event (request acks, heartbeats,
 * unknown event types). Input is the JSON-parsed frame object; callers own
 * `JSON.parse` and request/heartbeat routing.
 *
 * Event-push frames live under an `event` wrapper per the ws-api spec
 * (`{ event: { e: "executionReport", ... } }`); the older raw-stream shape
 * placed the event at the top level (`{ e: ..., ... }`). Both are accepted
 * because Binance has historically left top-level pushes intact for legacy
 * clients during migration windows.
 */
export const parseUserStreamFrame = (raw: unknown): UserStreamEvent | null => {
  if (typeof raw !== 'object' || raw === null) return null;
  const data = raw as Record<string, unknown>;
  const inner = (data['event'] ?? data) as Record<string, unknown>;
  const ev = inner['e'];

  if (ev === 'executionReport') {
    return {
      kind: 'execution-report',
      symbol: String(inner['s'] ?? ''),
      orderId: Number(inner['i'] ?? 0),
      clientOrderId: String(inner['c'] ?? ''),
      orderStatus: String(inner['X'] ?? ''),
      side: inner['S'] === 'BUY' ? 'BUY' : 'SELL',
      executionType: String(inner['x'] ?? ''),
      priceLastFilled: String(inner['L'] ?? '0'),
      qtyLastFilled: String(inner['l'] ?? '0'),
      cumQty: String(inner['z'] ?? '0'),
      cumQuoteQty: String(inner['Z'] ?? '0'),
      tradeId: Number(inner['t'] ?? 0),
      eventTimeMs: Number(inner['E'] ?? 0),
    };
  }

  if (ev === 'balanceUpdate') {
    return {
      kind: 'balance-update',
      asset: String(inner['a'] ?? ''),
      delta: String(inner['d'] ?? '0'),
      eventTimeMs: Number(inner['E'] ?? 0),
    };
  }

  if (ev === 'outboundAccountPosition') {
    const balRaw = (inner['B'] ?? []) as Record<string, unknown>[];
    return {
      kind: 'account-position',
      balances: balRaw.map((b) => ({
        asset: String(b['a'] ?? ''),
        free: String(b['f'] ?? '0'),
        locked: String(b['l'] ?? '0'),
      })),
      eventTimeMs: Number(inner['E'] ?? 0),
    };
  }

  return null;
};
