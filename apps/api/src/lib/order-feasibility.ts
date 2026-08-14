import type { BinanceMode } from '@app/binance';
import { AccountInfoSnapshot, type ConfigDiagnostic } from '@app/contracts';
import { GLOBAL_KEYS, profileKey, type ProfileRepo } from '@app/db';
import { Decimal } from '@app/money';
import { protectiveStopBandWarning, type AnyStrategy } from '@app/strategy-core';
import type { DI } from 'di.js';
import { HttpError } from 'middleware/error.js';
import { z } from 'zod';

// The slice of the mode's `binance:symbol-info[-test]:<S>` snapshot the
// feasibility check needs: the order filters plus the quote-asset code (used to
// read the account's quote cash when valuing the grid). Parsed rather than cast
// so a drifted snapshot is reported as unavailable, not misread.
const SymbolInfoForFeasibility = z.object({
  quoteAsset: z.string(),
  filters: z.object({
    minNotional: z.string(),
    tickSize: z.string(),
    stepSize: z.string(),
    minQty: z.string(),
    maxQty: z.string(),
    minPrice: z.string(),
    maxPrice: z.string(),
    // The price band, when the snapshot carries one. `.catch(undefined)` keeps a
    // band that has drifted from "no band on this symbol": a malformed row must
    // fail open on the band alone, not take the whole filter set down and report
    // an otherwise-readable symbol as unchecked. Absent on every entry written
    // before the field existed, and Binance does not publish it on every symbol.
    percentPriceBySide: z
      .object({
        bidMultiplierUp: z.string(),
        bidMultiplierDown: z.string(),
        askMultiplierUp: z.string(),
        askMultiplierDown: z.string(),
        avgPriceMins: z.number(),
      })
      .optional()
      .catch(undefined),
    // The per-symbol trailing bounds, on the same fail-open terms as the band:
    // the warning below can only promise the trail escape when the symbol's own
    // bounds accept the configured distance, and a drifted row must silence that
    // one clause rather than report the whole symbol as unchecked.
    trailingDelta: z
      .object({
        minTrailingAboveDelta: z.number(),
        maxTrailingAboveDelta: z.number(),
        minTrailingBelowDelta: z.number(),
        maxTrailingBelowDelta: z.number(),
      })
      .optional()
      .catch(undefined),
  }),
});

const TickerSnapshot = z.object({ price: z.string() });

const safeJson = <T>(schema: z.ZodType<T>, raw: string): T | null => {
  try {
    const parsed = schema.safeParse(JSON.parse(raw));
    return parsed.success ? parsed.data : null;
  } catch {
    return null;
  }
};

/**
 * Map a strategy-core diagnostic (deeply readonly) to the mutable contract wire
 * shape, optionally prefixing the message (e.g. with the symbol). Centralises the
 * readonly→mutable `path` copy so every route emits diagnostics identically.
 */
export const toWireDiagnostic = (
  d: {
    readonly level: ConfigDiagnostic['level'];
    readonly code: string;
    readonly message: string;
    readonly path?: readonly string[];
  },
  prefix = '',
): ConfigDiagnostic => ({
  level: d.level,
  code: d.code,
  message: `${prefix}${d.message}`,
  ...(d.path ? { path: [...d.path] } : {}),
});

/**
 * Attach save-time advisories to a mutation response body, omitting the field
 * entirely when there is nothing to report. An empty array would change the
 * shape of every clean response and leave the client deciding what `[]` means;
 * absence is the unambiguous "nothing to say".
 */
export const withDiagnostics = <T extends object>(
  body: T,
  diagnostics: readonly ConfigDiagnostic[],
): T & { diagnostics?: ConfigDiagnostic[] } =>
  diagnostics.length === 0 ? body : { ...body, diagnostics: [...diagnostics] };

