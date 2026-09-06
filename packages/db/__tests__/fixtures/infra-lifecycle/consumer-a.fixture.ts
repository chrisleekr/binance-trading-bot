import { expect, it } from 'vitest';

import { sharedDatabaseUrl } from '../../_infra.js';
import { recordEvent } from './events.fixture.js';

it('first suite consumes the shared database URL', async () => {
  const databaseUrl = await sharedDatabaseUrl();
  const databaseEnv = process.env['DATABASE_TEST_URL'] ?? '<unset>';
  recordEvent(`consumer-a:${databaseUrl}:${databaseEnv}`);
  expect(databaseUrl).toBe(process.env['EXPECTED_DATABASE_URL']);
});
