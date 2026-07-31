import { z } from 'zod';
import { SaveDiagnostics } from './config-lint.js';
import { EdgeMonitorPolicy, DEFAULT_EDGE_MONITOR_POLICY } from './edge-monitor.js';
import { ProfileNotifyEvents, DEFAULT_PROFILE_NOTIFY_EVENTS } from './notify-events.js';

/** Selects the Binance environment a profile trades against. `test` means testnet keys; `live` means real money. */
export const BinanceMode = z.enum(['test', 'live']);
/** TS type derived from {@link BinanceMode} so consumers don't re-run z.infer at every call site. */
export type BinanceMode = z.infer<typeof BinanceMode>;

/**
 * Profile display name. `.trim()` normalises padding before the length and
 * charset checks run; the charset matches the wizard's "letters, numbers,
 * spaces, dashes, and underscores" hint so the promise is enforced server-side.
 */
export const ProfileName = z
  .string()
  .trim()
  .min(1)
  .max(64)
  .regex(
    /^[A-Za-z0-9 _-]+$/,
    'Profile name can only contain letters, numbers, spaces, dashes, and underscores.',
  );

/**
 * The profile's trading quote currency (e.g. `USDT`, `BTC`). A plain exchange
 * symbol label, uppercased by the API before it is stored, so the stored value
 * matches the suffix discovery and the order paths compare against.
 */
export const QuoteAsset = z.string().min(2).max(16);
/** TS type derived from {@link QuoteAsset} so consumers don't re-run z.infer at every call site. */
export type QuoteAsset = z.infer<typeof QuoteAsset>;

/**
 * Equity-benchmark mode for the dashboard's "vs holding" line. `btc` holds BTC;
 * `basket` holds an equal-weight basket of the profile's own traded symbols —
 * the honest "did I beat the coins I picked, not just BTC" comparator.
 */
export const BenchmarkMode = z.enum(['btc', 'basket']);
/** TS type derived from {@link BenchmarkMode} so consumers don't re-run z.infer at every call site. */
export type BenchmarkMode = z.infer<typeof BenchmarkMode>;

/**
 * Live-enablement edge gate policy. Before a profile can be enabled in `live`
 * mode it must have a recent backtest, run on its CURRENT config, that clears
 * these net-of-fee thresholds. `enabled: false` turns the gate off for the
 * profile — a deliberate, visible opt-out, not a silent bypass. All metrics are
 * net-of-fee because the backtest engine charges fees on every simulated fill.
 */
export const EnablementPolicy = z.object({
  /** Master switch. When false the profile can be enabled live without a passing backtest. */
  enabled: z.boolean().default(true),
  /** Minimum net profit factor (gross win / gross loss). 1.0 = break-even. */
  minProfitFactor: z.number().nonnegative().default(1.1),
  /**
   * Minimum closed-trade count. A profit factor over a tiny sample is noise — a
   * config with no real edge clears 1.1 over 30 trades by luck a large fraction
   * of the time. 100 is a practical floor for the estimate to be more signal than
   * noise; it is NOT a significance guarantee (trade returns are non-normal and
   * autocorrelated), which is why `requireOutOfSample` below is the real
   * curve-fit defence, not the count.
   */
  minTrades: z.number().int().nonnegative().default(100),
  /** Minimum return beyond buy-and-hold, in percent. 0 = must at least match holding. */
  minAlphaVsHoldPct: z.number().default(0),
  /**
   * Require the edge to also clear `minProfitFactor` and `minAlphaVsHoldPct` in
   * the backtest's OUT-OF-SAMPLE holdout (the most-recent 30%, a slice the config
   * tuning never targeted). This is the defence against curve-fitting a single
   * window: a config that looks good only in-sample fails here. Default on (the
   * honest, fail-safe bar). A backtest run before the holdout shipped — or too
   * short to carve one — has no holdout and fails the check, so the operator
   * re-runs the backtest.
   */
  requireOutOfSample: z.boolean().default(true),
  /**
   * Minimum closed-trade count IN the out-of-sample holdout for its metrics to
   * count. The holdout is ~30% of the run, so it naturally holds fewer trades;
   * below this the holdout PF/alpha are themselves too noisy to trust and the
   * gate fails. Ignored when `requireOutOfSample` is off.
   */
  minOutOfSampleTrades: z.number().int().nonnegative().default(20),
  /** Reject a backtest older than this many days — config/market drift staleness. */
  maxBacktestAgeDays: z.number().int().positive().default(14),
  /**
   * Live edge-decay monitor. The thresholds above gate enabling; this watches a
   * profile AFTER it is live and reacts when realized net edge falls below the
   * pinned baseline. Defaulted so a profile (or fixture) predating the field
   * still parses.
   */
  monitor: EdgeMonitorPolicy.default(() => DEFAULT_EDGE_MONITOR_POLICY),
});
export type EnablementPolicy = z.infer<typeof EnablementPolicy>;
/** The effective policy when a profile has not customised one (column is null). */
export const DEFAULT_ENABLEMENT_POLICY: EnablementPolicy = EnablementPolicy.parse({});

/**
 * Body for `POST /profiles`. `config` is `unknown` here because the strategy
 * registry validates it against the strategy-specific schema, keeping it
 * loose at the API boundary lets new strategies ship without touching this
 * file.
 */
export const ProfileCreate = z.object({
  name: ProfileName,
  strategyName: z.string().min(1),
  strategyVersion: z.string().min(1),
  config: z.unknown(),
});
/** TS type derived from {@link ProfileCreate} so consumers don't re-run z.infer at every call site. */
export type ProfileCreate = z.infer<typeof ProfileCreate>;