/**
 * The finding for settings the feasibility check could not read at all, whether
 * because the named strategy is not registered or because the settings no longer
 * match its schema. One message covers both: from the operator's side the outcome
 * is identical, and neither verified anything.
 *
 * The wording names the settings BEING CHECKED rather than the profile's stored
 * config, because the callers check different things: the backtest route checks
 * the stored config merged with a per-run override, while the bind and lint
 * routes check the stored config alone. Blaming the stored profile would send an
 * operator whose override is the problem to inspect settings that are fine.
 *
 * It is also cause-neutral. The more likely branch is a config that no longer
 * matches its schema, where the strategy is registered and only the settings
 * drifted, so copy that blamed an unknown strategy would misname the cause.
 */
export const configUnverified = (): ConfigDiagnostic => ({
  level: 'warn',
  code: 'config-unverified',
  message:
    'These settings could not be read by the strategy that would run them, so order sizing was not verified.',
});

/** Options for {@link orderFeasibilityDiagnostics}. */
interface FeasibilityOptions {
  /** Symbols to check; defaults to the profile's bound symbols. */
  readonly symbols?: readonly string[];
  /**
   * A clean, known quote balance the full grid must fit — pass ONLY for a
   * backtest (`initialQuoteBalance`). Applied identically to every symbol. Takes
   * precedence over {@link fundFromAccountValue} if both are set.
   */
  readonly availableQuoteOverride?: string;
  /**
   * Fund the full grid from the profile's live account value on a per-symbol
   * basis: free+locked quote cash plus the COST BASIS of any base position
   * already built for that symbol (`avgEntryPrice × quantity` from the ledger).
   * Counting the deployed position as committed grid capital means a mid-grid
   * profile whose free quote has been spent down is NOT false-blocked — the flaw
   * of a free-quote-only check. Cost basis, not the live mark, is deliberate: a
   * trailing-trade grid is normally underwater mid-drawdown, so marking to market
   * would shrink the position below the quote it committed and false-block a
   * config edit during exactly the dip the grid is built to hold. This mirrors
   * the codebase's equity model (free + locked + deployed cost). When the
   * `account-info` snapshot is absent (e.g. a profile never enabled) the funding
   * check is skipped for lack of data; the per-order minimum checks still run.
   */
  readonly fundFromAccountValue?: boolean;
  /**
   * Binance mode of the profile being checked. Required — it selects which
   * symbol-info keyspace the filters are read from: a `test`-mode profile MUST
   * validate against testnet's own tickSize / lot filters, which differ from
   * production — otherwise a config valid on testnet is false-blocked (or an
   * infeasible one passes) at save time. The ticker price stays global: the
   * worker feeds every mode from the same production market stream, so the live
   * price is the exact signal a testnet profile ticks against.
   */
  readonly mode: BinanceMode;
  /**
   * Treat "no cached price for this symbol" as worth telling the operator about
   * on a successful save, and word the finding for the add-symbol bind. Off by
   * default and ON only for that route.
   *
   * The ticker cache is symbol-global and kept only while some profile streams
   * that symbol, so a symbol nothing trades yet usually has no price and its
   * sizing check is skipped. That is the common outcome on a bind, and the bind
   * is the one route where staying quiet would claim a check that did not run.
   * Elsewhere the finding is noise the operator cannot act on: a config save
   * would emit one per bound symbol, and a backtest replays historical candles
   * where a live price is irrelevant.
   */
  readonly reportMissingPrice?: boolean;
}

/**
 * Findings split by who produced them. `all` is everything in emission order;
 * `hostMinted` is the subset this module wrote itself, and the plugin's own
 * findings are exactly the members of `all` that are not in `hostMinted`.
 *
 * Only `hostMinted` may ride back on a mutation success body. A plugin's `code`
 * and `message` reach the wire verbatim, and the host hands strategies a wallet
 * figure to size against, so a plugin is free to interpolate a balance into its
 * copy. Filtering by code instead would let any plugin put arbitrary text on a
 * success body simply by spelling a host code.
 */
interface SplitDiagnostics {
  readonly all: ConfigDiagnostic[];
  readonly hostMinted: ConfigDiagnostic[];
}

/** The cost-basis slice of a ledger row the funding valuation reads. */
interface LedgerCost {
  readonly avgEntryPrice: string;
  readonly quantity: string;
}

