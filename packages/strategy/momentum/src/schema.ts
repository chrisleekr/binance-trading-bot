import { z } from 'zod';
import { decimalString, ManualOverridePayload } from '@app/contracts';
import { Decimal } from '@app/money';

/**
 * Candle intervals this strategy supports. The worker subscribes to the
 * profile's `config.candleInterval` (read by literal key, strategy-agnostic);
 * the enum here is the operator-pickable subset and the single source for both
 * {@link MomentumConfigSchema.candleInterval} and
 * {@link Strategy.capabilities.candleIntervals}.
 */
export const MOMENTUM_CANDLE_INTERVALS = ['1m', '5m', '15m', '30m', '1h', '4h', '1d'] as const;

const MOMENTUM_DEFAULT_INTERVAL = '1h' as const;

/**
 * Fast/slow EMA periods. Nested so a cross-field refinement (`fast < slow`)
 * can live here while the top-level {@link MomentumConfigSchema} stays a plain
 * `ZodObject` — the contract requires `configSchema` to be object-rooted for
 * the API's JSON-Schema form generation, and a top-level `.superRefine` would
 * turn it into a `ZodEffects`.
 */
const MomentumEmaSchema = z
  .object({
    fast: z
      .number()
      .int()
      .min(1)
      .describe('Fast EMA period, in candles. Must be shorter than the slow period.'),
    slow: z
      .number()
      .int()
      .min(2)
      .describe('Slow EMA period, in candles. Must be longer than the fast period.'),
  })
  .superRefine((val, ctx) => {
    if (val.fast >= val.slow) {
      ctx.addIssue({
        code: 'custom',
        path: ['fast'],
        message: 'fast EMA period must be below the slow EMA period',
      });
    }
  });

/**
 * Exchange-side protective stop: a resting STOP_LOSS_LIMIT SELL mirroring the
 * in-process trailing stop so an open long survives a worker outage or a gap
 * between candle evaluations (acute on the 1d interval, a 24h blind window).
 * Optional so the live worker, which reads stored config WITHOUT schema-parsing,
 * treats an absent block as disabled via optional chaining.
 */
const MomentumProtectiveStopSchema = z.object({
  enabled: z
    .boolean()
    .default(false)
    .describe('Rest a STOP_LOSS_LIMIT on the exchange that tracks the trailing-stop level.'),
  // Limit price as a fraction of the stop trigger, so a triggered stop crosses
  // the book and fills. 0.98 places the limit 2% below the trigger.
  limitOffsetPercentage: decimalString('limitOffsetPercentage must be in (0, 1)', {
    gt: 0,
    lt: 1,
  })
    .default('0.98')
    .describe('@ui:percent-of Limit price as a fraction of the stop trigger (0.98 = 2% below).'),
  // How far the computed trigger must move before the resting order is cancelled
  // and re-placed. This is the ONLY knob that bounds order spend in a market that
  // keeps grinding upward, so it matters more once the profit trail advances the
  // level intraday. Defaults to the core constant, so this leaf alone changes
  // nothing.
  minRearmDriftPct: decimalString('minRearmDriftPct must be in (0, 1)', { gt: 0, lt: 1 })
    .default('0.001')
    .describe(
      '@ui:percent-of How far the stop level must move before the order held at Binance is rewritten. Higher means fewer orders sent, at the cost of the resting order lagging the in-app stop by up to this much. 0.1 rewrites on every tenth of a percent.',
    ),
});

/**
 * Macro trend filter gating ENTRY. When enabled, a fresh long opens only while
 * price trades above a long-term moving average, so the strategy sits out a
 * confirmed downtrend instead of getting whipsawed by false EMA cross-ups on
 * bear rallies (the momentum engine's main failure mode). Exit logic is
 * untouched: the trailing stop and EMA cross-down still manage an open long.
 * The line is computed on the strategy's own `candleInterval`, so it is sized
 * for a daily-ish interval (period 200 on `1d` is the classic macro trend).
 * Optional so the live worker, which reads stored config WITHOUT schema-parsing,
 * treats an absent block as disabled via optional chaining.
 */
