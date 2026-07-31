// The single catalogue of operator documentation for every environment
// variable this stack reads.
//
// WHY: `docs/operations/env-vars.md` was a hand-written table that copied every
// default and bound out of a zod schema by hand. Nothing tied the two together:
// `no-undocumented-env-var.sh` only checks that a key is MENTIONED in the doc,
// so a default could change from 2 to 5 and the reference would keep claiming 2
// with CI green. Exactly that drift shipped in the technicals doc (#718).
//
// This module owns the prose; the zod schemas stay where they are parsed
// (`schema.ts`, `apps/api/src/env.ts`, `apps/worker/src/env.ts`). The two are
// pinned to each other by tests in each app that parse an EMPTY environment
// through the real schema and assert every documented default matches — so
// changing a default without updating the catalogue fails CI.
//
// Deliberately zod-free: `isolatedDeclarations` is on for `@app/core`, and an
// exported const holding zod types cannot be annotated without either widening
// every field to `ZodTypeAny` (which would make the app schemas parse to
// `unknown`) or restating ~30 concrete zod class types by hand.
//
// Some variables are read by Docker Compose or stamped into the web bundle by
// Vite and never parsed by application code. They carry `parsed: false`, so the
// default-drift tests know to skip them and the reference is still complete.

/** Which surface consumes the variable. Drives the doc grouping. */
export type EnvConsumer = 'shared' | 'api' | 'worker' | 'compose' | 'build';

/**
 * One environment variable: how it is parsed, and what an operator needs to
 * decide about it.
 *
 * `description`, `when` and `expect` are all required. A catalogue entry that
 * only restates its own name passes no gate worth having, so the generator
 * refuses to emit a table with an empty one.
 */
export interface EnvVar {
  /** Doc section this belongs under. */
  readonly group: string;
  /** Which process(es) read it. */
  readonly consumers: readonly EnvConsumer[];
  /**
   * False for compose- and build-only variables, which application code never
   * parses. The default-drift tests skip these, because there is no schema to
   * compare against.
   */
  readonly parsed: boolean;
  /** What the variable is, in one sentence, for an operator. */
  readonly description: string;
  /** The situation that should make an operator set or change it. */
  readonly when: string;
  /** The observable consequence, including what happens when it is left alone. */
  readonly expect: string;
  /** Accepted values, in operator terms. */
  readonly values: string;
  /**
   * The documented default. For a parsed variable this is asserted against the
   * schema's real default by each app's env-docs test; `null` means the
   * variable is required and boot fails without it.
   */
  readonly def: string | null;
  /**
   * Why the documented default differs from the schema default. The reasons
   * vary: a value `.env.example` ships explicitly, one resolved at boot from
   * another setting, a representation gap (`LIVE_DEMO` documents `off` for a
   * boolean `false`), or plain optionality (`PUBLIC_WEB_URL` has no default at
   * all). Compose- and build-only entries use it for values no schema parses.
   *
   * It redirects the default-drift assertion from `def` onto `defParsed`
   * rather than lifting it, so on a parsed variable it always travels with
   * one. Never optional decoration.
   */
  readonly defNote?: string;
  /**
   * The exact value the schema yields for an empty environment. Required on a
   * parsed entry whose `defNote` explains why that differs from the
   * operator-facing `def`; `null` means the schema yields no value at all, so
   * the key is absent from the parsed object. Without it `defNote` would be an
   * unbounded escape hatch: the drift tests would assert nothing about the
   * entry.
   *
   * A compose- or build-only entry (`parsed: false`) has no schema to pin, so
   * it carries its `defNote` alone and must not declare this.
   */
  readonly defParsed?: string | null;
}

