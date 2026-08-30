// @vitest-environment node
// Guards the web package's worker fan-out against silent regression.
//
// The web suite is the largest file count in the repo and vitest defaults to one worker per available core. On a shared runner that oversubscribes the box: every render competes for CPU, a multi-step interaction test starves mid-wait, and the failure surfaces as a timeout rather than as contention. Raising `testTimeout` would only move that ceiling, so the timeout is pinned here too — a later "fix" that lifts it instead of capping the workers fails this file.
//
// The node environment is required to import the config at all: with the directive removed, this file fails to load with `TypeError: The URL must be of scheme file`, thrown from the config's own `fileURLToPath(new URL('./src', import.meta.url))` before any assertion runs.

import { describe, expect, it } from 'vitest';

import config from '../vitest.config.js';

describe('@app/web vitest config', () => {
  it('caps worker fan-out so a shared runner is not oversubscribed', () => {
    // Vitest accepts a count or a percentage of the host's cores, and the percentage form is the one that adapts to whatever machine runs it. The assertion is therefore on the resolved effect — a small, bounded pool — not on which spelling was used.
    const maxWorkers = config.test?.maxWorkers;
    const cores = 16;
    const resolved =
      typeof maxWorkers === 'string'
        ? Math.max(1, Math.round((Number.parseFloat(maxWorkers) / 100) * cores))
        : maxWorkers;
    expect(resolved).toBeGreaterThanOrEqual(1);
    expect(resolved).toBeLessThanOrEqual(4);
  });

  it('keeps the testTimeout at 20s rather than absorbing contention by raising it', () => {
    expect(config.test?.testTimeout).toBe(20_000);
  });
});
