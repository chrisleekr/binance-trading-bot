import type { ZodObject, ZodType } from 'zod';
import type { Decimal } from '@app/money';
import type { CandleInterval, WsTopic } from '@app/contracts';

import type { Decision } from './decision.js';

export type OrderSide = 'BUY' | 'SELL';

export type OrderType = 'LIMIT' | 'MARKET' | 'STOP_LOSS_LIMIT';

export type OrderStatus =
  'NEW' | 'PARTIALLY_FILLED' | 'FILLED' | 'CANCELED' | 'PENDING_CANCEL' | 'REJECTED' | 'EXPIRED';

export type TimeInForce = 'GTC' | 'IOC' | 'FOK';

export interface Clock {
  nowMs(): number;
}

export interface RNG {
  next(): number;
}

export interface Candle {
  readonly openTimeMs: number;
  readonly closeTimeMs: number;
  readonly open: string;
  readonly high: string;
  readonly low: string;
  readonly close: string;
  readonly volume: string;
  readonly isClosed: boolean;
}

export interface SymbolFilters {
  readonly minNotional: string;
  readonly tickSize: string;
  readonly stepSize: string;
  readonly minQty: string;
  readonly maxQty: string;
  readonly minPrice: string;
  readonly maxPrice: string;
}

export interface SymbolInfo {
  readonly symbol: string;
  readonly baseAsset: string;
  readonly quoteAsset: string;
  readonly status: string;
  readonly filters: SymbolFilters;
  /**
   * Binance's tradability sets: the account must hold one permission from every
   * set or every order on this symbol is refused. Optional because the cached
   * entries written before the field existed are parsed with an unvalidated cast
   * and there is no migration, so a reader must treat absence as "unknown", never
   * as "permits nothing".
   */
  readonly permissionSets?: readonly (readonly string[])[];
}

export interface ApiLimits {
  readonly weightUsed1m: number;
  readonly weightLimit1m: number;
  readonly headroomBps: number;
}

// Balance amounts are Decimal at the strategy boundary. Wire formats
// (Redis `account-info`, Binance REST DTOs, replay JSONL fixtures) keep
// decimal-strings; each producer revives through one shared helper
// (`apps/worker/src/lib/balance-revive.ts`) before the strategy sees them
// so the wire-tolerance rules cannot drift between revival sites.
export interface Balance {
  readonly asset: string;
  readonly free: Decimal;
  readonly locked: Decimal;
}

export interface OpenOrder {
  readonly orderId: number;
  readonly clientOrderId: string;
  readonly symbol: string;
  readonly side: OrderSide;
  readonly type: OrderType;
  readonly status: OrderStatus;
  readonly price: string;
  readonly origQty: string;
  readonly executedQty: string;
  readonly cummulativeQuoteQty: string;
  readonly stopPrice?: string;
  readonly timeInForce?: TimeInForce;
  readonly transactTimeMs: number;
  readonly updateTimeMs: number;
}

export interface ProfileSnapshot {
  readonly id: string;
  readonly userId: string;
  readonly binanceMode: 'test' | 'live';
  readonly status: 'running' | 'paused' | 'stopped';
  readonly strategyVersion: string;
}

// Per-interval derived market data. The worker's IndicatorComputer writes
// these on each closed candle; money values are decimal-strings so the
// strategy revives them with `Decimal` at its boundary. A null sma/ema/rsi
// means the candle window was shorter than the indicator's period.
export interface IndicatorSnapshot {
  readonly windowSize: number;
  readonly lowestLow: string;
  readonly highestHigh: string;
  readonly sma20: string | null;
  readonly ema20: string | null;
  readonly rsi14: string | null;
  readonly lastCandleCloseTimeMs: number;
}

export interface MarketSnapshot {
  readonly symbol: string;
  readonly currentPrice: string;
  readonly candlesByInterval: Readonly<Partial<Record<CandleInterval, readonly Candle[]>>>;
  readonly symbolInfo: SymbolInfo;
  // Optional: absent on replay fixtures captured before indicators were
  // wired, and per-interval keys are absent until the computer has run.
  readonly indicatorsByInterval?: Readonly<Partial<Record<CandleInterval, IndicatorSnapshot>>>;
}

