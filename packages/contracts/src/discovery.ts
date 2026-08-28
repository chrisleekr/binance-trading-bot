import { z } from 'zod';
import { FeeBasis } from './archive.js';
import { ClosedTradesPeriod } from './dashboard.js';
import { asDecimalString, decimalString, DecimalString } from './decimal.js';
import { EntryBlockerResponse } from './entry-blocker.js';

/**
 * Profile-scoped auto-discovery configuration, stored in the
 * `profiles.discovery_config` jsonb column (NOT in the strategy config blob —
 * discovery is strategy-agnostic, invariant #1). Strategy-free, so it lives in
 * `@app/contracts`. The field set is a superset of the pure-chain
 * `DiscoveryConfig` (`@app/discovery`): it adds `enabled` and `refreshPeriodMs`,
 * which gate and pace the cron rather than the filter chain. Seed defaults are
 * the balanced posture ratified for discovery; the backtest gate tunes them.
 */

// Re-parse the schema's own defaults so an absent block yields a fully-shaped
// object (mirrors the strategy schemas' `withParsedDefault`).
const withParsedDefault = <T extends z.ZodTypeAny>(schema: T): z.ZodDefault<T> =>
  schema.default(() => schema.parse({}) as never);

const TrendConfirmSchema = withParsedDefault(
  z.object({
    adxPeriod: z.number().int().min(2).max(100).default(14).describe('ADX lookback in candles.'),
    adxMin: decimalString('adxMin must be a non-negative decimal', { gte: 0 })
      .default('25')
      .describe('@ui:decimal Minimum ADX for a confirmed trend. 25 is TradingView "trending".'),
    emaPeriod: z
      .number()
      .int()
      .min(2)
      .max(400)
      .default(20)
      .describe('EMA lookback for the price-above-trend check.'),
    volSmaPeriod: z
      .number()
      .int()
      .min(2)
      .max(400)
      .default(20)
      .describe('Volume-SMA lookback for the participation check.'),
    volMultiple: decimalString('volMultiple must be a positive decimal', { gt: 0 })
      .default('1.5')
      .describe('@ui:decimal Last volume must exceed this multiple of the volume SMA.'),
  }),
);

// Anti-chase entry guards (default-off). They only bite an `enterOnAdd`
// discovery entry: the cron captures the symbol's 24h high at add time and
// threads these knobs through the entry-hint bundle, so the strategy can refuse
// to buy a coin that already ran (chase guard) or is still falling (knife
// guard). Each knob defaults to the "off" sentinel ('0' / 0), so an absent block
// leaves every entry untouched.
const EntryGuardSchema = withParsedDefault(
  z.object({
    maxDistanceFrom24hHighPercent: decimalString(
      'maxDistanceFrom24hHighPercent must be a non-negative decimal',
      { gte: 0 },
    )
      .default('0')
      .describe(
        '@ui:percentage Skip a discovery entry while price is within this percent of the 24h high, so the bot does not chase a coin that already ran. 0 turns the guard off.',
      ),
    knifeCandles: z
      .number()
      .int()
      .min(0)
      .max(50)
      .default(0)
      .describe(
        'Skip a discovery entry while the last N closed candles are still falling (catching a falling knife). 0 turns the guard off.',
      ),
    knifeDropPercent: decimalString('knifeDropPercent must be a non-negative decimal', { gte: 0 })
      .default('0')
      .describe(
        '@ui:percentage Minimum total drop across the knifeCandles window needed to block the entry. 0 turns the guard off.',
      ),
  }),
);

