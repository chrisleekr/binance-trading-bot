import { z } from 'zod';
import {
  decimalString,
  isCapArmed,
  readAccountExposureCap,
  intervalsUniquenessRefiner,
  ManualOverridePayload,
  MAX_TECHNICALS_INTERVALS,
  TechnicalsBundleConfigSchema,
  TechnicalsBundleSchema,
  TechnicalsIfExpiresSchema,
  TechnicalsIntervalConfigSchema,
  TECHNICALS_INTERVALS_DESCRIBE,
} from '@app/contracts';
import { resolveForceSellGuards } from './force-sell-guards.js';

/**
 * Wraps an all-defaulted object schema with a self-deriving default: parsing
 * `{}` through the same schema yields the fully-shaped object, so the default
 * is derived from the schema's own field defaults and cannot drift from the
 * field set when a field is added. Zod 4 returns a literal `.default()` value
 * verbatim without re-parsing, so a hand-written default object is a known
 * drift hazard (a missing key ships an under-shaped default); this removes it.
 * The lambda also yields a fresh object per parse, so a downstream mutation
 * never bleeds into the next config.
 */
const withParsedDefault = <T extends z.ZodType>(schema: T): z.ZodDefault<T> =>
  // `parse({})` yields the schema's fully-defaulted output; the `as never`
  // satisfies Zod 4's `NoUndefined<output<T>>` default-callback bound over the
  // generic (these schemas never produce `undefined`).
  schema.default(() => schema.parse({}) as never);

/**
 * Candle intervals this strategy supports. Single source of truth for both
 * {@link TTConfigSchema.candleInterval} (the profile's primary interval) and
 * the Technicals intervals enum below — the operator cannot ask the
 * compute job for an interval the strategy itself cannot consume.
 */
const TT_CANDLE_INTERVALS = ['1m', '5m', '15m', '30m', '1h', '4h', '1d'] as const;

/**
 * Shared default for both {@link TTConfigSchema.candleInterval} and the TT
 * Technicals intervals[] default row. Pulling them off one constant keeps
 * the two from silently drifting apart on future tuning.
 */
const TT_DEFAULT_INTERVAL = '1h' as const;

/**
 * TT-narrowed Technicals interval row: identical to the contract shape
 * except `interval` is locked to {@link TT_CANDLE_INTERVALS}. A free-form
 * string would silently sink (the compute job produces no signal for an
 * unknown interval, so the buy gate degrades to `technicals-no-signal` forever
 * with no operator feedback). The contract schema stays generic so other
 * strategies can declare their own interval support; the strategy
 * tightens at the registry layer.
 */
const TTTechnicalsIntervalConfigSchema = TechnicalsIntervalConfigSchema.extend({
  interval: z
    .enum(TT_CANDLE_INTERVALS)
    .describe(
      'Which candle timeframe this signal rule watches, for example 1h. Must be a timeframe this strategy supports, or it produces no signal.',
    ),
});

/**
 * TT-narrowed Technicals bundle config: overrides the contract default's
 * generic `1m` row with a row pinned to the same interval the profile's
 * primary `candleInterval` defaults to, so a freshly-created profile
 * boots with a coherent default rather than two different intervals.
 */
const TTTechnicalsBundleConfigSchema = TechnicalsBundleConfigSchema.extend({
  intervals: z
    .array(TTTechnicalsIntervalConfigSchema)
    // `.extend` replaces the field, dropping the contract schema's
    // uniqueness refinement AND its `.max()` cap. Re-applying both keeps
    // the contract's invariants intact when a strategy narrows the field.
    .max(MAX_TECHNICALS_INTERVALS, {
      message: `up to ${MAX_TECHNICALS_INTERVALS} intervals — keeps the Binance klines weight budget in check. Add a strategy plugin if more are needed.`,
    })
    .superRefine(intervalsUniquenessRefiner)
    .default(() => [
      {
        interval: TT_DEFAULT_INTERVAL,
        whenStrongBuy: true,
        whenBuy: true,
        whenSell: false,
        whenStrongSell: false,
        whenNeutral: false,
        mode: 'block' as const,
      },
    ])
    .describe(`@ui:technicals-interval-rows ${TECHNICALS_INTERVALS_DESCRIBE}`),
  // Confirm window for a technicals force-sell. A whole-minute count, not a
  // money field, so `number` is the correct type. The matched sell trigger
  // must stay present for at least this long before the force-sell emits, so a
  // single flickering signal does not bail out of a position. Optional rather
  // than defaulted: an omitted value resolves through the bundle transform
  // below to a safe non-zero default when a sub-1h force-sell trigger is armed,
  // because a sub-minute exit on a single intraday print whipsaws a position.
  // An explicit 0 is an informed opt-out that sells on the first matching tick.
  forceSellConfirmMinutes: z
    .number()
    .int()
    .min(0)
    .max(10080)
    .optional()
    .describe(
      'Stops a brief blip from selling you out: a sell signal must stay on for this many minutes before the bot sells. Higher waits for confirmation but exits later; leave blank to use one candle of your shortest fast timeframe; 0 sells on the first reading.',
    ),
  // Re-entry cooldown after a technicals force-sell. A whole-minute count for
  // the same reason. After a force-sell, fresh first entries on this symbol are
  // suppressed until the clock passes the stamped deadline, so the strategy does
  // not buy straight back into the downturn it just sold out of. Optional for
  // the same reason as the confirm window: an omitted value resolves to 60 when
  // a sub-1h trigger is armed, else 0. An explicit 0 applies no cooldown.
  forceSellReentryCooldownMinutes: z
    .number()
    .int()
    .min(0)
    .max(10080)
    .optional()
    .describe(
      'After a signal-driven sell, the bot waits this many minutes before buying this coin again, so it does not jump straight back into the same drop. Higher is more patient; leave blank for 60 minutes; 0 buys back with no wait.',
    ),
})
  // Resolve the two force-sell guards at parse time so a fully-parsed config
  // (defaultTTConfig, backtest, API validateConfig) always carries
  // concrete minute counts: an omitted field becomes the safe non-zero default
  // when a sub-1h force-sell trigger is armed, while an explicit value (incl. 0)
  // passes through. `io: 'input'` keeps `z.toJSONSchema` emitting the optional
  // input fields, so the web auto-form still renders them.
  .transform((bundle) => {
    const guards = resolveForceSellGuards(bundle);
    return {
      ...bundle,
      forceSellConfirmMinutes: guards.confirmMinutes,
      forceSellReentryCooldownMinutes: guards.cooldownMinutes,
    };
  });

/**
 * Per-symbol patch shape for the Technicals block: every field optional
 * with NO defaults, so the override only carries what the operator
 * actually changed. The full bundle schema has `.default()` on each
 * field, which would silently inject a "default override" through
 * {@link TTOverrideConfigSchema}'s `.partial()` wrapper and clobber the
 * profile config on merge. A quietly-defaulted `intervals: []` would
 * replace the profile's intervals wholesale because `mergeConfig`
 * replaces arrays. Declared fresh here so the partial truly means
 * "absent inherits".
 */
const TTTechnicalsBundleConfigPatchSchema = z
  .object({
    useOnlyWithinMin: z.number().int().positive(),
    ifExpires: TechnicalsIfExpiresSchema,
    entryConfirmReads: z.number().int().min(1),
    intervals: z
      .array(TTTechnicalsIntervalConfigSchema)
      .max(MAX_TECHNICALS_INTERVALS, {
        message: `up to ${MAX_TECHNICALS_INTERVALS} intervals — keeps the Binance klines weight budget in check. Add a strategy plugin if more are needed.`,
      })
      .superRefine(intervalsUniquenessRefiner)
      .describe(`@ui:technicals-interval-rows ${TECHNICALS_INTERVALS_DESCRIBE}`),
    forceSellConfirmMinutes: z.number().int().min(0).max(10080),
    forceSellReentryCooldownMinutes: z.number().int().min(0).max(10080),
  })
  .partial();

/**
 * Per-profile knobs that disarm individual TT buy-side preconditions when an
 * operator wants to override a normally-vetoing input. Lives on the config
 * rather than runtime state so a toggle survives restarts and replays.
 */
export const TTForceBuyOverrideSchema = withParsedDefault(
  z.object({
    /**
     * Suppresses the Technicals gate so a buy emission can still happen when
     * the upstream signal would otherwise veto it. Default `true` (gate
     * active) is the safety stance; operators flip it to `false` only for a
     * manually-validated symbol.
     */
    checkTechnicals: z
      .boolean()
      .default(true)
      .describe(
        'On (default): the bot skips a buy when the trading-signal reading says sell, protecting you from buying into weakness. Off: buys ignore that signal entirely — only turn this off for a coin you have checked yourself.',
      ),
  }),
);
/** Parsed override knobs; the schema guarantees every key has a concrete value at runtime so gates can branch without optional chaining. */
export type TTForceBuyOverride = z.infer<typeof TTForceBuyOverrideSchema>;

/**
 * Operator-owned indicator preconditions for buy emissions. Each knob
 * gates a buy on a closed-candle indicator from the configured
 * `candleInterval`. Every knob defaults to disabled so a profile that
 * does not opt in keeps the price-only entry behaviour unchanged. The
 * threshold *values* are operator judgement, not a shipped default — the
 * schema only provides the mechanism.
 */
export const TTIndicatorGateSchema = withParsedDefault(
  z.object({
    /**
     * RSI(14) buy ceiling: a buy is vetoed unless `rsi14 <= rsiMaxBuy`.
     * Empty or `'0'` disables. Constrained to (0, 100] because RSI is
     * a bounded oscillator.
     */
    rsiMaxBuy: decimalString("rsiMaxBuy must be empty, '0', or in (0, 100]", {
      gt: 0,
      lte: 100,
      allowEmpty: true,
      allowZeroString: true,
    })
      .default('')
      .describe(
        "@ui:decimal Only buy when the coin is not already running hot. RSI is a 0-100 'how overbought' gauge; the bot buys only when it sits at or below this. Lower (e.g. 30) buys only deep dips; higher buys more freely. Blank or 0 turns it off.",
      ),
    /**
     * Required relationship between `currentPrice` and SMA(20). `off`
     * disables the check; `price-below-sma` vetoes unless price is
     * strictly below the SMA (dip entry); `price-above-sma` vetoes
     * unless price is strictly above it (momentum entry).
     */
    smaBias: z
      .enum(['off', 'price-below-sma', 'price-above-sma'])
      .default('off')
      .describe(
        "Only buy on the side of the recent average price you choose. The average here is the last 20 candles' plain average (its SMA). 'Below' buys dips under the average; 'above' buys strength over it; off skips this check.",
      ),
    /** Same relationship as {@link smaBias}, evaluated against EMA(20). */
    emaBias: z
      .enum(['off', 'price-below-ema', 'price-above-ema'])
      .default('off')
      .describe(
        "Same idea as the SMA check, but against the EMA — an average of the last 20 candles that leans on the most recent prices, so it reacts faster. 'Below' buys dips; 'above' buys strength; off skips it.",
      ),
  }),
);
/** Parsed indicator-gate knobs; every key has a concrete value at runtime so the gate branches without optional chaining. */
export type TTIndicatorGate = z.infer<typeof TTIndicatorGateSchema>;