export interface AccountSnapshot {
  readonly balances: Readonly<Record<string, Balance>>;
  /**
   * Whether the wallet was actually read this tick. `false` means the
   * `account-info` snapshot could not be loaded or parsed, so `balances` is
   * empty out of ignorance, not because the wallet holds nothing. Sizing must
   * fail OPEN on `false` (an empty-but-readable wallet is a KNOWN zero, a
   * distinction an empty map alone cannot carry). Set explicitly at every
   * construction site; never inferred from `balances` being empty.
   */
  readonly readable: boolean;
  /**
   * Total quote-asset cost basis deployed across the account's profiles that
   * share this profile's trading environment — same `binance_mode` and
   * `quote_asset` (sum of `avg_entry_price × quantity` over those open
   * positions, including this profile/symbol), as a decimal-string. The
   * mode + quote scope keeps it an apples-to-apples quote figure: a live tick
   * never folds in test-mode practice positions, and a USDT figure never adds a
   * BTC-quoted cost basis. A generic account-level fact the worker computes from
   * the cost-basis ledger and injects when assembling the tick; a strategy reads
   * it as a scalar so `tick()` stays per-(profile, symbol)-pure. It
   * is a recent snapshot, not a reserved figure — concurrent ticks on other
   * symbols can read the same value and both act, so a consumer cap is a coarse
   * backstop, not an exact allocator.
   *
   * Optional: the worker tick assembler and the backtest engine populate it;
   * other contexts (balance readers feeding the chart/executor, fixtures) omit
   * it, and a consumer treats absence as no cross-profile context (`'0'`).
   */
  readonly deployedQuoteAcrossProfiles?: string;
}

/**
 * Wire form of {@link AccountSnapshot} for {@link PreviewInput.account}: balances
 * as decimal-strings, not `Decimal`. The preview caller is the SPA, which is
 * barred from decimal.js and can only build string balances; a strategy that
 * needs free cash for sizing revives these to `Decimal` at its own boundary
 * (money-math packages may import decimal.js, the web cannot).
 */
export interface AccountSnapshotWire {
  readonly balances: Readonly<Record<string, { readonly free: string; readonly locked: string }>>;
  /** Wire form of {@link AccountSnapshot.deployedQuoteAcrossProfiles}. */
  readonly deployedQuoteAcrossProfiles?: string;
}

export type TriggerEvent =
  | { readonly kind: 'tick' }
  | {
      readonly kind: 'candle-close';
      readonly interval: CandleInterval;
      readonly openTimeMs: number;
    }
  | { readonly kind: 'order-update'; readonly orderId: number }
  | { readonly kind: 'manual' }
  | { readonly kind: 'override-resume' }
  | { readonly kind: 'cron' };

export enum IssueCode {
  ConfigInvalid = 'config-invalid',
  StateCorrupt = 'state-corrupt',
  StateSchemaMismatch = 'state-schema-mismatch',
  MarketStale = 'market-stale',
  AccountUnreachable = 'account-unreachable',
  InsufficientBalance = 'insufficient-balance',
  SymbolPaused = 'symbol-paused',
  InvariantViolated = 'invariant-violated',
}

export interface Issue {
  readonly severity: 'warn' | 'error';
  readonly code: IssueCode;
  readonly message: string;
}

/**
 * One finding from a strategy's config diagnostics. Distinct from
 * {@link Issue} (runtime state/market violations): a diagnostic flags a
 * *configuration* that is inert (silently ignored given the other settings) or
 * conflicting, so the operator is not misconfigured without knowing.
 *
 * `warn` / `info` are advisory — the pure `lintConfig` pass emits these and the
 * schema stays the sole hard-rejection gate for config it can validate alone.
 * `block` is emitted only by `checkOrderFeasibility`, which needs symbol filters
 * + price + balance the schema cannot see; a `block` means the config cannot
 * place a valid order and callers reject the mutation (a real 400), so it is
 * enforced at the mutation boundary rather than in the symbol-agnostic schema.
 * `code` is a stable machine key; `path` is the config field path so a form can
 * locate the setting.
 */
export interface ConfigDiagnostic {
  readonly level: 'warn' | 'info' | 'block';
  readonly code: string;
  readonly message: string;
  readonly path?: readonly string[];
}

export interface LogEntry {
  readonly level: 'debug' | 'info' | 'warn' | 'error';
  readonly message: string;
  readonly context?: Readonly<Record<string, unknown>>;
}

export interface MetricEntry {
  readonly name: string;
  readonly value: number;
  readonly tags?: Readonly<Record<string, string>>;
}

