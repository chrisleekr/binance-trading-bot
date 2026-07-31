// Playwright config for the operator-facing end-to-end suite.
//
// The full acceptance list in #49 calls for 27 canonical scenarios on
// chromium/firefox/webkit at two viewports (iPhone SE 375x667 and a
// 1280x720 laptop). This config declares the projects + reporter
// scaffold plus the gated `globalSetup` / `globalTeardown` that spin
// the docker compose stack when `E2E_FULL_STACK=1` is set; the 27
// scenarios themselves land in follow-up MRs against this scaffold.

import { defineConfig, devices, type PlaywrightTestConfig } from '@playwright/test';

// Matches global-setup's default: the E2E_FULL_STACK compose stack publishes
// web on the 5xxxx local-override port, not the native dev 5173.
const BASE_URL = process.env['E2E_BASE_URL'] ?? 'http://localhost:55173';
const IS_CI = process.env['CI'] !== undefined && process.env['CI'] !== '';

const config: PlaywrightTestConfig = defineConfig({
  testDir: './tests',
  // Gated on `E2E_FULL_STACK=1` inside the modules themselves so the
  // default playwright-image CI run (no docker daemon) keeps the data:
  // URL smoke working without orchestrating compose. When the gate is
  // on, setup brings `deploy/compose/docker-compose.yml` +
  // `docker-compose.local.yml` up via `docker compose up -d --wait` and
  // polls `/healthz` + the web port; teardown brings it back down.
  globalSetup: './global-setup.ts',
  globalTeardown: './global-teardown.ts',
  // CI runners are slower and more contended than developer laptops; the
  // 30s per-test cap is the same bound the Playwright examples use for
  // multi-step flows and is generous for the current smoke scenario.
  timeout: 30_000,
  expect: { timeout: 5_000 },
  // No retry on local. CI retries once because shared-runner flakes have
  // shown up across other test surfaces in this repo (vitest's
  // asyncUtilTimeout was bumped for the same class of issue).
  retries: IS_CI ? 1 : 0,
  // One worker per browser locally for predictable output; CI keeps the
  // Playwright default (worker per project) so the three browsers run
  // in parallel — `undefined` is excluded by exactOptionalPropertyTypes
  // so we go with a generous 4 to match the project list size.
  workers: IS_CI ? 4 : 1,
  reporter: IS_CI ? [['list'], ['junit', { outputFile: 'test-results/junit.xml' }]] : 'list',
  use: {
    baseURL: BASE_URL,
    // Capture artefacts only on failure so a passing CI run doesn't
    // upload tens of MB of traces.
    trace: 'retain-on-failure',
    screenshot: 'only-on-failure',
    video: 'retain-on-failure',
  },
  projects: [
    {
      // Mobile Chrome. `devices['iPhone SE']` would default to WebKit
      // (Playwright marks iPhone presets with `defaultBrowserType: webkit`),
      // duplicating the `webkit-desktop` coverage and missing Chromium on
      // mobile entirely. Pixel 5 is the Playwright-recommended Chromium
      // mobile preset; viewport stays pinned to the AC's 375x667.
      name: 'chromium-mobile',
      use: { ...devices['Pixel 5'], viewport: { width: 375, height: 667 } },
    },
    {
      name: 'chromium-desktop',
      use: { ...devices['Desktop Chrome'], viewport: { width: 1280, height: 720 } },
    },
    {
      name: 'firefox-desktop',
      use: { ...devices['Desktop Firefox'], viewport: { width: 1280, height: 720 } },
    },
    {
      name: 'webkit-desktop',
      use: { ...devices['Desktop Safari'], viewport: { width: 1280, height: 720 } },
    },
  ],
});

export default config;