const MomentumTrendFilterSchema = z.object({
  enabled: z
    .boolean()
    .default(false)
    .describe(
      'Only enter while price is above the long-term trend line, so the bot sits out confirmed downtrends instead of buying into them. Exits are unaffected.',
    ),
  maType: z
    .enum(['sma', 'ema'])
    .default('sma')
    .describe('Moving-average type for the long-term trend line.'),
  period: z
    .number()
    .int()
    .min(2)
    .max(400)
    .default(200)
    .describe(
      'Trend-line lookback in candles, on the strategy candle interval. 200 on a daily interval is the classic macro trend; a shorter period reacts faster.',
    ),
  // Slope veto. Price-above-line alone cannot tell an early bull (price below a
  // lagging slow line while a new uptrend starts) from a bear rally (price pops
  // above a fast line that is still falling). Requiring the line itself to rise
  // lets a faster `period` catch the early bull while the slope rejects rallies
  // on a still-declining line. Off keeps the simpler price-only gate.
  requireRising: z
    .boolean()
    .default(false)
    .describe(
      'Also require the trend line itself to be rising, not just price above it. This rejects entries on bear rallies that pop above a line that is still falling. Off keeps the simpler price-above-line gate.',
    ),
  slopeLookbackBars: z
    .number()
    .int()
    .min(1)
    .max(200)
    .default(10)
    .describe(
      'When "require rising" is on, how many candles back to measure the slope. The trend line must sit higher now than this many candles ago. Only used when "require rising" is on.',
    ),
});

/**
 * Entry overextension guard. The trend filter is a FLOOR (enter only above the
 * line); this is the CEILING (skip an entry while price sits too far above its
 * baseline). A lagging EMA cross confirms late on a fast mover, so by the time
 * it fires the coin can be far above trend and near exhaustion — the failure
 * mode behind momentum's stopped-out blow-off entries. On by default (via the
 * create-profile seed) with a wide ceiling so only egregious stretch is
 * rejected. The baseline is computed on the strategy's own `candleInterval`.
 * Optional so the live worker, which reads stored config WITHOUT schema-parsing,
 * treats an absent block as disabled via optional chaining; a present block with
 * `enabled` omitted is off (fail-safe).
 */
const MomentumEntryExtensionSchema = z.object({
  enabled: z
    .boolean()
    .default(false)
    .describe(
      'Skip an entry while price is stretched too far above its baseline trend line, so the bot does not buy into an overextended blow-off. Exits are unaffected.',
    ),
  maType: z
    .enum(['sma', 'ema'])
    .default('sma')
    .describe('Moving-average type for the baseline the stretch is measured from.'),
  period: z
    .number()
    .int()
    .min(2)
    .max(400)
    .default(50)
    .describe(
      'Baseline lookback in candles, on the strategy candle interval. 50 on a daily interval is a common medium-term baseline.',
    ),
  maxPercent: decimalString('maxPercent must be a positive decimal', { gt: 0 })
    .default('0.4')
    .describe(
      '@ui:percent-of How far above the baseline price may sit and still enter. 40 means skip an entry while price is more than 40% above the baseline line.',
    ),
});

/**
 * Volatility-scaled trailing stop. When enabled, the trail sits `multiple × ATR`
 * below the high since entry (a chandelier exit) instead of the fixed
 * `trailingStopPct` fraction, so the stop auto-widens for a volatile coin and
 * tightens for a calm one — one setting adapts to every symbol's volatility,
 * where a fixed fraction is mistuned for most of a varied discovery universe.
 * The in-process trail and the resting protective stop both read this same
 * level, so they never diverge. Off by default (the fixed fraction is unchanged
 * and golden replays stay byte-identical); when the window is too short to
 * compute ATR the trail falls back to the fixed fraction. Optional so the live
 * worker, reading config unparsed, treats an absent block as disabled.
 */