/** Partial update for `PATCH /profiles/:id`. All fields optional so the operator can flip just `enabled`. */
export const ProfilePatch = z.object({
  name: ProfileName.optional(),
  enabled: z.boolean().optional(),
  config: z.unknown().optional(),
  /** Trading quote currency. Optional so the operator can change just the quote. */
  quoteAsset: QuoteAsset.optional(),
  /** Equity-benchmark mode. Optional so the operator can flip just the comparator. */
  benchmarkMode: BenchmarkMode.optional(),
  /**
   * Backtest run pinned as the live scorecard's baseline. A uuid pins it (the
   * run must belong to the profile and be finished), null clears it; absent
   * leaves it unchanged.
   */
  baselineBacktestRunId: z.uuid().nullable().optional(),
  /**
   * Live-enablement gate policy. A full policy object replaces it; `null` resets
   * the profile to the defaults; absent leaves it unchanged. Partial fields fill
   * from {@link EnablementPolicy} defaults.
   */
  enablementPolicy: EnablementPolicy.nullable().optional(),
  /**
   * Per-event notification subscriptions. A full map replaces it; `null` resets
   * the profile to the defaults (every event on); absent leaves it unchanged.
   * The web sends the complete map (toggle one, keep the rest), since a partial
   * map fills unspecified categories from the defaults.
   */
  notifyEvents: ProfileNotifyEvents.nullable().optional(),
});
/** TS type derived from {@link ProfilePatch} so consumers don't re-run z.infer at every call site. */
export type ProfilePatch = z.infer<typeof ProfilePatch>;

/**
 * Response shape for `GET /profiles/:id`. `config` is `unknown` for the same
 * registry-owns-validation reason as {@link ProfileCreate}; clients narrow
 * via the strategy schema.
 */
export const ProfileResponse = z.object({
  id: z.uuid(),
  accountId: z.uuid(),
  name: z.string(),
  strategyName: z.string(),
  strategyVersion: z.string(),
  config: z.unknown(),
  enabled: z.boolean(),
  // The Binance environment. Not a profile column — the API fills it from the
  // profile's parent account (a key pair, hence one environment, is account-level).
  binanceMode: BinanceMode,
  quoteAsset: QuoteAsset,
  // Defaulted so a response (or test fixture) predating this field still parses;
  // the API always supplies it from the row's NOT NULL default-'btc' column.
  benchmarkMode: BenchmarkMode.default('btc'),
  /** Pinned baseline backtest run id, or null when none is set. */
  baselineBacktestRunId: z.uuid().nullable().default(null),
  /**
   * Effective live-enablement gate policy. Defaulted so a response or fixture
   * predating this field still parses; the API always supplies it, filling the
   * contract defaults when the profile's column is null.
   */
  enablementPolicy: EnablementPolicy.default(() => DEFAULT_ENABLEMENT_POLICY),
  /**
   * Per-event notification subscriptions. Defaulted so a response or fixture
   * predating this field still parses; the API always supplies it, filling the
   * defaults (every event on) when the profile's column is null.
   */
  notifyEvents: ProfileNotifyEvents.default(() => DEFAULT_PROFILE_NOTIFY_EVENTS),
  createdAt: z.iso.datetime(),
  updatedAt: z.iso.datetime(),
  /**
   * Present only on a config save that went through but could not be fully
   * checked. Absent on a read and on a clean save.
   */
  diagnostics: SaveDiagnostics,
});
/** TS type derived from {@link ProfileResponse} so consumers don't re-run z.infer at every call site. */
export type ProfileResponse = z.infer<typeof ProfileResponse>;

/** Response shape for `GET /profiles`. Plain array; list is small (single-account) so no pagination. */
export const ProfileList = z.array(ProfileResponse);
/** TS type derived from {@link ProfileList} so consumers don't re-run z.infer at every call site. */
export type ProfileList = z.infer<typeof ProfileList>;

/**
 * Body for `POST /profiles/:id/switch-strategy`. The route resets state to
 * the new strategy's `initialState(config)` and auto-pauses (sets
 * `enabled = false`) so an in-flight tick can't run the half-swapped
 * profile. Persistent records (orders, archive) are intentionally
 * preserved; the operator's audit trail survives the swap.
 */
export const SwitchStrategyRequest = z.object({
  strategyName: z.string().min(1),
  strategyVersion: z.string().min(1),
  config: z.unknown(),
});
/** TS type derived from {@link SwitchStrategyRequest} so consumers don't re-run z.infer at every call site. */
export type SwitchStrategyRequest = z.infer<typeof SwitchStrategyRequest>;

/**
 * What to do with a profile's live exposure when it is deleted. Deleting a
 * profile used to ABANDON its resting Binance orders: the rows cascaded away
 * locally while the orders stayed on the exchange, locking the operator's coins
 * with nothing left pointing at them. There is no "just delete it" any more —
 * the operator picks a disposition and the worker carries it out.
 *
 *  - `cancel-orders`: cancel every resting order on Binance, then delete. The
 *    coins are released back to the wallet; any position becomes plain holdings.
 *  - `handoff`: cancel the resting orders (their clientOrderIds encode THIS
 *    profile, so the target strategy could never recognise them) and re-point the
 *    POSITION to another profile of the same account, which arms its own stop on
 *    its next tick.
 */
export const ProfileDeleteDisposition = z.enum(['cancel-orders', 'handoff']);
/** TS type derived from {@link ProfileDeleteDisposition} so consumers don't re-run z.infer at every call site. */
export type ProfileDeleteDisposition = z.infer<typeof ProfileDeleteDisposition>;
