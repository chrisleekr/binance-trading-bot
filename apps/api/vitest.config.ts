import { defineProject } from '../../packages/config/vitest/index.js';

// Each isolated integration file lazily provisions its own Testcontainers Postgres and Redis pair through __tests__/_helpers.ts; files configured with DATABASE_TEST_URL and REDIS_TEST_URL instead share those external services. A cold Docker start can exceed Vitest's 10s default hook timeout, so this project allows 60s. `fileParallelism: false` also prevents concurrent files from truncating and reseeding the same external test database; the in-process reset chain only orders setupApp calls inside one isolated file.
export default defineProject({
  packageName: '@app/api',
  test: {
    hookTimeout: 60_000,
    fileParallelism: false,
    globalSetup: ['./__tests__/global-setup.ts'],
  },
});
