import { defineProject } from '../config/vitest/index.js';

// Serialisation remains scoped to local container runs. The global setup now provisions one endpoint for the whole project, while serial execution preserves the migration suites' established Docker and database concurrency behavior.
const provisionsContainers = process.env['TESTCONTAINERS'] === '1';

// Declared separately because Vitest types `teardownTimeout` as a root-only setting even though this package config is run as the root config. The value is still consumed when `vitest run` loads this file directly.
const test = {
  globalSetup: './__tests__/_global-setup.ts',
  hookTimeout: 180_000,
  teardownTimeout: 180_000,
  fileParallelism: !provisionsContainers,
  // Measured on the no-infra lane, same 238 passed / 472 skipped either way: 3.5s wall and 15s import shared, against 7.7s wall and 52s import isolated. The 79 files re-parse the same drizzle schema and migration helpers on every fresh registry, so the saving is import cost, not test cost.
  //
  // Safe because nothing here depends on a fresh registry per file. `_infra.ts` is a provided-context read with no module-level state to leak, teardown is owned by the project global setup rather than by whichever file imported first, and no suite calls `vi.resetModules()` on the shared graph.
  isolate: false,
};

export default defineProject({ packageName: '@app/db', test });
