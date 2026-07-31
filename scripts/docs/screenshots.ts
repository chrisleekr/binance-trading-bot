#!/usr/bin/env bun
// End-to-end refresh of every screenshot the docs site ships.
//
// Brings up its own stack against a dedicated database and Redis logical db,
// seeds it, boots the api and web dev server on dedicated ports, drives the
// Playwright capture, then tears the processes down. Nothing here touches the
// database `bun run dev` uses: the seeder wipes orders, positions and archive
// rows, which would be destructive against real dev data.
//
// Requires the local Postgres and Redis to be up (`docker compose up -d
// postgres redis`, or `bun run setup`).
//
// Run: `bun run docs:screenshots`

import { resolve } from 'node:path';

import { createDb, createPool } from '@app/db';
import { sql } from 'drizzle-orm';

const ROOT = resolve(import.meta.dir, '../..');

// Dedicated ports so a running `bun run dev` is never disturbed.
const API_PORT = 3188;
const ADMIN_PORT = 9188;
const STUDY_ADMIN_PORT = 9189;
const WEB_PORT = 5188;
const WEB_ORIGIN = `http://localhost:${WEB_PORT}`;

const READY_TIMEOUT_MS = 120_000;
const POLL_INTERVAL_MS = 500;

const info = (msg: string): void => console.log(`[docs-screenshots] ${msg}`);

function fail(msg: string): never {
  console.error(`[docs-screenshots] ${msg}`);
  process.exit(1);
}

/**
 * The docs stack's own database and Redis logical db, derived from the dev
 * connection strings so a developer does not have to configure a second pair.
 * Overridable for a stack that is not the local compose one.
 */
function resolveTargets(): { databaseUrl: string; redisUrl: string; adminUrl: string } {
  const devDb = process.env['DATABASE_URL'];
  const devRedis = process.env['REDIS_URL'];
  if (!devDb) fail('DATABASE_URL is not set (run `bun run setup` first)');
  if (!devRedis) fail('REDIS_URL is not set (run `bun run setup` first)');

  const databaseUrl = process.env['DOCS_DATABASE_URL'] ?? withDbName(devDb, docsDbName(devDb));
  // Logical db 1, so a reseed cannot flush the market data the dev stack holds.
  const redisUrl = process.env['DOCS_REDIS_URL'] ?? withRedisDb(devRedis, 1);

  // This runs with the seeder's live-account refusal disarmed, so isolation is
  // load-bearing rather than a nicety. The database name always gains a suffix,
  // but the Redis index is fixed at 1 — if the dev stack already uses it, the
  // seeded tickers and heartbeat would land on the keys a live worker reads.
  const devRedisDb = new URL(devRedis).pathname.slice(1) || '0';
  const docsRedisDb = new URL(redisUrl).pathname.slice(1) || '0';
  if (new URL(devRedis).host === new URL(redisUrl).host && devRedisDb === docsRedisDb) {
    fail(
      `REDIS_URL already uses logical db ${devRedisDb}, which the docs stack would overwrite — ` +
        'set DOCS_REDIS_URL to a different one',
    );
  }
  // The seeder refuses a non-local database host unless SEED_ALLOW_REMOTE=1, but
  // that check runs in the child. `ensureDatabase` below opens an admin pool and
  // issues CREATE DATABASE before then, so it needs the same bound.
  const host = new URL(databaseUrl).hostname;
  if (
    process.env['SEED_ALLOW_REMOTE'] !== '1' &&
    host !== 'localhost' &&
    host !== '127.0.0.1' &&
    host !== '::1'
  ) {
    fail(`refusing to create a database on non-local host "${host}" (set SEED_ALLOW_REMOTE=1)`);
  }
  // Derived from the resolved target, not from the dev URL: with
  // DOCS_DATABASE_URL pointing at another server, creating the database on the
  // dev server would leave debris there and still fail the migration.
  return { databaseUrl, redisUrl, adminUrl: withDbName(databaseUrl, 'postgres') };
}

const docsDbName = (url: string): string => `${new URL(url).pathname.slice(1)}_docs`;

const withDbName = (url: string, name: string): string => {
  const u = new URL(url);
  u.pathname = `/${name}`;
  return u.toString();
};

