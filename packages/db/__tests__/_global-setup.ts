import type { TestProject } from 'vitest/node';

declare module 'vitest' {
  export interface ProvidedContext {
    readonly databaseTestUrl: string | undefined;
  }
}

// Two ways to get a real Postgres: `TESTCONTAINERS=1` provisions a throwaway one (Docker required), or `DATABASE_TEST_URL` names a running server. Neither, and the provisioning suites `describe.skipIf` out in the no-Docker unit lane. Declared here rather than in the worker-side helper because this file decides whether to acquire anything at all; `_infra.ts` re-exports it for the suites.
export const HAS_INFRA =
  process.env['TESTCONTAINERS'] === '1' || Boolean(process.env['DATABASE_TEST_URL']);

/**
 * Owns the database fixture for the complete project run so a shared module graph cannot attach teardown to the first importing file.
 *
 * @param project - Vitest project receiving the serialisable URL exposed to test workers.
 * @returns Global teardown that releases whatever `withPostgres` acquired, or nothing when no infrastructure was requested.
 */
const setupDatabase = async (project: TestProject): Promise<void | (() => Promise<void>)> => {
  if (!HAS_INFRA) return;

  // Which selector wins when both are set is `withPostgres`'s rule, not this file's. Re-deciding it here would leave the db lane on the old precedence the day the wrapper grows a third selector, with every test still green. Imported lazily so the no-infra lane never loads Testcontainers.
  const { withPostgres } = await import('@app/testcontainers');
  const fixture = await withPostgres();
  project.provide('databaseTestUrl', fixture.databaseUrl);
  // A no-op on the reuse branch: the wrapper hands back a `stop` that releases nothing when it did not provision.
  return async () => {
    try {
      await fixture.stop();
    } catch (error) {
      // Vitest reports project-teardown rejections during close without making the CLI fail, so preserve the rejection in the process outcome before rethrowing its diagnostic.
      process.exitCode = 1;
      throw error;
    }
  };
};

export default setupDatabase;
