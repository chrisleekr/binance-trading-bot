import { z } from 'zod';
import { SaveDiagnostics } from './config-lint.js';
import { PositiveDecimalString } from './decimal.js';

/**
 * Validated trading-pair name (e.g. `BTCUSDT`). Constrained to upper-case
 * alphanumerics so a typo like `btcusdt` fails at the API boundary instead of
 * confusing a Binance lookup downstream.
 */
export const SymbolName = z
  .string()
  .min(2)
  .max(32)
  .regex(/^[A-Z0-9]+$/, 'symbol must be upper-case alphanumeric');
/** TS type derived from {@link SymbolName} so consumers don't re-run z.infer at every call site. */
export type SymbolName = z.infer<typeof SymbolName>;

/**
 * Origin of a profile-symbol binding: `manual` (the operator added it) or
 * `auto` (the discovery cron rotated it in). Gates which rows discovery is
 * allowed to reap; will also drive the source badge in a later UI slice.
 */
export const SymbolSource = z.enum(['manual', 'auto']);
/** TS type derived from {@link SymbolSource} so consumers don't re-run z.infer at every call site. */
export type SymbolSource = z.infer<typeof SymbolSource>;

/**
 * Per-symbol reserve floor in base units: the quantity the bot must never sell
 * below ("always hold N of this coin"; the bot trades only the surplus above
 * it). Null clears the reserve. A non-negative decimal-string so values like
 * `0.0001` survive the wire without IEEE-754 truncation; rejects negatives, NaN,
 * and scientific notation.
 */
export const ReserveBaseQuantity = z
  .string()
  .min(1)
  .max(40)
  .regex(
    /^(0|[1-9][0-9]*)(\.[0-9]+)?$/,
    'reserveBaseQuantity must be a non-negative decimal-string',
  )
  .nullable();
/** TS type derived from {@link ReserveBaseQuantity} so consumers don't re-run z.infer at every call site. */
export type ReserveBaseQuantity = z.infer<typeof ReserveBaseQuantity>;

/**
 * Per-symbol configuration row attached to a profile. `overrideConfig` is
 * `unknown` because each strategy owns the override schema; null means
 * "inherit profile defaults". `source` distinguishes operator-added from
 * discovery-rotated symbols. `reserveBaseQuantity` is the always-hold floor in
 * base units (null = none); `.default(null)` keeps responses recorded before the
 * field existed deserialising during rollout.
 */
export const ProfileSymbolResponse = z.object({
  symbol: SymbolName,
  overrideConfig: z.unknown().nullable(),
  source: SymbolSource,
  reserveBaseQuantity: ReserveBaseQuantity.default(null),
  /**
   * Present when the bind went through but its order sizing could not be
   * verified. Absent on a read. A newly bound symbol is not streaming a price
   * yet, so this is the ordinary outcome here rather than the exception, and
   * absence means the sizing really was checked.
   */
  diagnostics: SaveDiagnostics,
});
/** TS type derived from {@link ProfileSymbolResponse} so consumers don't re-run z.infer at every call site. */
export type ProfileSymbolResponse = z.infer<typeof ProfileSymbolResponse>;

/** Response for `GET /profiles/:id/symbols`. Small list, no pagination. */
export const ProfileSymbolList = z.array(ProfileSymbolResponse);
/** TS type derived from {@link ProfileSymbolList} so consumers don't re-run z.infer at every call site. */
export type ProfileSymbolList = z.infer<typeof ProfileSymbolList>;

/**
 * Body for `POST /profiles/:id/symbols`. New symbol starts with no overrides;
 * operator patches if needed. `avgEntryPrice` is the optional combined
 * "add a coin I already hold and tell the bot my cost basis" path (#496): when
 * present, the server seeds the cost-basis ledger and force-sets the strategy's
 * entry price so the bot manages the held position instead of treating it as
 * flat. Omitted for the common "add a pair to trade fresh" case.
 */
export const SymbolCreate = z.object({
  symbol: SymbolName,
  avgEntryPrice: PositiveDecimalString.optional(),
});
/** TS type derived from {@link SymbolCreate} so consumers don't re-run z.infer at every call site. */
export type SymbolCreate = z.infer<typeof SymbolCreate>;

/** Body for `PATCH /profiles/:id/symbols/:symbol`. Set `overrideConfig: null` to revert to profile defaults. */
export const SymbolPatch = z.object({
  overrideConfig: z.unknown().nullable(),
});
/** TS type derived from {@link SymbolPatch} so consumers don't re-run z.infer at every call site. */
export type SymbolPatch = z.infer<typeof SymbolPatch>;

/**
 * Body for `PUT /profiles/:id/symbols/:symbol/reserve`. Sets the always-hold
 * floor (base units), or `null` to clear it. A dedicated endpoint, separate from
 * the override PATCH, so writing the reserve never disturbs `overrideConfig` and
 * vice versa. The server additionally rejects a reserve greater than the live
 * base-asset holding (422); the schema only checks the shape here.
 */
export const SymbolReservePut = z.object({
  reserveBaseQuantity: ReserveBaseQuantity,
});
/** TS type derived from {@link SymbolReservePut} so consumers don't re-run z.infer at every call site. */
export type SymbolReservePut = z.infer<typeof SymbolReservePut>;