/**
 * Mean-reversion entry gate (a research-harness signal distinct from the
 * momentum/trend gates above). Vetoes a buy unless the price z-score —
 * `(currentPrice - SMA) / stddev` over `lookbackCandles` of the configured
 * Candle Interval — is at or below `entryZScoreMax`. A negative ceiling buys
 * statistical dips (e.g. -1 = 1σ below the rolling mean); a high positive
 * ceiling is effectively off (price is almost never that many σ above the
 * mean). Empty `entryZScoreMax` disables the gate, so a profile that has not
 * opted in keeps its entry behaviour unchanged (golden replay diff 0).
 */
export const TTMeanReversionGateSchema = withParsedDefault(
  z.object({
    entryZScoreMax: decimalString('entryZScoreMax must be empty or a decimal', {
      allowEmpty: true,
    })
      .default('')
      .describe(
        '@ui:decimal Only buy when price has dropped unusually far below its recent average, not just any dip. This is measured in standard steps below average (a z-score): -1 is one step below, -2 a rarer, deeper dip. Lower means fewer but stronger dip-buys; blank turns it off.',
      ),
    lookbackCandles: z
      .number()
      .int()
      .min(5)
      .max(400)
      .default(20)
      .describe(
        'How many recent candles the dip check averages over to decide what "normal" is. More candles give a smoother, slower baseline; fewer react to recent price faster.',
      ),
  }),
);
/** Parsed mean-reversion gate knobs; `entryZScoreMax === ''` means disabled. */
export type TTMeanReversionGate = z.infer<typeof TTMeanReversionGateSchema>;

/**
 * Re-arm-after-sell knobs (auto-trigger-buy). When enabled,
 * a sell that clears the position schedules a fresh first buy
 * `triggerAfterMinutes` later; the strategy stores the due timestamp in
 * `TTState.autoTriggerBuyAtMs` and a clock-gated branch in `tick()` fires
 * the buy once it comes due. Disabled by default so a profile that does
 * not opt in keeps its sell as the end of the cycle. The re-armed buy is
 * grid-aware: a grid profile re-enters at level 0, a non-grid profile uses
 * the single-buy entry.
 */
export const TTAutoTriggerBuySchema = withParsedDefault(
  z.object({
    enabled: z
      .boolean()
      .default(false)
      .describe(
        'Automatically starts a fresh buy a set time after a sell closes the position, so the bot keeps cycling in and out without you re-arming it. Off leaves a sale as the end of the trade.',
      ),
    // A wait duration in whole minutes, not a money field, so `number` is
    // the correct type (money values are `Decimal`; a minute count is a plain
    // counter). `.int()` keeps the minute count whole so
    // `now + triggerAfterMinutes * 60000` stays an integer for the
    // `autoTriggerBuyAtMs` int state schema. `.min(0)` rejects negatives and
    // allows 0, which re-arms on the next tick after a sell (no delay).
    triggerAfterMinutes: z
      .number()
      .int()
      .min(0)
      .default(20)
      .describe(
        'How long the bot waits after a sell before the automatic next buy. Longer gives the price more time to settle; 0 buys back almost immediately.',
      ),
    rescheduleWhileDisabled: z
      .boolean()
      .default(false)
      .describe(
        'If the profile is turned off when the automatic buy comes due, wait and buy later instead of skipping it. Off just skips that buy.',
      ),
  }),
);
/** Parsed re-arm knobs; every key has a concrete value at runtime so the consume branch reads them without optional chaining. */
export type TTAutoTriggerBuy = z.infer<typeof TTAutoTriggerBuySchema>;

/**
 * Opt-in volatility-scaled trailing stop. When enabled, the trail distance is
 * `multiplier × ATR(period)` of the trading interval instead of a fixed
 * fraction of the high: a sell fires when price <= high − multiplier × ATR. A
 * fixed % gets whipsawed in a wild market and sits too loose in a calm one;
 * scaling by ATR adapts the distance to realised volatility. ATR is computed
 * in-strategy from the trading interval's candle window (the worker ships the
 * candles; no extra interval needed). When enabled but ATR is not yet
 * computable (window shorter than period+1), the gate falls back to the
 * fixed-% trail, so a cold start still trails. Disabled by default — existing
 * configs and golden fixtures keep the fixed-% behaviour.
 *
 * `fromEntry` arms the trail from the entry price on the first held tick rather
 * than waiting for the position to reach `triggerPercentage`, so a pure
 * trend-follower has trailing protection from entry (not only the hard stop).
 */
export const TTAtrTrailingSchema = withParsedDefault(
  z.object({
    enabled: z
      .boolean()
      .default(false)
      .describe(
        'Sets the trailing-sell distance from how much price has been swinging lately (its ATR, the average recent candle range) instead of a fixed percent, giving volatile coins more room and calm ones less. Off uses the fixed-percent trail, and it falls back to that until enough candles exist.',
      ),
    fromEntry: z
      .boolean()
      .default(false)
      .describe(
        'Protect the trade with the swing-based trailing sell right from when you buy, instead of only after it is in profit. Useful for riding a trend. Only applies when ATR trailing is on.',
      ),
    period: z
      .number()
      .int()
      .min(2)
      .max(100)
      .default(14)
      .describe(
        'How many recent candles the swing-size (ATR) is averaged over. More gives a steadier trailing distance; fewer reacts faster to a change in volatility.',
      ),
    multiplier: decimalString('atrTrailing.multiplier must be a positive decimal', { gt: 0 })
      .default('3')
      .describe(
        '@ui:decimal How many swing-sizes (ATR) below the peak the bot sells. Smaller (e.g. 2) locks in gains sooner but exits early; larger (e.g. 4) gives the trade room but hands back more.',
      ),
  }),
);
/** Parsed ATR-trailing knobs; every key has a concrete value at runtime so the trailing-stop branch reads them without optional chaining. */
export type TTAtrTrailing = z.infer<typeof TTAtrTrailingSchema>;

/**
 * Exchange-side protective stop. Rests a STOP_LOSS_LIMIT SELL at the same
 * `avgEntryPrice × stopLossPercentage` level the in-process stop-loss watches,
 * so a position is still defended when the bot is offline (a gap-through fires
 * the resting order at the exchange instead of waiting for the next tick). The
 * in-process MARKET stop-loss remains the primary path; this is the backstop.
 * Off by default — existing configs and golden fixtures keep the bot-only stop.
 * Inert without a configured `stopLossPercentage`: no stop level, no order.
 */
export const TTProtectiveStopSchema = withParsedDefault(
  z.object({
    enabled: z
      .boolean()
      .default(false)
      .describe(
        'Places a backup sell order on Binance itself, so your stop-loss still protects you even if the bot is offline or crashes. It sits at the same price as your normal stop-loss. Needs a stop-loss percent set to do anything.',
      ),
    limitOffsetPercentage: decimalString('limitOffsetPercentage must be in (0, 1]', {
      gt: 0,
      lte: 1,
    })
      .default('0.995')
      .describe(
        '@ui:percent-below The backup order triggers at your stop price, then sells down to a limit price. This sets how far below the trigger that limit sits: a bigger gap makes it far more likely to actually sell in a fast drop, a tiny gap risks not filling at all. 0.5 means 0.5% below.',
      ),
  }),
);

/**
 * Break-even stop. Sits between the hard stop-loss and the profit trail and
 * closes the exit asymmetry where a winner gets a trailing stop but a stalled
 * trade has only the far hard stop. Once a CLOSED candle confirms a small gain
 * (`armAtPercentage`), a sticky floor arms at `floorPercentage` (1 = entry); a
 * later retrace to the floor market-sells near break-even, so a move that popped
 * but stalled before reaching `triggerPercentage` exits flat instead of riding
 * the hard stop down. Once the profit trail arms (highSinceBuy) it takes over
 * and this floor goes inert. Off by default — existing configs and golden
 * fixtures keep the prior stop-loss + trail behaviour.
 */
export const TTBreakEvenSchema = withParsedDefault(
  z.object({
    enabled: z
      .boolean()
      .default(false)
      .describe(
        'Once price has risen a little above your entry, protect the trade by selling if it falls back to break-even. Catches a move that popped then stalled, so it exits near flat instead of falling all the way to the hard stop-loss. Off by default.',
      ),
    armAtPercentage: decimalString('breakEven.armAtPercentage must be > 1', { gt: 1 })
      .default('1.01')
      .describe(
        '@ui:percent-above How far above your buy price the trade must rise before the break-even protection turns on. Smaller (e.g. 0.5%) kicks in sooner but can trip on small wiggles; larger waits for a clearer gain. 1 means 1% above.',
      ),
    floorPercentage: decimalString('breakEven.floorPercentage must be >= 1', { gte: 1 })
      .default('1')
      .describe(
        '@ui:percent-above Once protection is on, sell if price slips back to this much above your buy price. 0 sells right at break-even; 0.2 locks in at least 0.2% profit. Keep it below the turn-on level above.',
      ),
  }),
);