export interface Capabilities {
  readonly candleIntervals: readonly CandleInterval[];
  readonly needsUserDataStream: boolean;
  readonly needsMiniTicker: boolean;
  /**
   * Whether the strategy reads the cross-symbol KV store (tracker #267). When
   * true the worker loads the profile's KV snapshot and passes it as
   * `TickInput.profileKv`; when false/absent it skips that per-tick read, so the
   * per-symbol strategies that need no cross-symbol coupling pay nothing.
   */
  readonly needsProfileKv?: boolean;
  /**
   * Optional per-tick input channels this strategy reads, as tokens from the
   * contracts `BUNDLE_PROVIDERS` set. Typed as `readonly string[]` here — the
   * same loose-in-the-contract convention as `operatorActions` — because the
   * closed set is worker-internal (no wire descriptor) and enforced by the
   * registry consistency test. An empty array means the strategy reads no
   * injected bundle.
   */
  readonly bundleProviders: readonly string[];
  /**
   * Operator actions this strategy honors, as tokens from the contracts
   * `OPERATOR_ACTIONS` set. Typed as `readonly string[]` here — mirroring
   * `bundleProviders` — rather than the contracts enum type; the closed set is
   * enforced at the wire boundary (the descriptor's `z.enum`) and by the
   * registry consistency test. An empty array means the strategy exposes no
   * operator-action surface.
   */
  readonly operatorActions: readonly string[];
}

/**
 * One domain event a strategy emits: the WS `topic` its payload routes to plus
 * the zod schema for that payload. The strategy owns the topic mapping, so the
 * worker's emit-event handler reads the topic from here instead of keeping its
 * own event→topic table — adding an event is a strategy-package edit alone
 * (core invariant #1).
 */
export interface StrategyEvent {
  readonly topic: WsTopic;
  readonly payload: ZodType;
}

/**
 * Per-strategy domain-event vocabulary. Keys are event-type strings the
 * strategy emits via {@link Decision} `emit-event`; each value pairs the WS
 * topic to route on with the zod schema for the payload. The strategy declares
 * the map on its `events` field; {@link Decision} is generic over it so each
 * emit site is tsc-checked on both `eventType` and `payload`.
 */
export type StrategyEventMap = Readonly<Record<string, StrategyEvent>>;

/**
 * Per-tick input. `state` is scoped to `(profile, market.symbol)` — a
 * different symbol's tick on the same profile sees a different `state`
 * object. There is no profile-wide STATE object; cross-symbol coupling goes
 * through the per-profile KV store (tracker #267): a tick writes via `set-kv` /
 * `delete-kv` decisions and reads the merged snapshot via {@link TickInput.profileKv}.
 */
export interface TickInput<
  Config,
  State,
  Bundle extends Readonly<Record<string, unknown>> = Readonly<Record<string, never>>,
> {
  readonly clock: Clock;
  readonly rng: RNG;
  readonly trigger: TriggerEvent;
  readonly profile: ProfileSnapshot;
  readonly config: Config;
  /**
   * Per-(profile, symbol) state slice. The executor loads this row for
   * `market.symbol`, passes it to {@link Strategy.tick}, and persists the
   * returned `nextState` back to the same row.
   */
  readonly state: State;
  readonly market: MarketSnapshot;
  readonly account: AccountSnapshot;
  readonly openOrders: readonly OpenOrder[];
  readonly bundle: Bundle;
  readonly limits: ApiLimits;
  /**
   * Read-only snapshot of this profile's cross-symbol KV store (tracker #267):
   * the merge of every `set-kv` / `delete-kv` decision emitted under a
   * strategy-owned namespaced key. Present only when the strategy opts in via
   * `capabilities.needsProfileKv` — absent (and the worker skips the load) for
   * the per-symbol strategies that need no cross-symbol coupling. A KV mutation
   * in one symbol's tick appears here on subsequent ticks (eventual, per the
   * `set-kv` concurrency note), not within the same tick.
   *
   * Values are JSON-serialised on write and revive as PLAIN JSON, not the class
   * the producer wrote — the same boundary as snapshot `state`. A strategy
   * storing a `Decimal` reads back its decimal-string and must revive it itself
   * (the money-math invariant); a non-JSON-serialisable value fails the write.
   */
  readonly profileKv?: Readonly<Record<string, unknown>>;
}

