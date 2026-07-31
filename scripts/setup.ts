#!/usr/bin/env bun
// Idempotent first-run bootstrap. See `.claude/plans/02-monorepo-skeleton.md` → "Bootstrap script".
import { existsSync } from 'node:fs';
import { copyFile } from 'node:fs/promises';
import { resolve } from 'node:path';

const ROOT = resolve(import.meta.dir, '..');
const COMPOSE = resolve(ROOT, 'deploy/compose/docker-compose.yml');
// Local override publishes 5432/6379 on the host; required for the
// host-side waitForPostgres probe and for drizzle-kit to reach the DB.
const COMPOSE_LOCAL = resolve(ROOT, 'deploy/compose/docker-compose.local.yml');

function fail(msg: string): never {
  console.error(`[setup] ${msg}`);
  process.exit(1);
}

function info(msg: string): void {
  console.log(`[setup] ${msg}`);
}

function checkBunVersion(): void {
  const [maj, min] = Bun.version.split('.').map(Number);
  if (maj == null || min == null) fail(`unparsable Bun.version: ${Bun.version}`);
  if (maj < 1 || (maj === 1 && min < 3)) fail(`Bun >=1.3 required, got ${Bun.version}`);
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

function composeUp(): void {
  const r = Bun.spawnSync(
    ['docker', 'compose', '-f', COMPOSE, '-f', COMPOSE_LOCAL, 'up', '-d', 'postgres', 'redis'],
    { cwd: ROOT, stdout: 'inherit', stderr: 'inherit' },
  );
  if (r.exitCode !== 0) fail('docker compose up failed');
}

async function waitForPostgres(host = 'localhost', port = 5432, attempts = 30): Promise<void> {
  for (let i = 1; i <= attempts; i++) {
    try {
      const sock = await Bun.connect({
        hostname: host,
        port,
        // eslint-disable-next-line @typescript-eslint/no-empty-function
        socket: { data() {}, open() {}, close() {}, error() {} },
      });
      sock.end();
      info(`Postgres reachable on ${host}:${port} (attempt ${i})`);
      return;
    } catch {
      await new Promise((r) => setTimeout(r, 1000));
    }
  }
  fail(`Postgres did not become reachable on ${host}:${port} after ${attempts}s`);
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
  await waitForPostgres();
  dbMigrate();
  info('Setup complete.');
  info('Next: `bun run dev` to boot api+web+worker+technicals.');
}

await main();