// Correlation cap on NEW discovery adds (default-off). When enabled, a candidate
// whose recent-return correlation with any already-held/added symbol is at or
// above `maxPairwise` is skipped, so the auto-set is not one beta factor (e.g.
// ten alts that all track BTC) held many times. Negative correlation is never
// capped — it diversifies. Absent/disabled leaves the add-loop byte-identical.
const CorrelationSchema = withParsedDefault(
  z.object({
    maxPairwise: decimalString('maxPairwise must be a decimal in [0, 1]', { gte: 0, lte: 1 })
      .default('0')
      .describe(
        '@ui:decimal Max return correlation (0–1) a NEW coin may have with one already held; a more-correlated candidate is skipped so the auto-set is not one beta factor held many times. Lower is stricter; 0.8 blocks near-clones. 0 turns the cap off.',
      ),
    lookbackCandles: z
      .number()
      .int()
      .min(5)
      .max(200)
      .default(30)
      .describe('How many recent candles the correlation is measured over.'),
  }),
);

export const DiscoveryConfigSchema = withParsedDefault(
  z
    .object({
      enabled: z
        .boolean()
        .default(false)
        .describe('Master switch. When off, discovery never touches the symbol set.'),
      refreshPeriodMs: z
        .number()
        .int()
        .min(60_000)
        .max(86_400_000)
        .default(900_000)
        .describe('How often the discovery scan runs, in ms. 900000 is 15 minutes.'),
      blacklist: z.array(z.string()).default([]).describe('Symbols discovery must never auto-add.'),
      min24hPairVolumeUsd: decimalString('min24hPairVolumeUsd must be a positive decimal', {
        gt: 0,
      })
        .default('500000')
        .describe(
          '@ui:price Can the bot get in and out? The 24h trading volume of the exact market it would buy on, in US dollars. Set this low: a coin can be hugely popular overall while its market against your quote asset is quiet. Slippage costs dollars no matter which coin you settle in, so this floor is always in dollars.',
        ),
      min24hAssetVolumeUsd: decimalString('min24hAssetVolumeUsd must be a positive decimal', {
        gt: 0,
      })
        .default('50000000')
        .describe(
          '@ui:price Is the coin actually alive? The coin\'s total 24h trading volume on its main US-dollar market, whatever quote asset you happen to trade it against. This is the "no dead microcaps" floor, so set it high.',
        ),
      maxSpreadRatio: decimalString('maxSpreadRatio must be a positive decimal', { gt: 0 })
        .default('0.003')
        .describe('@ui:percent-of Max bid/ask spread as a fraction of mid. 0.003 is 0.3 percent.'),
      changeMinPercent: decimalString('changeMinPercent must be a decimal')
        .default('0')
        .describe(
          '@ui:decimal Minimum 24h gain against your quote asset, in percent. 0 means "the coin must simply beat the asset you hold when you are not in a trade" — the one setting here that means the same thing no matter which quote asset you pick. A higher number is a deliberate hurdle, and how hard it is to clear depends on the quote asset.',
        ),
      rankTopPercent: z
        .number()
        .int()
        .min(1)
        .max(100)
        .default(30)
        .describe(
          'Only consider coins in the top slice of all coins on your quote asset, ranked by 24h gain. 30 means the top 30 percent. Using a rank instead of a fixed percentage is what keeps discovery working when you switch quote asset.',
        ),
      rankExcludeTopPercent: z
        .number()
        .int()
        .min(0)
        .max(99)
        .default(5)
        .describe(
          'Skip the very hottest coins, which have usually already run. 5 means ignore the top 5 percent of gainers. Must be smaller than the top-percent setting. 0 skips nothing.',
        ),
      minAgeDays: z
        .number()
        .int()
        .min(1)
        // Capped at 40: the cron approximates age from the oldest candle of the
        // same 1h kline window it fetches for trend-confirm, and Binance caps a
        // klines request at 1000 candles (~41.6 days of 1h bars). A higher floor
        // could never be satisfied by that window and would silently reject every
        // symbol. A coarser daily age-probe would lift this; not needed for v1.
        .max(40)
        .default(30)
        .describe(
          'Minimum kline-history age before a symbol is eligible (max 40, see schema note).',
        ),
      maxAutoSymbols: z
        .number()
        .int()
        .min(1)
        .max(50)
        .default(5)
        .describe('Cap on concurrently auto-held symbols.'),
      minHoldMinutes: z
        .number()
        .int()
        .min(1)
        .max(43_200)
        .default(120)
        .describe('Min hold before reap AND re-add cooldown, in minutes.'),
      marketBreadthMinPercent: decimalString(
        'marketBreadthMinPercent must be a non-negative decimal',
        {
          gte: 0,
        },
      )
        .default('0')
        .describe(
          '@ui:decimal Risk-off guard. Before discovery adds any NEW coin this cycle, at least this percent of all coins in your quote asset must be up over the last 24h. If fewer are up the broad market is bleeding, so no new coins are added (coins you already hold are not touched). 0 turns the guard off.',
        ),
      enterOnAdd: z
        .boolean()
        .default(false)
        .describe(
          'Enter on a discovery add. Off (default): a freshly added coin still waits for the strategy buy gate, so a confirmed up-move can sit unbought if the short-interval signal disagrees. On: the first entry skips short-interval confirmation and buys on the 1h momentum discovery already confirmed; the only downside guard left is a Strong-Sell reading. Higher risk, so leave off until a net-of-cost backtest justifies it.',
        ),
      entryGuard: EntryGuardSchema,
      trendConfirm: TrendConfirmSchema,
      correlation: CorrelationSchema,
    })
    // An inverted rank band would reject every candidate and read as "discovery
    // is broken" rather than "your band is empty". `z.toJSONSchema` drops checks,
    // so AutoForm cannot enforce this client-side; the PATCH route rejects it.
    .refine((c) => c.rankExcludeTopPercent < c.rankTopPercent, {
      message: 'rankExcludeTopPercent must be less than rankTopPercent',
      path: ['rankExcludeTopPercent'],
    }),
);