export interface TickOutput<State, Events extends StrategyEventMap = StrategyEventMap> {
  readonly nextState: State;
  readonly decisions: readonly Decision<Events>[];
  readonly logs: readonly LogEntry[];
  readonly metrics: readonly MetricEntry[];
  /**
   * Optional strategy-typed audit events. Free-form `unknown[]` at the
   * contract layer so each strategy owns its own discriminated union
   * (e.g. trailing-trade's `TTAuditEvent`). The worker forwards this
   * slice to the strategy's {@link Strategy.extractAudit} adapter without
   * inspecting it. Distinct from `logs` (operator-facing pino) and `metrics`
   * (counter/gauge surface) — `events` is the typed audit channel.
   */
  readonly events?: readonly unknown[];
  /**
   * An operator override was present in the bundle and this tick did NOT act on
   * it, because the strategy is transiently unable to (not because the override
   * is invalid). The worker already removed the override from Redis before
   * calling `tick`, so without this signal the operator's one-shot intent — a
   * "flatten now" force-sell — is silently dropped while the UI reports it done.
   * Set it and the worker re-arms the override for the next tick; leave it
   * absent (or false) and the override is consumed, the normal outcome.
   *
   * Only set this when the blocker is transient. A permanent refusal (an
   * exchange filter that can never be satisfied) would re-arm forever.
   *
   * Lives on TickOutput, not on `nextState`: it describes what the worker must
   * do with a worker-owned Redis key, not a fact about the position.
   */
  readonly overrideDeferred?: boolean;
  /**
   * Why this tick declined to act on the override in the bundle — the
   * strategy's own short skip reason. Set it on any tick that emits no order
   * for the override, whether the refusal is permanent or deferred.
   *
   * Without it the worker can only tell the operator "the strategy declined",
   * which is the least useful sentence for the most common case (a manual order
   * that failed a symbol filter). The worker stores it verbatim on the override
   * row so the SPA can show the real reason.
   */
  readonly overrideDeclineReason?: string;
}

/**
 * Generic view of a strategy's open position. The worker's boot
 * reconcilers and fill-adopter read this to make plugin-agnostic
 * `Decimal` decisions (wallet reconcile, phantom-ledger prune, fill
 * resolution) without reading the strategy state body's concrete fields.
 * A plugin maps its own schema onto this view in {@link
 * PositionStateAdapter.readPosition}.
 */
export interface PositionView {
  /**
   * Weighted-average cost basis of the open position — the VWAP of every BUY
   * fill folded in so far, `null` when flat. NOT the last individual fill
   * price: {@link AdoptedFill} re-averages it on each BUY (see the fold in
   * `@app/strategy-core` fill-resolution). Sell-side gates key off this, so it
   * is the position's break-even reference, not a recent-trade marker.
   */
  readonly avgEntryPrice: string | null;
  readonly heldQuantity: string | null;
}

/**
 * An adopted exchange fill the worker has already resolved with `Decimal`
 * math (weighted-average entry price and post-fill quantity). The plugin
 * merges it onto its own state body so the worker never names a field:
 *   - `buy`         — entry/add: set entry price + held quantity, reset
 *                     any trailing high-water mark.
 *   - `sell-reduce` — partial exit: lower the held quantity only.
 *   - `empty`       — full exit: flatten the position.
 */
export type AdoptedFill =
  | { readonly kind: 'buy'; readonly avgEntryPrice: string; readonly heldQuantity: string }
  | { readonly kind: 'sell-reduce'; readonly heldQuantity: string }
  | { readonly kind: 'empty' };

/**
 * Optional position-mutation capability. A strategy that manages a single
 * long position per (profile, symbol) implements this so the worker's boot
 * reconcilers and fill-adopter can converge that position WITHOUT importing
 * the plugin's concrete state schema (core invariant #1). A strategy that
 * omits it is simply skipped by those boot/fill paths — the
 * capability-presence check replaces a hardcoded `schemaVersion` literal
 * gate in the worker.
 *
 * Every method returns the next state body, or `null` to signal "no change"
 * (the caller skips the durable write). Implementations MUST treat the
 * incoming body as their own schema but validate its shape, returning
 * `null` rather than throwing when it is unusable (e.g. an un-migrated
 * older-schema body). A `null` from {@link readPosition} tells the worker
 * the body is not this strategy's current schema, so it defers the row.
 */
