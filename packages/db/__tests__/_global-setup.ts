import type { TestProject } from 'vitest/node';

const TESTCONTAINERS_SPECIFIER = ['@app', 'testcontainers'].join('/');

declare module 'vitest' {
  export interface ProvidedContext {
    readonly databaseTestUrl: string | undefined;
  }
}

/**
 * Owns the database fixture for the complete project run so a shared module graph cannot attach teardown to the first importing file. Explicit container provisioning takes precedence over a caller-owned external URL, matching the repository's test-infrastructure contract.
 *
 * @param project - Vitest project receiving the serialisable URL exposed to test workers.
 * @returns Global teardown when this run provisioned a container, otherwise no teardown.
 */
const setupDatabase = async (project: TestProject): Promise<void | (() => Promise<void>)> => {
  if (process.env['TESTCONTAINERS'] === '1') {
    const { withPostgres } = (await import(TESTCONTAINERS_SPECIFIER)) as {
      readonly withPostgres: () => Promise<{
        readonly databaseUrl: string;
        readonly stop: () => Promise<void>;
      }>;
    };
    const fixture = await withPostgres();
    project.provide('databaseTestUrl', fixture.databaseUrl);
    return async () => {
      try {
        await fixture.stop();
      } catch (error) {
        // Vitest reports project-teardown rejections during close without making the CLI fail, so preserve the rejection in the process outcome before rethrowing its diagnostic.
        process.exitCode = 1;
        throw error;
      }
    };
  }

  const externalUrl = process.env['DATABASE_TEST_URL'];
  if (externalUrl) project.provide('databaseTestUrl', externalUrl);
};

export default setupDatabase;
