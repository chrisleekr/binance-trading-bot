// The closed catalogue of worker metrics, and the sink contract keyed to it.
//
// This module is a LEAF on purpose: it imports nothing from the worker. The sink
// contract has to name the metric union, and every emitter has to name the sink,
// so anything this file imported would come back as a cycle through `state/` or
// `boot/` — and `import/no-cycle` runs whole-repo, so the cycle would fail lint
// rather than merely being ugly.
//
// `MetricName` is written out as a union rather than derived via
// `keyof typeof CATALOG`. Deriving it reads better, but `isolatedDeclarations`
// (on repo-wide) rejects an object literal whose type an exported declaration
// depends on, with or without `as const satisfies`. Annotating CATALOG with
// `Record<string, …>` instead would widen the keys and collapse `MetricName` to
// `string`, silently un-checking every call site. So the union is the declared
// contract and the object is checked against it: `Record<MetricName, MetricSpec>`
// rejects a missing key (TS2741) and an unlisted one (TS2353), which keeps the
// two provably in step in both directions.
//
// Cardinality guard: the metric NAME set being closed mirrors the closed `reason`
// enum behind otel_dropped_spans_total, so a typo'd or ad-hoc name can never
// spawn an unbounded metric. Label VALUES (profileId, symbol) are operationally
// bounded by the deployment's profile×symbol count — the existing
// one-series-per-(profile, symbol) assumption — so they ride as plain labels.

export type MetricKind = 'counter' | 'gauge' | 'histogram';

export interface MetricSpec {
  readonly kind: MetricKind;
  readonly help: string;
  readonly labelNames: readonly string[];
  /** Histogram bucket bounds. Required for `kind: 'histogram'`, ignored otherwise. */
  readonly buckets?: readonly number[];
}

// Latency in ms: sub-ms ticks are common on the noop path, slow ticks run into
// the low seconds against a stalled dependency.
export const LATENCY_MS_BUCKETS = [1, 5, 10, 25, 50, 100, 250, 500, 1000, 2500, 5000] as const;

// Entries flushed per audit drain pass, never zero (an empty read returns
// early). The value sums every stream in one XREADGROUP reply and there is one
// stream per profile, while Redis applies the COUNT of 500 PER stream — so a
// fully backlogged pass reads 500 x streams, not 500. The top of the range has
// to clear that product or "was this pass capped?" collapses into +Inf exactly
// when the drainer is furthest behind; 10000 covers twenty saturated profiles,
// and a distribution piling up in +Inf is itself the signal to raise it. The
// low end stays dense because a caught-up drainer sits at 1-5 entries and the
// interesting move is small to large; reusing the latency bounds would resolve
// nothing below 25.
const AUDIT_BATCH_BUCKETS = [1, 2, 5, 10, 25, 50, 100, 250, 500, 1000, 2500, 5000, 10000] as const;

/**
 * Every metric name the worker emits. Adding a member here is what makes a name
 * callable; there is no other way to reach the sink, because `record()` accepts
 * only this union.
 *
 * That matters more than it looks. The prom-client adapter drops an unknown name
 * silently — no series, no log, no error — so an uncatalogued metric would not
 * merely lose a measurement, it would read zero forever and be indistinguishable
 * from a healthy path that never fired. Making the name space a type moves that
 * from "a lint gate might notice" to "it does not compile".
 */
