// Fixture stand-in for the observability registry. The gate reads metric names
// off `new Counter/Gauge/Histogram/Summary({ name: ... })` call sites, so the
// constructors are declared locally rather than imported: the fixture tree has no
// node_modules and the gate never resolves the import.
//
// All three real-world call shapes appear here, because the gate's window has to
// close on each one correctly: a bare top-level construction, one indented inside
// a factory with `labelNames`/`registers` after the name, and one whose options
// are spread-built and carry no literal name at all.

type Opts = {
  name?: string;
  help: string;
  labelNames?: readonly string[];
  buckets?: readonly number[];
  registers?: readonly unknown[];
};
declare const Counter: new (opts: Opts) => unknown;
declare const Gauge: new (opts: Opts) => unknown;
declare const Histogram: new (opts: Opts) => unknown;

export const pinoDropped = new Counter({
  name: 'pino_dropped_logs_total',
  help: 'Log lines dropped by the async destination when the buffer saturates.',
});

export const buildHttpMetrics = (registry: unknown): unknown => {
  const requests = new Counter({
    name: 'http_requests_total',
    help: 'Total API HTTP requests, labelled by method, matched route and status code.',
    labelNames: ['method', 'route', 'status'],
    registers: [registry],
  });
  return requests;
};

// The next two declarations are adjacent on purpose. `buildFromSpec` spreads its
// options and carries no literal name, the shape the worker's sink adapter uses,
// so the gate must register nothing for it. The descriptor immediately after it
// does hold a `name:` literal, and it is not a metric. A constructor scan bounded
// by a character count rather than by the call's own closing `})` reads straight
// past the constructor, adopts that literal as a declared metric, and then goes
// quiet on a real phantom. The fail fixture references it to prove it does not.
export const buildFromSpec = (base: Opts, spec: { buckets: readonly number[] }): unknown =>
  new Histogram({ ...base, buckets: [...spec.buckets] });
export const auditStreamDescriptor = { name: 'not_a_metric_name', kind: 'redis-stream' };

export const buildOwnedGauge = (registry: unknown): unknown =>
  new Gauge({
    name: 'worker_owned_accounts',
    help: 'Accounts whose user-data subscription this pod owns.',
    registers: [registry],
  });