/**
 * Unified daily-regime config. ONE moving-average definition (`ma` / `period` /
 * `confirmBars`) drives every regime-aware behaviour, so the operator reasons
 * about a single macro trend rather than separate, possibly-disagreeing knobs.
 * The bear-side actions:
 *
 *   - `onBear.exitToCash`        : once the DAILY regime is CONFIRMED bearish
 *     (the last `confirmBars` daily candles all close below the regime MA), exit
 *     the whole position to cash (a MARKET SELL) AND suppress fresh entry in
 *     lock-step until price recovers above the line. The exit + entry-suppression
 *     stay coupled (decoupling thrashes: sell to cash then immediately re-buy).
 *     Unlike the stop-loss / trailing stop it reacts to the macro trend, and
 *     unlike technicals-force-sell it WILL exit at a loss — cutting macro risk is
 *     the point. FAIL-SAFE: while the daily window is too short to confirm, it is
 *     fully inert (never sells, never freezes entry on missing data).
 *   - `onBear.blockEntry`        : suppress fresh first entries in a confirmed
 *     bear WITHOUT selling existing holdings — the entry-suppression half of
 *     `exitToCash` on its own, for sitting out a downtrend while leaving open
 *     positions to their own stop / trail. Same confirmed-bear signal and
 *     fail-safe semantics; never sells.
 *   - `onBear.suppressPromotion` : halt grid promotions (averaging-down adds)
 *     while price is INSTANTANEOUSLY below the regime MA, so the ladder stops
 *     deepening into a downtrend. FAIL-CLOSED: halts while the daily window is
 *     too short to evaluate (the operator opted into the precondition).
 *
 * Bull-side actions live under `onBull.*`. `onBull.hold` widens the sell trail
 * while a confirmed bull holds (the winner runs, then auto-tightens the moment
 * the bull ends). Every knob is off by default, so existing configs and golden
 * fixtures are unchanged.
 */
export const TTRegimeSchema = withParsedDefault(
  z.object({
    ma: z
      .enum(['sma', 'ema'])
      .default('ema')
      .describe(
        'Which kind of daily trend line to use: SMA is a plain average of recent days; EMA leans on the latest days so it turns faster. Both mark whether the market is broadly up or down.',
      ),
    period: z
      .number()
      .int()
      .min(2)
      .max(200)
      .default(200)
      .describe(
        'How many days the trend line averages over. 200 is the classic long-term trend; shorter (20-50) reacts faster to a turn but flips more often on noise.',
      ),
    confirmBars: z
      .number()
      .int()
      .min(1)
      .max(10)
      .default(3)
      .describe(
        'How many days in a row must close below the trend line before the bot calls it a downtrend and acts. Higher means fewer false alarms but a slower reaction; 1 acts on the first day below, 3 waits three days to ride out noise.',
      ),
    exposure: withParsedDefault(
      z.object({
        enabled: z
          .boolean()
          .default(false)
          .describe(
            '@ui:toggle Puts more money in when the daily trend is up and less (or none) when it is down, since a buy-only bot cannot make money in a falling market. Off spends the same size regardless of trend. Only the non-grid first buy is scaled.',
          ),
        neutralScalar: decimalString('neutralScalar must be a decimal in [0, 1]', {
          gte: 0,
          lte: 1,
        })
          .default('0.5')
          .describe(
            '@ui:decimal When the daily trend is flat (neither clearly up nor down), spend this fraction of your normal buy size. 0 sits out when flat, 1 buys full size; a confirmed uptrend always buys full and a downtrend buys nothing. 0.5 is half size.',
          ),
      }),
    ),
    onBear: withParsedDefault(
      z.object({
        exitToCash: z
          .boolean()
          .default(false)
          .describe(
            'Sell your whole position and stop buying when the daily trend turns down, then resume once it recovers. This can sell at a loss on purpose to dodge a bigger drop. Off by default.',
          ),
        blockEntry: z
          .boolean()
          .default(false)
          .describe(
            'Stop opening new positions while the daily trend is down, but keep what you already hold (its own stop-loss and trailing sell still guard it). A gentler option than selling everything to cash. Averaging-down adds are controlled separately below. Off by default.',
          ),
        suppressPromotion: z
          .boolean()
          .default(false)
          .describe(
            'While price is below the daily trend line, stop the averaging-down ladder from buying more, so you do not keep adding into a falling market. Off by default.',
          ),
        rearm: withParsedDefault(
          z.object({
            enabled: z
              .boolean()
              .default(false)
              .describe(
                'While you are sitting out a downtrend, let the bot buy back early the moment a faster trading signal says the turn is real, instead of waiting for the slow daily trend line to recover. Catches an early rebound without dropping the downtrend protection. Off by default; ignored when "exit to cash" is on.',
              ),
            interval: z
              .enum(TT_CANDLE_INTERVALS)
              .default('4h')
              .describe(
                'Which signal timeframe must confirm the turn before buying back early. Must be a timeframe you have signals computing for, or this never fires. 4h turns ahead of the daily trend line without the noise of very short timeframes.',
              ),
            minRecommendation: z
              .enum(['BUY', 'STRONG_BUY'])
              .default('STRONG_BUY')
              .describe(
                'How strong the turn signal must be to buy back early. STRONG_BUY is the safer, later trigger; BUY buys back sooner but catches more false bounces.',
              ),
          }),
        ),
      }),
    ),
    onBull: withParsedDefault(
      z.object({
        hold: withParsedDefault(
          z.object({
            enabled: z
              .boolean()
              .default(false)
              .describe(
                'When the daily trend is strongly up, give a winning trade more room so ordinary dips do not sell you out too soon. Off by default.',
              ),
            room: z
              .enum(['tight', 'normal', 'loose'])
              .default('normal')
              .describe(
                'How much slack to give a winner during a strong uptrend. Looser rides bigger swings for more upside but hands back more if it reverses near the top.',
              ),
          }),
        ),
        pyramid: withParsedDefault(
          z.object({
            enabled: z
              .boolean()
              .default(false)
              .describe(
                'When the daily trend is strongly up, add to a winning position as it climbs above your cost. Off by default. Needs a per-symbol or account spending cap set first, so it cannot buy without limit.',
              ),
            stepPercentage: decimalString('pyramid.stepPercentage must be a positive decimal', {
              gt: 0,
            })
              .default('0.05')
              .describe(
                '@ui:decimal How far price must rise above your last add before the bot adds again. Smaller adds more often and builds faster; larger adds rarely. 0.05 adds every 5 percent up.',
              ),
            maxAdds: z
              .number()
              .int()
              .min(1)
              .max(20)
              .default(3)
              .describe(
                'The most times the bot will add to one winning position. Caps how big it can get near a top, limiting how much you give back if it reverses.',
              ),
            maxPurchaseAmount: decimalString(
              'pyramid.maxPurchaseAmount must be a positive decimal',
              { gt: 0 },
            )
              .default('15')
              .describe(
                '@ui:price How much quote currency (e.g. USDT) to spend on each add to a winner. Sized on its own, separate from your grid ladder levels.',
              ),
          }),
        ),
        requireEntry: z
          .boolean()
          .default(false)
          .describe(
            'Only open a new position when the daily trend is a confirmed uptrend, so a dip-buyer waits for a real rise instead of buying into a flat or falling market. Off by default. Strict: if the trend cannot be confirmed yet, it stays out rather than guessing.',
          ),
      }),
    ),
  }),
);
/** Parsed unified regime knobs; every key has a concrete value at runtime so the gates read them without optional chaining. */
export type TTRegime = z.infer<typeof TTRegimeSchema>;

/**
 * Per-symbol override view of {@link TTRegimeSchema}: every key optional and no
 * defaults, so a stored override carries ONLY the regime keys it changes and the
 * worker's deep `mergeConfig` leaves the rest of the profile's regime intact.
 * (The full-object override pattern used for `forceBuyOverride` would inject
 * defaulted keys that clobber the base regime on merge.)
 */
export const TTRegimePatchSchema = z
  .object({
    ma: z.enum(['sma', 'ema']),
    period: z.number().int().min(2).max(200),
    confirmBars: z.number().int().min(1).max(10),
    exposure: z
      .object({
        enabled: z.boolean(),
        neutralScalar: decimalString('neutralScalar must be a decimal in [0, 1]', {
          gte: 0,
          lte: 1,
        }),
      })
      .partial(),
    onBear: z
      .object({
        exitToCash: z.boolean(),
        blockEntry: z.boolean(),
        suppressPromotion: z.boolean(),
        rearm: z
          .object({
            enabled: z.boolean(),
            interval: z.enum(TT_CANDLE_INTERVALS),
            minRecommendation: z.enum(['BUY', 'STRONG_BUY']),
          })
          .partial(),
      })
      .partial(),
    onBull: z
      .object({
        hold: z
          .object({ enabled: z.boolean(), room: z.enum(['tight', 'normal', 'loose']) })
          .partial(),
        pyramid: z
          .object({
            enabled: z.boolean(),
            stepPercentage: z.string(),
            maxAdds: z.number().int().min(1).max(20),
            maxPurchaseAmount: z.string(),
          })
          .partial(),
        requireEntry: z.boolean(),
      })
      .partial(),
  })
  .partial();

/**
 * Entry sizing for the no-grid single buy: a fixed quote amount, or a percent
 * of account equity (free + locked quote cash + cost-basis deployed across all
 * profiles). Replaces the v1 single `maxPurchaseAmount`. Grid ladders keep their
 * own per-level amounts and ignore this. The active mode's value field is
 * required (cross-field refine here, on save); the inactive one stays blank.
 * The live worker reads config unparsed, so an absent block fails safe in the
 * sizing path rather than guessing.
 */
const TTEntrySizingSchema = z
  .object({
    mode: z
      .enum(['fixed', 'percentOfAccount'])
      .default('fixed')
      .describe(
        'Choose how much to spend on the first buy: a fixed amount of quote currency, or a percent of your account value.',
      ),
    amount: decimalString('amount must be a positive decimal', { gt: 0, allowEmpty: true })
      .default('')
      .describe(
        '@ui:price How much quote currency (e.g. USDT) to spend on the first buy when you are not using a grid ladder. Bigger means larger positions and more risk per trade.',
      ),
    percent: decimalString('percent must be in (0, 1]', { gt: 0, lte: 1, allowEmpty: true })
      .default('')
      .describe(
        '@ui:percent-of How much of your account to risk per trade, as a percent. With a stop-loss set, the bot sizes the buy so hitting the stop loses about this percent: 1 risks 1%, and a tighter stop lets it buy more for the same risk. One buy is capped at half your account. With no stop-loss it just spends this percent.',
      ),
  })
  .superRefine((val, ctx) => {
    if (val.mode === 'fixed' && val.amount === '') {
      ctx.addIssue({
        code: 'custom',
        path: ['amount'],
        message: 'amount is required for fixed sizing',
      });
    }
    if (val.mode === 'percentOfAccount' && val.percent === '') {
      ctx.addIssue({
        code: 'custom',
        path: ['percent'],
        message: 'percent is required for percent-of-account sizing',
      });
    }
  })
  .describe(
    '@ui:amount-or-percent-entry How to size the first buy when there is no grid ladder: a fixed amount, or a percent of your account risked per trade (sized against your stop-loss, capped at half your account).',
  );

