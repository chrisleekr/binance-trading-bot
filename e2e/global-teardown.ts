// Playwright globalTeardown. Mirror of `global-setup.ts`: when the gate
// is on, brings the docker compose stack down so a re-run starts from a
// clean state. No-op when the gate is off, otherwise we'd try to stop
// containers that were never started.

import { spawnSync } from 'node:child_process';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const COMPOSE_FILES = [
  'deploy/compose/docker-compose.yml',
  'deploy/compose/docker-compose.local.yml',
];

// Match `global-setup.ts`: compose paths are repo-root-relative, and
// Playwright runs with cwd = `e2e/`.
const REPO_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');

const composeArgs = (cmd: string[]): string[] => {
  const out: string[] = [];
  for (const file of COMPOSE_FILES) {
    out.push('-f', file);
  }
  return [...out, ...cmd];
};

/**
 * Entry point Playwright calls after every project finishes. Matches the
 * gate in `global-setup.ts`; running `docker compose down` without a
 * prior `up` is harmless on Docker but produces noisy stderr on hosts
 * without a daemon, so we short-circuit instead.
 */
const globalTeardown = async (): Promise<void> => {
  if (process.env['E2E_FULL_STACK'] !== '1') return;

  // No `--remove-orphans`: setup brings up a fixed, explicit service set, so an
  // e2e run never leaves orphans to reap. On a host that runs another compose
  // stack under the same project namespace, `--remove-orphans` would delete
  // those unrelated containers. No `-v` either: volumes are operator-owned and
  // shared with local dev, so wiping them would surprise the next `bun run dev`.
  const down = spawnSync('docker', ['compose', ...composeArgs(['down'])], {
    stdio: 'inherit',
    cwd: REPO_ROOT,
  });
  if (down.status !== 0) {
    // Teardown failures are logged but not thrown; Playwright has
    // already recorded the test result and re-throwing here would only
    // mask it. The `e2e_teardown_failed` tag is greppable in CI logs so
    // a leaked stack does not silently hide between runs.
    console.error(`e2e_teardown_failed: docker compose down exited ${down.status}`);
  }
};

export default globalTeardown;
