// Profile-control journeys: kill-switch engage/release and config-save
// round-trip. Both drive the SPA the way an operator would — real clicks
// on real buttons, no API shortcuts — and assert the on-screen result.
//
// Serial + one shared login: the API rate-limits /sign-in (60s window),
// so a fresh login per test would trip "Too many attempts" and flake.
//
// Gated by env, not E2E_FULL_STACK: the full-stack flag spins docker
// compose in global-setup, which conflicts with the native `bun run dev`
// workflow these specs target. Setting E2E_USER_*/E2E_PROFILE_ID is the
// explicit opt-in (CI runs only the no-stack smoke subset).
//
// Account-scoped IA: every profile surface is nested under
// `/accounts/$accountId/profiles/$profileId/...`, so navigations here name both
// the account and the profile. Needs an operator full-stack run
// (`E2E_FULL_STACK` + the env vars) to validate.

import { test, expect, type Browser, type Page } from '@playwright/test';

const EMAIL = process.env['E2E_USER_EMAIL'] ?? '';
const PASSWORD = process.env['E2E_USER_PASSWORD'] ?? '';
const ACCOUNT_ID = process.env['E2E_ACCOUNT_ID'] ?? '';
const PROFILE_ID = process.env['E2E_PROFILE_ID'] ?? '';
const ENABLED = EMAIL && PASSWORD && ACCOUNT_ID && PROFILE_ID;

test.describe.configure({ mode: 'serial' });
test.skip(
  !ENABLED,
  'profile-controls specs require E2E_USER_EMAIL/PASSWORD + E2E_ACCOUNT_ID + E2E_PROFILE_ID',
);

let page: Page;

// The generated config form folds expert sub-sections — and the root "Advanced
// settings" tier — into collapsed <details>, so a deep field (e.g.
// regime.onBull.*) is mounted but not actionable until its ancestors are open.
// Click open every closed disclosure, one per pass, re-querying so nested folds
// (revealed only once their parent opens) are picked up too. Bounded so a stuck
// summary can never loop forever.
const expandAllSections = async (): Promise<void> => {
  for (let i = 0; i < 30; i += 1) {
    const summary = page.locator('details:not([open]) > summary').first();
    if ((await summary.count()) === 0) break;
    await summary.click();
  }
};

test.beforeAll(async ({ browser }: { browser: Browser }) => {
  page = await browser.newPage();
  await page.goto('/login');
  await page.locator('#login-email').fill(EMAIL);
  await page.locator('#login-password').fill(PASSWORD);
  await Promise.all([
    page.waitForURL((url) => !url.pathname.endsWith('/login'), { timeout: 15_000 }),
    page.getByRole('button', { name: /sign in|log in/i }).click(),
  ]);
});

test.afterAll(async () => {
  // `page` is unset if beforeAll throws before newPage(); guard so teardown
  // doesn't mask the real setup failure.
  await page?.close();
});

test('kill-switch: engage then release via the scoped profile controls', async () => {
  // v3 IA: `/profiles/$id` redirects to the dashboard scoped to that profile;
  // the kill switch lives in the profile-controls header for the scoped profile.
  await page.goto(`/accounts/${ACCOUNT_ID}/profiles/${PROFILE_ID}`);
  const kill = page.getByTestId('profile-controls-kill');
  await expect(kill).toBeVisible({ timeout: 10_000 });

  // Engage.
  await kill.click();
  const dialog = page.getByTestId('profile-controls-kill-dialog');
  await expect(dialog).toBeVisible();
  await page.getByTestId('profile-controls-kill-confirm').click();
  await expect(dialog).toBeHidden({ timeout: 5_000 });

  // Engaged: re-opening the kill dialog now offers Resume.
  await kill.click();
  await expect(page.getByTestId('profile-controls-kill-dialog')).toContainText('Resume trading');
  await page.getByTestId('profile-controls-kill-confirm').click();
  await expect(dialog).toBeHidden({ timeout: 5_000 });

  // Released: the dialog offers Stop again. Leave state as found via Cancel.
  await kill.click();
  await expect(page.getByTestId('profile-controls-kill-dialog')).toContainText('Stop trading');
  await page.getByRole('button', { name: 'Cancel' }).click();
});

test('symbol-config: the per-symbol override editor opens as a drawer from the workspace', async () => {
  // v3 IA: open a symbol's workspace from the grid (a `?sym=` row link), then
  // open its config drawer from the workspace header CONFIG affordance. The old
  // `/symbols/$sym/config` page is retired (it redirects into this same flow).
  await page.goto('/');
  const symbolRow = page.locator('[data-testid^="symbol-link-"]');
  test.skip((await symbolRow.count()) === 0, 'profile has no symbols to open a config editor for');
  await symbolRow.first().click();
  await expect(page.getByTestId('symbol-workspace')).toBeVisible({ timeout: 10_000 });

  await page.getByTestId('symbol-config-open').click();
  await expect(page.getByTestId('symbol-config-panel')).toBeVisible({ timeout: 10_000 });
  await expect(page.getByTestId('override-summary')).toBeVisible();
  await expect(page.getByTestId('symbol-config-save')).toBeVisible();
  await expect(page.getByTestId('override-count')).toHaveText(/\d+ overridden/);
});

