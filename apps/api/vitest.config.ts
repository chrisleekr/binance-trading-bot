import { defineProject } from '../../packages/config/vitest/index.js';

// The api integration suites share one testcontainers Postgres+Redis stack,
// provisioned lazily on the first setupApp() (see __tests__/_helpers.ts). On a
// cold Docker host that cold-start runs well past vitest's 10s default
// hookTimeout, so the first beforeAll times out while the container is still
// starting. The shared infraPromise has not settled yet, so every sibling
// suite awaiting it also hits its own 10s hook timeout before the container is
// ready — the whole package cascades with "Hook timed out in 10000ms". 60s
// absorbs a cold container start so an isolated
// `--filter @app/api test` run is reliable. No packageName: api stays off the
// coverage-threshold gate (its integration suites skip without a DB, so a
// threshold would fail the no-Postgres unit-coverage job).
// `fileParallelism: false`: every suite shares ONE Postgres + Redis, and each
// setupApp() truncates and reseeds them. Run files concurrently and one file's
// truncate lands between another's seed and its first query — 68 of 416 tests
// fail on `users_pkey` duplicates and cascading beforeAll crashes, which in turn
// silently *skip* another ~115. The in-process `resetChain` only orders setupApp
// calls within a single worker, so isolation has to come from here.
export default defineProject({
  test: {
    hookTimeout: 60_000,
    fileParallelism: false,
    globalSetup: ['./__tests__/global-setup.ts'],
  },
});
