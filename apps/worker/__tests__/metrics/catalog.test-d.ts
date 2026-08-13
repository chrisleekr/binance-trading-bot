// Compiler-enforced: a metric name that is not in the catalogue cannot be
// recorded.
//
// The sink drops an unknown name silently — no series, no log, no error — so the
// metric reads zero forever and looks exactly like a healthy path that never
// fired. No runtime test can pin that closed, because the failure IS the absence
// of output. Only the type system can make the bad call unwritable, so this file
// is the gate.
//
// A previous attempt scanned the source with a bash gate. Three review rounds
// found seven distinct evasions (`metrics!.`, `metrics['record']`, an aliased
// receiver, a computed name, …) because a syntactic scanner was being asked a
// type question. The four `@ts-expect-error` blocks below are exactly those
// escapes, kept as regressions.

import type { MetricName, MetricsSink } from '../../src/metrics/catalog.js';

declare const metrics: MetricsSink | undefined;
declare const deps: { metrics?: MetricsSink };
declare const someString: string;

// --- Directive-free assertions -------------------------------------------
// `@ts-expect-error` proves an error exists somewhere on the next line; these
// prove the SHAPE of the union itself, which no directive can drift away from.
// If MetricName ever widened back to `string`, every negative test below would
// keep "passing" by silently asserting nothing — these four would not.

type Assert<T extends true> = T;
type Equals<A, B> =
  (<G>() => G extends A ? 1 : 2) extends <G>() => G extends B ? 1 : 2 ? true : false;

// The whole design rests on this. A `Record<string, …>` annotation on CATALOG
// would make MetricName `string` and un-check every call site in the worker.
type _NameIsNotString = Assert<Equals<MetricName, string> extends true ? false : true>;
type _NameHasKnownMember = Assert<'tick_latency_ms' extends MetricName ? true : false>;
type _NameRejectsUnknown = Assert<'definitely_not_catalogued' extends MetricName ? false : true>;
// A widened `string` must not flow into the parameter.
type _StringNotAssignable = Assert<string extends MetricName ? false : true>;

// --- The four evasions, as negative assertions ----------------------------
// Each directive is consumed by a real TS2345. `no-unwired-test-d.sh` compiles
// this file and fails on TS2578 ("Unused '@ts-expect-error'"), so a directive
// that stops suppressing anything breaks the build instead of going quiet.
// Kept on ONE line each: tsc reports at the ARGUMENT's position, and a directive
// only suppresses the line directly beneath it.

// @ts-expect-error a non-null assertion does not widen the name parameter
metrics!.record('uncatalogued', 1);

// @ts-expect-error reaching the method by bracket access checks the same signature
metrics!['record']('uncatalogued', 1);

const sink = deps.metrics!;
// @ts-expect-error renaming the receiver cannot launder the name
sink.record('uncatalogued', 1);

// @ts-expect-error a plain string is not a MetricName, however it was computed
metrics!.record(someString, 1);

// --- Positive controls -----------------------------------------------------
// Un-suppressed, so this file fails if a catalogued call is what breaks and the
// negatives above are passing for the wrong reason.
metrics?.record('tick_latency_ms', 42, { profileId: 'p1', symbol: 'BTCUSDT' });
metrics?.record('audit_batch_size', 3);
sink.record('audit_consumer_lag', 7, { stream: 'audit:a:b:stream' });
sink.record('audit_consumer_pending', 12, { stream: 'audit:a:b:stream' });
sink.record('audit_consumer_lag_unknown', 1, { stream: 'audit:a:b:stream', cause: 'probe-failed' });