export interface PositionStateAdapter<State = unknown> {
  /** Project the generic position view, or `null` when the body shape is unusable. */
  readPosition(state: State): PositionView | null;
  /** Merge an adopted fill onto the body. */
  applyFill(state: State, fill: AdoptedFill): State | null;
  /** Pin the wallet-reconciled held quantity (boot held-quantity reconciler). */
  setHeldQuantity(state: State, heldQuantity: string | null): State | null;
  /** Revive the entry price from the durable ledger (boot avgEntryPrice reviver). */
  setAvgEntryPrice(state: State, avgEntryPrice: string): State | null;
  /**
   * Clear this position's per-cycle fields — the entry price and any
   * trailing high-water mark. The phantom-ledger prune calls it with no
   * options; the operator-triggered `reset-grid-trade` calls it with
   * `{ resetGridIndex: true }` to also abandon the current grid cycle, so a
   * grid strategy clears its own grid-level field (e.g. TT's
   * `currentGridTradeIndex`) without the worker naming it (core invariant
   * #1). A strategy with no grid index treats `resetGridIndex` as a no-op.
   * Returns the cleared body even when already clear, so the durable write
   * stays idempotent across job retries.
   */
  clearPosition(state: State, opts?: { readonly resetGridIndex?: boolean }): State | null;
}

/**
 * What kind of lever a blocker is, so the consumer can tint it and the operator
 * knows whether it is theirs to change:
 *  - `market`: the gate reading the market correctly (e.g. a bearish rating).
 *  - `config`: an entry precondition the operator armed and can relax.
 *  - `sizing`: the order was built but fell below a size floor.
 *  - `data`: warm-up / missing data, resolves over a longer window.
 */
export type ReasonKind = 'market' | 'config' | 'sizing' | 'data';

/**
 * One reason-code attribution entry. This is the single home for ALL per-code
 * display copy, so a new strategy gets a full diagnosis funnel with no consumer
 * change: `gloss` is the plain-language line for the blocker, `kind` tints it,
 * `setting` names the lever, `paths` are the dotted config keys that arm it (in
 * priority order, so the consumer reports the first armed one), and `note` is the
 * context shown when there is no editable lever (a market read or a fixed
 * exchange minimum). A pure `gloss`/`kind` entry (no setting/paths/note) is a
 * legible blocker the operator cannot tune. All strings; no Decimal, no I/O.
 */
export interface ReasonAttributionEntry {
  readonly setting?: string;
  readonly paths?: readonly string[];
  readonly note?: string;
  readonly gloss?: string;
  readonly kind?: ReasonKind;
}

/** Map from a strategy's decision reason/metric code to its {@link ReasonAttributionEntry}. */
export type ReasonAttribution = Readonly<Record<string, ReasonAttributionEntry>>;

/**
 * Tone bucket for a {@link PreviewRow}, driving the operator-facing colour and
 * label of a projected level. A superset of the frontend chart's line tones: it
 * adds `trail` for a trailing-stop level (a stop that ratchets up as price
 * rises) so the preview and the tick share one vocabulary. `neutral` is an
 * informational line the operator cannot act on (a trend line, a target weight).
 */
export type PreviewTone = 'entry' | 'buy' | 'sell' | 'trail' | 'stop' | 'neutral';

/**
 * One projected level in a strategy's {@link PreviewModel}. Plain data; every
 * money field is a decimal-string, never IEEE-754. A row is either PRICE-bearing
 * (a level the tick acts on — entry band, grid rung, stop, trail) or PRICE-LESS
 * (a rebalance basket target carrying `symbol` / `weight` / `drift`, no price).
 *
 * `trigger` marks a row actionable in the CURRENT state (entry/buy rows when
 * flat; exit/stop/trail rows when held); `triggerWhen` names the side
 * `currentPrice` must be on for that action to fire, and the drift gate keys off
 * it. `skip` carries the typed sizing rejection when a band cannot place an
 * order (e.g. `min-notional`), so the operator sees why it shows no size.
 */
export interface PreviewRow {
  readonly code: string;
  readonly label?: string;
  readonly tone: PreviewTone;
  readonly price?: string;
  readonly limitPrice?: string;
  readonly quantity?: string;
  readonly trigger?: boolean;
  readonly triggerWhen?: 'above' | 'below';
  readonly skip?: string;
  readonly symbol?: string;
  readonly weight?: string;
  readonly drift?: string;
  readonly note?: string;
  /** true = this priced row should be drawn as a candle-chart price line. */
  readonly chartLine?: boolean;
}

/** A titled group of {@link PreviewRow}s (e.g. "Entry", "Grid ladder", "Basket"). */
export interface PreviewSection {
  readonly title: string;
  readonly rows: readonly PreviewRow[];
}

