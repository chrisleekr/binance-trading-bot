#!/usr/bin/env bun
// Idempotent first-run bootstrap: safe to re-run, and every step is a no-op once already satisfied.
import { existsSync, readFileSync } from 'node:fs';
import { copyFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

// `import.meta.dir` is a Bun extension and is undefined under the vitest/vite transform, so the module would throw on import in the test that covers the probe. The URL form resolves identically under both runtimes.
const ROOT = fileURLToPath(new URL('..', import.meta.url));
const COMPOSE = resolve(ROOT, 'deploy/compose/docker-compose.yml');
// Local override republishes Postgres and Redis on 5-prefixed host ports (55432 / 56379) so the stack co-exists with other services already holding the well-known numbers. Those are the ports `.env.example` points at, and the only ones a host-side probe or drizzle-kit can reach.
const COMPOSE_LOCAL = resolve(ROOT, 'deploy/compose/docker-compose.local.yml');

function fail(msg: string): never {
  console.error(`[setup] ${msg}`);
  process.exit(1);
}

function info(msg: string): void {
  console.log(`[setup] ${msg}`);
}

/**
 * Reads the Bun floor out of the root manifest's `engines` field.
 *
 * Restating the number here is what let this check drift: it admitted 1.3.x long after the repo moved to `>=1.4`, and the damage was silent rather than loud. Bun writes `bun.lock` in a format that changed at 1.4, so an older runtime passing this gate goes on to rewrite the lockfile a version backwards through setup's own `bun install`, and the diff looks like an unrelated dependency change. `no-bun-version-skew.sh` pins the nine sites that name an exact version; `engines` is the range, and deriving from it means this cannot disagree with the pin.
 *
 * @returns The major and minor of the minimum supported Bun version.
 */
export function requiredBunFloor(): { major: number; minor: number } {
  const raw = JSON.parse(readFileSync(resolve(ROOT, 'package.json'), 'utf8')) as {
    engines?: { bun?: string };
  };
  const spec = raw.engines?.bun;
  if (spec == null) fail('package.json has no engines.bun to derive the Bun floor from');
  const m = /(\d+)\.(\d+)/.exec(spec);
  if (m?.[1] == null || m[2] == null) fail(`unparsable engines.bun range: ${spec}`);
  return { major: Number(m[1]), minor: Number(m[2]) };
}

function checkBunVersion(): void {
  const [maj, min] = Bun.version.split('.').map(Number);
  if (maj == null || min == null) fail(`unparsable Bun.version: ${Bun.version}`);
  const floor = requiredBunFloor();
  if (maj < floor.major || (maj === floor.major && min < floor.minor)) {
    fail(`Bun >=${floor.major}.${floor.minor} required, got ${Bun.version}`);
  }
  info(`Bun ${Bun.version} OK`);
}

function checkDocker(): void {
  const v = Bun.spawnSync(['docker', '--version']);
  if (v.exitCode !== 0) fail('docker not installed or not on PATH');
  const c = Bun.spawnSync(['docker', 'compose', 'version']);
  if (c.exitCode !== 0) fail('docker compose plugin missing (try `docker compose version`)');
  info('docker + docker compose OK');
}

async function ensureEnv(): Promise<void> {
  const envFile = resolve(ROOT, '.env');
  const example = resolve(ROOT, '.env.example');
  if (existsSync(envFile)) {
    info('.env present, skipping copy');
    return;
  }
  if (!existsSync(example)) fail('.env.example missing');
  await copyFile(example, envFile);
  info(
    '.env created from .env.example. Fill DATABASE_URL / REDIS_URL / WEB_ORIGIN and set AUTH_SECRET (`openssl rand -hex 32`), then re-run',
  );
  process.exit(0);
}

function bunInstall(): void {
  const r = Bun.spawnSync(['bun', 'install'], { cwd: ROOT, stdout: 'inherit', stderr: 'inherit' });
  if (r.exitCode !== 0) fail('bun install failed');
}

// `--wait` blocks until both services report healthy, not merely created. Without it compose returns as soon as the containers exist, and on a re-run it recreates them, so `db:migrate` opens a connection against a Postgres that is still starting and dies with "Connection terminated unexpectedly". Both services already declare a healthcheck in docker-compose.yml (`pg_isready`, `redis-cli ping`), so waiting on those is the readiness contract itself; re-implementing it here would be a second source of truth that can disagree with the one the stack runs on.
function composeUp(): void {
  const r = Bun.spawnSync(
    [
      'docker',
      'compose',
      '-f',
      COMPOSE,
      '-f',
      COMPOSE_LOCAL,
      'up',
      '-d',
      '--wait',
      'postgres',
      'redis',
    ],
    { cwd: ROOT, stdout: 'inherit', stderr: 'inherit' },
  );
  if (r.exitCode !== 0) fail('docker compose up failed');
}

// Scheme defaults, used only when a URL omits its port. Restating them is safe in a way that restating the HOST port was not: these are the protocol's own registered numbers, not a local deployment choice that drifts.
const DEFAULT_PORTS: Readonly<Record<string, number>> = {
  'postgres:': 5432,
  'postgresql:': 5432,
  'redis:': 6379,
  'rediss:': 6379,
};

/**
 * Strips the credentials out of a connection URL so it can be named in an error.
 *
 * A Postgres or Redis URL carries its password in the userinfo, and every throw below is read somewhere a password should not be: a terminal, a pasted issue report, a CI log. The regex runs on the raw string rather than on a parsed `URL` because the unparsable branch is exactly the one that has no parse to work from.
 *
 * @param url - The raw connection URL, parsable or not.
 * @returns The same string with any `user:password@` replaced by `***@`.
 */
const redactUserinfo = (url: string): string => url.replace(/\/\/[^/@]*@/, '//***@');

/**
 * Resolves the TCP endpoint a readiness probe should dial out of a service connection URL.
 *
 * The probe target has to be derived rather than restated: the compose override publishes Postgres on 55432 and Redis on 56379, so a hardcoded 5432 default waits out its whole budget against a port nothing is listening on and `bun run setup` fails on a clean checkout before it ever migrates. Deriving from the same URL the app connects with means the two cannot disagree.
 *
 * @param url - Any service connection URL, `DATABASE_URL` or `REDIS_URL`; the name says database because Postgres is the probe this was written for, but the parse is scheme-driven and applies to both.
 * @returns The hostname and port to connect to, falling back to the scheme's registered default port when the URL omits one.
 */
export function probeTargetFromDatabaseUrl(url: string): { host: string; port: number } {
  let parsed: URL;
  try {
    parsed = new URL(url);
  } catch {
    throw new Error(`unparsable connection URL: ${redactUserinfo(url)}`);
  }
  const port = parsed.port ? Number(parsed.port) : DEFAULT_PORTS[parsed.protocol];
  if (port == null) {
    throw new Error(
      `no port in ${redactUserinfo(url)} and no default known for scheme ${parsed.protocol}`,
    );
  }
  if (!parsed.hostname) throw new Error(`no host in connection URL: ${redactUserinfo(url)}`);
  return { host: parsed.hostname, port };
}

/**
 * Polls a TCP connect against a service until it answers, then reports where it answered.
 *
 * This proves only that something is listening on the derived host and port; `--wait` on the compose up above is what proves the service is ready to serve. The probe still earns its place for the case compose cannot cover: an operator who started the stack themselves, where setup's `up` is a no-op and no healthcheck is waited on. It is also what makes the DATABASE_URL / REDIS_URL derivation observable, since it prints the endpoint it actually reached.
 *
 * @param label - Service name for the operator-facing log lines, e.g. `Postgres`.
 * @param url - The connection URL the app itself uses; the probe target is derived from it rather than restated.
 * @param attempts - Number of one-second attempts before giving up and failing setup.
 * @returns Nothing; exits the process through `fail` when the endpoint never answers.
 */
async function waitForService(label: string, url: string, attempts = 30): Promise<void> {
  const { host, port } = probeTargetFromDatabaseUrl(url);
  for (let i = 1; i <= attempts; i++) {
    try {
      const sock = await Bun.connect({
        hostname: host,
        port,
        // eslint-disable-next-line @typescript-eslint/no-empty-function
        socket: { data() {}, open() {}, close() {}, error() {} },
      });
      sock.end();
      info(`${label} reachable on ${host}:${port} (attempt ${i})`);
      return;
    } catch {
      await new Promise((r) => setTimeout(r, 1000));
    }
  }
  fail(`${label} did not become reachable on ${host}:${port} after ${attempts}s`);
}

function requireEnv(name: string): string {
  const value = process.env[name];
  if (!value) fail(`${name} is not set — fill it in .env (copied from .env.example) and re-run`);
  return value;
}

function dbMigrate(): void {
  const r = Bun.spawnSync(['bun', 'run', 'db:migrate'], {
    cwd: ROOT,
    stdout: 'inherit',
    stderr: 'inherit',
  });
  if (r.exitCode !== 0) fail('db:migrate failed');
}

async function main(): Promise<void> {
  checkBunVersion();
  checkDocker();
  await ensureEnv();
  bunInstall();
  composeUp();
  await waitForService('Postgres', requireEnv('DATABASE_URL'));
  // Redis has no equivalent of dbMigrate to notice it is still starting, so nothing downstream would report a Redis that never came up — the first boot of the app would.
  await waitForService('Redis', requireEnv('REDIS_URL'));
  dbMigrate();
  info('Setup complete.');
  info('Next: `bun run dev` to boot api+web+worker+technicals.');
}

// Guarded so a test can import `probeTargetFromDatabaseUrl` without this module spawning `docker compose up` as a side effect of the import.
if (import.meta.main) {
  await main();
}