/** Stored shape of the discovery config (superset of the pure-chain config). */
export type StoredDiscoveryConfig = z.infer<typeof DiscoveryConfigSchema>;

/**
 * The "is it working" half of the operator dashboard: realized PnL attributed
 * to `source='auto'` archives (all-time and rolling-7-day) plus win rate.
 * `realizedProfit` is the Recorded cost-basis result; `netProfit` subtracts the additional quote adjustment. How far the Net fields can be trusted is what the matching fee tier says; the all-time and 7-day windows carry their own, because a window that happens to hold only proven cycles is proven whatever the other one holds.
 */
export const DiscoveryScoreboard = z.object({
  realizedProfit: DecimalString,
  realizedProfitPercent: DecimalString,
  totalFees: DecimalString.default(asDecimalString('0')),
  netProfit: DecimalString.default(asDecimalString('0')),
  feeBasis: FeeBasis.default('unknown'),
  tradeCount: z.number().int().nonnegative(),
  /** Fraction of auto trades that closed NET-positive, 0..1; 0 when no trades. */
  winRate: z.number().min(0).max(1),
  realizedProfit7d: DecimalString,
  netProfit7d: DecimalString.default(asDecimalString('0')),
  feeBasis7d: FeeBasis.default('unknown'),
  tradeCount7d: z.number().int().nonnegative(),
});
export type DiscoveryScoreboard = z.infer<typeof DiscoveryScoreboard>;

/**
 * One source's slice of the period-ranged scoreboard (discovery=`auto` vs
 * `manual`). Carries the raw win/loss counts and gross win/loss magnitudes so
 * the web layer derives win% and profit factor with the same helpers the
 * trade-archive page uses — the ratios are display-only, the money stays a
 * decimal string. `realizedProfit` is the signed Recorded result; `netProfit` subtracts `totalFees` (the additional quote adjustment). `wins`/`losses` and `grossProfit`/`grossLoss` classify the known Net subtotal, and `feeBasis` says how far that classification can be trusted. No `quoteAsset`: a profile trades one quote, surfaced once by the strip.
 */
export const ScoreboardSourceRollup = z.object({
  source: z.string(),
  realizedProfit: DecimalString,
  totalFees: DecimalString.default(asDecimalString('0')),
  netProfit: DecimalString.default(asDecimalString('0')),
  feeBasis: FeeBasis.default('unknown'),
  tradeCount: z.number().int().nonnegative(),
  wins: z.number().int().nonnegative(),
  losses: z.number().int().nonnegative(),
  grossProfit: DecimalString,
  grossLoss: DecimalString,
});
export type ScoreboardSourceRollup = z.infer<typeof ScoreboardSourceRollup>;