/**
 * Resolve the quote balance the full grid must fit for one symbol. A backtest's
 * clean override wins; otherwise value the account against this symbol —
 * free+locked quote cash + the cost basis of the base position already built
 * (`avgEntryPrice × quantity`, drawdown-invariant). Returns `undefined` (skip the
 * funding check, keep per-order minimums) when no account snapshot is available
 * or an amount is malformed.
 */
const resolveAvailableQuote = (
  opts: FeasibilityOptions,
  accInfo: AccountInfoSnapshot | null,
  symbolInfo: z.infer<typeof SymbolInfoForFeasibility>,
  ledger: LedgerCost | null,
): string | undefined => {
  if (opts.availableQuoteOverride !== undefined) return opts.availableQuoteOverride;
  if (!accInfo) return undefined;
  try {
    const q = accInfo.balances[symbolInfo.quoteAsset];
    const quoteCash = q ? new Decimal(q.free).add(q.locked) : new Decimal(0);
    const deployedCost = ledger
      ? new Decimal(ledger.avgEntryPrice).mul(ledger.quantity)
      : new Decimal(0);
    return quoteCash.add(deployedCost).toString();
  } catch {
    return undefined;
  }
};

/**
 * Per-symbol order-feasibility diagnostics for a profile's config, resolved
 * against live exchange facts the config schema cannot see. For each symbol it
 * reads the filters + current price and runs the strategy's `checkOrderFeasibility`,
 * prefixing each finding with the symbol so a multi-symbol profile names the
 * offender. A symbol whose filters or price snapshot is missing or unparseable
 * cannot be checked, and says so with a `warn` (`filters-unavailable` /
 * `price-unavailable`) rather than passing silently. That covers the market-data
 * gap only — a strategy's own check may still return nothing for a config it
 * declines to size, so an empty result is not a guarantee of full coverage.
 * `config` MUST be the schema-parsed config so the strategy reads typed fields.
 *
 * A second, cheaper check runs per symbol for any strategy that declares
 * `protectiveStopBandSettings`: whether the configured stop is deeper than the
 * symbol's `PERCENT_PRICE_BY_SIDE` band will hold. It needs the filters only, no
 * price and no balance, so it runs for a symbol with no cached price and for a
 * strategy with no order-feasibility check at all. Both lists come back empty
 * only when the strategy declares neither.
 *
 * The full-grid funding check runs only when `availableQuoteOverride` or
 * `fundFromAccountValue` is set (see {@link FeasibilityOptions}); otherwise only
 * the per-order minimum checks run.
 *
 * Findings come back split by provenance, see {@link SplitDiagnostics}.
 */