const MomentumAtrTrailingStopSchema = z.object({
  enabled: z
    .boolean()
    .default(false)
    .describe(
      'Scale the trailing stop to the coin’s own volatility (ATR) instead of a fixed percent, so a volatile coin gets a wider stop and a calm one a tighter stop. Unlike the fixed percent, this stop can also move DOWN when volatility spikes (it is not a one-way ratchet), giving a volatile move room rather than shaking you out.',
    ),
  period: z
    .number()
    .int()
    .min(2)
    .max(100)
    .default(14)
    .describe('ATR lookback in candles, on the strategy candle interval.'),
  multiple: decimalString('multiple must be a positive decimal', { gt: 0 })
    .default('3')
    .describe(
      'How many ATRs below the peak the stop sits. 3 means sell when price falls 3 ATRs from the high reached since entry.',
    ),
});

/**
 * Profit-side ratchet: a SECOND trailing stop that exists only above entry.
 *
 * The hard stop's high-water mark advances on the TRADING interval's closed
 * candle, so on a 1d profile an intraday run is unprotected until the next daily
 * close. This leg advances instead on closed 1m candles (fed for every symbol
 * regardless of `candleInterval`) folded into N-minute buckets. The effective
 * stop is `max(hard, profit)`, so it can only ever tighten protection, and a
 * trade that never clears the activation threshold behaves exactly as before.
 *
 * `ratchetMinutes` is the order-spend lever: the level cannot move more than
 * once per bucket, so the resting order cannot be rewritten more often than
 * that either.
 *
 * Optional so the live worker, which reads stored config WITHOUT schema-parsing,
 * reads an absent block as disabled via optional chaining.
 */
const MomentumProfitTrailSchema = z
  .object({
    enabled: z
      .boolean()
      .default(false)
      .describe(
        'Once a trade is far enough in profit, follow the price up and sell on a small pullback, locking the gain in. Below your entry price nothing changes: your normal trailing stop still does the work.',
      ),
    activationPct: decimalString('activationPct must be in (0, 1)', { gt: 0, lt: 1 })
      .default('0.05')
      .describe(
        '@ui:percent-of How far in profit the trade must get before the fast trail switches on. 5 means it starts following once you are 5% up.',
      ),
    trailPct: decimalString('trailPct must be in (0, 1)', { gt: 0, lt: 1 })
      .default('0.03')
      .describe(
        '@ui:percent-of How far price may fall back from its peak before the fast trail sells. 3 means sell on a 3% pullback. It must be enough below the activation that the sale still lands above your entry: the pullback comes off the higher arming price, so it costs more than the activation gained. With a 5% activation the largest value accepted is a little under 4.8%.',
      ),
    ratchetMinutes: z
      .number()
      .int()
      .min(1)
      .max(60)
      .default(5)
      .describe(
        'How often the profit trail moves up, in minutes. Only a 1-minute close that lands on this grid can raise it. This paces the profit trail and nothing else: your normal trailing stop still moves on your candle interval, so the stop order held at Binance can be rewritten more often than this whenever the normal stop is the higher of the two. The sell check itself runs every tick, so a fall through the current level is caught immediately. Lower reacts faster and sends more orders; 5 is a good balance.',
      ),
  })
  .superRefine((v, ctx) => {
    // Below entry the trail must never arm, or it could sell at a loss. Once
    // armed the stop sits at `entry x (1 + act) x (1 - trail)`, which clears
    // entry only while `trail < act / (1 + act)` — the pullback is taken off
    // the HIGHER arming price, so it costs more than `act` gained. The naive
    // `trail < act` admits a sliver above that bound where the stop computes
    // below entry and the `Decimal.max(entryPrice, ...)` floor pins it exactly
    // AT entry: a break-even gross sale, a loss once fees are paid, and not
    // what the field text promises.
    const act = new Decimal(v.activationPct);
    if (new Decimal(v.trailPct).gte(act.div(act.plus(1)))) {
      ctx.addIssue({
        code: 'custom',
        path: ['trailPct'],
        message:
          'trailPct must be below activationPct / (1 + activationPct), or the armed trail sits at or below entry',
      });
    }
  });