/**
 * Account-wide deployed-capital ceiling, expressed as an absolute quote
 * `amount` or a `percent` of account equity. Replaces the v1
 * `maxAccountExposureQuote` string. Bounds the total quote deployed across the
 * account's profiles in the SAME mode + quote asset (incl. this position): a
 * new grid level / pyramid add is refused when that total plus the new level
 * would breach it. Same-mode + same-quote so a live cap never counts test-mode
 * practice positions or a different quote unit. A
 * `percent` cap is resolved against live equity by the strategy (tick) and the
 * dashboard gauge; the worker/api duck-read it via `readAccountExposureCap`.
 * Best-effort: concurrent ticks on other symbols can race past it, so it is a
 * coarse backstop, not an exact allocator. `off` (or absent) disables it.
 */
const TTAccountCapSchema = z
  .object({
    mode: z
      .enum(['off', 'amount', 'percent'])
      .default('off')
      .describe(
        'Cap the total money the bot holds in coins across your profiles: by a fixed amount, by a percent of your account, or off.',
      ),
    amount: decimalString('amount must be a positive decimal', { gt: 0, allowEmpty: true })
      .default('')
      .describe(
        '@ui:price The most quote currency (e.g. USDT) to hold in coins at once across your profiles that trade the same mode and quote asset. Set the same value on those profiles for one shared ceiling.',
      ),
    percent: decimalString('percent must be in (0, 1]', { gt: 0, lte: 1, allowEmpty: true })
      .default('')
      .describe(
        '@ui:percent-of The most of your account, by value, to hold in coins at once across your same-mode, same-quote profiles. 50 keeps about half in cash as a reserve.',
      ),
  })
  .superRefine((val, ctx) => {
    if (val.mode === 'amount' && val.amount === '') {
      ctx.addIssue({
        code: 'custom',
        path: ['amount'],
        message: 'amount is required when the cap is a fixed amount',
      });
    }
    if (val.mode === 'percent' && val.percent === '') {
      ctx.addIssue({
        code: 'custom',
        path: ['percent'],
        message: 'percent is required when the cap is a percent',
      });
    }
  })
  .describe(
    '@ui:advanced @ui:amount-or-percent The most of your account the bot will hold in coins at once, across profiles trading the same mode and quote asset: a fixed amount, a percent, or off. The rest stays as cash.',
  );

/**
 * Trading fees the account pays, in basis points (1 bp = 0.01%). Lets the
 * strategy account for round-trip cost so a profit-taking exit can never book a
 * net loss, and lets a backtest default to the same cost as live. The live
 * strategy enters and exits with market orders (both legs taker), so it uses
 * `takerBps` for its round-trip estimate; `makerBps` is consumed by the
 * backtester's limit-fill model. Both default to '0', which is byte-identical to
 * the prior fee-blind behaviour, so an existing profile is unaffected until set.
 */
const TTFeesSchema = withParsedDefault(
  z
    .object({
      takerBps: decimalString('takerBps must be a non-negative decimal', { gte: 0 })
        .default('0')
        .describe(
          'The fee Binance takes on each buy or sell (spot is about 0.1%). Match it to your account: set it too low and backtests will look more profitable than real trading. The bot counts a round trip so a profit-taking sell never books a loss after fees.',
        ),
      makerBps: decimalString('makerBps must be a non-negative decimal', { gte: 0 })
        .default('0')
        .describe(
          'The fee for orders that rest on the book rather than filling instantly. Backtests use it for limit-order fills; live trading uses the taker fee above. Match it to your account.',
        ),
    })
    .describe(
      'The fees Binance charges, so profit targets clear the real cost and backtests match what you actually pay live.',
    ),
);

/**
 * How strategy BUY orders are placed. `market` (the default) crosses the spread
 * for an immediate fill and pays the taker fee on every entry. `maker` rests a
 * passive LIMIT buy `makerOffsetBps` below the price so the order does not cross
 * the spread and pays no slippage, at the cost of fill uncertainty (a passive
 * buy fills only if the price reaches it). At Binance spot VIP0 the maker and
 * taker fees are equal, so the benefit is the avoided spread and slippage, not a
 * lower fee — backtest a maker-mode config before enabling it live. Only entries
 * are affected: exits stay MARKET (a reactive stop must fill), and a grid level
 * that already configures a stop-limit buy keeps it. Defaults to `market`, which
 * is byte-identical to the prior taker-only behaviour, so an existing profile is
 * unaffected until it opts in.
 */
const TTExecutionSchema = withParsedDefault(
  z
    .object({
      entryMode: z
        .enum(['market', 'maker'])
        .default('market')
        .describe(
          'How the bot places your buys. "market" buys instantly at the going price and pays the taker fee. "maker" rests a patient limit buy just below the price so you save the spread and slippage, but it only fills if price comes down to it. At Binance VIP0 both fees are equal, so maker trades a cheaper fill for less certainty — backtest it before going live.',
        ),
      makerOffsetBps: decimalString('makerOffsetBps must be a non-negative decimal', { gte: 0 })
        .default('0')
        .describe(
          'For maker buys: how far below the current price to rest the order. 0 rests right at the price; a larger offset rests deeper, so the buy is cheaper but less likely to fill. Ignored unless entry mode is "maker".',
        ),
      // Cancel a still-resting maker entry after this many closed candles so the
      // strategy re-prices to the current market next tick instead of dead-resting
      // at a stale level for the whole window. A maker LIMIT entry is GTC (Binance
      // has no per-order expiry), so without this the only ways off the book are a
      // fill or a strategy cancel. Only the flat first entry is timed; promotions
      // are managed by grid re-pricing. 0 = OFF (default), byte-identical to the
      // pre-timeout behaviour. Inert in market mode (a market entry never rests).
      // A candle count, not money, so `number`.
      entryTimeoutBars: z
        .number()
        .int()
        .nonnegative()
        .default(0)
        .describe(
          'For maker buys: if a resting buy has not filled after this many candles, cancel it so the next tick can re-price it to the current market instead of sitting at a stale price. 0 leaves it resting until it fills. Ignored for market buys, which fill immediately.',
        ),
    })
    .describe(
      'How your buys are placed: instantly at market (taker), or as a patient limit order (maker).',
    ),
);

/**
 * TT-side configuration the operator owns end-to-end. Account-scoped via the
 * surrounding profile; nothing here may reach into other profiles' state.
 */
