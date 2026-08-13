// The "why isn't it trading?" investigation, driven the way an operator drives
// it: a real click on the profile landing header, a real confirm, real steps
// arriving from the worker.
//
// Two properties are worth an e2e and cannot be proven in jsdom:
//
// 1. The lever actually lands. A finding names a config path; the link has to
//    reach the right tab AND open every collapsed `<details>` above the field.
//    Asserted on the field's `id`, never its label — a copy change must not be
//    able to pass a link that goes nowhere.
// 2. The run is durable. Closing the drawer is not a cancel: the worker owns
//    the run, so reopening resumes the same run rather than starting another.
//
// Gated by env like profile-controls.spec.ts, not by E2E_FULL_STACK: these need
// a real worker draining the diagnosis queue, which the CI no-stack smoke run
// does not have.

import { test, expect, type Browser, type Page } from '@playwright/test';

const EMAIL = process.env['E2E_USER_EMAIL'] ?? '';
const PASSWORD = process.env['E2E_USER_PASSWORD'] ?? '';
const ACCOUNT_ID = process.env['E2E_ACCOUNT_ID'] ?? '';
const PROFILE_ID = process.env['E2E_PROFILE_ID'] ?? '';
const ENABLED = EMAIL && PASSWORD && ACCOUNT_ID && PROFILE_ID;

// A run holds the queue for as long as its slowest step; the stored-snapshot
// mode used here skips the Binance re-probe, so this is generous, not tight.
const RUN_TIMEOUT_MS = 60_000;

test.describe.configure({ mode: 'serial' });
test.skip(
  !ENABLED,
  'profile-diagnosis specs require E2E_USER_EMAIL/PASSWORD + E2E_ACCOUNT_ID + E2E_PROFILE_ID',
);

let page: Page;

/** Where the trigger lives: the profile landing page, not a management sub-page. */
const PROFILE_HOME = `/accounts/${ACCOUNT_ID}/profiles/${PROFILE_ID}`;

const openInvestigate = async (): Promise<void> => {
  await page.getByTestId('open-investigate').click();
  await expect(page.getByTestId('investigate-sheet')).toBeVisible();
};

const closeSheet = async (): Promise<void> => {
  await page.keyboard.press('Escape');
  await expect(page.getByTestId('investigate-sheet')).toBeHidden();
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
  await page?.close();
});

test('investigate: header button to a finished report, and a lever that lands on the field', async () => {
  // The profile landing page. The trigger used to sit on the shared sub-page
  // header, where it repeated on nine editors and read as scoped to whichever
  // one was open; a profile-wide diagnostic belongs where the profile is the
  // subject.
  await page.goto(PROFILE_HOME);

  const button = page.getByTestId('open-investigate');
  await expect(button).toBeVisible({ timeout: 10_000 });
  await openInvestigate();

  // The confirm step exists so nothing runs until the operator says so.
  await expect(page.getByTestId('diagnosis-confirm')).toBeVisible();
  // Stored-snapshot mode: an e2e must not spend the account's Binance request
  // weight, and every step but the funnel re-probe is identical either way.
  await page.getByTestId('diagnosis-start-stored').click();

  const run = page.getByTestId('diagnosis-run');
  await expect(run).toBeVisible();
  // All nine rungs are seeded before the job is enqueued, so the ladder is
  // whole from the first render rather than growing a row at a time.
  await expect(page.getByTestId(/^diagnosis-step-/)).toHaveCount(9);
  await expect(run).toHaveAttribute('data-run-status', 'done', { timeout: RUN_TIMEOUT_MS });

  // Every step reached a terminal status; a step left `pending` on a finished
  // run means the worker returned without writing it.
  const steps = await page.getByTestId(/^diagnosis-step-/).all();
  for (const step of steps) {
    await expect(step).not.toHaveAttribute('data-status', 'pending');
    await expect(step).not.toHaveAttribute('data-status', 'running');
  }
  await expect(page.getByTestId('diagnosis-verdict')).toBeVisible();

  const lever = page.getByTestId(/^diagnosis-lever-/).first();
  test.skip(
    (await lever.count()) === 0,
    'this profile reported no finding with a config lever — nothing to follow',
  );

  // The path is read off the element rather than hardcoded: which lever a live
  // profile offers depends on what is actually wrong with it today.
  const testId = await lever.getAttribute('data-testid');
  const path = (testId ?? '').replace('diagnosis-lever-', '');
  expect(path).not.toBe('');

  await lever.click();
  // Id, not label. The field must be on screen, which means every collapsed
  // Panel and AutoForm group above it was expanded on arrival.
  const field = page.locator(`[id="${path}"]`);
  await expect(field).toBeVisible({ timeout: 10_000 });
  await expect(page).toHaveURL(new RegExp(`focus=${encodeURIComponent(path)}`));
});

