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
      /**
       * Commission charged on THIS event's trade, not on the order so far.
       * `z`/`Z` are cumulative but `n`/`N` are per-trade, so a consumer that
       * needs the order's total commission must accumulate across the
       * partials itself.
       */
      readonly commission: string;
      /**
       * Asset the commission was charged in. Binance charges a BUY in the
       * BASE asset unless a discount asset (BNB) is enabled, so this must be
       * compared against the symbol's base asset before netting anything.
       * Empty when the event carries no trade (a bare NEW / CANCELED report).
       */
      readonly commissionAsset: string;
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
 * Decode one parsed user-data frame into a typed event, or `null` for any frame that is not a recognised account event (request acks, heartbeats, unknown event types). Callers own `JSON.parse` and request/heartbeat routing.
 *
 * Event-push frames live under an `event` wrapper (`{ event: { e: "executionReport", ... } }`); the older raw-stream shape placed the event at the top level (`{ e: ..., ... }`). Both are accepted because Binance has historically left top-level pushes intact for legacy clients during migration windows.
 *
 * @param raw - The JSON-parsed frame object, in either shape. Anything that is not a non-null object is refused rather than coerced.
 * @returns The typed event, or `null` when the frame is not a recognised account event. On an execution report `clientOrderId` is `''` whenever `c` is absent or is not a string, so a non-string JSON scalar can never become a marker key.
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
      // Read as a string or not at all, because `c` is the only field here that becomes a KEY: it names the cross-profile placement marker the event router's ownership gate reads back. (Other fields are decoded rather than blindly stringified too — `S` is compared, `i`/`t`/`E` go through `Number()` — but a coercion in any of them yields at most a value that matches nothing.) `String()` would turn a non-string JSON scalar into a legal-looking id (`0`, `false`), collapsing distinct orders onto one shared marker key and attributing them all to whichever profile last placed with that shape. Every other field is read as data, so a coercion there is at worst a value that matches nothing. Empty is already the gate's "no marker", which falls back to the orders-row verdict.
      clientOrderId: typeof inner['c'] === 'string' ? inner['c'] : '',
      orderStatus: String(inner['X'] ?? ''),
      side: inner['S'] === 'BUY' ? 'BUY' : 'SELL',
      executionType: String(inner['x'] ?? ''),
      priceLastFilled: String(inner['L'] ?? '0'),
      qtyLastFilled: String(inner['l'] ?? '0'),
      cumQty: String(inner['z'] ?? '0'),
      cumQuoteQty: String(inner['Z'] ?? '0'),
      // Binance sends `N: null` (not an absent key) on a report with no trade,
      // so `??` is load-bearing: `String(null)` would yield the literal "null"
      // and match no asset symbol.
      commission: String(inner['n'] ?? '0'),
      commissionAsset: String(inner['N'] ?? ''),
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
