import { appendFileSync } from 'node:fs';

/**
 * Persists one lifecycle event so the parent process can inspect ordering after Vitest has completed global teardown.
 *
 * @param event - Event name and any value observed by the fixture suite.
 */
export const recordEvent = (event: string): void => {
  appendFileSync(process.env['INFRA_LIFECYCLE_LOG']!, `${event}\n`);
};
