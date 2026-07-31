// Foundation /login smoke (#49-A acceptance). Gated on `E2E_FULL_STACK=1`
// because the current playwright-image CI run has no docker daemon to
// spin the compose stack the page needs. With the gate on, the smoke
// drives Playwright against the running `apps/web` dev server via
// `globalSetup` and locks the page-load contract: `/login` reaches the
// SPA shell and the document title carries trading-bot branding.

import { expect, test } from '@playwright/test';

const E2E_FULL_STACK = process.env['E2E_FULL_STACK'] === '1';

test.skip(!E2E_FULL_STACK, 'login smoke requires the full docker compose stack (E2E_FULL_STACK=1)');

test('GET /login renders the SPA shell with the trading-bot title', async ({ page }) => {
  const response = await page.goto('/login');
  expect(response, 'navigation response').not.toBeNull();
  expect(response?.ok(), `status ${response?.status()}`).toBe(true);
  // The Vite shell sets `<title>binance-trading-bot</title>`; the
  // acceptance reads as "title carries trading-bot branding", so the
  // case-insensitive substring is the load-bearing assertion. A future
  // per-route title change ("Login — Trading Bot") still satisfies it.
  // The `[- _]?` class (not `.`) keeps the regex from matching arbitrary
  // characters between "trading" and "bot".
  await expect(page).toHaveTitle(/trading[- _]?bot/i);
});