/**
 * A strategy's projection of where its config would act, for the operator's
 * pre-trade "what will this do" view and the drift gate. Pure, plain data.
 */
export interface PreviewModel {
  readonly sections: readonly PreviewSection[];
}

/**
 * Input to {@link Strategy.previewLevels}. A subset of {@link TickInput}: the
 * config (possibly UNPARSED — read it defensively), the current state slice
 * (`null` when flat / planning), the reference `entryPrice` (the position's
 * avgEntryPrice, or the price a first entry would fill at) and `currentPrice`,
 * plus the optional market facts a strategy needs to size a level. No clock, no
 * rng, no decisions — the projection is a pure read.
 */
export interface PreviewInput<Config, State> {
  readonly config: Config;
  readonly state: State | null;
  readonly entryPrice: string | null;
  readonly currentPrice: string | null;
  readonly filters?: SymbolFilters;
  readonly candles?: readonly Candle[];
  /**
   * Account balances in WIRE form (decimal-strings), so the SPA — which cannot
   * build `Decimal` — can supply them. A strategy that sizes off free cash
   * revives them to `Decimal` at its boundary. Absent when the caller only wants
   * price levels.
   */
  readonly account?: AccountSnapshotWire;
  /**
   * Quote asset the config's orders are funded in — the balance key
   * {@link AccountSnapshotWire.balances} the sizing epilogue reads for free cash. A
   * projection that shows the live-clamped order size needs it (a fixed size is
   * clamped to free cash); absent when the caller only wants price levels.
   */
  readonly quoteAsset?: string;
}

/**
 * Strategy plugin contract.
 *
 * State scope. The `State` generic is the **per-(profile, symbol) slice** the
 * worker loads, passes to {@link Strategy.tick}, and persists after each tick. A
 * strategy trading multiple symbols on one profile receives one slice per symbol
 * per tick — there is no profile-wide state object. Profile-scoped state goes
 * through the per-profile KV store instead: a tick publishes under a
 * strategy-owned namespaced key via `set-kv` / `delete-kv` decisions and reads
 * the merged snapshot back on later ticks via {@link TickInput.profileKv}, which
 * requires opting in with `capabilities.needsProfileKv`. A KV write is visible to
 * sibling symbols on subsequent ticks, never within the same tick.
 *
 * Concurrency. Ticks for different symbols of the same profile may run in
 * parallel. The executor's `chainByKey` serialises calls per `(profileId,
 * symbol)` only. State writes are atomic per (profile, symbol); fill-adopter
 * mutations acquire the same per-symbol lock. Concurrent sibling ticks are
 * last-writer-wins per KV key, so a strategy republishes its slice each tick.
 * Boot reconcilers rely on pre-queue temporal exclusivity at startup, not the
 * lock.
 */
export interface Strategy<
  Config = unknown,
  State = unknown,
  Bundle extends Readonly<Record<string, unknown>> = Readonly<Record<string, never>>,
  Events extends StrategyEventMap = StrategyEventMap,