export const TTConfigSchema = z
  .object({
    // Binance trading pair, uppercase alphanumeric (BTCUSDT, ETHBTC). A
    // bare string would let an empty / lowercase / whitespace value reach
    // the worker, which then queries a non-existent market every tick. The
    // 6-20 length bound is a cheap fat-finger gate (a Binance spot symbol
    // pairs two assets, so it cannot be shorter); the worker's exchangeInfo
    // lookup is the authoritative existence check.
    symbol: z
      .string()
      .refine((raw) => /^[A-Z0-9]{6,20}$/.test(raw), {
        message: 'symbol must be an uppercase Binance pair, 6-20 alphanumeric characters',
      })
      .describe(
        'The Binance trading pair this profile trades, in uppercase, e.g. BTCUSDT (buy Bitcoin with USDT).',
      ),
    // The strategy declares its supported intervals via
    // `Strategy.capabilities.candleIntervals`; the schema enum here MUST
    // be a subset (operator pick within what the strategy can serve).
    // Operator-supported set: 1m through 1d.
    candleInterval: z
      .enum(TT_CANDLE_INTERVALS)
      .default(TT_DEFAULT_INTERVAL)
      .describe(
        'The candle timeframe the bot reads for its signals and grid logic, e.g. 1h is one candle per hour. Shorter reacts faster but is noisier.',
      ),
    buy: z
      .object({
        enabled: z
          .boolean()
          .describe(
            'Master on/off for buying. Off pauses all new buys; your existing positions still sell and stop-out normally.',
          ),
        // Entry sizing for the no-grid single buy (fixed amount or percent of
        // account equity). Replaces the v1 maxPurchaseAmount. Grid ladders size
        // each level from gridLevels[].maxPurchaseAmount and ignore this.
        // `.default(...)` so a config stored BEFORE this field shipped (v1, only
        // `maxPurchaseAmount`) still parses instead of failing the schema — the
        // same forward-compat default every sibling here carries. Without it a
        // stale config runs live (the worker reads config unparsed) yet cannot be
        // backtested (the backtest parses strictly), a live/backtest divergence.
        // A grid profile ignores this block, so the default is inert there; a
        // non-grid profile should re-save to set its real entry size.
        entrySizing: TTEntrySizingSchema.default({ mode: 'fixed', amount: '15', percent: '' }),
        // Multiplier on avgEntryPrice that triggers the lbp-clear escape hatch
        // when price drops to or below it. Constrained to (0, 1]: zero (or
        // missing) disables; > 1 would trigger on price ABOVE entry, which
        // would clear the lbp every tick on any gain and is never intended.
        // `.default('')` so a stored config that omits the key parses to "" (the
        // disabled state) instead of throwing `expected string, received
        // undefined`. The avgEntryPrice rename (formerly
        // `lastBuyPriceRemoveThreshold`) shipped greenfield with no config
        // migration, so pre-rename configs carry the old key and lack this one;
        // the live tick already reads a missing value as disabled, and the
        // backtest full-parse (backtest-runner configSchema.parse)
        // must agree.
        avgEntryPriceRemoveThreshold: decimalString(
          "avgEntryPriceRemoveThreshold must be empty, '0', or in (0, 1]",
          { gt: 0, lte: 1, allowEmpty: true, allowZeroString: true },
        )
          .default('')
          .describe(
            '@ui:advanced @ui:percent-below Cleanup for a leftover average-cost record when a position has effectively gone to dust. It only acts when your coin balance is below the tradable minimum, there is no open buy order, and price has fallen this far below the recorded average cost. 10 means 10% below. Harmless on a real held position. Blank disables it.',
          ),
        gridRepriceMinDriftPercent: decimalString(
          "gridRepriceMinDriftPercent must be empty, '0', or in (0, 1)",
          { gt: 0, lt: 1, allowEmpty: true, allowZeroString: true },
        )
          .default('0')
          .describe(
            '@ui:advanced @ui:percent-of Stops the resting grid buy order from being re-placed on tiny price wiggles: only move it when the new price is at least this much lower. Higher means fewer order updates; 0 re-places on any drop.',
          ),
        // Ordered grid ladder. Level 0 is the entry buy — a MARKET buy by
        // default, or a STOP_LOSS_LIMIT buy when the level sets stop/limit price
        // percentages. Each subsequent level fires when price has
        // dropped to `avgEntryPrice * triggerPercentage` (so 0.97 means "buy
        // again at 3% below the weighted-average cost basis"). Each level sizes its buy with the
        // min/max purchase amounts: the strategy spends up to
        // `maxPurchaseAmount` (capped by the wallet) and skips the level when it
        // cannot meet `minPurchaseAmount`. Empty array preserves the single-buy
        // behaviour using the buy-level `maxPurchaseAmount`; explicit
        // array overrides it. Length is uncapped; the operator owns how deep the
        // averaging-down ladder runs.
        gridLevels: z
          .array(
            z
              .object({
                triggerPercentage: decimalString(
                  'gridLevels[].triggerPercentage must be a positive decimal',
                  { gt: 0 },
                ).describe(
                  '@ui:percent-below How far below your average cost this rung buys more. 3 means buy again once price is 3% under your average cost. The first rung (level 0) is the entry buy and ignores this — leave it at 0.',
                ),
                // Buy stop-limit. When BOTH stop and limit are set, this
                // level's BUY is a STOP_LOSS_LIMIT instead of a MARKET buy:
                // stopPrice = currentPrice × stop, price = currentPrice × limit.
                // Empty (the default) keeps the level a MARKET buy, so existing
                // configs are unchanged. Constrained to >= 1 because a buy stop
                // fires as price RISES through it — a value below 1 would trigger
                // instantly and defeat the bounce-confirmation entry.
                stopPricePercentage: decimalString(
                  'gridLevels[].stopPricePercentage must be empty or >= 1',
                  { gte: 1, allowEmpty: true },
                )
                  .default('')
                  .describe(
                    '@ui:percent-above Turn this rung into a stop-limit buy that only arms once price rises through a level this far above the current price, confirming a bounce before buying. 1 means 1% above. Blank is a plain instant buy; if you set this, also set the buy limit price below.',
                  ),
                limitPricePercentage: decimalString(
                  'gridLevels[].limitPricePercentage must be empty or >= 1',
                  { gte: 1, allowEmpty: true },
                )
                  .default('')
                  .describe(
                    '@ui:percent-above The most you will pay on a stop-limit buy, set this far above the current price. 1.5 means 1.5% above. Must be at or above the buy stop price. Blank is a plain instant buy.',
                  ),
                // A floor on the quote spent at this level. Empty (default)
                // applies no floor. quantity.ts clamps the spend into [min, max],
                // still capped by the wallet, and skips with a typed reason when
                // even the floor cannot clear minQty / minNotional.
                minPurchaseAmount: decimalString(
                  'gridLevels[].minPurchaseAmount must be empty or a positive decimal',
                  { gt: 0, allowEmpty: true },
                )
                  .default('')
                  .describe(
                    '@ui:price The least quote currency (e.g. USDT) to spend at this rung. Blank means no minimum.',
                  ),
                // The quote-asset budget for this level (the cap the strategy
                // sizes the buy up to). Required and positive.
                maxPurchaseAmount: decimalString(
                  'gridLevels[].maxPurchaseAmount must be a positive decimal',
                  { gt: 0 },
                ).describe(
                  '@ui:price How much quote currency (e.g. USDT) to spend at this rung. The bot spends up to this, limited by your available balance.',
                ),
              })
              // Stop and limit are a pair (an incomplete STOP_LOSS_LIMIT cannot
              // be placed), and the limit must clear the stop so the resting buy
              // can fill once the stop triggers. Percentage comparisons only, so
              // no money-typed arithmetic crosses the decimal boundary here.
              .superRefine((lvl, ctx) => {
                const stop = lvl.stopPricePercentage;
                const limit = lvl.limitPricePercentage;
                if (stop !== '' && limit === '') {
                  ctx.addIssue({
                    code: 'custom',
                    path: ['limitPricePercentage'],
                    message: 'limitPricePercentage is required when stopPricePercentage is set',
                  });
                }
                if (limit !== '' && stop === '') {
                  ctx.addIssue({
                    code: 'custom',
                    path: ['stopPricePercentage'],
                    message: 'stopPricePercentage is required when limitPricePercentage is set',
                  });
                }
                if (stop !== '' && limit !== '' && Number(limit) < Number(stop)) {
                  ctx.addIssue({
                    code: 'custom',
                    path: ['limitPricePercentage'],
                    message:
                      'limitPricePercentage must be greater than or equal to stopPricePercentage',
                  });
                }
              }),
          )
          .default([])
          .describe(
            'Optional averaging-down ladder that buys more as price falls below your average cost. Leave it empty to just make one buy using Entry Sizing above.',
          ),
        // Indicator preconditions applied to every buy emission (non-grid
        // first-buy, grid entry, and grid promotions). Disabled by default.
        indicatorGate: TTIndicatorGateSchema.describe(
          '@ui:advanced Require an extra condition before any buy — an overbought ceiling (RSI), or price on a chosen side of its recent average (SMA/EMA). Off by default.',
        ),
        // Mean-reversion z-score entry gate (research-harness signal). Disabled
        // by default; tunable via buy.meanReversionGate.*.
        meanReversionGate: TTMeanReversionGateSchema.describe(
          '@ui:advanced Only buy when price has dropped unusually far below its recent average (a real dip), not just any dip. Fewer but higher-quality entries. Off by default.',
        ),
        // Re-arm-after-sell timer. Disabled by default; when on, a sell
        // schedules a fresh first buy a fixed delay later.
        autoTriggerBuy: TTAutoTriggerBuySchema.describe(
          '@ui:advanced Automatically start a fresh buy a set time after a sell closes the position, so the bot keeps cycling. Off by default.',
        ),
        // Re-entry cooldown after a LOSS exit (stop-loss, or a force-sell /
        // regime-exit taken below cost). After such an exit, fresh first entries
        // on this symbol are suppressed until the clock passes the stamped
        // deadline, so the strategy does not buy straight back into the dump it
        // just realised a loss into. A whole-minute count, not money, so `number`
        // is correct. Defaults to 60; 0 disables the cooldown. The default is a
        // behavioural change from the prior always-re-enter behaviour — a
        // post-loss re-buy now waits an hour by default.
        lossCooldownMinutes: z
          .number()
          .int()
          .min(0)
          .default(60)
          .describe(
            '@ui:advanced After a losing exit (a stop-loss, or a signal or trend exit taken below your average cost), wait this many minutes before buying this coin again, so the bot does not jump back into the same drop. Higher is more patient; 0 turns the wait off.',
          ),
        // First-buy trigger basis. 'immediate' (default) keeps the
        // current behaviour: level 0 fires from flat on the next eligible tick.
        // 'lowest-price' defers level 0 until price returns to the window low ×
        // level 0 trigger. Default preserves existing configs.
        firstBuyTriggerBasis: z
          .enum(['immediate', 'lowest-price'])
          .default('immediate')
          .describe(
            "@ui:advanced How the very first buy is triggered. 'immediate' buys as soon as conditions allow; 'lowest-price' waits until price comes back down near its recent low before buying, for a better entry.",
          ),
        // Candle-window length for the 'lowest-price' basis.
        // A count, not money, so `number` is correct (mirrors triggerAfterMinutes).
        // Ignored in 'immediate' mode; clamped to the candles actually supplied.
        candleLimit: z
          .number()
          .int()
          .min(1)
          .max(1000)
          .default(60)
          .describe(
            '@ui:advanced How many recent candles the "lowest-price" first buy looks back over to find that low. Only used when First Buy Trigger Basis is lowest-price.',
          ),
        // Opt-in position-sizing risk caps. Both bound how much a single symbol
        // can cost the account and gate the same decision — opening a new grid
        // level — so they live together (branches/risk-caps.ts). Quote-absolute,
        // not a percent of equity: a per-equity base needs an account-level view
        // the per-(profile, symbol) tick() does not have (core invariant #4); the
        // percent variant is deferred to the cross-profile heat-cap design. Empty
        // or '0' disables, so existing configs and golden fixtures are unchanged.
        //
        // Total quote deployed into this symbol (sum of all filled grid levels =
        // weighted-average cost × held). A new level is refused when filling it
        // would push the deployed total above this. Bounds committed capital.
        maxSymbolExposureQuote: decimalString(
          "maxSymbolExposureQuote must be empty, '0', or a positive decimal",
          { gt: 0, allowEmpty: true, allowZeroString: true },
        )
          .default('')
          .describe(
            '@ui:advanced @ui:price The most quote currency (e.g. USDT) to put into this one coin across all grid rungs. Once reached, the bot skips further buys on it, capping how much a single coin can cost you. Blank or 0 disables.',
          ),
        // Worst-case loss budget. The stop liquidates the whole position a fixed
        // fraction below cost, so worst-case loss = deployed × (1 − stopLoss); a
        // disabled stop means the full deployed is at risk (price→0). A new level
        // is refused when its worst-case loss would breach this. Converts an
        // unbounded ladder's "unknown catastrophic loss" into a known capped loss.
        maxPositionLossQuote: decimalString(
          "maxPositionLossQuote must be empty, '0', or a positive decimal",
          { gt: 0, allowEmpty: true, allowZeroString: true },
        )
          .default('')
          .describe(
            '@ui:advanced @ui:price The most quote currency (e.g. USDT) you are willing to lose on this position. Worst case is all your money in the coin sold at the stop-loss; the bot skips a new rung if adding it would risk more than this. Blank or 0 disables.',
          ),
        // Account-wide deployed-capital ceiling (fixed amount or percent of
        // equity). Unlike the two caps above (which bound THIS symbol), this
        // bounds the total quote deployed across the account's profiles in the
        // same mode + quote asset: a new level is refused, or downsized on the
        // no-grid entry, when that total (incl. this position) plus the new
        // level would breach it. The
        // worker supplies the cross-profile total (`account.deployedQuoteAcross
        // Profiles`); `tick()` stays per-(profile,symbol)-pure by reading a
        // scalar and resolving a percent cap against equity. Best-effort:
        // concurrent ticks on other symbols can race past it.
        accountCap: TTAccountCapSchema.optional(),
      })
      // Each promotion fires when `price <= avgEntryPrice * triggerPercentage`,
      // where `avgEntryPrice` is the weighted-average cost basis of the open
      // position, re-averaged (VWAP) on every BUY fill — NOT the last individual
      // fill price (tick.ts evaluateGridBuy; fold in @app/strategy-core
      // fill-resolution). The trigger is therefore relative to the running cost
      // basis, so consecutive levels may repeat (0.97, 0.97 each buy 3% below the
      // current average cost — the canonical averaging-down ladder). The only
      // per-level invariant is trigger < 1 (a promotion buys BELOW its reference;
      // >= 1 would re-fire at or above the average cost on the next tick). Level 0
      // has no prior position; in 'immediate' basis its `triggerPercentage` is
      // informational and pinned to '1' (the pin below rejects a fat-finger like
      // `0.5` at save time). In 'lowest-price' basis level 0's trigger multiplies
      // the window low and is meaningful, so the pin is lifted there.
      .superRefine((val, ctx) => {
        const levels = val.gridLevels;
        const lvl0 = levels[0];
        // Level 0's triggerPercentage is informational only in 'immediate' mode
        // (the entry fires at the current price), so it is pinned to 1 there. In
        // 'lowest-price' mode it IS meaningful — it multiplies the window low to
        // set the entry trigger — so the pin is lifted.
        if (
          val.firstBuyTriggerBasis === 'immediate' &&
          lvl0 !== undefined &&
          Number(lvl0.triggerPercentage) !== 1
        ) {
          // Compared numerically, not by string equality, so the canonical
          // forms `'1'`, `'1.0'`, `'1.00'` are all accepted — operators (and
          // fixtures) write the same value in slightly different shapes.
          ctx.addIssue({
            code: 'custom',
            path: ['gridLevels', 0, 'triggerPercentage'],
            message: `gridLevels[0].triggerPercentage must equal 1 — level 0 is the entry buy and fires at the current price; the value is informational`,
          });
        }
        for (let i = 1; i < levels.length; i += 1) {
          const curLvl = levels[i];
          /* v8 ignore start -- reason: i < levels.length so the indexed access is always defined; the undefined guard exists only for noUncheckedIndexedAccess */
          if (curLvl === undefined) continue;
          /* v8 ignore stop -- reason: end of the unreachable noUncheckedIndexedAccess guard above */
          const cur = Number(curLvl.triggerPercentage);
          if (!(cur < 1)) {
            ctx.addIssue({
              code: 'custom',
              path: ['gridLevels', i, 'triggerPercentage'],
              message: `gridLevels[${i}].triggerPercentage (${curLvl.triggerPercentage}) must be below 1 — a promotion buys below the weighted-average cost basis`,
            });
          }
        }
      })
      .describe(
        'When and how much to buy: your entry size, plus an optional averaging-down ladder that buys more as the price falls below your average cost.',
      ),
    sell: z
      .object({
        enabled: z
          .boolean()
          .describe(
            'Master on/off for selling. Off pauses the stop-loss and trailing sells — leave it on so your positions stay protected.',
          ),
        // Multiplier on avgEntryPrice that triggers the stop-loss MARKET SELL
        // when price drops to or below it. Constrained to (0, 1] so the
        // stop-loss only fires on a LOSS relative to entry; > 1 would fire
        // every tick on a gain. '0' disables.
        stopLossPercentage: decimalString("stopLossPercentage must be empty, '0', or in (0, 1]", {
          gt: 0,
          lte: 1,
          allowEmpty: true,
          allowZeroString: true,
        }).describe(
          '@ui:percent-below Caps your loss: sell at market if price falls this far below your average buy price. 3 means sell if it drops 3% below. Tighter (smaller) means smaller losses but more likely to sell on a dip. Blank disables it.',
        ),
        // Multiplier on avgEntryPrice that arms the trailing-stop window
        // (e.g. '1.05' = trailing engages once price reaches 5% above entry).
        // Must be > 1 to be meaningful; <= 1 would arm immediately and
        // collapse the trailing semantic into the stop-loss path. '0' or
        // empty disables.
        triggerPercentage: decimalString("triggerPercentage must be empty, '0', or > 1", {
          gt: 1,
          allowEmpty: true,
          allowZeroString: true,
        }).describe(
          '@ui:percent-above How far above your average buy price the trailing stop starts following the price up. 5 means it starts trailing once you are 5% up. Blank disables it.',
        ),
        // Multiplier on highSinceBuy that fires the trailing-stop SELL on
        // retrace from the high (e.g. '0.98' = sell when price retraces 2%
        // from the high since trigger). Constrained to (0, 1].
        trailingStopPercentage: decimalString(
          "trailingStopPercentage must be empty, '0', or in (0, 1]",
          { gt: 0, lte: 1, allowEmpty: true, allowZeroString: true },
        )
          .default('0.98')
          .describe(
            '@ui:percent-below Locks in profit once you are up: the bot sells if price drops this far from its highest point since the trail started. 2 means sell after a 2% pullback from the high. Smaller protects more profit but may sell early; larger gives room but hands more back. Blank disables it.',
          ),
        // Opt-in volatility-scaled trailing stop. Schema + rationale on
        // TTAtrTrailingSchema.
        atrTrailing: TTAtrTrailingSchema.describe(
          '@ui:advanced Set the trailing-sell distance from how much price has been swinging lately (its ATR) instead of a fixed percent, so volatile coins get more room. Off by default.',
        ),
        // Opt-in exchange-side protective stop (offline backstop). Schema +
        // rationale on TTProtectiveStopSchema. Off by default.
        protectiveStop: TTProtectiveStopSchema.describe(
          '@ui:advanced Place a backup stop-loss order on Binance itself so it still fires even if the bot is offline. Off by default.',
        ),
        // Opt-in break-even stop. Schema + rationale on TTBreakEvenSchema. Off by
        // default. Fires between the hard stop-loss and the profit trail.
        breakEven: TTBreakEvenSchema.describe(
          '@ui:advanced After a small gain, protect the trade by selling near break-even if price falls back, so a stalled winner does not turn into a loss. Off by default.',
        ),
        // Closed-candle ceiling for a discovery single-entry. A discovery pick is
        // a momentum/breakout bet with a thesis that resolves quickly; if it has
        // neither hit its profit trail nor its hard stop after this many closed
        // candles, the thesis has gone stale and the position is market-sold to
        // free the capital. 0 = OFF (default), so non-discovery positions and
        // existing configs are unaffected. A candle count, not money, so `number`.
        discoveryTimeStopBars: z
          .number()
          .int()
          .nonnegative()
          .default(0)
          .describe(
            '@ui:advanced For a position opened by auto-discovery: sell it after this many candles if it has neither taken profit nor hit its stop, to free up the money from a bet that went nowhere. 0 turns this off. Only affects auto-discovery positions, not ones you enter yourself.',
          ),
        // General time-stop for any NON-discovery position. A position that never
        // reached its sell trigger (the profit trail never armed) after this many
        // closed candles has gone nowhere — market-sell it to free the capital
        // rather than dead-hold. A position that DID reach the trigger is left to
        // the trail. 0 = OFF (default), so existing configs and the golden fixtures
        // are byte-identical. entryAtMs is only stamped on a non-discovery entry
        // when this is enabled (see grid-buy.ts). A candle count, not money.
        timeStopBars: z
          .number()
          .int()
          .nonnegative()
          .default(0)
          .describe(
            '@ui:advanced Sell a position you entered normally after this many candles, but only if it never even reached your sell trigger (it went nowhere). One that did reach the trigger is left to the trailing stop. 0 turns this off. Auto-discovery positions use their own setting.',
          ),
        // Minimum gross profit (percent above average cost) the technicals
        // force-sell needs before it may exit. The force-sell otherwise fires on
        // ANY profit, which on small positions can realise a "win" smaller than
        // the round-trip fee. Set this above the round-trip fee (a market BUY +
        // SELL is ~0.15% with the BNB discount) so a force-sell can only book a
        // net gain. Gross, not net: it does not subtract fees, so leave headroom.
        // '0' = OFF (default): any profit clears, byte-identical to the prior
        // behaviour. Does not touch stop-loss, the profit trail, or the time-stop.
        forceSellMinProfitPercent: decimalString(
          'forceSellMinProfitPercent must be a non-negative decimal',
          { gte: 0 },
        )
          .default('0')
          .describe(
            '@ui:advanced @ui:percentage The least profit, as a percent above your average cost, before a signal-driven sell is allowed to exit. Without it, such a sell can take a gain smaller than the trading fee and lose money. 0.3 means only let it exit at 0.3% or more above cost. 0 turns the floor off.',
          ),
      })
      .describe(
        'When to get out: lock in gains with a trailing stop, or cap a loss with a stop-loss.',
      ),
    // Unified daily-regime block: one MA definition + bear-side actions
    // (cash-rotation exit, promotion suppression). Schema + rationale on
    // TTRegimeSchema. Off by default.
    regime: TTRegimeSchema.describe(
      '@ui:advanced React to the broad daily trend: spend more in an uptrend, sell to cash or sit out a downtrend, or give winners more room in a strong rally. Off by default.',
    ),
    forceBuyOverride: TTForceBuyOverrideSchema.describe(
      '@ui:advanced Turn off individual buy-side safety checks for a coin you have checked yourself. Use with care. Off by default.',
    ),
    // Technicals freshness gate. `useOnlyWithinMin` is the staleness
    // window in minutes (a signal older than this is treated as expired);
    // `ifExpires` is what the buy-side does on expiry — `do-not-buy` is the
    // safer default, `allow-anyway` lets a stale signal still pass the
    // gate. The strategy's technicals-gate reads both off `bundle.technicals.config`
    // every tick; the worker reads this field off the per-profile config
    // and passes it through bundleProvider instead of the previous frozen
    // hardcoded default. Zod 4 `.default()` returns the object verbatim,
    // so the default has to be the fully-shaped object (mirrors the
    // `forceBuyOverride` and `indicatorGate` defaults above).
    // `withParsedDefault` keeps the source of truth single — the contracts
    // schema owns every TV default — and yields a fresh object per parse so a
    // downstream mutation never bleeds into the next config.
    technicals: withParsedDefault(TTTechnicalsBundleConfigSchema).describe(
      '@ui:advanced How fresh a trading signal must be to count, plus the per-timeframe Buy/Sell rules that can allow or block trades.',
    ),
    // Trading fees, so profit-taking exits clear the round-trip cost and a
    // backtest can default to the same fees as live. Off (0) by default.
    fees: TTFeesSchema.describe(
      '@ui:advanced The Binance fees you pay, so profit targets clear the real cost and backtests match your live trading.',
    ),
    // How buy orders are placed: market (taker, default) or passive limit
    // (maker). Default 'market' keeps the prior taker-only behaviour.
    execution: TTExecutionSchema.describe(
      '@ui:advanced How your buys are placed: instantly at market (taker), or as a patient limit order (maker).',
    ),
  })
  .superRefine((cfg, ctx) => {
    // Safety contract: the bull pyramid is the only path that deploys capital UP
    // into strength, so it must not run without a hard size ceiling. Refuse to
    // enable it unless a per-symbol or account exposure cap is armed (the
    // evaluator reuses evaluateRiskCaps, which only bites when one is set).
    // `isCapArmed` is the single owner of the disarm rule (@app/contracts), so
    // the worker gate and the dashboard gauge share this exact semantics.
    if (
      cfg.regime.onBull.pyramid.enabled &&
      !isCapArmed(cfg.buy.maxSymbolExposureQuote) &&
      !readAccountExposureCap(cfg).armed
    ) {
      ctx.addIssue({
        code: 'custom',
        path: ['regime', 'onBull', 'pyramid', 'enabled'],
        message:
          'Bull pyramid needs a safety ceiling: set a per-symbol exposure cap (buy.maxSymbolExposureQuote) or an account exposure cap (buy.accountCap) before enabling it.',
      });
    }
  });