// Positive decimal-string form — `0.01`, `0.00000001`, `1`, `1.5`. Rejects
// `NaN`, `abc`, scientific notation, signs. Shared by every Binance filter
// value so precision survives the wire without IEEE-754 truncation.
const FilterDecimalString = z
  .string()
  .min(1)
  .max(32)
  .regex(/^(0|[1-9][0-9]*)(\.[0-9]+)?$/, 'filter value must be a positive decimal-string');

/**
 * The seven Binance filter thresholds a strategy needs to size and price an
 * order, mirroring `SymbolFilters` in `@app/strategy-core`. Each value is a
 * decimal-string (trailing zeros preserved) so a consumer can read tick/step
 * precision straight off the string.
 */
export const SymbolFilters = z.object({
  minNotional: FilterDecimalString,
  tickSize: FilterDecimalString,
  stepSize: FilterDecimalString,
  minQty: FilterDecimalString,
  maxQty: FilterDecimalString,
  minPrice: FilterDecimalString,
  maxPrice: FilterDecimalString,
});
/** TS type derived from {@link SymbolFilters} so consumers don't re-run z.infer at every call site. */
export type SymbolFilters = z.infer<typeof SymbolFilters>;

/** Shape of a raw Binance filter row, before projection. Every value is optional
 * because each `filterType` carries only its own subset of these fields. */
interface RawSymbolFilter {
  readonly filterType: string;
  readonly minPrice?: string;
  readonly maxPrice?: string;
  readonly tickSize?: string;
  readonly minQty?: string;
  readonly maxQty?: string;
  readonly stepSize?: string;
  readonly minNotional?: string;
}

/**
 * Project a symbol's raw Binance filter list into the full {@link SymbolFilters}
 * set. `minNotional` comes from the current `NOTIONAL` filter, falling back to
 * the legacy `MIN_NOTIONAL` — the divergence that let the api route (which only
 * read `tickSize`) drift from the worker. Values pass through verbatim so
 * trailing zeros survive. Returns `null` when a required filter group is absent
 * or any value is not a positive decimal-string, so a partial upstream row can
 * never produce a half-populated filter set.
 */
export const projectSymbolFilters = (
  filters: readonly RawSymbolFilter[] | undefined,
): SymbolFilters | null => {
  const find = (type: string): RawSymbolFilter | undefined =>
    filters?.find((f) => f.filterType === type);
  const price = find('PRICE_FILTER');
  const lot = find('LOT_SIZE');
  const notional = find('NOTIONAL') ?? find('MIN_NOTIONAL');
  const parsed = SymbolFilters.safeParse({
    minNotional: notional?.minNotional,
    tickSize: price?.tickSize,
    stepSize: lot?.stepSize,
    minQty: lot?.minQty,
    maxQty: lot?.maxQty,
    minPrice: price?.minPrice,
    maxPrice: price?.maxPrice,
  });
  return parsed.success ? parsed.data : null;
};

/**
 * One row from Binance's `exchangeInfo` endpoint, narrowed to the fields the
 * symbol picker needs (symbol id + base/quote for grouping/filtering + status
 * so disabled pairs don't reach the operator).
 */
export const ExchangeInfoSymbol = z.object({
  symbol: SymbolName,
  baseAsset: z.string().min(1).max(16),
  quoteAsset: z.string().min(1).max(16),
  status: z.string().min(1).max(32),
  /**
   * Authoritative tick size from Binance's `PRICE_FILTER`. The chart's
   * Y-axis precision and any LIMIT-order price input use this when present
   * — derive-from-window is a fallback for symbols whose recent close
   * prices haven't exercised the full tick. Decimal-string so values like
   * `0.00000001` survive the wire without IEEE-754 truncation. Optional
   * (not just nullable) so cache entries written by the previous deploy —
   * which omit the field — keep deserialising during the rollout window.
   */
  filterTickSize: FilterDecimalString.nullable().optional(),
  /**
   * The full sizing/pricing filter set (`NOTIONAL` + `LOT_SIZE` + `PRICE_FILTER`)
   * so a strategy preview can size a concrete entry quantity, not just read the
   * tick. `null` when the symbol lacks a complete filter set. Optional so cache
   * entries written before the field existed keep deserialising.
   */
  filters: SymbolFilters.nullable().optional(),
});
/** TS type derived from {@link ExchangeInfoSymbol} so consumers don't re-run z.infer at every call site. */
export type ExchangeInfoSymbol = z.infer<typeof ExchangeInfoSymbol>;

/**
 * Response for `GET /exchange-info`. Backed by a Redis cache so the same
 * payload survives the wizard, the symbols/new picker, and any future
 * symbol-aware screen without each one round-tripping to Binance.
 */
export const ExchangeInfoResponse = z.object({
  symbols: z.array(ExchangeInfoSymbol),
  fetchedAt: z.iso.datetime(),
});
/** TS type derived from {@link ExchangeInfoResponse} so consumers don't re-run z.infer at every call site. */
export type ExchangeInfoResponse = z.infer<typeof ExchangeInfoResponse>;