/** Every environment variable, keyed by name, in the order the docs render. */
export const ENV_CATALOGUE: Readonly<Record<string, EnvVar>> = {
  // ── Required ───────────────────────────────────────────────────────────────
  AUTH_SECRET: {
    group: 'Required',
    consumers: ['api'],
    parsed: true,
    values: '64 hex characters',
    def: null,
    description: 'Signs your login-session cookie.',
    when: 'Always, on every deployment. Generate it with `openssl rand -hex 32` — never reuse one between instances.',
    expect:
      'No default. Boot fails if it is shorter than 32 characters. Changing it invalidates every existing session, so you are signed out.',
  },
  WEB_ORIGIN: {
    group: 'Required',
    consumers: ['api'],
    parsed: true,
    values: 'comma-separated origins, no wildcards',
    def: null,
    description:
      'Comma-separated list of exact browser origins allowed for CORS, login CSRF, and the WebSocket upgrade.',
    when: 'Always. Set it to the address you open the app at, e.g. `https://bot.example.com`. List several, comma-separated, to serve the SPA on more than one origin.',
    expect:
      'No default. Boot fails if it is empty or if any entry contains `*` — credentialed CORS forbids a wildcard, and allowing one would loosen the auth gate only. A mismatch shows as a browser that loads the page but cannot sign in.',
  },
  DATABASE_URL: {
    group: 'Required',
    consumers: ['shared'],
    parsed: true,
    values: 'a Postgres connection string',
    def: null,
    description: 'Postgres connection string, read by every process.',
    when: 'Always, unless you use the bundled Compose Postgres — the compose files supply an in-network default.',
    expect:
      'No default. Boot crashes if unset rather than silently connecting to `localhost`, which is the failure a fallback would hide.',
  },
  REDIS_URL: {
    group: 'Required',
    consumers: ['shared'],
    parsed: true,
    values: 'a Redis connection string',
    def: null,
    description: 'Redis connection string for the job queues and caches.',
    when: 'Always, unless you use the bundled Compose Redis. Include the password when Redis requires auth: `redis://:pw@host:6379`.',
    expect: 'No default. Boot crashes if unset, for the same reason as the database URL.',
  },
  POSTGRES_PASSWORD: {
    group: 'Required',
    consumers: ['compose'],
    parsed: false,
    values: 'any string',
    def: 'postgres',
    defNote: 'shipped in `.env.example`; the production overlay uses a secret file instead',
    description: 'Password the bundled Postgres container initialises with.',
    when: 'On any Compose deployment. Change it from the shipped value before exposing the stack to anything.',
    expect:
      '`.env.example` ships `postgres`. The production overlay reads a `deploy/secrets/*` file instead and ignores this variable. Changing it after first boot does NOT change the existing database password — the container only initialises once.',
  },

  // ── Runtime ────────────────────────────────────────────────────────────────
  NODE_ENV: {
    group: 'Runtime',
    consumers: ['api'],
    parsed: true,
    values: '`development`, `test`, `production`',
    def: 'development',
    description: 'Selects development or production framework behaviour.',
    when: 'Rarely — the container image sets it. Set it to `production` if you run the app outside the image.',
    expect: 'Development mode adds verbose framework output and disables some caching.',
  },
  LOG_LEVEL: {
    group: 'Runtime',
    consumers: ['worker'],
    parsed: true,
    values: '`fatal`, `error`, `warn`, `info`, `debug`, `trace`',
    def: 'info',
    description: 'Log verbosity for the worker, the loudest process in the stack.',
    when: 'While debugging. Turn it back down afterwards.',
    expect:
      '`debug` and `trace` flood stdout and can fill a disk on a busy account. `warn` and above will hide the routine decision log you usually want.',
  },
  ROLE: {
    group: 'Runtime',
    consumers: ['worker'],
    parsed: true,
    values: '`all`, `api`, `worker`, `study`',
    def: 'all',
    description: 'Which listeners and consumers this process runs.',
    when: 'Only when splitting the stack across containers. The single-box default runs everything in one process.',
    expect:
      '`all` runs the api, the live worker and the backtest consumer on one event loop, which is why the tuning defaults below are conservative. Splitting into `api` + `worker` + `study` keeps a long backtest off the trading loop. Only the `api` role runs database migrations.',
  },
  LIVE_DEMO: {
    group: 'Runtime',
    consumers: ['api', 'worker'],
    parsed: true,
    values: '`1` or `true` to enable; anything else is off',
    def: 'off',
    defNote: 'the flag parses to a boolean, so the schema default is `false`',
    defParsed: 'false',
    description: 'Turns the instance into a public, no-login sandbox.',
    when: 'Only on a throwaway public demo box. Never on an instance holding your keys.',
    expect:
      'Injects a demo operator for every anonymous request, blocks credential and destructive routes, suppresses all notifier sending, and refuses to boot if any account is on live Binance. Only `1` or `true` enable it.',
  },
  PUBLIC_WEB_URL: {
    group: 'Runtime',
    consumers: ['worker'],
    parsed: true,
    values: 'an absolute URL, no trailing slash',
    def: null,
    defNote: 'optional: unset means notifications send without a link',
    defParsed: null,
    description: 'Base URL used to build tap-through links inside operator notifications.',
    when: 'When you want a Slack or Telegram alert to link straight to the relevant screen.',
    expect:
      'Optional. Unset, notifications still send — just without a link. A trailing slash is trimmed automatically. Boot fails if the value is not a valid URL.',
  },

  // ── HTTP and admin ports ───────────────────────────────────────────────────
  PORT: {
    group: 'HTTP and admin ports',
    consumers: ['api'],
    parsed: true,
    values: 'a port number',
    def: '3000',
    description: 'Port serving the API and the single-page app.',
    when: 'If 3000 is already taken on the host.',
    expect:
      'Must differ from the admin port, or boot fails with a clear message rather than a port-in-use crash.',
  },
  ADMIN_PORT: {
    group: 'HTTP and admin ports',
    consumers: ['api'],
    parsed: true,
    values: 'a port number',
    def: '9100',
    description: "Port for the api's health and metrics endpoints.",
    when: 'If 9100 is taken. Kept separate from the public port so a slow scrape cannot starve it.',
    expect: 'Serves `/healthz`, `/readyz` and `/metrics`, all unauthenticated.',
  },
  ADMIN_HOST: {
    group: 'HTTP and admin ports',
    consumers: ['api'],
    parsed: true,
    values: 'an interface address',
    def: '127.0.0.1',
    description: "Interface the api's admin server binds.",
    when: 'On Kubernetes, set it to `0.0.0.0` so the kubelet probes reach the pod IP.',
    expect:
      'The default binds loopback only, keeping the unauthenticated admin endpoints off the LAN. If you open it up, restrict the port with a NetworkPolicy — a Service is not a firewall.',
  },
  WORKER_ADMIN_PORT: {
    group: 'HTTP and admin ports',
    consumers: ['worker'],
    parsed: true,
    values: 'a port number',
    def: '9101',
    description: "Port for the worker's health and metrics endpoints.",
    when: 'If 9101 is taken on the host.',
    expect:
      "Defaults to one above the api's so both can run on one host during development. Inside Compose each container has its own loopback, so they could share a port.",
  },
  WORKER_ADMIN_HOST: {
    group: 'HTTP and admin ports',
    consumers: ['worker'],
    parsed: true,
    values: 'an interface address',
    def: '127.0.0.1',
    description: "Interface the worker's admin server binds.",
    when: 'On Kubernetes, for the same probe reason as the api.',
    expect: 'Loopback by default; the same NetworkPolicy caveat applies if you widen it.',
  },
  APP_HTTP_PORT: {
    group: 'HTTP and admin ports',
    consumers: ['compose'],
    parsed: false,
    values: 'a host port number',
    def: '80',
    defNote:
      'shipped in `.env.example`; unset, the base and scale compose files publish on 3000 and the production file on 80',
    description: 'Host port the app publishes on under Docker Compose.',
    when: 'To publish on a port other than the compose default, e.g. behind a reverse proxy on 8080.',
    expect:
      'Compose-only; the application never reads it. Unset, the base and scale compose files publish on 3000 and the production file on 80.',
  },

  // ── Database ───────────────────────────────────────────────────────────────
  POSTGRES_DB: {
    group: 'Database',
    consumers: ['compose'],
    parsed: false,
    values: 'a Postgres identifier',
    def: 'binance_trading_bot',
    defNote: 'compose-only',
    description: 'Database name the bundled Postgres creates on first boot.',
    when: 'Rarely. Change it only before the first boot — it has no effect afterwards.',
    expect:
      'Compose-only. The application reads the database name out of the connection string, not from here, so changing one without the other breaks the connection.',
  },
  POSTGRES_USER: {
    group: 'Database',
    consumers: ['compose'],
    parsed: false,
    values: 'a Postgres identifier',
    def: 'postgres',
    defNote: 'compose-only',
    description: 'Superuser the bundled Postgres creates on first boot.',
    when: 'Rarely, and only before first boot.',
    expect: 'Compose-only, and subject to the same first-boot-only caveat as the database name.',
  },
  PGSSLMODE: {
    group: 'Database',
    consumers: ['shared'],
    parsed: true,
    values: '`disable`, `allow`, `prefer`, `require`, `verify-ca`, `verify-full`',
    def: 'prefer',
    description: 'libpq SSL mode used by the backup and restore commands.',
    when: 'When Postgres is behind TLS and you want backups to require or verify it.',
    expect:
      "Applies to `pg_dump` and `pg_restore` only — the app's own driver has its own SSL configuration and ignores this. `.env.example` ships `disable` for a local plaintext Postgres.",
  },

  // ── Retention ──────────────────────────────────────────────────────────────
  ACTION_LOG_RETENTION_DAYS: {
    group: 'Retention (days before pruning)',
    consumers: ['worker'],
    parsed: true,
    values: 'a positive integer',
    def: '30',
    description: 'How long per-symbol action-log entries are kept.',
    when: 'Raise it if you investigate incidents more than a month after the fact.',
    expect:
      'A daily sweep deletes anything older. Action logs are the highest-volume table, so a long horizon costs real disk.',
  },
  AUDIT_LOG_RETENTION_DAYS: {
    group: 'Retention (days before pruning)',
    consumers: ['worker'],
    parsed: true,
    values: 'a positive integer',
    def: '90',
    description: 'How long the audit trail of operator and system actions is kept.',
    when: 'Raise it if you need a longer forensic window. This is the record of who changed what.',
    expect: 'Longer than the action-log default on purpose. Deleted rows are unrecoverable.',
  },
  DISCOVERY_SNAPSHOT_RETENTION_DAYS: {
    group: 'Retention (days before pruning)',
    consumers: ['worker'],
    parsed: true,
    values: 'a positive integer',
    def: '180',
    description: 'How long auto-discovery universe snapshots are kept.',
    when: 'Raise it before running a discovery net-edge backtest, which needs a long series.',
    expect:
      'Deliberately generous, because this series is meant to accumulate. A short horizon defeats its purpose and cannot be backfilled.',
  },
  EQUITY_SNAPSHOT_RETENTION_DAYS: {
    group: 'Retention (days before pruning)',
    consumers: ['worker'],
    parsed: true,
    values: 'a positive integer',
    def: '365',
    description: 'How long the per-profile equity series behind the profit-vs-hold chart is kept.',
    when: 'Raise it to keep a multi-year equity curve.',
    expect:
      'Roughly 96 rows per profile per day, so the storage cost is modest. Trimming it shortens the chart permanently.',
  },

  // ── Worker tuning ──────────────────────────────────────────────────────────
  BACKTEST_CONCURRENCY: {
    group: 'Worker tuning',
    consumers: ['worker'],
    parsed: true,
    values: 'a positive integer',
    def: '1',
    description: 'How many backtest replays may run at once.',
    when: 'Raise it on a dedicated backtest box; keep it at 1–2 when the worker shares a core with live trading.',
    expect:
      'Replays are CPU-bound, so raising this on a shared box adds tail latency to the dashboard and the trading loop. `.env.example` ships `4` for a dedicated study box.',
  },
  STUDY_CPU_SHARE: {
    group: 'Worker tuning',
    consumers: ['worker'],
    parsed: true,
    values: 'a number in (0, 1]',
    def: null,
    defNote: 'resolved at boot: `0.5` under `ROLE=all`, else `1.0`',
    defParsed: null,
    description: 'Fraction of one core a backtest replay may consume.',
    when: 'To trade backtest speed against live responsiveness when both share a process.',
    expect:
      'Unset resolves to 0.5 under `ROLE=all` and 1.0 for a dedicated worker or study process, so the default already does the right thing. The runner sleeps at yield points to hold the share, so a low value makes backtests proportionally slower.',
  },
  TICK_CONCURRENCY: {
    group: 'Worker tuning',
    consumers: ['worker'],
    parsed: true,
    values: 'a positive integer',
    def: '25',
    description: 'How many per-symbol tick jobs may run at once.',
    when: 'Lower it if the dashboard feels sluggish while many symbols are active under `ROLE=all`.',
    expect:
      'Ordering per (profile, symbol) is enforced regardless of this value, so lowering it only reduces throughput — never correctness.',
  },
  KLINE_CONCURRENCY: {
    group: 'Worker tuning',
    consumers: ['worker'],
    parsed: true,
    values: 'a positive integer',
    def: '8',
    description: 'How many Binance candle fetches the technicals job runs at once per interval.',
    when: 'Lower it if technical-rating computation is monopolising the event loop, or to reduce burst request weight.',
    expect:
      'Each fetched symbol then runs synchronous indicator maths, so this bounds how many bursts stack up.',
  },
  TICK_PERSIST_TIMEOUT_MS: {
    group: 'Worker tuning',
    consumers: ['worker'],
    parsed: true,
    values: 'a positive integer, milliseconds',
    def: '100',
    description: 'Time budget for the durable per-tick strategy-state write.',
    when: 'Raise it on network-replicated storage, where a commit is a cross-node round trip.',
    expect:
      'On timeout the tick falls back to a degraded cache path, which is safe but is meant to be rare. Left too low on slow storage, the fallback becomes the steady state. The default suits a local SSD.',
  },
  WORKER_REPLICAS: {
    group: 'Worker tuning',
    consumers: ['compose'],
    parsed: false,
    values: 'a positive integer',
    def: '1',
    defNote: 'compose-only',
    description: 'Live-worker replica count in the scale compose file.',
    when: 'Keep it at 1. Multi-replica scale-out is merged but dormant.',
    expect:
      'Compose interpolates it into the service replica count; application code never reads it. Raising it today runs untested concurrency paths.',
  },

  // ── Observability ──────────────────────────────────────────────────────────
  OTEL_SERVICE_NAME: {
    group: 'Observability (OpenTelemetry)',
    consumers: ['compose'],
    parsed: false,
    values: 'any string',
    def: 'binance-trading-bot',
    defNote: 'compose-only',
    description: 'Service name stamped on exported traces.',
    when: 'When you export traces and run more than one instance.',
    expect: 'Ignored unless the OTLP endpoint below is set.',
  },
  OTEL_EXPORTER_OTLP_ENDPOINT: {
    group: 'Observability (OpenTelemetry)',
    consumers: ['compose'],
    parsed: false,
    values: 'a collector URL',
    def: null,
    defNote: 'compose-only; empty disables the exporter',
    description: 'OTLP collector endpoint. Setting it is what enables trace export.',
    when: 'When you have a collector to send traces to.',
    expect: 'Empty by default, so the exporter is off and no telemetry leaves the box.',
  },
  OTEL_EXPORTER_OTLP_HEADERS: {
    group: 'Observability (OpenTelemetry)',
    consumers: ['compose'],
    parsed: false,
    values: '`key=value` pairs',
    def: null,
    defNote: 'compose-only; empty by default',
    description: 'Extra headers attached to the OTLP export request.',
    when: 'When your collector needs authentication.',
    expect: 'Treat the value as a credential — it typically carries a token.',
  },

  // ── Build and deploy ───────────────────────────────────────────────────────
  IMAGE_TAG: {
    group: 'Build and deploy',
    consumers: ['compose'],
    parsed: false,
    values: 'a Docker tag',
    def: 'latest',
    defNote: 'compose-only',
    description: 'Image tag Docker Compose pulls.',
    when: 'To pin a release instead of tracking the moving latest tag.',
    expect:
      'The default moves with every release, so an unpinned deployment can change under you on the next pull.',
  },
  BACKUP_DIR: {
    group: 'Build and deploy',
    consumers: ['shared'],
    parsed: true,
    values: 'an absolute path',
    def: '/backups',
    description: 'Directory the scheduled backup writes dump files into.',
    when: 'To write backups somewhere other than the bundled volume.',
    expect:
      'The backup job creates the directory if missing, and the backup screen lists what is there. Point it outside the container volume and the dumps will not survive a container rebuild.',
  },
  GIT_SHA: {
    group: 'Build and deploy',
    consumers: ['shared'],
    parsed: true,
    values: 'a git commit sha',
    def: '',
    description: 'Build commit stamped into the image, surfaced on the status endpoint.',
    when: 'Never by hand — the Docker build injects it.',
    expect:
      'Empty in a local build, where boot falls back to the local git commit or `unknown`. It is what lets the status bar spot api/worker version skew.',
  },
  WEB_DIST_DIR: {
    group: 'Build and deploy',
    consumers: ['api'],
    parsed: true,
    values: 'a directory path',
    def: 'apps/web/dist',
    description: 'Directory of the built web app the api serves.',
    when: 'Never by hand — the container image sets it.',
    expect:
      'If the directory is absent the api serves no web app at all, which is correct during development (Vite serves it) and for an api behind a CDN.',
  },
  VITE_API_BASE_URL: {
    group: 'Web build (build-time only)',
    consumers: ['build'],
    parsed: false,
    values: 'a URL path or absolute URL',
    def: '/api',
    defNote: 'build-time only',
    description: 'Base URL the web app calls.',
    when: 'Only when the API is served under a different base path.',
    expect:
      'Baked into the bundle at build time. Changing it after the build has no effect — you must rebuild.',
  },
  VITE_PWA: {
    group: 'Web build (build-time only)',
    consumers: ['build'],
    parsed: false,
    values: '`0` or `1`',
    def: '0',
    defNote: 'build-time only',
    description: 'Builds the app as an installable progressive web app.',
    when: 'To install the dashboard to a phone home screen.',
    expect:
      'Build-time only. Enabling it adds a service worker, which caches aggressively — expect to hard-refresh after a deploy.',
  },
};
