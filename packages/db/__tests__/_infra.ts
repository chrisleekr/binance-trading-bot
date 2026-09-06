// The project global setup owns the one Postgres endpoint and its teardown. Keeping this module to a provided-context read makes its lifetime independent of which test file imports it first when Vitest reuses the module graph.

import { inject } from 'vitest';

// Two ways to get a real Postgres: `TESTCONTAINERS=1` provisions a throwaway one (Docker required), or `DATABASE_TEST_URL` names a running server. Neither, and the provisioning suites `describe.skipIf` out in the no-Docker unit lane.
export const HAS_INFRA =
  process.env['TESTCONTAINERS'] === '1' || Boolean(process.env['DATABASE_TEST_URL']);

/**
 * Returns the project-owned Postgres endpoint shared by every provisioning suite. Callers that need an empty schema create a scratch database on this endpoint rather than asking for a second container.
 *
 * @returns The base connection string, which addresses the fixture's default database rather than any suite's scratch one.
 */
export const sharedDatabaseUrl = async (): Promise<string> => {
  const databaseUrl = inject('databaseTestUrl');
  if (!databaseUrl) {
    throw new Error(
      'Database test infrastructure was requested without a URL from the project global setup.',
    );
  }
  return databaseUrl;
};