/**
 * Period-ranged discovery scoreboard — the subset of {@link DiscoveryScoreboard}
 * that is meaningfully filterable by a past time window (the trade-archive
 * aggregates). Backs the Home KPI strip's D/W/M/All toggle. The top-level
 * realised/win-rate fields stay attributed to `auto` (discovery) so the existing
 * cells are unchanged; `bySource` adds the auto-vs-manual breakdown the strip's
 * by-source band renders. `from`/`to` are echoed back like
 * {@link ClosedTradesResponse}. The gauge cards (deployed cost, exposure cap,
 * holdings, auto-symbol count) are point-in-time "now" values with no historical
 * series, so they are not part of this and stay live regardless of the period.
 */
export const DiscoveryScoreboardResponse = z.object({
  period: ClosedTradesPeriod,
  tz: z.string(),
  from: z.iso.datetime(),
  to: z.iso.datetime(),
  realizedProfit: DecimalString,
  realizedProfitPercent: DecimalString,
  totalFees: DecimalString.default(asDecimalString('0')),
  netProfit: DecimalString.default(asDecimalString('0')),
  feeBasis: FeeBasis.default('unknown'),
  tradeCount: z.number().int().nonnegative(),
  /** Fraction of auto trades that closed NET-positive in the window, 0..1; 0 when none. */
  winRate: z.number().min(0).max(1),
  /** Per-source slices (auto, manual) for the window; deterministic by source. */
  bySource: z.array(ScoreboardSourceRollup).default([]),
});
export type DiscoveryScoreboardResponse = z.infer<typeof DiscoveryScoreboardResponse>;

/** Exposure gauge: account-wide deployed cost basis vs the configured cap. */
export const DiscoveryGauge = z.object({
  deployedQuote: DecimalString,
  maxAccountExposureQuote: DecimalString.nullable(),
  autoSymbolCount: z.number().int().nonnegative(),
});
export type DiscoveryGauge = z.infer<typeof DiscoveryGauge>;

/** Filter-chain stage names; mirrors `@app/discovery`'s `DiscoveryFilterName`. */
export const DiscoveryFilterName = z.enum([
  'quote',
  'assetPolicy',
  'blacklist',
  'liquidity',
  'activity',
  'spread',
  'changeBand',
  'age',
  'trend',
]);
export type DiscoveryFilterName = z.infer<typeof DiscoveryFilterName>;

/** What the cycle did with a candidate; mirrors `@app/discovery`'s `DiscoveryDisposition`. */
export const DiscoveryDisposition = z.enum([
  'added',
  'kept',
  'faded-held',
  'faded-removed',
  'cooldown',
  'slot-capped',
  'correlation-high',
  'sibling-owns-base',
  'sibling-quotes-base',
  'rejected',
]);
export type DiscoveryDisposition = z.infer<typeof DiscoveryDisposition>;

/**
 * One live-universe candidate row: why a symbol is in or out of the auto-set
 * this cycle. `gainerScore` is null for a held symbol that vanished from the
 * ticker feed (then `passed` is empty and `failedAt` null; `disposition` is the
 * reason).
 */
export const DiscoveryCandidate = z.object({
  symbol: z.string(),
  gainerScore: DecimalString.nullable(),
  passed: z.array(DiscoveryFilterName),
  failedAt: DiscoveryFilterName.nullable(),
  disposition: DiscoveryDisposition,
  // Why this auto pick isn't entering, glossed in the dashboard. Read server-side
  // from persisted strategy state. `.default(null)` so the Redis snapshot the cron
  // writes WITHOUT this key (DiscoveryUniverse reuses this schema for both the
  // snapshot and the API response, and `.parse()` strips unknown keys) parses to
  // `null` rather than failing.
  entryBlocker: EntryBlockerResponse.default(null),
});
export type DiscoveryCandidate = z.infer<typeof DiscoveryCandidate>;

