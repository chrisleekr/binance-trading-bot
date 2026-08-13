import { expect, test } from '@playwright/test';

const EMAIL = process.env['E2E_USER_EMAIL'];
const PASSWORD = process.env['E2E_USER_PASSWORD'];
const ACCOUNT_ID = process.env['E2E_ACCOUNT_ID'];
const PROFILE_ID = process.env['E2E_PROFILE_ID'];

if (!EMAIL || !PASSWORD || !ACCOUNT_ID || !PROFILE_ID) {
  throw new Error('app-p0 requires the private app-e2e seed manifest');
}

test.describe.configure({ mode: 'serial' });

test('signs in and renders the seeded profile dashboard', async ({ page }) => {
  await page.goto('/login');
  await page.locator('#login-email').fill(EMAIL);
  await page.locator('#login-password').fill(PASSWORD);
  await Promise.all([
    page.waitForURL(`/accounts/${ACCOUNT_ID}`, { timeout: 15_000 }),
    page.getByRole('button', { name: /sign in|log in/i }).click(),
  ]);

  await page.goto(`/accounts/${ACCOUNT_ID}/profiles/${PROFILE_ID}`);
  await expect(page).toHaveURL(`/accounts/${ACCOUNT_ID}/profiles/${PROFILE_ID}`);
  await expect(page.getByTestId('terminal-overview')).toBeVisible();
});