test('profit-loss: realised card switches period and the unrealised total renders', async () => {
  await page.goto(`/accounts/${ACCOUNT_ID}/profiles/${PROFILE_ID}`);

  await expect(page.getByTestId('unrealised-total')).toBeVisible({ timeout: 10_000 });
  const tradeCount = page.getByTestId('realised-trade-count');
  await expect(tradeCount).toBeVisible({ timeout: 10_000 });

  // Each period button drives a fresh closed-trades query. Wait for the
  // period-specific fetch so the assertion can't pass on stale content
  // left over from the previous period.
  for (const code of ['w', 'm', 'a', 'd'] as const) {
    await Promise.all([
      page.waitForResponse((res) => {
        if (!res.ok()) return false;
        const url = new URL(res.url());
        return url.pathname.endsWith('/closed-trades') && url.searchParams.get('period') === code;
      }),
      page.getByTestId(`realised-period-${code}`).click(),
    ]);
    await expect(tradeCount).toHaveText(/\d+ closed trades?/, { timeout: 5_000 });
  }
});

test('config-save: a form edit persists across a reload, then reverts', async () => {
  // The config editor is a generated form (AutoForm); drive a single typed
  // field rather than a JSON blob.
  const field = () => page.getByLabel('Max Purchase Amount');
  const open = async (): Promise<void> => {
    await page.goto(`/accounts/${ACCOUNT_ID}/profiles/${PROFILE_ID}/config`);
    await field().waitFor({ state: 'attached' });
    await expandAllSections();
    await expect(field()).toBeVisible();
  };
  const save = async (): Promise<void> => {
    await page.getByRole('button', { name: /^Save$/ }).click();
    await expect(page.getByText('Config saved.')).toBeVisible({ timeout: 5_000 });
  };

  await open();
  const before = await field().inputValue();
  const probe = before === '13' ? '14' : '13';

  try {
    await field().fill(probe);
    await save();

    await open();
    expect(await field().inputValue()).toBe(probe);
  } finally {
    // revert through the same UI path so the dev DB is left as found,
    // even when an assertion above fails
    await field().fill(before);
    await save();
  }
});

test('bull-hold: the room choice persists across a reload, then reverts', async () => {
  // The bull-hold sell-trail dial (regime.onBull.hold.room) is an enum select
  // in the generated config form. Drive it the way an operator would and assert
  // the chosen room survives a reload.
  const room = () => page.getByLabel('Room', { exact: true });
  const open = async (): Promise<void> => {
    await page.goto(`/accounts/${ACCOUNT_ID}/profiles/${PROFILE_ID}/config`);
    await room().waitFor({ state: 'attached' });
    await expandAllSections();
    await expect(room()).toBeVisible();
  };
  const save = async (): Promise<void> => {
    await page.getByRole('button', { name: /^Save$/ }).click();
    await expect(page.getByText('Config saved.')).toBeVisible({ timeout: 5_000 });
  };

  await open();
  const before = await room().inputValue();
  const probe = before === 'loose' ? 'normal' : 'loose';

  try {
    await room().selectOption(probe);
    await save();

    await open();
    expect(await room().inputValue()).toBe(probe);
  } finally {
    await room().selectOption(before);
    await save();
  }
});

test('bull-pyramid: the add cap persists across a reload, then reverts', async () => {
  // The pyramid add cap (regime.onBull.pyramid.maxAdds) is a numeric field in
  // the generated config form. Edited while the pyramid stays OFF, so the
  // exposure-cap superRefine does not gate the save.
  const maxAdds = () => page.getByLabel('Max Adds', { exact: true });
  const open = async (): Promise<void> => {
    await page.goto(`/accounts/${ACCOUNT_ID}/profiles/${PROFILE_ID}/config`);
    await maxAdds().waitFor({ state: 'attached' });
    await expandAllSections();
    await expect(maxAdds()).toBeVisible();
  };
  const save = async (): Promise<void> => {
    await page.getByRole('button', { name: /^Save$/ }).click();
    await expect(page.getByText('Config saved.')).toBeVisible({ timeout: 5_000 });
  };

  await open();
  const before = await maxAdds().inputValue();
  const probe = before === '3' ? '4' : '3';

  try {
    await maxAdds().fill(probe);
    await save();

    await open();
    expect(await maxAdds().inputValue()).toBe(probe);
  } finally {
    await maxAdds().fill(before);
    await save();
  }
});
