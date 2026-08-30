import { z } from 'zod';
import { FeeBasis } from './archive.js';
import { asDecimalString, DecimalString } from './decimal.js';
import { EntryBlockerResponse } from './entry-blocker.js';
import { OrderResponse } from './orders.js';
import { BenchmarkMode } from './profiles.js';
import { SymbolSource } from './symbols.js';

/**
 * Per-symbol row on a profile's dashboard. Mirrors the operator-visible
 * "is this symbol making/losing money right now" surface; decimals are
 * wire-encoded as strings to preserve tick-level precision in the browser.
 */
export const ProfileDashboardSymbol = z.object({
  symbol: z.string(),
  enabled: z.boolean(),
  /** Where this binding came from: the operator (`manual`), discovery (`auto`), or a system recovery that can claim neither (`unknown`). Drives the source badge. Defaults to `manual` so a payload from a pre-discovery deploy (or a fixture that omits it) still decodes; the live projection always sets it from the row. */
  source: SymbolSource.default('manual'),
  avgEntryPrice: DecimalString.nullable(),
  currentPrice: DecimalString.nullable(),
  /** Held base-asset quantity; null when the symbol is flat. The display
   * layer derives unrealised P/L from `(currentPrice - avgEntryPrice) * quantity`. */
  quantity: DecimalString.nullable(),
  openOrderCount: z.number().int().nonnegative(),
  /** Resting orders for this symbol — same shape the per-symbol
   * `SymbolStateResponse` ships. Lets the profile dashboard render a
   * profile-wide open-orders table without an extra per-symbol fetch.
   * `openOrderCount === openOrders.length` by construction. */
  openOrders: z.array(OrderResponse),
  /** Why this symbol is not entering a position right now, or `null` when it is
   * holding or has no blocker. Enriched server-side from the persisted strategy
   * state. `.default(null)` keeps old payloads (Redis snapshots written before
   * this field existed) decodable. */
  entryBlocker: EntryBlockerResponse.default(null),
  /** Why this symbol's open position has NO exchange-side protective stop, or
   * `null` when it is protected (or flat). Enriched server-side from the same
   * persisted strategy state as `entryBlocker`. */
  protectiveStopBlocker: EntryBlockerResponse.default(null),
  /**
   * Why the operator's recorded cost basis was NOT handed to the strategy for this symbol, or null when it was.
   *
   * Travels beside `avgEntryPrice` because that is the record the refusal is about: the row survives the refusal by design, so a client holding only the row renders a position the strategy does not have — and prices it, because entry price and quantity are both right there. Same shape and same source as the per-symbol `SymbolStateResponse` field, so the dashboard row and the symbol workspace cannot disagree about whether a coin is held.
   *
   * `since` is when the refusal opened, not when it was last re-observed, so a duration stays exact after the opening log row has been swept. `.default(null)` keeps a payload written before this field shipped decodable.
   */
  positionSeedRefusal: z
    .object({
      code: z.string(),
      since: z.iso.datetime(),
    })
    .nullable()
    .default(null),
});
/** TS type derived from {@link ProfileDashboardSymbol} so consumers don't re-run z.infer at every call site. */
export type ProfileDashboardSymbol = z.infer<typeof ProfileDashboardSymbol>;

/**
 * Response shape for `GET /profiles/:profileId/dashboard`. Snapshot is read
 * from Redis-cached values (`cachedAt`) so the UI poll never hits Postgres
 * on the hot path.
 */
export const ProfileDashboardResponse = z.object({
  profileId: z.uuid(),
  enabled: z.boolean(),
  binanceMode: z.enum(['test', 'live']),
  // The profile's trading quote currency (e.g. USDT, BTC). Defaulted so a
  // dashboard-cache blob written before this field existed still decodes (the
  // 5s TTL recomputes it fresh); the balances panel labels amounts in this unit.
  quoteAsset: z.string().default('USDT'),
  balances: z.array(
    z.object({
      asset: z.string(),
      free: DecimalString,
      locked: DecimalString,
      // Per-asset price in the profile's quote asset (e.g. USDT), from the
      // market-trend cron's price map. `null` when the asset has no traded
      // quote pair (dust the projection cannot value). `.nullable()` with no
      // default: an old cache blob omits it and the display layer treats
      // undefined as unpriced, same as null.
      usdPrice: DecimalString.nullable().optional(),
    }),
  ),
  totalProfit: DecimalString,
  // Deployed cost-basis in the quote asset (Σ avgEntryPrice × quantity) summed
  // over the account's positions that share THIS profile's binance_mode and
  // quote_asset. With `balances` it lets the config form preview a
  // percent-of-equity entry as a quote figure — equity = quote cash +
  // deployedQuote, the same total the strategy resolves at tick time. Scoped to
  // (mode, quoteAsset) so a live profile never counts test-mode practice
  // positions or a different quote unit. Defaulted so a dashboard-cache blob
  // written before this field existed still decodes (the 5s TTL recomputes it).
  deployedQuote: DecimalString.default(asDecimalString(0)),
  // Count of this profile's enabled notifiers. The SPA shows a "no
  // notifications" banner on a live profile with zero, since a real-money
  // emergency would otherwise go unheard. Computed fresh per request (not
  // from the dashboard cache) so a just-saved notifier clears the banner.
  enabledNotifierCount: z.number().int().nonnegative(),
  symbols: z.array(ProfileDashboardSymbol),
  cachedAt: z.iso.datetime(),
});
/** TS type derived from {@link ProfileDashboardResponse} so consumers don't re-run z.infer at every call site. */
export type ProfileDashboardResponse = z.infer<typeof ProfileDashboardResponse>;