/**
 * Entry sizing: a fixed quote amount per buy, or a percent of account equity.
 * Modeled as an object so the operator picks exactly one mode in the UI and the
 * unused field stays blank; the worker reads the active field at tick time. The
 * cross-field rule (the chosen mode carries its value) is enforced here on save.
 * The live worker reads config unparsed, so an absent block falls back to a
 * fail-safe skip in `tick()`, not a guess. `percentOfAccount` is a fraction in
 * (0, 1] of equity, where equity = free+locked quote cash + the cost-basis of
 * every open position across the account's profiles in the SAME mode + quote
 * asset (`@app/strategy-core` AccountSnapshot.deployedQuoteAcrossProfiles; the
 * worker scopes the aggregate so a live tick never counts test-mode positions).
 */
const MomentumEntrySizingSchema = z
  .object({
    mode: z
      .enum(['fixed', 'percentOfAccount'])
      .default('fixed')
      .describe('Size each entry by a fixed quote amount or a percent of account equity.'),
    amount: decimalString('amount must be a positive decimal', { gt: 0, allowEmpty: true })
      .default('')
      .describe('@ui:price Quote-asset amount spent on each entry when sizing by fixed amount.'),
    percent: decimalString('percent must be in (0, 1]', { gt: 0, lte: 1, allowEmpty: true })
      .default('')
      .describe(
        '@ui:percent-of Percent of account equity spent on each entry. 10 means 10% of your cash plus the value of coins you hold.',
      ),
  })
  .superRefine((val, ctx) => {
    if (val.mode === 'fixed' && val.amount === '') {
      ctx.addIssue({
        code: 'custom',
        path: ['amount'],
        message: 'amount is required when sizing by fixed amount',
      });
    }
    if (val.mode === 'percentOfAccount' && val.percent === '') {
      ctx.addIssue({
        code: 'custom',
        path: ['percent'],
        message: 'percent is required when sizing by percent of account',
      });
    }
  })
  .describe(
    '@ui:amount-or-percent How much to spend on each buy: a fixed amount, or a percent of account equity (cash + the value of coins you hold).',
  );

/**
 * Reserve cap: the most of the account, by equity, the bot will hold in coins at
 * once, so a crash cannot deploy everything. Off by default. `percentOfAccount`
 * caps total deployed cost-basis (across the account's profiles in the same
 * mode + quote asset) at this fraction of equity; an entry that would breach it
 * is downsized to fit, or held when the
 * account is already at the cap. A coarse backstop, not an exact allocator:
 * concurrent ticks on other symbols read the same deployed snapshot, so the cap
 * can be briefly overshot. Optional so an absent block reads as off in the
 * unparsed worker config.
 */
const MomentumAccountCapSchema = z
  .object({
    mode: z
      .enum(['off', 'percentOfAccount'])
      .default('off')
      .describe('Whether to cap how much of the account is deployed into coins at once.'),
    percent: decimalString('percent must be in (0, 1]', { gt: 0, lte: 1, allowEmpty: true })
      .default('')
      .describe(
        '@ui:percent-of Most of the account, by equity, to hold in coins at once. 50 keeps about half as a cash reserve.',
      ),
  })
  .superRefine((val, ctx) => {
    if (val.mode === 'percentOfAccount' && val.percent === '') {
      ctx.addIssue({
        code: 'custom',
        path: ['percent'],
        message: 'percent is required when the cap is on',
      });
    }
  })
  .describe(
    '@ui:amount-or-percent The most of the account, by equity, to hold in coins at once. The rest stays as a cash reserve. 50 keeps about half in reserve.',
  );

/**
 * Operator-owned momentum configuration. Account-scoped via the surrounding
 * profile. The strategy never reads another profile's state. `symbol` is
 * deliberately absent: the worker resolves traded symbols from the
 * `profile_symbols` table, not from strategy config.
 */
