import { assertTestDatabaseUrl } from '../../packages/db/src/test-guard.js';

const databaseUrl = process.env['DATABASE_TEST_URL'];
if (!databaseUrl) throw new Error('DATABASE_TEST_URL is required');

assertTestDatabaseUrl(databaseUrl);