/**
 * Open-position P/L inputs for one symbol the profile holds. The home screen
 * sums `(currentPrice - avgEntryPrice) * quantity` across these for the card's
 * unrealised-P/L readout. The rollup ships the decimal-string facts, not the
 * money math — decimal.js is barred on the server read path, so the sum is
 * done in the browser display layer.
 */
export const DashboardPositionInput = z.object({
  // The Binance pair (e.g. `SOLUSDT`). Carried so the card can group the
  // unrealised-P/L sum by quote asset and label each total with its unit,
  // rather than showing a bare unitless number.
  symbol: z.string(),
  avgEntryPrice: DecimalString,
  currentPrice: DecimalString.nullable(),
  quantity: DecimalString.nullable(),
});
/** TS type derived from {@link DashboardPositionInput} so consumers don't re-run z.infer at every call site. */
export type DashboardPositionInput = z.infer<typeof DashboardPositionInput>;

/**
 * One row of the cross-profile dashboard list. Includes only the at-a-glance
 * fields needed for the operator's home screen; full detail flows through
 * {@link ProfileDashboardResponse}.
 */
export const DashboardAggregateRow = z.object({
  profileId: z.uuid(),
  name: z.string(),
  enabled: z.boolean(),
  /** `test` = Binance testnet (practice funds), `live` = real account. The home
   * screen keeps the two apart so practice P/L is never summed into the
   * real-money headline. */
  binanceMode: z.enum(['test', 'live']),
  /** The profile's trading quote currency (e.g. USDT, BTC). Defaulted so an
   * aggregate-cache blob written before this field existed still decodes. */
  quoteAsset: z.string().default('USDT'),
  lastTickAt: z.iso.datetime().nullable(),
  lastTickLatencyMs: z.number().int().nonnegative().nullable(),
  /** True when a Binance API-key row exists for this profile. Lets the home
   * screen distinguish "no key configured" from "key set but no tick yet" so
   * the operator gets the right next-step hint without drilling in. */
  apiKeyConfigured: z.boolean(),
  /** Short token describing the most recent tick-loop failure (e.g.
   * `auth-rejected`, `cold-load-failed`), or `null` when the loop is healthy
   * or has never run. Written by the worker into the profile-state blob; the
   * projection forwards it untouched. */
  lastTickError: z.string().nullable(),
  killSwitch: z.boolean(),
  /** Open (not-yet-closed) orders across every symbol this profile trades. */
  openOrderCount: z.number().int().nonnegative(),
  /** Symbols holding a position — a stored avg-entry-price means an open trade. */
  openPositionCount: z.number().int().nonnegative(),
  /** One entry per held position; the client sums these into the card P/L. */
  positions: z.array(DashboardPositionInput),
});
/** TS type derived from {@link DashboardAggregateRow} so consumers don't re-run z.infer at every call site. */
export type DashboardAggregateRow = z.infer<typeof DashboardAggregateRow>;

/** Response shape for `GET /dashboard-aggregate`: the cross-profile rollup. */
export const DashboardAggregateResponse = z.object({
  profiles: z.array(DashboardAggregateRow),
});
/** TS type derived from {@link DashboardAggregateResponse} so consumers don't re-run z.infer at every call site. */
export type DashboardAggregateResponse = z.infer<typeof DashboardAggregateResponse>;

/**
 * Closed-trades period selector: `a`ll, `d`ay, `w`eek, `m`onth. Short codes
 * kept stable to keep saved operator URLs working.
 */
export const ClosedTradesPeriod = z.enum(['a', 'd', 'w', 'm']);
/** TS type derived from {@link ClosedTradesPeriod} so consumers don't re-run z.infer at every call site. */
export type ClosedTradesPeriod = z.infer<typeof ClosedTradesPeriod>;