test('investigate: at 375x667 the button fits the header and the drawer is full width', async () => {
  const viewport = page.viewportSize();
  if (viewport === null || viewport.width > 420) {
    test.skip(true, 'mobile-layout assertions only');
    return;
  }

  await page.goto(PROFILE_HOME);
  await expect(page.getByTestId('open-investigate')).toBeVisible({ timeout: 10_000 });

  // A third header action is exactly what pushes a phone header into a second
  // row or off the side, so the page's own width is the assertion.
  const overflow = await page.evaluate(
    () => document.documentElement.scrollWidth - document.documentElement.clientWidth,
  );
  expect(overflow).toBeLessThanOrEqual(1);

  await openInvestigate();
  const sheetWidth = await page
    .getByTestId('investigate-sheet')
    .evaluate((el) => el.getBoundingClientRect().width);
  // Full-bleed, not a centred dialog: nine steps plus a report do not fit one.
  expect(sheetWidth).toBeGreaterThanOrEqual(viewport.width - 1);
  await closeSheet();
});

test('investigate: closing the drawer does not cancel the run', async () => {
  await page.goto(PROFILE_HOME);
  await openInvestigate();

  // A previous run is on screen from the test above, so ask for a fresh one.
  const again = page.getByTestId('investigate-again');
  if ((await again.count()) > 0) await again.click();
  await page.getByTestId('diagnosis-start-stored').click();
  await expect(page.getByTestId('diagnosis-run')).toBeVisible();
  const runId = await page.getByTestId('diagnosis-run').getAttribute('data-run-id');

  await closeSheet();
  // The header button is the running indicator while the drawer is shut.
  await expect(page.getByTestId('open-investigate')).toContainText(/investigating|investigate/i);

  await openInvestigate();
  const reopened = page.getByTestId('diagnosis-run');
  await expect(reopened).toBeVisible();
  // Same run, not a restart: a confirm dialog here would mean the close threw
  // the run away.
  await expect(page.getByTestId('diagnosis-confirm')).toHaveCount(0);
  if (runId !== null) await expect(reopened).toHaveAttribute('data-run-id', runId);
  await expect(reopened).toHaveAttribute('data-run-status', 'done', { timeout: RUN_TIMEOUT_MS });
});

test('investigate: reachable from a sub-page through the Manage slide-over', async () => {
  // The sub-page headers dropped the trigger, so this is the only way back to
  // the investigation from an editor. Both drawers are modal dialogs, so the
  // handover has to swap them rather than stack them — a nested pair leaves the
  // page unclickable behind a stranded `pointer-events: none`.
  await page.goto(`/accounts/${ACCOUNT_ID}/profiles/${PROFILE_ID}/discovery`);
  await expect(page.getByTestId('open-investigate')).toHaveCount(0);

  await page.getByTestId('open-manage-sheet').click();
  await expect(page.getByTestId('manage-sheet')).toBeVisible();
  await page.getByTestId('profile-manage-investigate').click();

  await expect(page.getByTestId('investigate-sheet')).toBeVisible();
  await expect(page.getByTestId('manage-sheet')).toHaveCount(0);
  await expect(page.getByRole('dialog')).toHaveCount(1);

  await closeSheet();
  await expect(page.getByRole('dialog')).toHaveCount(0);
  // Click, not toBeEnabled: a stranded `pointer-events: none` leaves every
  // button "enabled" by the disabled-attribute definition. Only a real click
  // runs the hit-target check that a dead overlay fails.
  await page.getByTestId('open-manage-sheet').click();
  await expect(page.getByTestId('manage-sheet')).toBeVisible();
});