export const MomentumConfigSchema = z.object({
  candleInterval: z
    .enum(MOMENTUM_CANDLE_INTERVALS)
    .default(MOMENTUM_DEFAULT_INTERVAL)
    .describe('Candle interval the strategy reads for its EMA cross.'),
  entrySizing: MomentumEntrySizingSchema,
  // Reserve cap is account-wide, so it is profile-level only (excluded from the
  // per-symbol override below): a per-symbol cap on an account-wide total is
  // meaningless.
  accountCap: MomentumAccountCapSchema.optional(),
  ema: MomentumEmaSchema,
  // Trailing-stop retrace fraction off the high since entry. (0, 1): a sell
  // fires when price falls to `highSinceEntry * (1 - trailingStopPct)`.
  trailingStopPct: decimalString('trailingStopPct must be in (0, 1)', { gt: 0, lt: 1 })
    .default('0.05')
    .describe(
      '@ui:percent-of How far price may fall from its peak before the trailing-stop sells. 5 means sell on a 5% pullback from the high reached since entry. Must be above 0 and below 100.',
    ),
  // Volatility-scaled trailing stop. When enabled, overrides the fixed
  // `trailingStopPct` distance with `multiple × ATR` below the high. Off by
  // default so existing configs and golden replays stay byte-identical.
  atrTrailingStop: MomentumAtrTrailingStopSchema.optional(),
  // Profit-side ratchet layered ON TOP of the hard stop above; the effective
  // level is the max of the two. Off by default so existing configs and golden
  // replays stay byte-identical.
  profitTrail: MomentumProfitTrailSchema.optional(),
  // Entry confirmation band: the fast EMA must clear the slow EMA by this
  // fraction for a cross-up to count, filtering marginal crosses that whipsaw
  // in a chop near the MAs. [0, 1); 0 (or absent) reproduces a bare cross.
  // Optional so a stored config without the field is read as 0.
  entryMarginPct: decimalString('entryMarginPct must be in [0, 1)', { gte: 0, lt: 1 })
    .optional()
    .describe(
      '@ui:percent-of How far the fast EMA must exceed the slow EMA to confirm an entry. 1 means require a 1% margin; 0 enters on a bare cross.',
    ),
  protectiveStop: MomentumProtectiveStopSchema.optional(),
  // Macro trend filter gating entries (exit logic untouched). Off by default so
  // existing configs and golden replays stay byte-identical.
  trendFilter: MomentumTrendFilterSchema.optional(),
  // Entry overextension guard: a CEILING on how far above its baseline price may
  // sit at entry (the trend filter is the floor). Seeded on by the create-profile
  // default; an absent block reads as off in the unparsed worker config, so
  // existing golden replays stay byte-identical.
  entryExtension: MomentumEntryExtensionSchema.optional(),
});
/** Operator-owned configuration that survives restarts and replays; runtime state lives in {@link MomentumState}. */
export type MomentumConfig = z.infer<typeof MomentumConfigSchema>;

/**
 * Per-symbol config override: only the keys that differ from the profile
 * config; the rest inherit. `candleInterval` is excluded (it drives the
 * profile's shared WS subscription, so it cannot vary per symbol) and the root
 * is `.strict()` so passing it is rejected. The `ema` cross-field refinement
 * still fires when the block is present. The API re-checks the merged effective
 * config against {@link MomentumConfigSchema}.
 */