const withRedisDb = (url: string, db: number): string => {
  const u = new URL(url);
  u.pathname = `/${db}`;
  return u.toString();
};

/**
 * Recreate the docs database from scratch.
 *
 * Dropped, not reused. The seeder only bootstraps profiles on an EMPTY database
 * — an existing one is adopted as-is — so reusing yesterday's database silently
 * pins the profile configs to whatever shipped then, and a config change made
 * for the docs never reaches the screenshots. This database is disposable by
 * construction (its name always carries the `_docs` suffix and it holds only
 * the operator this pipeline created), so dropping it costs nothing and makes
 * every run reproducible.
 */
async function ensureDatabase(adminUrl: string, databaseUrl: string): Promise<void> {
  const name = new URL(databaseUrl).pathname.slice(1);
  // CREATE DATABASE takes no bind parameters, so the name is interpolated. The
  // guarantee lives here rather than in a property of URL parsing: anything
  // outside a plain identifier is refused before it reaches the statement.
  if (!/^[A-Za-z0-9_-]+$/.test(name)) {
    fail(`refusing to create a database with the unsafe name "${name}"`);
  }
  const pool = createPool({ kind: 'admin', connectionString: adminUrl });
  const db = createDb(pool);
  try {
    const rows = await db.execute(sql`select 1 from pg_database where datname = ${name}`);
    if (rows.rowCount !== 0) {
      // Terminate stragglers first: a leftover connection from a killed run
      // makes DROP DATABASE fail outright rather than wait.
      await db.execute(
        sql`select pg_terminate_backend(pid) from pg_stat_activity where datname = ${name} and pid <> pg_backend_pid()`,
      );
      await db.execute(sql.raw(`drop database "${name}"`));
      info(`dropped stale database ${name}`);
    }
    await db.execute(sql.raw(`create database "${name}"`));
    info(`created database ${name}`);
  } finally {
    await pool.end();
  }
}

/** Run a command to completion, failing the script on a non-zero exit. */
function runStep(
  label: string,
  cmd: string[],
  env: Record<string, string>,
  cwd: string = ROOT,
): void {
  info(label);
  const proc = Bun.spawnSync(cmd, {
    cwd,
    env: { ...process.env, ...env },
    stdout: 'inherit',
    stderr: 'inherit',
  });
  if (proc.exitCode !== 0) fail(`${label} failed (exit ${proc.exitCode})`);
}

/** Wait until `url` answers, so the capture never races a half-booted stack. */
async function waitForUrl(url: string, label: string): Promise<void> {
  const deadline = Date.now() + READY_TIMEOUT_MS;
  let lastError: unknown;
  while (Date.now() < deadline) {
    try {
      const res = await fetch(url, { signal: AbortSignal.timeout(POLL_INTERVAL_MS) });
      if (res.ok) {
        info(`${label} ready`);
        return;
      }
      lastError = new Error(`status ${res.status}`);
    } catch (err) {
      lastError = err;
    }
    await new Promise((r) => setTimeout(r, POLL_INTERVAL_MS));
  }
  fail(`${label} did not come up in ${READY_TIMEOUT_MS}ms (${String(lastError)})`);
}

