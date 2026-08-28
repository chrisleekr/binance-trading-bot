import { expect, test, type Page } from '@playwright/test';

const EMAIL = process.env['E2E_USER_EMAIL'];
const PASSWORD = process.env['E2E_USER_PASSWORD'];
const ACCOUNT_ID = process.env['E2E_ACCOUNT_ID'];
const PROFILE_ID = process.env['E2E_PROFILE_ID'];

if (!EMAIL || !PASSWORD || !ACCOUNT_ID || !PROFILE_ID) {
  throw new Error('app-p0 requires the private app-e2e seed manifest');
}

test.describe.configure({ mode: 'serial' });

/**
 * The furthest any compact archive row extends past the viewport's right edge, in CSS pixels.
 *
 * The document itself cannot scroll — the shell is `h-svh … overflow-hidden` — so a too-wide row does not move `documentElement.scrollWidth`; it is simply clipped, invisibly. Measuring each row's own box against the viewport is what actually catches a symbol, badge or amount that fails to truncate at phone width. Measured on the COMPACT rows because they are the surface that is laying out at 390px: a probe aimed at the hidden table would report 0 by arithmetic, restating the assertion that the table is hidden rather than guarding anything.
 *
 * Throws rather than returning a passing default when there is nothing to measure. A `?? 0` on the empty branch would turn a renamed testid into a guard that is green forever.
 *
 * Sub-pixel rounding makes exact equality flaky, hence the caller's 1px tolerance.
 *
 * @param page - The page to measure, at whatever viewport it currently has.
 * @returns The largest `getBoundingClientRect().right - documentElement.clientWidth` across the compact rows. Negative when every row fits inside the viewport.
 */
const compactRowOverflow = (page: Page): Promise<number> =>
  page.evaluate(() => {
    const list = document.querySelector('[data-testid="archive-card-list"]');
    if (!list) {
      throw new Error('compact overflow probe: no [data-testid="archive-card-list"] in the DOM');
    }
    const rows = [...list.querySelectorAll('li')];
    if (rows.length === 0) {
      throw new Error('compact overflow probe: archive-card-list rendered no rows to measure');
    }
    const viewportWidth = document.documentElement.clientWidth;
    return Math.max(...rows.map((row) => row.getBoundingClientRect().right - viewportWidth));
  });