export const MomentumOverrideConfigSchema = z
  .object({
    entrySizing: MomentumConfigSchema.shape.entrySizing,
    ema: MomentumConfigSchema.shape.ema,
    // `.unwrap()` drops the outer `.default()`/`.optional()` so the override is a
    // pure shape gate. The stored override is the RAW body (the API validates but
    // does not persist the parsed, default-filled copy — see routes/symbols.ts),
    // and `mergeConfig` deep-merges that raw object, so a block override carrying
    // only the fields it changes leaves the profile's other fields intact.
    trailingStopPct: MomentumConfigSchema.shape.trailingStopPct.unwrap(),
    entryMarginPct: MomentumConfigSchema.shape.entryMarginPct.unwrap(),
    atrTrailingStop: MomentumConfigSchema.shape.atrTrailingStop.unwrap(),
    profitTrail: MomentumConfigSchema.shape.profitTrail.unwrap(),
    // The signal shape and risk of a discovery-picked altcoin differ from the
    // BTC-tuned profile default, so these gate/exit levers are per-symbol
    // overridable. Each block's leaves default, so a partial override validates;
    // the API re-checks the deep-merged effective config against
    // MomentumConfigSchema. `accountCap` stays excluded: a per-symbol cap on an
    // account-wide total is meaningless.
    trendFilter: MomentumConfigSchema.shape.trendFilter.unwrap(),
    protectiveStop: MomentumConfigSchema.shape.protectiveStop.unwrap(),
    entryExtension: MomentumConfigSchema.shape.entryExtension.unwrap(),
  })
  .partial()
  .strict();
/** Parsed per-symbol override; a partial view of {@link MomentumConfig} the worker deep-merges over the profile config. */
export type MomentumOverrideConfig = z.infer<typeof MomentumOverrideConfigSchema>;

/**
 * Current momentum state-schema version. Shared by the state schema literal
 * and the position adapter's body gate so the two cannot drift (a stale
 * adapter copy would silently no-op every fill / reconcile merge).
 */
export const MOMENTUM_STATE_SCHEMA_VERSION = '1.0.0';

/**
 * Persisted per-(profile, symbol) state. `entryPrice === null` is the flat
 * position; a non-null `entryPrice` is an open long. `schemaVersion` is bumped
 * lock-step with any migration; loaders that see a different version refuse to
 * boot rather than silently mutate a stranger's fields.
 */
export const MomentumStateSchema = z.object({
  schemaVersion: z.literal(MOMENTUM_STATE_SCHEMA_VERSION),
  // Entry price of the open long, or null when flat. Set on the entry emit and
  // reconciled by the fill-adopter; cleared on the exit emit.
  entryPrice: z.string().nullable(),
  // High-water mark of the closed-candle CLOSE since entry; the trailing stop
  // measures the retrace from this. Ratcheted on closed candles only — never on
  // a live intra-candle wick — so a transient spike cannot tighten the stop.
  // Seeded to the entry price on entry; cleared on exit.
  highSinceEntry: z.string().nullable(),
  // High-water mark of the profit trail: the best close among the bucket-end 1m
  // candles seen since entry, floored at the entry price. Separate from
  // `highSinceEntry` because the two ratchet on different clocks — this one
  // intraday, that one on the trading interval — and the effective stop is the
  // max of the levels they produce. Null while the profit trail is disabled or
  // the position is flat. Additive with `.default(null)` so the state schema
  // version can stay put, for the same reason as `lastEntryCandleMs`.
  profitHigh: z.string().nullable().default(null),
  // Authoritative held base-asset quantity for sell sizing. Maintained by the
  // fill-adopter and reconciled against the wallet at boot; null when flat.
  heldQuantity: z.string().nullable(),
  // Close time of the candle whose cross-up opened the last entry; enforces one
  // entry per cross. Stamped at ENTRY, not exit, because an exchange-side
  // protective stop reaches the strategy only as `{kind: 'empty'}`, carrying no
  // timestamp. Survives the exit emit and the fill-adopter's flatten, both of
  // which spread the body. Additive with `.default(null)` so the state schema
  // version can stay put: momentum declares no `migrateState`, and a bump would
  // strand live rows at the old version, silently no-opping the position adapter.
  lastEntryCandleMs: z.number().int().nullable().default(null),
  // Epoch bounding which 1m closes may ratchet the profit trail: the close
  // instant of the newest 1m candle already closed when the position opened.
  // Deliberately NOT `lastEntryCandleMs`, which names the CANDLE the cross fired
  // on: a cross stays live for the rest of that candle, so on a 1h/1d profile an
  // entry held back by a budget skip or a mid-candle restart can land hours after
  // that close. Folding from there would seed the mark with a pre-entry peak the
  // position never held, arm the trail immediately, and sell the position it just
  // opened. Null means the epoch is unknown (a wallet-reconciled position, or an
  // entry taken before any 1m candle closed): fold nothing.
  // Additive with `.default(null)` for the same no-version-bump reason.
  profitTrailSinceMs: z.number().int().nullable().default(null),
  // Why the last tick refused to open a long, or null when it did not (an entry
  // fired, an exit ran, or a plain hold). The generic worker path turns a change
  // in this field into a queryable action_log row, so an operator can see which
  // lever suppressed an entry without reading the tick metrics. `reason` is the
  // stable code the web glosses off `momentumReasonAttribution`; `detail` carries
  // optional structured context. Additive with `.default(null)` for the same
  // no-version-bump reason as `lastEntryCandleMs`.
  entryBlocker: z
    .object({
      reason: z.enum([
        'already-entered-this-candle',
        'insufficient-history',
        'below-trend',
        'falling-trend',
        'overextended',
        'extension-insufficient-history',
        'sizing-unconfigured',
        'cap-reached',
        'min-qty',
        'min-notional',
        'invalid-filters',
      ]),
      detail: z.record(z.string(), z.unknown()).optional(),
    })
    .nullable()
    .default(null),
  // Why the exchange-side protective stop is NOT armed on a held position, or
  // null when it is (or when there is nothing to protect). Distinct from
  // `entryBlocker`: a position can be open and running while its downside
  // protection is refused, which is the more urgent of the two to surface.
  // Additive with `.default(null)`, same no-version-bump reason as above.
  protectiveStopBlocker: z
    .object({
      reason: z.enum([
        'base-locked-by-foreign-order',
        'base-below-exchange-minimum',
        'base-short-of-tracked-position',
        'price-outside-exchange-band',
      ]),
      detail: z.record(z.string(), z.unknown()).optional(),
    })
    .nullable()
    .default(null),
});
/** Mutable per-tick state the strategy writes back. Persisted by the executor; never read by other profiles or accounts. */
export type MomentumState = z.infer<typeof MomentumStateSchema>;

