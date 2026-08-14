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
 * Binance's `PERCENT_PRICE_BY_SIDE` band: the multipliers that bound how far an
 * order's price may sit from a reference price, per side. Binance refuses a BUY
 * outside `[ref × bidMultiplierDown, ref × bidMultiplierUp]` and a SELL outside
 * `[ref × askMultiplierDown, ref × askMultiplierUp]` with -1013, so a resting
 * protective stop priced under the ask floor can never be placed however often
 * it is retried. `avgPriceMins` is the averaging window Binance derives the
 * reference over (0 = last trade price), carried so a refusal can name it.
 */
export const PercentPriceBySide = z.object({
  bidMultiplierUp: FilterDecimalString,
  bidMultiplierDown: FilterDecimalString,
  askMultiplierUp: FilterDecimalString,
  askMultiplierDown: FilterDecimalString,
  avgPriceMins: z.number().int().nonnegative(),
});
/** TS type derived from {@link PercentPriceBySide} so consumers don't re-run z.infer at every call site. */
export type PercentPriceBySide = z.infer<typeof PercentPriceBySide>;

/**
 * Binance's `TRAILING_DELTA` filter: the inclusive basis-point bounds on the
 * `trailingDelta` an order may carry, PER SYMBOL. A SELL stop-loss trails down
 * from the high-water mark, so the `Below` pair is the one that governs it. Not
 * money — a delta is a ratio Binance types as a `LONG` — so these are plain
 * non-negative integers rather than decimal-strings.
 */
export const TrailingDelta = z.object({
  minTrailingAboveDelta: z.number().int().nonnegative(),
  maxTrailingAboveDelta: z.number().int().nonnegative(),
  minTrailingBelowDelta: z.number().int().nonnegative(),
  maxTrailingBelowDelta: z.number().int().nonnegative(),
});
/** TS type derived from {@link TrailingDelta} so consumers don't re-run z.infer at every call site. */
export type TrailingDelta = z.infer<typeof TrailingDelta>;

/**
 * The seven Binance filter thresholds a strategy needs to size and price an
 * order, mirroring `SymbolFilters` in `@app/strategy-core`. Each value is a
 * decimal-string (trailing zeros preserved) so a consumer can read tick/step
 * precision straight off the string.
 *
 * `percentPriceBySide` is OPTIONAL and parsed independently of those seven:
 * absence means the band is UNKNOWN, never "no band", so a consumer reading it
 * fails open. Binance does not publish the row on every symbol, cached entries
 * written before the field existed omit it, and there is no migration.
 */
export const SymbolFilters = z.object({
  minNotional: FilterDecimalString,
  tickSize: FilterDecimalString,
  stepSize: FilterDecimalString,
  minQty: FilterDecimalString,
  maxQty: FilterDecimalString,
  minPrice: FilterDecimalString,
  maxPrice: FilterDecimalString,
  percentPriceBySide: PercentPriceBySide.optional(),
  trailingDelta: TrailingDelta.optional(),
});
/** TS type derived from {@link SymbolFilters} so consumers don't re-run z.infer at every call site. */
export type SymbolFilters = z.infer<typeof SymbolFilters>;

/** Shape of a raw Binance filter row, before projection. Every value is optional
 * because each `filterType` carries only its own subset of these fields. Exported
 * so a caller that declares a typed row shape uses the projector's own input
 * instead of a copy that can silently fall behind it. Callers that stay
 * deliberately permissive, like the api's cache-load schema, keep their own. */
export interface RawSymbolFilter {
  readonly filterType: string;
  readonly minPrice?: string;
  readonly maxPrice?: string;
  readonly tickSize?: string;
  readonly minQty?: string;
  readonly maxQty?: string;
  readonly stepSize?: string;
  readonly minNotional?: string;
  readonly bidMultiplierUp?: string;
  readonly bidMultiplierDown?: string;
  readonly askMultiplierUp?: string;
  readonly askMultiplierDown?: string;
  readonly avgPriceMins?: number;
  readonly minTrailingAboveDelta?: number;
  readonly maxTrailingAboveDelta?: number;
  readonly minTrailingBelowDelta?: number;
  readonly maxTrailingBelowDelta?: number;
}