/** True when `tz` is an IANA zone the runtime's Intl can resolve. */
const isValidTimeZone = (tz: string): boolean => {
  try {
    new Intl.DateTimeFormat('en-CA', { timeZone: tz });
    return true;
  } catch {
    return false;
  }
};

/**
 * Query string for the period-windowed reads (`GET /closed-trades` and
 * `GET /discovery-scoreboard`). `tz` is required because period boundaries
 * (start-of-day/week/month) depend on the operator's local clock; it is refined
 * to a resolvable IANA zone so a bad value fails as a 422 at the boundary rather
 * than throwing a `RangeError` (→ 500) deep in `periodWindow`'s Intl call.
 */
export const ClosedTradesQuery = z.object({
  period: ClosedTradesPeriod.default('d'),
  tz: z.string().min(1).max(64).default('UTC').refine(isValidTimeZone, 'unknown IANA timezone'),
});
/** TS type derived from {@link ClosedTradesQuery} so consumers don't re-run z.infer at every call site. */
export type ClosedTradesQuery = z.infer<typeof ClosedTradesQuery>;

/**
 * Aggregated P&L over the requested period. `from`/`to` are echoed back so
 * the client can render the period label without re-deriving boundaries.
 */
export const ClosedTradesResponse = z.object({
  period: ClosedTradesPeriod,
  tz: z.string(),
  from: z.iso.datetime(),
  to: z.iso.datetime(),
  totalProfit: DecimalString,
  totalProfitPercent: DecimalString,
  tradeCount: z.number().int().nonnegative(),
});
/** TS type derived from {@link ClosedTradesResponse} so consumers don't re-run z.infer at every call site. */
export type ClosedTradesResponse = z.infer<typeof ClosedTradesResponse>;

/** One point on a profile's net-P/L curve, with its passive benchmark price. */
export const EquitySnapshotPoint = z.object({
  capturedAt: z.iso.datetime(),
  /** Cumulative net-of-fee profit = realised + unrealised mark-to-market. */
  netPnlQuote: DecimalString,
  /** Cumulative realised net-of-fee profit from the trade archive. */
  realizedNetQuote: DecimalString,
  /** Mark-to-market value of open positions. */
  positionValueQuote: DecimalString,
  /** Cost basis of open positions. */
  positionCostQuote: DecimalString,
  /** Benchmark asset (e.g. 'BTC') and its price in the quote asset at capture. */
  benchmarkAsset: z.string(),
  benchmarkPriceQuote: DecimalString,
  /** How well the realised leg's fee component was known when this point was recorded. Carried per point rather than filtered server-side: the realised leg is an all-time cumulative fold, and no forward path lifts its tier once stamped, so dropping the weak points would blank the curve rather than defer it. Defaulted so a body written before this field shipped still parses, and defaulted to the WEAKEST tier so silence is never read as proof. */
  feeBasis: FeeBasis.default('unknown'),
  /**
   * Per-symbol mark prices at capture (symbol → quote price) for the held
   * positions, so the basket-hold line is computable at render time. `nullish`:
   * rows written before this shipped have none, and the card degrades to a flat
   * basket line for those points.
   */
  benchmarkPrices: z.record(z.string(), DecimalString).nullish(),
});
/** TS type derived from {@link EquitySnapshotPoint}. */
export type EquitySnapshotPoint = z.infer<typeof EquitySnapshotPoint>;

/**
 * A profile's net-P/L time series (oldest-first) for the "profit vs hold" card.
 * `quoteAsset` labels the unit; `points` is empty until the cron has run once.
 */
export const EquitySnapshotsResponse = z.object({
  profileId: z.uuid(),
  quoteAsset: z.string(),
  points: z.array(EquitySnapshotPoint),
  /**
   * Which "vs holding" comparator the card should draw for this profile.
   * Defaulted so a response or fixture predating this field still parses.
   */
  benchmarkMode: BenchmarkMode.default('btc'),
});
/** TS type derived from {@link EquitySnapshotsResponse}. */
export type EquitySnapshotsResponse = z.infer<typeof EquitySnapshotsResponse>;

/** Query for the equity-snapshots read: optional ISO range + a row cap. */
export const EquitySnapshotsQuery = z.object({
  from: z.iso.datetime().optional(),
  to: z.iso.datetime().optional(),
  limit: z.coerce.number().int().min(1).max(2000).default(500),
});
/** TS type derived from {@link EquitySnapshotsQuery}. */
export type EquitySnapshotsQuery = z.infer<typeof EquitySnapshotsQuery>;