/**
 * Per-tick external inputs. Momentum reads only the operator-override slot (the
 * `override` bundle provider) so an operator can force-sell a held position; the
 * worker's bundle-builder fills it (null = none) and the tick consumes a
 * `trigger-sell`. Reuses the shared {@link ManualOverridePayload} shape.
 *
 * `override` is nullish: absent, null, or a payload all mean the same "no
 * pending override" when missing. The tick reads it through optional chaining,
 * so an assembler that omits the key entirely is as valid as an explicit null.
 */
export const MomentumBundleSchema = z.object({
  override: ManualOverridePayload.nullish(),
});
/** Per-tick bundle: the operator-override slot, absent or null when there is no pending override. */
export type MomentumBundle = z.infer<typeof MomentumBundleSchema>;

/** Initial persisted state for a newly-onboarded profile; flat. */
export const initialMomentumState = (): MomentumState => ({
  schemaVersion: MOMENTUM_STATE_SCHEMA_VERSION,
  entryPrice: null,
  highSinceEntry: null,
  profitHigh: null,
  heldQuantity: null,
  lastEntryCandleMs: null,
  profitTrailSinceMs: null,
  entryBlocker: null,
  protectiveStopBlocker: null,
});

/**
 * Schema-valid seed config the create-profile wizard pre-fills its editor
 * with. Parsed through {@link MomentumConfigSchema} so schema defaults fill the
 * omitted fields and the value is guaranteed to pass server validation.
 */
export const defaultMomentumConfig = (): MomentumConfig =>
  MomentumConfigSchema.parse({
    entrySizing: { mode: 'fixed', amount: '15' },
    ema: { fast: 9, slow: 21 },
    // Protect new profiles by default: the resting stop is the only downside
    // guard if the worker is down or price gaps between candle evaluations.
    protectiveStop: { enabled: true },
    // Guard new profiles against buying an overextended blow-off. The wide 40%
    // default only rejects egregious stretch, not a normal early-trend entry.
    entryExtension: { enabled: true },
  });