> {
  readonly name: string;
  readonly version: string;
  readonly displayName: string;
  readonly description: string;
  readonly capabilities: Capabilities;

  // Must be a zod object schema, not just any `ZodType`: the API serialises
  // it to JSON Schema for the SPA's generated config form, which requires an
  // object root (`type: 'object'` with `properties`). `ZodType<Config>`
  // carries the `Config` output linkage; the `ZodObject` member only adds
  // the object-rooted requirement.
  readonly configSchema: ZodType<Config> & ZodObject;
  // Per-symbol config override surface: a partial view of `configSchema`
  // where every field is optional, so an operator overrides only the keys
  // they change and the rest inherit the profile config. Must be a
  // `ZodObject` for the same JSON-Schema serialisation reason as
  // `configSchema`. The merged result (`mergeConfig(profileConfig,
  // override)`) is the value re-checked against `configSchema`, so
  // cross-field refinements live there, not here.
  readonly overrideConfigSchema: ZodObject;
  readonly stateSchema: ZodType<State>;
  readonly bundleSchema: ZodType<Bundle>;

  /**
   * Domain-event vocabulary this strategy emits. Each entry pairs an event
   * type string with the zod schema for that event's payload. The
   * {@link Decision} `emit-event` variant is generic over this map, so a
   * mistyped `eventType` or `payload` is a compile-time error at the
   * strategy call site — no runtime parse needed at the executor.
   */
  readonly events: Events;

  // A schema-valid config the create-profile wizard seeds its editor with.
  // The strategy owns this because a valid config cannot be synthesised from
  // `configSchema` alone (required fields have no defaults). Implementations
  // MUST build it by parsing a seed object through `configSchema` so schema
  // defaults and refinements are applied — see trailing-trade's
  // `defaultTTConfig`.
  readonly defaultConfig: Config;

  /**
   * Optional position-mutation capability used by the worker's boot
   * reconcilers, fill-adopter, and the `reset-grid-trade` pipeline handler
   * (via `clearPosition({ resetGridIndex: true })`). Present when the
   * strategy manages a single long position per (profile, symbol); absent
   * strategies are skipped by those paths. See {@link PositionStateAdapter}.
   */
  readonly position?: PositionStateAdapter<State>;

  /**
   * Narrow this strategy's own {@link TickOutput.events} slice into the block
   * the worker merges into the tick's audit-log payload, or `undefined` when
   * the tick emitted nothing worth auditing (the common case — keeping the
   * payload small). The strategy owns the interpretation because it owns the
   * event union: the worker never inspects `events`.
   *
   * Return top-level keys namespaced to this strategy's vocabulary (e.g.
   * `{ technicals: { forceSell: ... } }`); the worker refuses keys that would
   * clobber its own audit fields. Absent on strategies that emit no events.
   *
   * Pure: no I/O, no clock, no randomness — it runs inside the tick path.
   */
  readonly extractAudit?: (
    events: readonly unknown[],
  ) => Readonly<Record<string, unknown>> | undefined;

  initialState(config: Config): State;

  /**
   * AUTHORITATIVE attribution: did THIS profile, running THIS strategy on THIS
   * symbol, place the order carrying `clientOrderId`? Answered by recomputing the
   * deterministic ids the strategy would emit for `(profileId, symbol, config)`
   * and testing membership — the id scheme is strategy-owned, so only the
   * strategy can answer, and it is the sole reason `apps/api` can adopt an orphan
   * order without asking the operator to guess.
   *
   * It gates adoption; it is not a hint. Adopting an order back to the profile
   * that placed it is safe by construction — the strategy recognises its own id
   * and simply resumes managing the order. Adopting it anywhere ELSE hands one
   * strategy's resting order to another, which cannot recognise, reprice, or
   * cancel it; the base asset stays locked, the true owner's own order is refused
   * for want of free balance, and the profile wedges. So a `null` here is a hard
   * refusal, never a "pick one yourself".
   *
   * The returned `intent` is the strategy's OWN slot name for the order (the same
   * `intent.reason` its `place-order` decision would carry), so the adopted row
   * lands in the slot the strategy actually uses rather than a generic bucket it
   * can never account for.
   *
   * Return null when the id is unattributable — including ids the strategy DID
   * emit but cannot re-derive because they fold unbounded runtime data (a candle
   * close time, a UUID) into the hash. Under-claiming is safe (the operator is
   * told the order is not adoptable); over-claiming is not. Omit the method
   * entirely on a strategy whose ids are all unenumerable.
   *
   * Pure: no I/O, no clock, no randomness.
   */
  attributeOrder?(input: {
    readonly clientOrderId: string;
    readonly profileId: string;
    readonly symbol: string;
    readonly config: Config;
  }): { readonly intent: string } | null;

  migrateState?(input: { readonly fromVersion: string; readonly state: unknown }): State;

  /**
   * Reconcile a tick commit that lost a cross-pod CAS race. A concurrent fill
   * on the account's stream-owner pod advanced the (profile, symbol) slice's
   * `version` mid-tick, so the worker re-reads the fill's authoritative body
   * (`base`) and asks the strategy to graft only the non-re-derivable latch
   * fields the tick stamped at its exit transition (loss-cooldown anchor,
   * force-sell re-entry deadline, scheduled re-arm) from `latchSource` (the
   * tick's would-be next state) onto it. Returns the merged body to CAS-write
   * again.
   *
   * Pure: return a new body, mutate neither input. MUST NOT copy position or
   * order state from `latchSource` — `base` owns those; graft only the latch
   * fields, preferring the more-recent value so a cooldown is never moved
   * earlier. NEVER reached at single replica (`chainByKey` serialises
   * tick-vs-fill, so a tick commit never CAS-misses); absent on strategies
   * with no latch field that outlives the position it was stamped in.
   */
  mergeConcurrent?(input: { readonly base: State; readonly latchSource: State }): State;

  validateInvariants?(input: {
    readonly state: State;
    readonly market: MarketSnapshot;
  }): readonly Issue[];
  /**
   * Pure, advisory lint of a (schema-valid) config: flags settings that are
   * inert or conflicting given the rest of the config — e.g. an entry-sizing
   * mode set while a grid ladder makes it inert. No I/O, deterministic. Called
   * by the API on a draft config so the operator sees the silent gotchas before
   * saving. Absent on strategies with nothing to lint.
   */
  lintConfig?(config: Config): readonly ConfigDiagnostic[];

  /**
   * Pure feasibility check of a (schema-valid) config against ONE symbol's live
   * order minimums and the available quote balance. Unlike {@link lintConfig},
   * this needs runtime facts the schema cannot see — the symbol's `SymbolFilters`
   * (`minQty` / `minNotional` / `stepSize`), a reference `price`, and the quote
   * balance that must fund the orders — so it lives here rather than in the
   * symbol-agnostic schema. Resolves each entry / grid-level order the config
   * would place to a quote amount, checks each against the minimums at `price`
   * (reusing the same sizing epilogue `tick()` uses), and checks the whole ladder
   * fits `availableQuote`. Emits `block`-level diagnostics the caller turns into a
   * hard rejection; empty when every order is fundable and clears its minimum.
   *
   * Per-symbol by design: the caller loops the profile's bound symbols. No I/O,
   * deterministic. Absent on strategies that place no exchange orders.
   *
   * `availableQuote` is optional: pass the quote balance to also check the whole
   * ladder is fundable, or omit it (balance unknown, e.g. a profile with no live
   * wallet snapshot) to run only the per-order minimum checks, which need just
   * `price` and `filters`.
   */
  checkOrderFeasibility?(input: {
    readonly config: Config;
    readonly filters: SymbolFilters;
    readonly price: string;
    readonly availableQuote?: string;
  }): readonly ConfigDiagnostic[];

  /**
   * Static map from a decision reason/metric code (the strings this strategy
   * emits on entry-blocker logs and veto metrics) to the config setting that
   * armed it. Lets the SPA name the exact lever behind each backtest blocker
   * off the strategy's own declaration instead of a copy hardcoded in the web
   * (core invariant #1). Plain data, no I/O; serialised verbatim onto the
   * public {@link Strategy} descriptor. Absent on strategies that expose no
   * tunable entry levers.
   */
  readonly reasonAttribution?: ReasonAttribution;

  /**
   * Maximum candle lookback (in candles, on the strategy candle interval) this
   * config needs to evaluate every decision — the longest moving-average period,
   * window-low scan, or z-score lookback the config enables. The worker sizes the
   * candle window fed to `tick()` from this in BOTH live and backtest, so a
   * config's lookback behaves identically in both worlds: a setting larger than
   * the default window is honoured everywhere instead of being silently starved
   * live (a fixed-window load) yet active in backtest (a longer rolling window).
   *
   * Reads the config DEFENSIVELY — the live worker may pass it UNPARSED (raw
   * JSON), so the implementation coerces and optional-chains and never throws.
   * Returns a plain candle count; the caller floors it at the default window, so
   * returning a smaller value never shrinks the window. Absent on strategies
   * whose lookback never exceeds the default window.
   */
  requiredWindow?(config: Config): number;

  /**
   * Extra candle history the preview needs BEYOND the tick window, as
   * `{ interval, frames }` pairs — e.g. a daily-regime line needs N daily
   * candles the per-tick window does not carry. Empty / absent when the preview
   * reads only the tick's own window. Reads the config DEFENSIVELY (the live
   * worker may pass it unparsed); deterministic, no I/O.
   */
  previewDataNeeds?(
    config: Config,
  ): readonly { readonly interval: string; readonly frames: number }[];

  /**
   * Project where this config would act as a set of price / level rows, for the
   * operator's pre-trade view AND the drift gate ({@link
   * assertPreviewTickAgreement}). Pure and deterministic; reads the config
   * DEFENSIVELY (the live worker may pass it unparsed). STATE-AWARE: set
   * `trigger` only on rows actionable in the given `state` (entry rows when
   * flat, exit / stop / trail rows when held). Required on every strategy.
   */
  previewLevels(input: PreviewInput<Config, State>): PreviewModel;

  tick(input: TickInput<Config, State, Bundle>): TickOutput<State, Events>;
}