/** The latest persisted universe snapshot: when the scan ran + its candidates. */
export const DiscoveryUniverse = z.object({
  computedAtMs: z.number().int().nonnegative(),
  candidates: z.array(DiscoveryCandidate),
});
export type DiscoveryUniverse = z.infer<typeof DiscoveryUniverse>;

/**
 * Per-auto-symbol position state, so the dashboard can show whether a coin
 * discovery added is actually HOLDING a position or just SUBSCRIBED-and-waiting
 * for the strategy's entry conditions. Discovery only adds a symbol to the
 * trading set; the profile's own buy gate decides if it ever buys, and the two
 * signals (discovery's 1h trend vs the buy gate) can disagree; without this an
 * auto symbol that never enters reads as "working". A symbol with no cost-basis
 * row is flat (waiting); a row with quantity > 0 is holding, and
 * `quoteCostBasis` is its deployed cost basis (`avgEntryPrice × quantity`),
 * computed server-side to keep money math off the `number`-only web boundary.
 */
export const DiscoveryHolding = z.object({
  symbol: z.string(),
  quantity: DecimalString,
  avgEntryPrice: DecimalString,
  quoteCostBasis: DecimalString,
});
export type DiscoveryHolding = z.infer<typeof DiscoveryHolding>;

/** One discovery activity-feed entry, projected from a discovery `action_log` row. */
export const DiscoveryActivityEntry = z.object({
  time: z.string(),
  symbol: z.string(),
  action: z.enum(['add', 'remove']),
  msg: z.string(),
});
export type DiscoveryActivityEntry = z.infer<typeof DiscoveryActivityEntry>;

/**
 * Body for `POST /profiles/:id/symbols/:symbol/force-eject`: sell the position
 * to cash and engage the re-add cooldown; `blocklist:true` also blacklists the
 * symbol so discovery never rotates it back in.
 */
export const ForceEjectRequest = z.object({
  blocklist: z.boolean().default(false),
});
export type ForceEjectRequest = z.infer<typeof ForceEjectRequest>;

/** Response for `GET /profiles/:id/discovery` — the operator dashboard payload. */
export const DiscoveryDashboardResponse = z.object({
  config: DiscoveryConfigSchema,
  // True when the stored discovery_config failed schema validation (e.g. an
  // out-of-band DB edit wrote an out-of-range value). The API then returns safe
  // defaults with `enabled:false` so the dashboard still renders; the cron
  // independently treats the bad config as disabled. The flag lets the UI warn
  // that the saved settings are NOT applied until the operator re-saves, instead
  // of silently presenting defaults as if they were the real config.
  configInvalid: z.boolean().default(false),
  // The profile's trading quote currency (e.g. USDT, BTC). Now a first-class
  // profile column, not part of the discovery config; surfaced here so the
  // dashboard labels cost-basis amounts in the right unit.
  quoteAsset: z.string(),
  scoreboard: DiscoveryScoreboard,
  gauge: DiscoveryGauge,
  // null when discovery has never scanned this profile (no snapshot persisted).
  universe: DiscoveryUniverse.nullable().default(null),
  // Cost-basis rows for auto symbols that currently HOLD a position; an auto
  // symbol absent here is subscribed-but-flat (waiting for the buy gate).
  holdings: z.array(DiscoveryHolding).default([]),
  // The LIVE auto-symbol set right now (source='auto' in profile_symbols). The
  // universe is a frozen snapshot of the last cron scan, so an operator action
  // (pin / eject / remove) is invisible there until the next scan; the dashboard
  // reconciles each universe row against this live set so a row's controls and
  // held/waiting status reflect the action immediately, not the stale scan.
  autoSymbols: z.array(z.string()).default([]),
  activity: z.array(DiscoveryActivityEntry).default([]),
});
export type DiscoveryDashboardResponse = z.infer<typeof DiscoveryDashboardResponse>;
