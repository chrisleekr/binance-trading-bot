import { expect, it } from 'vitest';

import { sharedDatabaseUrl } from '../../_infra.js';
import { recordEvent } from './events.fixture.js';

it('later suite consumes the same shared database URL', async () => {
  const databaseUrl = await sharedDatabaseUrl();
  const databaseEnv = process.env['DATABASE_TEST_URL'] ?? '<unset>';
  recordEvent(`consumer-b:${databaseUrl}:${databaseEnv}`);
  expect(databaseUrl).toBe(process.env['EXPECTED_DATABASE_URL']);
});