const runFeasibility = async (
  di: DI,
  p: ProfileRepo,
  strategy: AnyStrategy,
  config: unknown,
  opts: FeasibilityOptions,
): Promise<SplitDiagnostics> => {
  const empty = { all: [], hostMinted: [] };
  const check = strategy.checkOrderFeasibility;
  // Resolved once: the stop settings are symbol-independent, the band they are
  // judged against is not.
  const bandSettings = strategy.protectiveStopBandSettings?.(config) ?? null;
  if (!check && bandSettings === null) return empty;

  const symbolList = opts.symbols ?? (await p.profileSymbols.listForProfile()).map((s) => s.symbol);
  if (symbolList.length === 0) return empty;

  const r = di.redis.raw();
  // When valuing against live account value: one account-info read (quote cash)
  // plus one batched ledger read (deployed cost basis per symbol) for the whole
  // basket. The ledger read is skipped when there is no account snapshot, since
  // the funding check is skipped anyway.
  const fundLive = Boolean(opts.fundFromAccountValue) && opts.availableQuoteOverride === undefined;
  const accInfoRaw = fundLive ? await r.get(profileKey(p.scope, 'accountInfo')) : null;
  const accInfo = accInfoRaw ? safeJson(AccountInfoSnapshot, accInfoRaw) : null;
  const ledgerBySymbol = new Map<string, LedgerCost>();
  if (fundLive && accInfo) {
    for (const row of await p.avgEntryPrices.findBySymbols(symbolList)) {
      ledgerBySymbol.set(row.symbol, row);
    }
  }
  // Read every symbol's filters + price in parallel so an N-symbol basket pays
  // one round of Redis round-trips, not N sequential ones.
  const snapshots = await Promise.all(
    symbolList.map(async (symbol) => {
      const [symInfoRaw, tickerRaw] = await Promise.all([
        r.get(GLOBAL_KEYS.symbolInfo(symbol, opts.mode)),
        r.get(GLOBAL_KEYS.ticker(symbol)),
      ]);
      return { symbol, symInfoRaw, tickerRaw };
    }),
  );

  // Operator copy uses the same environment label the account screens show, not
  // the raw column value.
  const exchangeLabel = opts.mode === 'test' ? 'Testnet' : 'Live';

  const all: ConfigDiagnostic[] = [];
  const hostMinted: ConfigDiagnostic[] = [];
  // Every finding this module writes itself goes through here, so provenance is
  // recorded where it is known rather than re-derived downstream from a string.
  const mint = (d: ConfigDiagnostic, carryToSave: boolean): void => {
    all.push(d);
    if (carryToSave) hostMinted.push(d);
  };

  for (const { symbol, symInfoRaw, tickerRaw } of snapshots) {
    // A missing or drifted snapshot means this symbol was NOT checked. Saying
    // nothing is indistinguishable from "checked and fine", so the config would
    // be admitted with no validation behind it. Report the gap instead, as a
    // `warn`: the fault is in the cached market data, not in the config being
    // saved, so it must not reject the save. Filters are resolved before the
    // price so a symbol missing both yields one finding, not two.
    const info = symInfoRaw ? safeJson(SymbolInfoForFeasibility, symInfoRaw) : null;
    if (!info) {
      // Same code, different sentence: neither check may claim the other's
      // coverage. A strategy that does not size orders never had sizing to
      // verify, but the band check below reads these same filters, so it went
      // unrun too and saying nothing would read as "checked and fine".
      mint(
        toWireDiagnostic(
          {
            level: 'warn',
            code: 'filters-unavailable',
            message: check
              ? `Binance ${exchangeLabel} trading rules have not loaded yet, so order sizing was not verified.`
              : `Binance ${exchangeLabel} trading rules have not loaded yet, so the backup stop was not checked against this symbol's price band.`,
          },
          `${symbol}: `,
        ),
        true,
      );
      continue;
    }

    // Deliberately AHEAD of the price gate below: the band check reads the
    // symbol's filters and the profile's own settings, and nothing else. A
    // freshly bound symbol for which nothing is streaming yet has no cached price,
    // which is the common case on the one route where this warning matters most.
    //
    // Host-minted from the plugin's NUMBERS, never from plugin prose, so it can
    // ride back on the mutation body. Fails open on its own: no band published,
    // an unreadable multiplier, or a profile resting no stop yields nothing.
    const bandWarning = protectiveStopBandWarning({
      settings: bandSettings,
      band: info.filters.percentPriceBySide,
      trailing: info.filters.trailingDelta,
    });
    if (bandWarning) mint(toWireDiagnostic(bandWarning, `${symbol}: `), true);

    const ticker = tickerRaw ? safeJson(TickerSnapshot, tickerRaw) : null;
    if (!ticker) {
      // Neither wording reads as a fault, because neither is one. The two
      // callers hit this for different reasons, and the flag that decides who
      // hears about it already says which caller is asking, so it selects the
      // copy too. On a bind the operator has just added a symbol nothing is
      // tracking; on the settings screen they are editing a profile that is not
      // running.
      const reason = opts.reportMissingPrice
        ? `No ${exchangeLabel} price is cached for this symbol yet — a price is kept only while some profile is tracking that symbol`
        : `No current ${exchangeLabel} price for this profile yet — prices stream while a profile is running`;
      if (check) {
        mint(
          toWireDiagnostic(
            {
              level: 'warn',
              code: 'price-unavailable',
              message: `${reason}, so order sizing was not verified.`,
            },
            `${symbol}: `,
          ),
          Boolean(opts.reportMissingPrice),
        );
      }
      continue;
    }

    const availableQuote = resolveAvailableQuote(
      opts,
      accInfo,
      info,
      ledgerBySymbol.get(symbol) ?? null,
    );
    const orderInput = {
      config,
      filters: info.filters,
      price: ticker.price,
      ...(availableQuote !== undefined ? { availableQuote } : {}),
    };
    // Plugin output: never `mint`. The settings-lint surface is a read the
    // operator asked for, and echoing their own strategy's words back to them
    // is its whole purpose. A mutation success body is a different thing: it is
    // the record of what was written, so it carries only findings the host
    // itself minted and can vouch for.
    if (check) {
      for (const d of check(orderInput)) all.push(toWireDiagnostic(d, `${symbol}: `));
    }
  }
  return { all, hostMinted };
};

