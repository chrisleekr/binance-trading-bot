// One Postgres endpoint per test file, provisioned lazily and torn down by a hook this module owns.
//
// The migration suites here used to each resolve their own endpoint inside `beforeAll`, which put the container's only handle inside the hook that acquires it. When that hook timed out — the ordinary outcome once several suites provisioned at once — the suite's own `afterAll` never ran and the container that eventually came up was never stopped. The teardown therefore has to live outside the hook that acquires: the file-scope `afterAll` below runs whether or not any suite's setup succeeded.
//
// Serialisation is the other half, and it lives in `vitest.config.ts` (`fileParallelism: false`): Vitest isolates module state per test file, so this memo bounds provisioning within a file, never across them. Only running one file at a time bounds it across the package.

import { afterAll } from 'vitest';

// Two ways to get a real Postgres: `TESTCONTAINERS=1` provisions a throwaway one (Docker required), or `DATABASE_TEST_URL` names a running server. Neither, and the provisioning suites `describe.skipIf` out — the no-Docker unit lane.
export const HAS_INFRA =
  process.env['TESTCONTAINERS'] === '1' || Boolean(process.env['DATABASE_TEST_URL']);

/** A resolved endpoint plus the hook that releases whatever was provisioned to obtain it. */
interface SharedInfra {
  readonly databaseUrl: string;
  readonly stop: () => Promise<void>;
}

let infraPromise: Promise<SharedInfra> | null = null;

/**
 * The base Postgres connection string for this test file, provisioning one throwaway container on first call and returning the same endpoint thereafter. Callers that need an empty schema create a scratch database on this endpoint rather than asking for a second container.
 *
 * @returns The base connection string, which addresses the wrapper's default database rather than any suite's scratch one.
 */
export const sharedDatabaseUrl = async (): Promise<string> => {
  // Dynamic import so the no-Docker unit lane never resolves the testcontainers dependency graph: every file here is loaded during collection, including the ones whose suites skip.
  infraPromise ??= import('@app/testcontainers').then((module) => module.withPostgres());
  return (await infraPromise).databaseUrl;
};

/**
 * Releases the endpoint this file provisioned, if it ever resolved. A no-op when `DATABASE_TEST_URL` supplied the endpoint, because nothing was provisioned to release.
 *
 * @returns A promise that settles once the provisioned container has stopped.
 */
export const stopSharedInfra = async (): Promise<void> => {
  const pending = infraPromise;
  if (!pending) return;
  infraPromise = null;
  // Swallowed rather than awaited bare: a provision that never resolved leaves nothing to stop (the deadline reaper in `@app/testcontainers` owns a container that arrives late), and rethrowing here would replace the real setup failure in the report with a teardown one.
  const infra = await pending.catch(() => null);
  await infra?.stop();
};

afterAll(stopSharedInfra);
