// Playwright globalSetup. Gated on E2E_FULL_STACK=1 so the default
// playwright-image CI run (no docker daemon available) keeps the current
// data: URL smoke working without trying to orchestrate compose. When the
// gate is on, spins `deploy/compose/docker-compose.yml` +
// `docker-compose.local.yml` via `docker compose up -d --wait`, then polls
// the single `app` service (which serves both the SPA and `/api`) until it
// responds.

import { spawnSync } from 'node:child_process';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

/**
 * Compose orchestration for the e2e suite. `docker compose up --wait` blocks on
 * the healthchecks of postgres, redis, and `app` (the app image has a
 * HEALTHCHECK on the api /readyz), but the function still follows up with an
 * explicit HTTP poll before letting the test run start.
 */
const COMPOSE_FILES = [
  'deploy/compose/docker-compose.yml',
  'deploy/compose/docker-compose.local.yml',
];

// Compose paths in COMPOSE_FILES are repo-root-relative; Playwright runs
// with cwd = `e2e/`, so resolve once and pass via `spawnSync({ cwd })`.
const REPO_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');

// Defaults target the dockerized local-override port (the 5xxxx homelab
// scheme), not the native `bun run dev` ports: E2E_FULL_STACK brings up the
// compose stack below, where the single `app` service publishes the SPA + /api
// same-origin on 53000.
const API_HEALTH_URL = process.env['E2E_API_HEALTH_URL'] ?? 'http://localhost:53000/healthz';
const WEB_BASE_URL = process.env['E2E_BASE_URL'] ?? 'http://localhost:53000';
const READY_TIMEOUT_MS = 120_000;
const POLL_INTERVAL_MS = 1_000;

/**
 * Wait until `url` returns a 2xx within the timeout. Throws so Playwright
 * fails fast if the stack never comes up — silent skip would hide a real
 * config drift between compose and the test config. `signal` lets the
 * caller cancel an in-flight wait when a sibling URL has already failed,
 * so the slowest losing poll cannot stretch the run to its full deadline.
 */
const waitForUrl = async (url: string, timeoutMs: number, signal?: AbortSignal): Promise<void> => {
  const deadline = Date.now() + timeoutMs;
  let lastError: unknown;
  while (Date.now() < deadline) {
    if (signal?.aborted) {
      throw new Error(`e2e: wait for ${url} aborted before ready (${String(lastError)})`);
    }
    try {
      const res = await fetch(url, {
        method: 'GET',
        signal: AbortSignal.any(
          signal
            ? [signal, AbortSignal.timeout(POLL_INTERVAL_MS)]
            : [AbortSignal.timeout(POLL_INTERVAL_MS)],
        ),
      });
      if (res.ok) return;
      lastError = new Error(`status ${res.status}`);
    } catch (err) {
      lastError = err;
    }
    await new Promise((r) => setTimeout(r, POLL_INTERVAL_MS));
  }
  throw new Error(`e2e: ${url} did not become ready in ${timeoutMs}ms (${String(lastError)})`);
};

/**
 * Compose the `-f file -f file` argument list once so the up/down calls
 * cannot drift apart and stop tearing the same stack down they brought
 * up.
 */
const composeArgs = (cmd: string[]): string[] => {
  const out: string[] = [];
  for (const file of COMPOSE_FILES) {
    out.push('-f', file);
  }
  return [...out, ...cmd];
};

/**
 * Entry point Playwright calls before any project runs. No-op when
 * `E2E_FULL_STACK=1` is not set so the default e2e run (CI's playwright
 * image without a docker daemon) keeps working with the data: URL smoke.
 */
const globalSetup = async (): Promise<void> => {
  if (process.env['E2E_FULL_STACK'] !== '1') return;

  // The default topology is one `app` service (ROLE=all) running api + worker +
  // study in one process; it serves the SPA and /api, which is all the e2e specs
  // need.
  const services = ['postgres', 'redis', 'app'];
  const up = spawnSync('docker', ['compose', ...composeArgs(['up', '-d', '--wait', ...services])], {
    stdio: 'inherit',
    cwd: REPO_ROOT,
  });
  if (up.status !== 0) {
    throw new Error(`e2e: docker compose up failed (exit ${up.status})`);
  }

  // `Promise.allSettled` so one URL's failure aborts the other before
  // both burn the full READY_TIMEOUT_MS; aggregate the errors so the
  // failure message names every URL that didn't come up.
  const controller = new AbortController();
  const results = await Promise.allSettled([
    waitForUrl(API_HEALTH_URL, READY_TIMEOUT_MS, controller.signal).catch((err) => {
      controller.abort();
      throw err;
    }),
    waitForUrl(WEB_BASE_URL, READY_TIMEOUT_MS, controller.signal).catch((err) => {
      controller.abort();
      throw err;
    }),
  ]);
  const failures = results.filter((r): r is PromiseRejectedResult => r.status === 'rejected');
  if (failures.length > 0) {
    throw new Error(`e2e: stack not ready — ${failures.map((f) => String(f.reason)).join('; ')}`);
  }
};

export default globalSetup;
