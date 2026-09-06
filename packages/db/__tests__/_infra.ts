// The project global setup owns the one Postgres endpoint and its teardown. Keeping this module to a provided-context read makes its lifetime independent of which test file imports it first when Vitest reuses the module graph.

import { inject } from 'vitest';

// Re-exported from the lifecycle owner so the suites keep one import site and the predicate has one definition.
export { HAS_INFRA } from './_global-setup.js';

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