export type MetricName =
  | 'tick_latency_ms'
  | 'tick_total'
  | 'tick_failures_total'
  | 'decision_count'
  | 'bullmq_queue_wait_jobs'
  | 'pg_pool_idle'
  | 'pg_pool_total'
  | 'pg_pool_waiting'
  | 'binance_ws_disconnects_total'
  | 'tick_throttled_kill_switch'
  | 'tick_throttled_symbol_pause'
  | 'tick_throttled_override_claim'
  | 'tick_throttled_redis_unavailable'
  | 'binance_api_weight'
  | 'order_budget_deferred'
  | 'state_commit_persist_error'
  | 'state_commit_persist_timeout'
  | 'state_commit_cas_miss'
  | 'state_commit_latch_merged'
  | 'state_commit_latch_merge_exhausted'
  | 'state_commit_latch_merge_error'
  | 'audit_batch_size'
  | 'audit_stream_length'
  | 'audit_consumer_lag'
  | 'audit_consumer_pending'
  | 'audit_consumer_lag_unknown'
  | 'audit_entries_reclaimed'
  | 'audit_read_no_body'
  | 'audit_entries_stuck'
  | 'audit_poison_entries_dropped'
  | 'exchange_info_filters_unparseable_total'
  | 'exchange_info_band_unparseable_total'
  | 'exchange_info_trailing_delta_unparseable_total'
  | 'strategy_metric_total'
  | 'cron_overrun_total'
  | 'archive_recovery_sweep_profiles_total';

/**
 * The spec behind each name. Exhaustive by construction: a name in the union with
 * no entry here fails to compile, and an entry with no name in the union does too.
 *
 * Kind and labels follow the call site's semantics, not the name suffix:
 * `binance_api_weight` is a point-in-time gauge (Binance's rolling 1m weight)
 * rather than a monotonic counter, and `audit_batch_size` declares no labels
 * because its call site passes no tags — declaring one would stamp it
 * `unknown` on every series and invent a dimension the metric does not have.
 */