/** Operator-owned configuration that survives restarts and replays; runtime state lives in {@link TTState} instead. */
export type TTConfig = z.infer<typeof TTConfigSchema>;

/**
 * Per-symbol config override schema. An override carries only the keys that
 * should differ from the profile config; the rest inherit. `buy` and `sell`
 * are `.partial()` so their required leaves (`enabled`, `maxPurchaseAmount`,
 * `stopLossPercentage`, …) become optional; the nested gate objects
 * (`indicatorGate`, `autoTriggerBuy`) and `forceBuyOverride` are already
 * all-defaulted, so an override may include or omit them freely. `symbol`
 * (the override row's key) and `candleInterval` (drives the profile's single
 * shared WS subscription, so it cannot vary per symbol) are excluded, and
 * the root is `.strict()` so passing either is rejected. Leaf refinements
 * still fire when a field is present. Cross-field rules — the grid
 * `superRefine` — are NOT re-applied here: the API validates the merged
 * effective config (`mergeConfig(profileConfig, override)`) through
 * {@link TTConfigSchema}, where those rules hold against a realised config.
 */
export const TTOverrideConfigSchema = z
  .object({
    // `z.object(...shape)` rebuilds the buy object from its field map: a
    // fresh, unrefined copy. `.partial()` rejects a schema that still
    // carries a refinement, and the cross-field grid rule is re-checked on
    // the merged config anyway, so dropping it here is intentional.
    buy: z.object(TTConfigSchema.shape.buy.shape).partial(),
    sell: TTConfigSchema.shape.sell.partial(),
    // `.unwrap()` drops the outer `.default()` so an override that omits
    // forceBuyOverride stays omitted (inherits) instead of being filled in.
    forceBuyOverride: TTConfigSchema.shape.forceBuyOverride.unwrap(),
    // Per-symbol Technicals override: the patch-shaped schema (no field
    // defaults) so omitted keys cleanly inherit the profile config. The
    // per-symbol Technicals surface lives here. `mergeConfig` deep-merges
    // the present keys
    // onto the profile's `technicals`, with `intervals[]` replaced
    // wholesale (the operator either sets the per-symbol intervals or
    // inherits the profile's).
    technicals: TTTechnicalsBundleConfigPatchSchema,
    // Per-symbol regime override: a deep-partial patch (no defaults) so an
    // override carries only the regime keys it changes and deep-merge leaves the
    // rest of the profile's regime intact.
    regime: TTRegimePatchSchema,
  })
  .partial()
  // Strict at the root so a stray `symbol` or `candleInterval` in an
  // override is rejected, not silently stripped — both are profile-level
  // (the row key, and the shared WS subscription interval).
  .strict();