async function main(): Promise<void> {
  const { databaseUrl, redisUrl, adminUrl } = resolveTargets();
  info(`database: ${databaseUrl.replace(/:[^:@/]+@/, ':***@')}`);

  await ensureDatabase(adminUrl, databaseUrl);

  // LIVE_DEMO is explicitly off whatever the developer's `.env` says: the demo
  // mode drops the login screen, injects the operator, and paints a banner over
  // every page — none of which the docs should show. It also refuses to boot
  // against the live-mode account the seeder creates.
  const stackEnv = { DATABASE_URL: databaseUrl, REDIS_URL: redisUrl, LIVE_DEMO: '0' };
  runStep('migrating', ['bun', 'run', 'db:migrate'], stackEnv);

  // Taken after migrating, not before: the seeded worker heartbeat is stamped
  // with this instant, and the status bar reads a worker that booted before the
  // newest applied migration as schema lag ("restart needed").
  const NOW_MS = Date.now();

  // SEED_DOCS_STACK tells the seeder this database is disposable, which is what
  // licenses the live-mode account it needs for a populated header strip.
  // SEED_NOW_MS is the instant the capture also freezes the browser clock to;
  // without a shared instant every rendered age clamps to "0s ago".
  // Credentials resolved once and passed to both children. The seeder reads
  // SEED_OPERATOR_*, the capture reads DOCS_LOGIN_* — without forwarding, they
  // agree only by their defaults matching, so overriding one breaks the login.
  const email = process.env['SEED_OPERATOR_EMAIL'] ?? 'docs@example.com';
  const password = process.env['SEED_OPERATOR_PASSWORD'] ?? 'docs-screenshot-pw-1234';

  runStep('seeding', ['bun', './scripts/seed-dev-data.ts'], {
    ...stackEnv,
    SEED_DOCS_STACK: '1',
    SEED_NOW_MS: String(NOW_MS),
    SEED_OPERATOR_EMAIL: email,
    SEED_OPERATOR_PASSWORD: password,
  });

  // The api and web dev server run only for the capture. Cleanup rides
  // `process.on('exit')` rather than a `finally`: every failure path here goes
  // through `fail()`, and `process.exit()` tears the process down without
  // unwinding the stack, so a `finally` would never run. Orphans would be worse
  // than a port clash — vite is `--strictPort`, so the next run's readiness poll
  // would succeed against the previous run's stale server.
  const children: Bun.Subprocess[] = [];
  const killAll = (): void => {
    for (const child of children) child.kill();
  };
  process.on('exit', killAll);
  for (const signal of ['SIGINT', 'SIGTERM'] as const) {
    process.on(signal, () => {
      killAll();
      process.exit(signal === 'SIGINT' ? 130 : 143);
    });
  }

  const spawn = (cmd: string[], cwd: string, env: Record<string, string>): void => {
    children.push(
      Bun.spawn(cmd, {
        cwd,
        env: { ...process.env, ...stackEnv, ...env },
        stdout: 'ignore',
        stderr: 'inherit',
      }),
    );
  };

  {
    info('starting api');
    spawn(['bun', 'src/index.ts'], resolve(ROOT, 'apps/api'), {
      PORT: String(API_PORT),
      ADMIN_PORT: String(ADMIN_PORT),
      // Better Auth rejects a sign-in whose origin is not trusted, and the SPA
      // is served from the docs port, not the dev one.
      WEB_ORIGIN,
    });
    await waitForUrl(`http://localhost:${ADMIN_PORT}/healthz`, 'api');

    // A real backtest, run through the real queue by a real study worker.
    // The Results and History tabs read `backtest_runs`; a seeder cannot write
    // a believable row there, because a BacktestResult is ~50 interdependent
    // numbers (metrics, equity curve, round-trips, decision breakdown) that only
    // agree with each other if an actual replay produced them. So the pipeline
    // runs one instead of fabricating it.
    info('starting study worker');
    spawn(['bun', 'src/index.ts'], resolve(ROOT, 'apps/worker'), {
      ROLE: 'study',
      // Distinct from the api's, and from the dev worker's default.
      WORKER_ADMIN_PORT: String(STUDY_ADMIN_PORT),
      // The api already migrated this database; two runners racing on
      // `_app_migrations` is exactly what this flag exists to prevent.
      SKIP_MIGRATIONS: '1',
    });
    await waitForUrl(`http://localhost:${STUDY_ADMIN_PORT}/healthz`, 'study worker');

    info('starting web');
    spawn(['bunx', 'vite', '--port', String(WEB_PORT), '--strictPort'], resolve(ROOT, 'apps/web'), {
      API_PROXY_TARGET: `http://localhost:${API_PORT}`,
    });
    await waitForUrl(WEB_ORIGIN, 'web');

    // Playwright resolves out of `e2e/node_modules`, so the capture runs from
    // there; it writes straight into `docs/assets/screenshots/`.
    runStep(
      'capturing',
      ['bun', 'run', 'docs:capture'],
      {
        DOCS_BASE_URL: WEB_ORIGIN,
        DOCS_FROZEN_AT_MS: String(NOW_MS),
        DOCS_LOGIN_EMAIL: email,
        DOCS_LOGIN_PASSWORD: password,
      },
      resolve(ROOT, 'e2e'),
    );
    info('screenshots refreshed');
  }
  killAll();
}

main().catch((err: unknown) => {
  console.error('[docs-screenshots]', err);
  process.exit(1);
});
