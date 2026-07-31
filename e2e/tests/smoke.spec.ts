// Foundation smoke. Runs without the docker compose stack so this MR
// can land before #48's testcontainers wiring is in place. The next 26
// canonical scenarios (onboarding, profile create, manual order, ...
// see #49 AC) live in follow-up files that depend on `globalSetup`
// spinning the real stack.

import { expect, test } from '@playwright/test';

const HTML = '<!doctype html><title>Playwright smoke</title><body><h1>ok</h1></body>';

test('Playwright runs and Chromium/Firefox/Webkit boot the browser engine', async ({ page }) => {
  // Navigate to a data: URL so the test depends on nothing external.
  await page.goto(`data:text/html;charset=utf-8,${encodeURIComponent(HTML)}`);
  await expect(page).toHaveTitle('Playwright smoke');
  const heading = page.locator('h1');
  await expect(heading).toHaveText('ok');
});