/**
 * Project a symbol's raw Binance filter list into the full {@link SymbolFilters}
 * set. `minNotional` comes from the current `NOTIONAL` filter, falling back to
 * the legacy `MIN_NOTIONAL` — the divergence that let the api route (which only
 * read `tickSize`) drift from the worker. Values pass through verbatim so
 * trailing zeros survive. Returns `null` when a required filter group is absent
 * or any value is not a positive decimal-string, so a partial upstream row can
 * never produce a half-populated filter set.
 *
 * `PERCENT_PRICE_BY_SIDE` and `TRAILING_DELTA` are parsed SEPARATELY and spread
 * in only on success, because they carry the opposite failure meaning to the
 * seven. A missing sizing threshold must void the whole set (a half-populated
 * one sizes a bad order), whereas a missing or garbled band must degrade to
 * "unknown" and leave the seven intact: folding either into the same
 * all-or-nothing parse would turn every symbol Binance publishes no such row for
 * into a null filter set, which is a far larger outage than the row it was meant
 * to add.
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
  if (!parsed.success) return null;
  // Only the by-side band is projected. Binance still documents a legacy
  // `PERCENT_PRICE` filter carrying the same -1013, but no listed spot symbol
  // publishes it (all 3641 carry `PERCENT_PRICE_BY_SIDE` instead), so mapping it
  // would be dead code guarding a case that cannot arrive.
  const band = PercentPriceBySide.safeParse(find('PERCENT_PRICE_BY_SIDE'));
  // Same all-or-nothing-free treatment as the band, and for the same reason: a
  // symbol that publishes no trailing bounds must still yield a usable filter
  // set, and the reader answers absence with "do not place a trailing order".
  const trailing = TrailingDelta.safeParse(find('TRAILING_DELTA'));
  return {
    ...parsed.data,
    ...(band.success ? { percentPriceBySide: band.data } : {}),
    ...(trailing.success ? { trailingDelta: trailing.data } : {}),
  };
};

/**
 * A symbol's `permissionSets` as Binance publishes them: a list of sets of
 * permission names. Non-empty at both levels, since an empty list carries no
 * claim and must be treated as "not published" rather than as "permits nothing".
 */
export const SymbolPermissionSets = z.array(z.array(z.string().min(1).max(32)).min(1)).min(1);
/** TS type derived from {@link SymbolPermissionSets} so consumers don't re-run z.infer. */
export type SymbolPermissionSets = z.infer<typeof SymbolPermissionSets>;

/**
 * Project a symbol's raw `permissionSets` field into {@link SymbolPermissionSets}.
 * All-or-nothing like {@link projectSymbolFilters}: a shape Binance changed, or a
 * partially-typed list, yields `null` rather than a half-read set, because a
 * half-read set would be used to REFUSE orders on symbols the account can trade.
 */
export const projectPermissionSets = (raw: unknown): SymbolPermissionSets | null => {
  const parsed = SymbolPermissionSets.safeParse(raw);
  return parsed.success ? parsed.data : null;
};

/**
 * The permission tags cached for an account, read back from their JSON string.
 * Returns an empty list for anything unusable (absent key, non-JSON, wrong
 * shape, or a list carrying any non-string entry) so a corrupt value degrades
 * exactly like an absent one: callers read empty as "cannot tell" and fail open.
 *
 * All-or-nothing like {@link projectPermissionSets}, and for the same reason.
 * Keeping the survivors of a partially-typed list would return a positively-read
 * but INCOMPLETE held-permission list, which reads as a confident "not
 * permitted" and blocks every order on a tradable symbol, exits included.
 */
export const parseAccountPermissions = (raw: string | null): readonly string[] => {
  if (raw === null) return [];
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    return [];
  }
  if (!Array.isArray(parsed)) return [];
  if (!parsed.every((p) => typeof p === 'string' && p.length > 0)) return [];
  return parsed as readonly string[];
};

/**
 * Whether an account may trade a symbol, per Binance's published tradability
 * rule: `permissionSets` is an AND of ORs, so the account must hold at least one
 * permission from EVERY published set. An account holding only
 * `[LEVERAGED, TRD_GRP_025]` therefore fails a symbol publishing the single set
 * `[SPOT, MARGIN, TRD_GRP_005, …]`, and every order on it is refused -2010
 * "This symbol is not permitted for this account" no matter how often it retries.
 *
 * Fails OPEN in every ambiguity — no published sets, an empty set, or an unknown
 * account permission list (a cold cache). The cost of a wrong "not permitted" is
 * every order on a symbol the account can trade, silently; the cost of a wrong
 * "permitted" is one Binance rejection, exactly what happens today.
 */
export const isSymbolPermittedForAccount = (input: {
  readonly permissionSets?: readonly (readonly string[])[] | null | undefined;
  readonly accountPermissions?: readonly string[] | null | undefined;
}): boolean => {
  const sets = input.permissionSets;
  const held = input.accountPermissions;
  if (sets === null || sets === undefined || sets.length === 0) return true;
  if (held === null || held === undefined || held.length === 0) return true;
  const heldSet = new Set(held);
  return sets.every((set) => set.length === 0 || set.some((p) => heldSet.has(p)));
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
  /**
   * Binance's tradability sets for this symbol. Carried so a bind can refuse a
   * symbol the account's own permissions can never trade, instead of discovering
   * it one -2010 per tick. `null` when Binance published nothing usable.
   * Optional so cache entries written before the field existed keep deserialising.
   */
  permissionSets: SymbolPermissionSets.nullable().optional(),
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