export const CATALOG: Readonly<Record<MetricName, MetricSpec>> = {
  tick_latency_ms: {
    kind: 'histogram',
    help: 'Tick handler wall-clock latency in milliseconds.',
    labelNames: ['profileId', 'symbol'],
    buckets: LATENCY_MS_BUCKETS,
  },
  // The denominator every tick-health ratio needs. `tick_latency_ms` is observed
  // on the success path only, so a worker whose ticks all throw reports no
  // latency and no failures: it reads as idle, which is indistinguishable from
  // healthy. This one moves on every path — success, throttled skip, throw.
  tick_total: {
    kind: 'counter',
    help: 'Tick handler invocations, counted on every outcome: completed, throttled and thrown alike.',
    labelNames: ['profileId', 'symbol'],
  },
  // The numerator. Deliberately NOT incremented on a throttled skip: a paused
  // symbol or an engaged kill-switch is the operator's own instruction, and
  // counting it would hold a failure-ratio alert on for as long as the pause.
  tick_failures_total: {
    kind: 'counter',
    help: 'Tick handler invocations that threw. Throttled skips are not failures and are excluded.',
    labelNames: ['profileId', 'symbol'],
  },
  decision_count: {
    kind: 'counter',
    help: 'Strategy decisions emitted, accumulated across ticks.',
    labelNames: ['profileId', 'symbol'],
  },
  // Runtime pressure. Queue backlog and pool exhaustion both present as "ticks
  // are late" and need opposite responses, so each carries its own series.
  // Labelled by queue: a stuck pipeline queue and a stuck tick queue mean
  // different things, and one unlabelled number can say neither.
  bullmq_queue_wait_jobs: {
    kind: 'gauge',
    help: 'Jobs waiting in this BullMQ queue, sampled on the runtime-gauge interval.',
    labelNames: ['queue'],
  },
  // The pool is process-wide, so these carry no labels; adding one would stamp
  // every series 'unknown' and invent a dimension the metric does not have.
  // `waiting` is the one that means trouble — clients blocked with no connection
  // to hand them — while idle/total is the context that says whether the pool is
  // small or simply busy.
  pg_pool_idle: {
    kind: 'gauge',
    help: 'Postgres pool connections currently idle.',
    labelNames: [],
  },
  pg_pool_total: {
    kind: 'gauge',
    help: 'Postgres pool connections currently open, idle and in use together.',
    labelNames: [],
  },
  pg_pool_waiting: {
    kind: 'gauge',
    help: 'Callers queued for a Postgres connection because the pool had none free.',
    labelNames: [],
  },
  // A flapping user-data stream is invisible from outside: the pool reconnects,
  // profiles keep ticking, and the only trace is a log line. Per account,
  // because the remedy (re-issuing that account's key) is per account.
  binance_ws_disconnects_total: {
    kind: 'counter',
    help: 'User-data stream sockets closed for this account, counted once per close. A watchdog reconnect closes the stale socket itself, so it registers as the one disconnect it is.',
    labelNames: ['accountId'],
  },
  tick_throttled_kill_switch: {
    kind: 'counter',
    help: 'Ticks short-circuited because the profile kill-switch was engaged.',
    labelNames: ['profileId', 'symbol'],
  },
  tick_throttled_symbol_pause: {
    kind: 'counter',
    help: 'Ticks short-circuited because the symbol was paused (per-coin pause flag).',
    labelNames: ['profileId', 'symbol'],
  },
  // The claim gate and the governor's backpressure are SILENT skips: no order, no
  // state commit, no audit row, and the override case writes no action_log either. A
  // counter is the only numeric trace either one leaves, so a missing entry here
  // would make them invisible rather than merely unmeasured.
  tick_throttled_override_claim: {
    kind: 'counter',
    help: 'Ticks stood down because the override_actions row could not be claimed (operator cancel won, or the claim was unconfirmable).',
    labelNames: ['profileId', 'symbol'],
  },
  tick_throttled_redis_unavailable: {
    kind: 'counter',
    help: 'Ticks skipped because the weight governor could not reach Redis on a bulk read.',
    labelNames: ['profileId'],
  },
  binance_api_weight: {
    kind: 'gauge',
    help: 'Binance used request weight in the last 1m window, as reported on the tick response.',
    labelNames: ['profileId'],
  },
  // A deferred reprice leaves no order at Binance and raises no operator alert,
  // so this counter is its only numeric trace — the audit row records it, but
  // one row per tick is not something an operator watches. Without this counter
  // a saturated order budget is indistinguishable from a market that simply
  // stopped moving.
  order_budget_deferred: {
    kind: 'counter',
    help: 'Order batches skipped for this tick because the account had no Binance ORDERS headroom.',
    labelNames: ['profileId', 'symbol'],
  },
  state_commit_persist_error: {
    kind: 'counter',
    help: 'Symbol-state PG persist rejected on the tick commit path (degrade-to-warn).',
    labelNames: ['profileId', 'symbol'],
  },
  state_commit_persist_timeout: {
    kind: 'counter',
    help: 'Symbol-state PG persist exceeded the tick commit timeout (degrade-to-warn).',
    labelNames: ['profileId', 'symbol'],
  },
  // The CAS and latch-merge outcomes are the only numeric trace of a commit
  // that silently lost or dropped state. Each one is paired with a log line,
  // but a log is per-event: only a counter shows whether the case fires once a
  // day or on every tick, which is the difference between a curiosity and a
  // scale-out blocker.
  state_commit_cas_miss: {
    kind: 'counter',
    help: 'Tick commit lost the symbol_states version race to a concurrent writer.',
    labelNames: ['profileId', 'symbol'],
  },
  state_commit_latch_merged: {
    kind: 'counter',
    help: 'Tick latch fields were successfully grafted onto the concurrent CAS winner.',
    labelNames: ['profileId', 'symbol'],
  },
  state_commit_latch_merge_exhausted: {
    kind: 'counter',
    help: 'Latch merge ran out of CAS retries; the pending latch fields were dropped.',
    labelNames: ['profileId', 'symbol'],
  },
  state_commit_latch_merge_error: {
    kind: 'counter',
    help: 'Latch merge threw; the latch was dropped and the tick continued.',
    labelNames: ['profileId', 'symbol'],
  },
  // Audit drainer. Batch size is a distribution over passes; the two stream
  // probes are levels re-read from Redis each pass, so accumulating them would
  // report a total that never existed.
  audit_batch_size: {
    kind: 'histogram',
    help: 'Audit entries persisted in one drain pass, summed across all streams.',
    labelNames: [],
    buckets: AUDIT_BATCH_BUCKETS,
  },
  audit_stream_length: {
    kind: 'gauge',
    help: 'Current XLEN of an audit stream, including entries already consumed.',
    labelNames: ['stream'],
  },
  // The drainer probes on every pass, but three outcomes still leave the gauge
  // unrefreshed: a failed GROUPS probe, an absent consumer group, and a null lag.
  // A gauge keeps its last value, so none of them is visible on this series. The
  // companion counter below carries all three, which is what lets an alert
  // distinguish a genuinely flat backlog from one nothing has measured since the
  // last healthy pass.
  audit_consumer_lag: {
    kind: 'gauge',
    help: 'Entries on this audit stream the drainer consumer group has not yet read. Not refreshed on a pass whose probe failed, whose consumer group was absent, or whose lag came back null.',
    labelNames: ['stream'],
  },
  // Lag alone cannot see a Postgres stall. Reading keeps succeeding through one,
  // so lag stays near zero while every unpersisted batch piles up here unacked.
  // Alert on both, or the drainer looks caught up while it persists nothing.
  //
  // Falls back on its own once the backend recovers, because the reclaim path
  // claims abandoned entries off the pending list and acks them. Alert on its
  // growth rather than its value anyway: recovery is bounded by the min-idle
  // window and the batch size, so the reading trails the incident by passes.
  audit_consumer_pending: {
    kind: 'gauge',
    help: 'Entries on this audit stream delivered to the drainer but not yet acknowledged. Climbs when persistence fails while Redis stays healthy, and falls back over later passes once the reclaim path re-claims and persists them. A small flat residue can remain: an entry that cannot be written and has no successfully written sibling is never discarded.',
    labelNames: ['stream'],
  },
  audit_consumer_lag_unknown: {
    kind: 'counter',
    help: 'Drain passes that could not put a number on this stream backlog. cause=probe-failed means the XINFO GROUPS probe errored; cause=trimmed-past-group means Redis reported trimming dropped entries the group never read; cause=group-missing means the reply carried no such consumer group, so nothing is draining the stream.',
    labelNames: ['stream', 'cause'],
  },
  // The recovery counterpart to audit_consumer_pending: the gauge says how much
  // is stranded, this says how much is coming back. A pending reading that falls
  // while this stays flat is trimming, not recovery.
  audit_entries_reclaimed: {
    kind: 'counter',
    help: 'Audit entries claimed back off this stream drainer group pending list and persisted, after an earlier pass failed to persist them.',
    labelNames: ['stream'],
  },
  // The first sighting of a body-less entry, which the drop counter below cannot
  // report: retirement needs a delivery count, that count is a property of the
  // pending list, and the entry only reaches the pending list after this read.
  // The gap between the two is at least the delivery ceiling in reclaim passes
  // and a 60s min-idle window apiece, so without this series the condition is
  // several minutes old before anything says it started.
  audit_read_no_body: {
    kind: 'counter',
    help: 'Entries a live XREADGROUP read off this audit stream whose fields carry no usable body. This worker never XADDs an entry without one, so a rise means something else is writing to audit:*. Nothing is discarded here: the entry stays in the pending list, and the reclaim path retires it onto audit_poison_entries_dropped{cause="no-body"} only once repeated deliveries put it past the ceiling. Seeded at zero per stream so a first-ever sighting is a rise increase() can see.',
    labelNames: ['stream'],
  },
  // The one reclaim outcome no other series can show. A persist failure leaves
  // the reclaim counter flat, the drop counter flat, and audit_consumer_pending
  // merely holding a floor, which is indistinguishable from a batch legitimately
  // in flight. Counted per pass rather than per entry lifetime, so it is the
  // repetition over a window that names an entry stuck.
  audit_entries_stuck: {
    kind: 'counter',
    help: "Entries the reclaim claimed off this stream's drainer-group pending list and then neither persisted nor retired, so they stay pending and will be claimed again next pass. Seeded at zero per stream so a first-ever occurrence is a rise increase() can see.",
    labelNames: ['stream'],
  },
  // The only trace a deliberately discarded audit row leaves. Every discard route
  // must land here, or a drop reads as recovery on both backlog gauges. Seeded at
  // zero per stream and cause so a first-ever drop is a rise increase() can see
  // rather than a series that appears already at its final value.
  audit_poison_entries_dropped: {
    kind: 'counter',
    help: 'Audit entries acknowledged away without ever being written. cause=rejected means all three of: the entry had been redelivered past the delivery ceiling, the solo re-persist the bisect isolated it to failed with a row-deterministic error, and a sibling row was written to Postgres in the same pass, capped at 8 per stream per pass so a systematic rejection cannot destroy a whole backlog in one go; cause=corrupt-json means the entry body would not parse, or parsed without the fields action_logs needs, so no backend could ever accept it; cause=no-body means the reclaim kept claiming an entry whose fields carry no body at all until it passed the delivery ceiling. A rejected or corrupt-json drop is an action_logs row that will never exist; a no-body drop most likely is not, because no body ever reached the drainer to become one.',
    labelNames: ['stream', 'cause'],
  },
  // A symbol whose published filter list the projection could not read. Every
  // such symbol silently gets the all-zero fallback, which the sizing path reads
  // as invalid-filters and skips, so the coin quietly stops trading. Symbols that
  // publish NO filters are excluded: those are untradeable dust pairs behaving
  // normally and would drown the signal. Labelled by mode only, deliberately not
  // by symbol: Binance lists thousands of spot pairs, and a per-symbol label
  // turns one counter into a cardinality incident.
  exchange_info_filters_unparseable_total: {
    kind: 'counter',
    help: 'Symbols whose exchangeInfo filters array was present and non-empty but could not be projected into the full filter set, per Binance mode. Each one falls back to all-zero filters, which makes the symbol unsizeable and therefore untraded.',
    labelNames: ['mode'],
  },
  // The band is projected separately and spread in only on success, so a garbled
  // one still yields a complete filter set and the counter above stays at zero.
  // Its own series because the consequence is its own: the symbol keeps trading,
  // but the protective-stop band check reads "no band published" and fails open,
  // so the cancel/re-place pair goes back out into a -1013 the exchange will keep
  // refusing. Same mode-only labelling, same cardinality reason.
  exchange_info_band_unparseable_total: {
    kind: 'counter',
    help: 'Symbols that published a PERCENT_PRICE_BY_SIDE filter which could not be projected, per Binance mode. The rest of the filter set survives, so the symbol keeps trading while its protective stop loses the price-band check and re-arms into rejections.',
    labelNames: ['mode'],
  },
  // Projected and dropped the same way, and it needs its own series for the same
  // reason the band does: the consequence is specific. `native-trail` is the one
  // escape from a band refusal, and it derives its distance from these bounds —
  // without them the strategy falls back to refusing, so an escape the operator
  // deliberately turned on turns itself off. Nothing else reports it: the symbol
  // keeps trading and its ordinary priced stop is unaffected.
  exchange_info_trailing_delta_unparseable_total: {
    kind: 'counter',
    help: 'Symbols that published a TRAILING_DELTA filter which could not be projected, per Binance mode. The rest of the filter set survives, so the symbol keeps trading while onBandBlock native-trail silently stops being placeable and falls back to refusing the stop.',
    labelNames: ['mode'],
  },
  // The one series behind every `MetricEntry` a strategy puts on its tick output.
  // Strategy names are dotted, per-plugin, and partly built at runtime, so they
  // cannot be members of this union — and a name that is not a member reaches no
  // registry at all. Carrying the strategy's own name as a LABEL is what lets the
  // catalogue stay closed while the entries still export.
  //
  // Label set is deliberately narrow. `name` is bounded by an exact-set gate over
  // the emitting call sites; every other tag a strategy attaches (side, cap,
  // level, regime, addIndex) is dropped by the sink's label projection rather than
  // promoted, because each one would multiply the series count for a dimension
  // only one strategy has.
  //
  // `reason` is the one promoted free-form tag and it carries NO such gate. Every
  // call site today passes a literal-union value (`SellSkipReason`,
  // `RebalancePlan['reason']`, the two band-adjustment causes), which is why the
  // cardinality is small — but `MetricEntry.tags` is `Record<string, string>`, so
  // that is a property of the current call sites and not something the sink or a
  // test enforces. A strategy that passes an id, a symbol or an error string here
  // grows one series per distinct value, per profile, per symbol. Check the tag's
  // value type when adding a `reason` to a strategy metric.
  strategy_metric_total: {
    kind: 'counter',
    help: 'Strategy-emitted metric entries drained from each tick, by strategy and entry name. Event-counted: every entry increments once per occurrence, never once per tick spent in the state it describes, so a rate is a rate of things happening and not a measure of how long a condition has held.',
    labelNames: ['strategy', 'name', 'profileId', 'symbol', 'reason'],
  },
  // A self-rescheduling cron that overruns its period re-arms at delay 0, which is byte-identical to a healthy fast loop from outside: same queue depth, same completed jobs, same cron-status row. One sweep therefore ran for eight hours against a fifteen minute cadence and emitted nothing. Labelled by cron because the remedy is per cron, and a single unlabelled number could not say which one is late.
  cron_overrun_total: {
    kind: 'counter',
    help: 'Self-rescheduling cron runs whose elapsed time exceeded the configured period, by cron. A non-zero rate means that cron no longer holds its cadence.',
    labelNames: ['cron'],
  },
  // The sweep walks profiles serially, so a run that stalled on the third of ten profiles reported the same tail log as a run where the other seven had nothing to repair. Outcome is a closed set of swept | failed | timeout | checkout | unswept: `timeout` separates a profile whose query hit the per-profile budget from one whose query simply errored, and `checkout` separates the account-wide shape — the pool was empty before this profile's work began, so every profile in the pass fails identically — because the three need different responses. No profileId label: the count is a fleet-level health signal and the per-profile identity already rides the warn log.
  archive_recovery_sweep_profiles_total: {
    kind: 'counter',
    help: 'Profiles the archive-recovery sweep accounted for in a run, by outcome. `swept`: the profile was walked, whether or not it had anything to repair. `failed`: the profile query OR one of its backfill enqueues threw. `timeout`: the database cancelled a statement for that profile, which the budget is the expected cause of. `checkout`: the pool refused a connection before the transaction for that profile opened, which is account-wide backpressure rather than anything about the profile itself. `unswept`: the pass ran out of its wall-clock budget before reaching the profile, so the next run resumes there. A sustained non-zero `unswept` rate means the active-profile count has outgrown one pass.',
    labelNames: ['outcome'],
  },
};

/**
 * The one metrics sink contract. Optional at every injection point so test stubs
 * and callers that wire no metrics can omit it; a missing sink is a no-op, never
 * a throw. Declared here rather than beside any one emitter so no subsystem can
 * restate it with a wider `name: string` and quietly opt out of the catalogue.
 */
export interface MetricsSink {
  record(name: MetricName, value: number, tags?: Readonly<Record<string, string>>): void;
  /**
   * Retire one label-set of a metric, so the series leaves the next scrape.
   *
   * Required, not optional: a per-profile or per-symbol child outlives the
   * subject that owned it, and prom-client keeps exporting its last value
   * forever. A stopped profile therefore reports a live-looking reading and any
   * alert over that series can never resolve. An optional method would be
   * omitted by exactly the alternative sink that most needs to implement it.
   */
  forget(name: MetricName, tags?: Readonly<Record<string, string>>): void;
}
