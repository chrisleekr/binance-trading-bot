// Pins the `bun run setup` readiness probe to the port the stack actually publishes.
//
// The local compose override publishes Postgres on 55432 and Redis on 56379 (a `5` prefix so the stack co-exists with other homelab services), and `.env.example` — the file setup copies to `.env` — points at those. The probe's own default used to be a bare 5432, so on a clean checkout setup brought the stack up and then waited out its whole budget on a port nothing was listening on, failing the documented first-run bootstrap before it ever migrated. A second copy of the number is the defect, not the number itself, so the target is derived from the URL the app connects with.

import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';

import { describe, expect, it } from 'vitest';

import { probeTargetFromDatabaseUrl, requiredBunFloor } from '../../../scripts/setup.ts';

const REPO_ROOT = fileURLToPath(new URL('../../../', import.meta.url));

/**
 * Reads one repo-root-relative file so each assertion names the artefact it is pinning.
 *
 * @param relativePath - Path from the repository root, e.g. `.env.example`.
 * @returns The file's UTF-8 contents.
 */
const readRepoFile = (relativePath: string): string =>
  readFileSync(join(REPO_ROOT, relativePath), 'utf8');

const setupSource = readRepoFile('scripts/setup.ts');
const envExample = readRepoFile('.env.example');
const localCompose = readRepoFile('deploy/compose/docker-compose.local.yml');
const baseCompose = readRepoFile('deploy/compose/docker-compose.yml');

// The argv array is prettier-wrapped across lines, so the whole function body is the unit to search; a line-anchored match would go blind the next time the formatting changes.
const composeUpBody = setupSource.match(/function composeUp\(\): void \{(?<body>[\s\S]*?)\n\}/)
  ?.groups?.['body'];

const databaseUrl = envExample.match(/^DATABASE_URL=(?<url>\S+)$/m)?.groups?.['url'];
const redisUrl = envExample.match(/^REDIS_URL=(?<url>\S+)$/m)?.groups?.['url'];

describe('probeTargetFromDatabaseUrl', () => {
  it('parses the host and port out of a connection URL', () => {
    expect(probeTargetFromDatabaseUrl('postgres://user:pw@db.internal:55432/app')).toEqual({
      host: 'db.internal',
      port: 55432,
    });
    expect(probeTargetFromDatabaseUrl('redis://cache.internal:56379')).toEqual({
      host: 'cache.internal',
      port: 56379,
    });
  });

  it("falls back to the scheme's registered port when the URL omits one", () => {
    expect(probeTargetFromDatabaseUrl('postgres://user:pw@db.internal/app').port).toBe(5432);
    expect(probeTargetFromDatabaseUrl('redis://cache.internal').port).toBe(6379);
  });

  it('refuses a URL it cannot resolve a target from rather than probing a guess', () => {
    // Silently defaulting is exactly the failure this replaced: the probe then waits out its budget against a port nothing serves and blames the database.
    expect(() => probeTargetFromDatabaseUrl('not a url')).toThrow(/unparsable/);
    expect(() => probeTargetFromDatabaseUrl('amqp://broker.internal/vhost')).toThrow(/no default/);
  });

  it('keeps the password out of the message when it names the URL it refused', () => {
    // Every one of these throws is read somewhere a password should not be: a terminal, a pasted issue report, a CI job log. Both refusal branches are covered because the unparsable one has no parsed URL to redact from and has to work on the raw string.
    const secret = 'hunter2';
    const noDefaultPort = `amqp://admin:${secret}@broker.internal/vhost`;
    const unparsable = `://admin:${secret}@not a url`;

    expect(() => probeTargetFromDatabaseUrl(noDefaultPort)).toThrow(/no default/);
    expect(() => probeTargetFromDatabaseUrl(noDefaultPort)).not.toThrow(new RegExp(secret));
    expect(() => probeTargetFromDatabaseUrl(unparsable)).toThrow(/unparsable/);
    expect(() => probeTargetFromDatabaseUrl(unparsable)).not.toThrow(new RegExp(secret));
  });
});

describe('setup Bun floor', () => {
  it('derives the floor from engines.bun rather than restating a version', () => {
    // A second copy of the number is the defect. This one admitted 1.3.x long after the repo moved to >=1.4, and the failure was silent: Bun changed the bun.lock format at 1.4, so an older runtime cleared this gate and then rewrote the lockfile a version backwards through setup's own `bun install`, surfacing as an unrelated-looking dependency diff.
    const engines = JSON.parse(readRepoFile('package.json')) as { engines?: { bun?: string } };
    const spec = engines.engines?.bun;
    expect(spec).toBeDefined();

    const declared = /(\d+)\.(\d+)/.exec(spec as string);
    expect(declared).not.toBeNull();
    expect(requiredBunFloor()).toEqual({
      major: Number(declared?.[1]),
      minor: Number(declared?.[2]),
    });
  });

  it('states no Bun version of its own for the derivation to drift from', () => {
    // The vacuity guard for the assertion above: it only proves the two agree today. A reintroduced literal is how they stop agreeing tomorrow. The pattern targets a COMPARISON against a number, because the shape this replaced spelled its floor as two bare integers, `maj < 1 || (maj === 1 && min < 3)`, with no `1.3` anywhere for a version-shaped pattern to find.
    const floorCheck = setupSource.match(
      /function checkBunVersion\(\): void \{(?<body>[\s\S]*?)\n\}/,
    )?.groups?.['body'];
    expect(floorCheck).toBeDefined();
    expect(floorCheck).not.toMatch(/[<>=]=?\s*\d/);
  });
});

describe('setup readiness probe', () => {
  it('reads a DATABASE_URL and a REDIS_URL with explicit ports out of .env.example', () => {
    // Vacuity guard for the assertions below: a renamed or reformatted var would otherwise leave them comparing undefined against undefined.
    expect(databaseUrl).toBeDefined();
    expect(redisUrl).toBeDefined();
  });

  it('resolves the .env.example URLs onto the host ports the local compose override publishes', () => {
    // Deliberately a text claim about compose: the published mapping is the one fact no import can derive, and it is the half of the pair that drifted.
    const publishedPostgres = localCompose.match(/'(?<host>\d+):5432'/)?.groups?.['host'];
    const publishedRedis = localCompose.match(/'(?<host>\d+):6379'/)?.groups?.['host'];
    expect(publishedPostgres).toBeDefined();
    expect(publishedRedis).toBeDefined();

    expect(probeTargetFromDatabaseUrl(databaseUrl as string).port).toBe(Number(publishedPostgres));
    expect(probeTargetFromDatabaseUrl(redisUrl as string).port).toBe(Number(publishedRedis));
  });
});

describe('setup compose bring-up', () => {
  it('waits on the declared healthchecks rather than treating a created container as ready', () => {
    // Vacuity guard: a renamed or restructured composeUp would otherwise leave the assertion searching an empty string.
    expect(composeUpBody).toBeDefined();
    expect(composeUpBody).toContain("'up'");
    expect(composeUpBody).toContain("'--wait'");
  });

  it('has a healthcheck on both services for --wait to block on', () => {
    // --wait only blocks on services that declare one, so without these it returns immediately and silently buys nothing.
    expect(baseCompose).toContain('pg_isready');
    expect(baseCompose).toContain("'redis-cli', 'ping'");
  });
});
