import { recordEvent } from './events.fixture.js';

/**
 * Replaces the container boundary with deterministic lifecycle events while preserving the wrapper shape consumed by the real global setup.
 *
 * @returns A fixed URL and a stop function that records global teardown.
 */
export const withPostgres = async () => {
  if (process.env['TESTCONTAINERS'] === '1') {
    recordEvent('start');
    return {
      databaseUrl: 'postgres://fixture/shared',
      stop: async () => {
        recordEvent('stop');
        const failure = process.env['INFRA_LIFECYCLE_STOP_FAILURE'];
        if (failure) throw new Error(failure);
      },
    };
  }
  return {
    databaseUrl: process.env['DATABASE_TEST_URL']!,
    stop: async () => undefined,
  };
};
