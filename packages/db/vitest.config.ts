import { defineProject } from '../config/vitest/index.js';

// Serialisation exists for one reason: to hold the one-container-at-a-time invariant while the seven migration suites provision their own Postgres, because Vitest's default fan-out started all seven against one Docker daemon at once and orphaned the containers that eventually came up.
//
// So it is armed only when there are containers to hold it over. With TESTCONTAINERS unset there are none: those suites either skip outright (the Docker-free unit lane) or run against a DATABASE_TEST_URL the lane already supplied, each on its own scratch database. Serialising there buys nothing and costs the package roughly 3x wall clock, measured.
const provisionsContainers = process.env['TESTCONTAINERS'] === '1';

export default defineProject({
  packageName: '@app/db',
  // 180s, not the 120s a pure provisioning budget would need. `remove-paper-trading-migration` provisions, creates a scratch database, then runs the migration set in two staged passes, and `withPostgres` may legitimately spend its full 90s PROVISION_DEADLINE_MS before the first pass starts. That suite carried an explicit 180s of its own until the shared memo took provisioning over, and `infra-lifecycle-config` now forbids a per-hook override, so the budget has to be right here or the heaviest hook regresses into the bare "beforeAll timed out" this whole path replaces.
  test: { hookTimeout: 180_000, fileParallelism: !provisionsContainers },
});