/** Parsed per-symbol override; a deep-partial view of {@link TTConfig} the worker deep-merges over the profile config. */
export type TTOverrideConfig = z.infer<typeof TTOverrideConfigSchema>;

/**
 * Current TT state-schema version. Single source of truth shared by the
 * state schema literal and the position adapter's body gate, so the two
 * cannot drift (a stale adapter copy would silently no-op every fill /
 * reconcile merge).
 */
export const TT_STATE_SCHEMA_VERSION = '2.0.0';

/**
 * Every rung a held position can stop at, highest priority first (the resolver
 * documents what each one means). Exported as a value so the attribution table
 * can be checked for completeness: a new rung without an operator-readable
 * explanation would surface in the UI as a bare code.
 */
export const EXIT_BLOCKER_REASONS = [
  'sell-disabled',
  'exit-order-open',
  'exit-unsellable',
  'exit-config-invalid',
  'trail-high-raised',
  'atr-trail-above-price',
  'trail-above-price',
  'awaiting-sell-arm',
  'break-even-floor-not-hit',
  'break-even-not-armed',
  'stop-loss-not-hit',
  'time-stop-pending',
  'no-exit-configured',
] as const;

/**
 * TT-side persisted state. `schemaVersion` is bumped lock-step with
 * `migrateState`; loaders that see a different version refuse to boot rather
 * than silently mutate a stranger's fields.
 */