/**
 * Every per-symbol finding for a config, host-minted and plugin-supplied alike,
 * for the settings-lint surface that shows the operator the full picture.
 */
export const orderFeasibilityDiagnostics = async (
  di: DI,
  p: ProfileRepo,
  strategy: AnyStrategy,
  config: unknown,
  opts: FeasibilityOptions,
): Promise<ConfigDiagnostic[]> => (await runFeasibility(di, p, strategy, config, opts)).all;

/**
 * Enforce order feasibility at a mutation boundary: run the per-symbol check and
 * throw `VALIDATION_FAILED` (a 422) when any `block` diagnostic is found, so a
 * config that cannot place a valid order or fund its grid is rejected rather than
 * saved. Advisory `warn` / `info` findings never block a save — including the
 * `filters-unavailable` / `price-unavailable` warns, so a stale market-data cache
 * reports itself without rejecting an otherwise valid edit.
 *
 * Returns the host-minted findings (see {@link SplitDiagnostics}) so the caller
 * can hand them to the operator alongside the saved row. Passing feasibility
 * silently used to be indistinguishable from being unable to check it at all.
 */
export const assertOrderFeasible = async (
  di: DI,
  p: ProfileRepo,
  strategy: AnyStrategy,
  config: unknown,
  opts: FeasibilityOptions,
): Promise<ConfigDiagnostic[]> => {
  const { all, hostMinted } = await runFeasibility(di, p, strategy, config, opts);
  const blocks = all.filter((d) => d.level === 'block');
  if (blocks.length > 0) {
    throw new HttpError('VALIDATION_FAILED', blocks.map((b) => b.message).join(' '), blocks);
  }
  return hostMinted;
};

/**
 * {@link assertOrderFeasible} for a profile whose strategy + raw config still
 * need resolving. Looks up the live strategy, schema-parses `rawConfig`, and runs
 * the check, so a mutation route enforces feasibility in a single call instead of
 * repeating the resolve + parse prelude.
 *
 * An unknown strategy or a config that no longer parses leaves nothing to size
 * against, so the check cannot run. That returns a `config-unverified` warn
 * rather than nothing: skipping silently made the least-checked mutation in the
 * system look exactly like the most-checked one.
 */
export const assertOrderFeasibleForProfile = async (
  di: DI,
  p: ProfileRepo,
  profile: {
    readonly strategyName: string;
    readonly strategyVersion: string;
  },
  rawConfig: unknown,
  binanceMode: BinanceMode,
  opts: Omit<FeasibilityOptions, 'mode'> = {},
): Promise<ConfigDiagnostic[]> => {
  const resolved = di.strategies.describeForProfile(profile.strategyName, profile.strategyVersion);
  if (resolved.status === 'unknown') return [configUnverified()];
  const parsed = resolved.strategy.configSchema.safeParse(rawConfig);
  if (!parsed.success) return [configUnverified()];
  // Mode is an explicit REQUIRED argument, read by the caller from the account
  // row. It used to be inferred from a `binanceMode` field on the profile
  // argument, but that column lives on `accounts`, not `profiles` — the field was
  // always `undefined`, so every caller silently validated a testnet profile
  // against PRODUCTION tickSize / lot filters. A required positional cannot be
  // forgotten the way an optional duck-typed field can.
  return assertOrderFeasible(di, p, resolved.strategy, parsed.data, {
    ...opts,
    mode: binanceMode,
  });
};
