import { defineProject } from '../config/vitest/index.js';

// Serialisation remains scoped to local container runs. The global setup now provisions one endpoint for the whole project, while serial execution preserves the migration suites' established Docker and database concurrency behavior.
const provisionsContainers = process.env['TESTCONTAINERS'] === '1';

// Declared separately because Vitest types `teardownTimeout` as a root-only setting even though this package config is run as the root config. The value is still consumed when `vitest run` loads this file directly.
const test = {
  globalSetup: './__tests__/_global-setup.ts',
  hookTimeout: 180_000,
  teardownTimeout: 180_000,
  fileParallelism: !provisionsContainers,
  isolate: false,
};

export default defineProject({ packageName: '@app/db', test });