export const TTStateSchema = z.object({
  schemaVersion: z.literal(TT_STATE_SCHEMA_VERSION),
  avgEntryPrice: z.string().nullable().default(null),
  // Authoritative held base-asset quantity for sell sizing. Maintained by
  // the fill-adopter on every executionReport and reconciled against the
  // wallet at boot. Decoupled from the LBP row's qty column (which records
  // only the most recent BUY's fill quantity and drifts from the wallet on
  // partial sells, external transfers, and BNB fee deductions) and from
  // `wallet.free + locked` (which conflates multiple profiles trading the
  // same base asset). `null` until either the first BUY fill is adopted
  // or the boot reconciler seeds it; sell-sizing paths fall back to
  // wallet.free when null and cap by wallet.free when set.
  heldQuantity: z.string().nullable().default(null),
  disabledUntilMs: z.number().int().nullable().default(null),
  triggers: z
    .object({
      override: z.unknown().nullable(),
    })
    // Function default so each parse yields a fresh object; `initialTTState`
    // derives from `parse({})`, and a shared literal default would alias the
    // `triggers` envelope across every seeded state.
    .default(() => ({ override: null })),
  // High-water mark of currentPrice since avgEntryPrice was set. Null
  // until the first time price >= avgEntryPrice * triggerPercentage in
  // a tick; thereafter the trailing-stop branch in `tick.ts` updates
  // it on every higher close and fires a SELL once price retraces by
  // `trailingStopPercentage`. Cleared together with avgEntryPrice on
  // sell so the cycle restarts. Defaulted to null so a state row
  // serialised before this field was added still parses cleanly.
  highSinceBuy: z.string().nullable().default(null),
  // True once the break-even stop armed for the CURRENTLY-open position: a
  // closed candle confirmed a gain of `sell.breakEven.armAtPercentage`. Sticky
  // until the position closes; while armed AND before the profit trail takes
  // over (`highSinceBuy === null`), a retrace to `sell.breakEven.floorPercentage`
  // market-sells near break-even. Reset to false wherever avgEntryPrice /
  // highSinceBuy reset on a full close or a new entry. Defaulted false and
  // coerced in `normalizeTickState` so a row serialised before this field
  // (arriving `undefined`, not `false`) does not misfire the `=== true` guard.
  // Off-path (break-even disabled) it stays false and is never read, so the
  // golden replay is byte-identical.
  breakEvenArmed: z.boolean().default(false),
  // Index of the currently-held grid level. Null = no position (sell
  // happened or never bought). 0 = entry filled, awaiting either next
  // promotion or sell. N > 0 = promotion N filled. Advances
  // optimistically on each BUY emit; cleared together with
  // avgEntryPrice / highSinceBuy on SELL emit. Defaulted to null so a
  // state row serialised before this field was added still parses
  // cleanly; the state-normalisation step in `tick.ts` bumps it to 0
  // when an existing position is detected.
  currentGridTradeIndex: z.number().int().nonnegative().nullable().default(null),
  // ms-timestamp at which a re-armed first buy is due, or null when no
  // re-arm is pending. Set by the post-sell state construction when
  // `config.buy.autoTriggerBuy.enabled`; consumed (cleared) by the
  // clock-gated branch in `tick.ts` once `<= clock.nowMs()`. Defaulted to
  // null so a state row serialised before this field was added still
  // parses cleanly.
  autoTriggerBuyAtMs: z.number().int().nullable().default(null),
  // Number of bull-pyramid strength-adds made in the CURRENT position, or null
  // when flat / no add yet. The pyramid evaluator reads `(bullAddCount ?? 0)`
  // against `regime.onBull.pyramid.maxAdds`; bumped on each add emit and reset
  // to null wherever avgEntryPrice resets on a full close. Defaulted to null and
  // coerced in `normalizeTickState` so a row serialised before this field
  // (which arrives `undefined`, not `null`, across a non-schema-hop load) does
  // not misfire the `?? 0` / `=== null` guards.
  bullAddCount: z.number().int().nonnegative().nullable().default(null),
  // Reference price the NEXT pyramid add is spaced from: the last add's price,
  // or null to fall back to avgEntryPrice for the first add. Reset with the
  // position on full close. Same default-null + normalize coercion rationale.
  lastBullAddPrice: z.string().nullable().default(null),
  // True iff the CURRENTLY-open position was opened via an armed enterOnAdd
  // discovery hint. Discovery picks momentum/breakouts; a failed breakout that
  // reverses is the expected failure mode, and averaging down into it is the
  // worst reaction. This flag durably marks the position so the strategy holds
  // it as a single entry (no grid promotions) and enforces a required hard stop
  // and an optional time-stop. Reset to false wherever avgEntryPrice resets on a
  // full close. Defaulted false and coerced in `normalizeTickState` so a row
  // serialised before this field (arriving `undefined`, not `false`, across a
  // non-schema-hop load) does not misfire the promotion-suppression guard.
  // Stamped at the entry EMIT, not at fill: in the narrow window where a
  // discovery entry order is resting unfilled, a manual BUY for the same symbol
  // adopts this marker and is treated as the discovery single-entry. Accepted by
  // design — that window is brief and the single-entry handling is the safe side.
  discoveryEntry: z.boolean().default(false),
  // ms-timestamp of the discovery entry, or null when the position is not a
  // discovery entry. Read only by the time-stop, which counts closed candles
  // since this instant. A timestamp, not money, so `number` is correct.
  entryAtMs: z.number().int().nullable().default(null),
  // ms-timestamp the configured force-sell trigger was first seen continuously
  // present, or null when no trigger is pending. The confirm-window gate sets it
  // on the first present tick and clears it the moment the trigger goes absent;
  // the force-sell emits only once `now - forceSellFirstSeenAtMs` reaches the
  // configured window. Defaulted null and coerced in `normalizeTickState` so a
  // row serialised before this field (arriving `undefined`, not `null`, across a
  // non-schema-hop load) reads as the contract null.
  forceSellFirstSeenAtMs: z.number().int().nullable().default(null),
  // ms-timestamp until which fresh first entries on this symbol are suppressed
  // after a technicals force-sell, or null when no cooldown is pending. Stamped
  // at the force-sell emission as `now + forceSellReentryCooldownMinutes * 60000`;
  // every first-entry path skips while `now < forceSellCooldownUntilMs`. Same
  // default-null + normalize coercion rationale as the fields above.
  forceSellCooldownUntilMs: z.number().int().nullable().default(null),
  // ms-timestamp of the most recent LOSS exit on this symbol (stop-loss, or a
  // force-sell / regime-exit taken below cost), or null when none has occurred
  // or the cooldown has lapsed and a re-entry cleared it. Stamped at the loss
  // exit emit; every first-entry path skips while
  // `now < lastLossExitAt + lossCooldownMinutes * 60000`. Deliberately survives
  // a flat position (NOT reset in clearedSellPosition) for the same reason the
  // force-sell cooldown does: the gate must outlive the close to suppress a
  // buy-back. Same default-null + normalize coercion rationale as the fields
  // above.
  lastLossExitAt: z.number().int().nullable().default(null),
  // Reason code of the loss exit that set `lastLossExitAt` (e.g. 'grid-stop-loss',
  // 'technicals-force-sell', 'regime-exit'), or null when no loss exit is in
  // effect. Display-only context; the gate reads only `lastLossExitAt`. Survives
  // a flat position alongside it. Same default-null rationale.
  lastLossExitReason: z.string().nullable().default(null),
  // Consecutive ticks the non-grid first-entry technicals gate has read ALLOW,
  // capped at the configured `technicals.entryConfirmReads`. The hysteresis gate
  // requires the count to reach that threshold before the first buy is permitted,
  // so a single flickering ALLOW does not open a position; a veto resets it to 0.
  // Position-scoped — cleared on every full close. Defaulted 0 and coerced in
  // `normalizeTickState` so a row serialised before this field reads as 0.
  entryConfirmCount: z.number().int().nonnegative().default(0),
  // Structured explanation of why the buy path did NOT open or add this tick, or
  // null when a buy was placed or there is genuinely nothing to block (a held
  // position with no pending entry). Pure data, written into every buy-path
  // terminal so the worker can diff it across ticks and the web can render one
  // plain-language status line ("Not buying: ..."). The reason is a stable
  // kebab-case code; detail carries only the sparse explaining numbers (prices
  // and quantities as decimal-strings, never IEEE-754) so the gloss can fill in
  // values. Defaulted null + coerced in normalizeTickState so a row serialised
  // before this field reads as the contract null.
  entryBlocker: z
    .object({
      reason: z.enum([
        'awaiting-trigger-price',
        'regime-downtrend',
        'regime-unavailable',
        'regime-exit-bear',
        'regime-not-uptrend',
        'technicals-no-signal',
        'technicals-stale',
        'technicals-sell',
        'technicals-disallowed',
        'indicator-rsi',
        'indicator-sma',
        'indicator-ema',
        'indicator-mean-reversion',
        'indicator-unavailable',
        'exposure-cap',
        'account-exposure-cap',
        'loss-budget',
        'force-sell-cooldown',
        'loss-cooldown',
        'technicals-confirming',
        'discovery-no-stop',
        'chase-guard',
        'knife-guard',
        'min-qty',
        'min-notional',
        'min-purchase',
        'invalid-filters',
        'sizing-unconfigured',
        'cap-reached',
      ]),
      detail: z.record(z.string(), z.unknown()).optional(),
    })
    .nullable()
    .default(null),
  // Why an OPEN position has NO exchange-side protective stop, or null when it is
  // armed (or there is nothing to protect). Distinct from `entryBlocker` and the
  // louder of the two: a position can run while its downside protection is refused
  // because a resting order the bot does not control holds the base. Same shape and
  // same persisted-state convention momentum uses, so the api projection and the web
  // gloss read both strategies through one contract. Defaulted null + coerced in
  // `normalizeTickState` so a row serialised before this field reads as the
  // contract null.
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
  // Structured explanation of why the HELD position did not exit this tick, or
  // null when the position is flat or an exit was emitted. The mirror image of `entryBlocker`
  // on the sell side: without it a position that never reaches its sell arm
  // ticks in silence for weeks, and the operator reads that silence as the bot
  // ignoring an exit. The reason names the exit rung the position is waiting on
  // and `detail` carries its threshold (decimal-strings, never IEEE-754) plus
  // `hasDownsideExit`, so a position with no configured exit BELOW the entry is
  // legible from the record alone. Defaulted null + coerced in
  // `normalizeTickState` so a row serialised before this field reads as the
  // contract null.
  exitBlocker: z
    .object({
      reason: z.enum(EXIT_BLOCKER_REASONS),
      // Identity of "the same blocker as last tick" for a consumer that records
      // only CHANGES: the reason plus the rung's threshold, never the live price
      // that rides in `detail` for legibility. Optional so a consumer stays
      // correct (reason-only) against a state that predates it.
      changeKey: z.string().optional(),
      detail: z.record(z.string(), z.unknown()).optional(),
    })
    .nullable()
    .default(null),
});
/** Mutable per-tick state the strategy writes back. Persisted by the executor; never read by other profiles or accounts. */
export type TTState = z.infer<typeof TTStateSchema>;
/** Structured "why no buy this tick" record carried in {@link TTState}; null means a buy fired or nothing was blocking. */
export type EntryBlocker = NonNullable<TTState['entryBlocker']>;
/** Structured "why no exit this tick" record carried in {@link TTState}; null means the position is flat or an exit fired. */
export type ExitBlocker = NonNullable<TTState['exitBlocker']>;

/**
 * Slice of the override bundle the strategy reads each tick. The worker
 * `bundle-builder` performs an atomic GETDEL on the API-written Redis row
 * so a single-shot operator override is observed exactly once even with
 * concurrent ticks; `null` is the steady state. The strategy never writes
 * here — clearing is the worker's atomic-consume.
 */
export const TTOverrideBundleSchema = ManualOverridePayload.nullable();
/** Read-only view of the override row; the strategy must not mutate it because the API owns the writes and the worker owns the consume. */
export type TTOverrideBundle = z.infer<typeof TTOverrideBundleSchema>;

/**
 * Generic per-(profile, symbol) entry hint, set out-of-band by auto-discovery
 * when it adds a symbol with `enterOnAdd` armed. The worker bundle-builder reads
 * the backing Redis key and injects it; discovery writes that key directly, so
 * neither package imports the other (core invariant #1). The strategy treats it
 * as advisory input: on a flat first entry it relaxes the short-interval
 * technicals gate to a Strong-Sell floor. Absent (the steady state) leaves every
 * gate untouched, which is why it is optional — a tick with no hint is the
 * unchanged path and the golden replay stays diff-0.
 */
export const TTEntryHintBundleSchema = z
  .object({
    enterOnAdd: z.boolean(),
    // Anti-chase guard inputs (#473, broadened in #486), refreshed by discovery
    // each cycle and optional so a hint-less tick stays byte-identical (golden
    // replay diff-0): `high24h` is the symbol's current 24h high, and the three
    // knobs mirror the profile's discovery entryGuard config. The guards apply to
    // ANY discovery entry — enterOnAdd or a lowest-price wait — so `enterOnAdd`
    // can be false here; a non-discovery first buy (no hint) never sees them.
    high24h: decimalString('entryHint.high24h must be a non-negative decimal', {
      gte: 0,
    }).optional(),
    maxDistanceFrom24hHighPercent: decimalString(
      'entryHint.maxDistanceFrom24hHighPercent must be a non-negative decimal',
      { gte: 0 },
    ).optional(),
    knifeCandles: z.number().int().optional(),
    knifeDropPercent: decimalString('entryHint.knifeDropPercent must be a non-negative decimal', {
      gte: 0,
    }).optional(),
  })
  .nullable();
export type TTEntryHintBundle = z.infer<typeof TTEntryHintBundleSchema>;

/**
 * Per-tick external inputs the strategy needs that aren't in the core
 * snapshots: the latest Technicals verdict, the manual-override payload (null
 * when no operator action is pending), and the optional discovery entry hint.
 */
export const TTBundleSchema = z.object({
  technicals: TechnicalsBundleSchema,
  override: TTOverrideBundleSchema,
  entryHint: TTEntryHintBundleSchema.optional(),
});
/** Per-tick external inputs the strategy reads but never writes; sourced from bundle providers, separate from market/account snapshots. */
export type TTBundle = z.infer<typeof TTBundleSchema>;

/**
 * Initial persisted state for a newly-onboarded profile. Derived from the
 * schema's own field defaults (`parse({ schemaVersion })`) rather than a
 * hand-written literal, so a new state field carries its `.default(...)` into
 * the seed automatically and the two cannot drift.
 */
export const initialTTState = (): TTState =>
  TTStateSchema.parse({ schemaVersion: TT_STATE_SCHEMA_VERSION });

/**
 * Schema-valid seed config the create-profile wizard pre-fills its editor
 * with. Parsed through {@link TTConfigSchema} so schema defaults fill the
 * omitted fields and the value is guaranteed to pass server validation; the
 * operator edits `symbol` and the knobs before submitting.
 */
export const defaultTTConfig = (): TTConfig =>
  TTConfigSchema.parse({
    symbol: 'BTCUSDT',
    candleInterval: '1h',
    buy: {
      enabled: true,
      entrySizing: { mode: 'fixed', amount: '15' },
      avgEntryPriceRemoveThreshold: '0',
    },
    sell: { enabled: true, stopLossPercentage: '0.97', triggerPercentage: '1.05' },
  });