test('signs in and renders the seeded profile dashboard and fee-incomplete archive', async ({
  page,
}, testInfo) => {
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

  await page.goto(`/accounts/${ACCOUNT_ID}/profiles/${PROFILE_ID}/history?section=archive`);
  // A ROW marker, on whichever of the two list surfaces the current width has live — `getByRole` skips elements hidden from the accessibility tree, so the `hidden` variant contributes nothing and this holds at any width without resizing. Scoped to the lists on purpose: the by-exit-reason and by-source bands render the same marker under the same name and precede both lists in the DOM, so an unscoped `.first()` would resolve to a band and stay green even if every row marker vanished. Matched on the name rather than the glyph because the name is what pins which fault the seeded row hit.
  await expect(
    page
      .locator('[data-testid="archive-list"], [data-testid="archive-card-list"]')
      .getByRole('img', { name: 'Net P/L unavailable' })
      .first(),
  ).toBeVisible();

  if (testInfo.project.name === 'chromium-mobile') {
    // The project's own phone viewport, asserted before this test resizes anything.
    expect(page.viewportSize()).toEqual({ width: 375, height: 667 });
  }

  // Phone. Every project runs this leg, so the compact rendering is proven on all four browsers rather than only on the one project configured narrow.
  await page.setViewportSize({ width: 390, height: 844 });
  await expect(page.getByTestId('archive-card-list')).toBeVisible();
  // C1, and deliberately the FIRST assertion after the wait that makes the list measurable. An overflow check placed lower would sit behind `archive-list` being hidden, and that gate halts the test in the very scenario an overflow check exists to catch — so the check would only ever run in the case where its value is arithmetically forced to pass.
  expect(await compactRowOverflow(page)).toBeLessThanOrEqual(1);
  await expect(page.getByTestId('archive-list')).toBeHidden();

  // Both variants mount at once and only CSS separates them, so "hidden" has to mean hidden to assistive technology too, not merely invisible. Both render a RowActions trigger under the SAME accessible name, so if `hidden` ever leaves the table wrapper this count doubles. Deterministic where the unit lane cannot be: happy-dom loads no stylesheet, so it can never evaluate `display:none`.
  const compactRows = page.getByRole('button', { name: /^Trade details for / });
  const rowCount = await compactRows.count();
  expect(rowCount).toBeGreaterThan(0);
  const actionsName = /^Actions for .+ archive entry$/;
  // Shape check: every compact row carries its own kebab.
  const insideCompactList = await page
    .getByTestId('archive-card-list')
    .getByRole('button', { name: actionsName })
    .count();
  expect(insideCompactList).toBe(rowCount);
  // The isolation guard, and the reason these two counts are scoped differently: comparing two page-wide queries lets both move together, so a duplicated list would still balance. Scoped-inside versus anywhere-on-the-page cannot. The table renders this same accessible name, so the moment `hidden` stops removing it from the accessibility tree the unscoped count rises while the scoped one does not.
  await expect(page.getByRole('button', { name: actionsName })).toHaveCount(insideCompactList);
  await expect(page.getByRole('table')).toHaveCount(0);

  // Buy, sell, fees and commission live one tap away rather than off-screen. Targeted by accessible name so the assertion does not depend on which archive id the seed happens to mint.
  await compactRows
    .filter({ has: page.getByRole('img', { name: 'Net P/L unavailable' }) })
    .first()
    .click();
  const sheet = page.getByTestId('archive-detail-sheet');
  await expect(sheet).toBeVisible();
  await expect(sheet.getByTestId('archive-detail-fees')).toContainText('0.01 BNB');
  await expect(sheet.getByTestId('archive-detail-buy')).toBeVisible();
  await expect(sheet.getByTestId('archive-detail-sell')).toBeVisible();
  // Closed before the resize: the sheet portals to <body>, so an open one would sit over the table the next leg reads.
  await sheet.getByRole('button', { name: 'Close' }).click();
  await expect(sheet).toBeHidden();

  // Tablet and up. 768px is the `md` breakpoint itself, the narrowest width at which the table is the rendering, so it is the edge worth pinning.
  await page.setViewportSize({ width: 768, height: 1024 });
  // Asserted directly, so a scrollbar eating the initial containing block fails as "the breakpoint did not engage" rather than as a mystery missing table.
  expect(await page.evaluate(() => window.matchMedia('(min-width: 768px)').matches)).toBe(true);
  await expect(page.getByTestId('archive-list')).toBeVisible();
  await expect(page.getByTestId('archive-card-list')).toBeHidden();

  // The table's own content, checked where the table is the live rendering. Prefix-matched on the desktop testid namespace, which the compact `archive-card-*` and sheet `archive-detail-*` ids deliberately do not share.
  // Scoped INSIDE the table on purpose, so this stays an assertion about the desktop rendering even if another surface later adopts the same testid prefix. Asserted on the accessible name rather than the text: the cost-basis glyph `n/a` is a substring of the fee glyph `net n/a`, so a text assertion cannot tell the two faults apart, while the names differ outright.
  await expect(
    page.getByTestId('archive-list').locator('[data-testid^="archive-pnl-unavailable-"]').first(),
  ).toHaveAccessibleName('Net P/L unavailable');
  await expect(
    page.locator('[data-testid^="archive-profit-"]').filter({ hasText: '4.50' }),
  ).toBeVisible();
  await expect(
    page.locator('[data-testid^="archive-fees-"]').filter({ hasText: 'BNB' }),
  ).toContainText('0.01 BNB');
  await page.getByTestId('pnl-basis-gross').click();
  await expect(page.locator('[data-testid^="archive-profit-"]').first()).toContainText('10');

  // Desktop. The sidebar only renders at `md` and up, so this is the first leg that can see it at all, and 1280x768 is a common laptop rail height — short enough that a single expanded profile used to push ACCOUNT, SYSTEM and the collapse control below the fold.
  await page.setViewportSize({ width: 1280, height: 768 });
  // The PROFILE route, not the account root: the active profile expands inline into its own sections, and that expansion is the regression condition. On the account root the list is short enough that the bug cannot reproduce.
  await page.goto(`/accounts/${ACCOUNT_ID}/profiles/${PROFILE_ID}`);
  const sideNav = page.getByTestId('side-nav');
  await expect(sideNav).toBeVisible();
  // The load barrier, and it has to come BEFORE any measurement. `SideNav` renders `data?.profiles ?? []`, so while the aggregate query is in flight the rail holds nothing but pinned chrome — which fits at 768 even with the defect present, making every assertion below green against unfixed code. A full `page.goto` starts from a cold cache, and `locator.evaluate` waits for nothing. `Risk` renders only under `active && !collapsed`, i.e. only once the aggregate has landed AND the routed profile has expanded inline, which is exactly the regression condition.
  await expect(sideNav.getByRole('link', { name: 'Risk', exact: true })).toBeVisible();

  // The positive anchor, and the barrier above is not a substitute for it: `Risk` proves the profile expanded, not that the expansion outgrew the rail. `E2E_ACCOUNT_ID` / `E2E_PROFILE_ID` come from the seed manifest, so the seed decides that — and with too few profiles the PRE-fix layout also fits at 768, which would make every bound below green against unfixed code forever. Requiring the list to actually overflow is what keeps an under-filled seed loud instead of silent.
  const listOverflow = await page
    .getByTestId('side-nav-profiles-scroll')
    .evaluate((el) => el.scrollHeight - el.clientHeight);
  expect(listOverflow).toBeGreaterThan(1);

  // C1: the rail itself must not be the scroll container. Measured on the nav rather than on the profile list, because the defect is precisely that the profile list's growth escaped into the rail. 1px of tolerance for sub-pixel rounding, the same allowance the compact-row probe uses.
  const railOverflow = await sideNav.evaluate((nav) => nav.scrollHeight - nav.clientHeight);
  expect(railOverflow).toBeLessThanOrEqual(1);

  // C5: the two things that actually disappeared. `mt-auto` pinned the collapse control to the end of the SCROLL CONTENT, so the one control that would shrink the sidebar was the first below the fold.
  const toggle = page.getByTestId('side-nav-toggle');
  await expect(toggle).toBeVisible();
  const toggleBox = await toggle.boundingBox();
  expect(toggleBox).not.toBeNull();
  expect((toggleBox?.y ?? 0) + (toggleBox?.height ?? 0)).toBeLessThanOrEqual(768);

  // A SYSTEM-section row, scoped inside the rail so the header's own settings icon cannot stand in for it. It sits ABOVE the collapse control, so it is the weaker of the two bounds — asserted anyway because a footer pinned by some other means would satisfy the toggle check while still clipping the section above it.
  const systemLink = sideNav.getByRole('link', { name: 'Settings', exact: true });
  await expect(systemLink).toBeVisible();
  const systemBox = await systemLink.boundingBox();
  expect(systemBox).not.toBeNull();
  expect((systemBox?.y ?? 0) + (systemBox?.height ?? 0)).toBeLessThanOrEqual(768);
});
