// Manual-trade select fit. The three native <select>s in the symbol workspace's right rail are laid out as three equal flex columns, which gives each about 90px inside a 288px rail — not enough to show "Coin (quantity)", the longest option, so the operator reads a truncated label and cannot tell what the form is about to do.
//
// This is the only check that can observe that defect. The vitest suite renders into happy-dom, which computes no layout at all, and a native <select> paints its selected option inside a UA shadow tree that no test environment builds — so the unit test can assert which classes the row carries and nothing more.
//
// Gated by env the same way `manual-order-roundtrip.spec.ts` is: five vars are the explicit opt-in — E2E_USER_EMAIL, E2E_USER_PASSWORD, E2E_ACCOUNT_ID, E2E_PROFILE_ID and E2E_SYMBOL — so the default playwright-image CI run (no application stack) skips it rather than failing. Unlike that spec this one places no orders and needs no Binance connectivity: it only reads geometry.

import { expect, test, type Page } from '@playwright/test';

const EMAIL = process.env['E2E_USER_EMAIL'] ?? '';
const PASSWORD = process.env['E2E_USER_PASSWORD'] ?? '';
const ACCOUNT_ID = process.env['E2E_ACCOUNT_ID'] ?? '';
const PROFILE_ID = process.env['E2E_PROFILE_ID'] ?? '';
const SYMBOL = process.env['E2E_SYMBOL'] ?? '';
const ENABLED = EMAIL && PASSWORD && ACCOUNT_ID && PROFILE_ID && SYMBOL;

test.skip(
  !ENABLED,
  'manual-trade-select-fit spec requires E2E_USER_EMAIL/PASSWORD + E2E_ACCOUNT_ID + E2E_PROFILE_ID + E2E_SYMBOL',
);

const SELECT_IDS = ['manual-side', 'manual-type', 'manual-sizing'] as const;

// Measured at each declared breakpoint rather than at one hard-coded size: the row is a two-column grid below sm and the same grid inside a 288px rail on desktop, so a fit that holds at 1280 says nothing about 375 — the charter's pinned mobile viewport, and the width the config's `chromium-mobile` project exists to cover. Setting a viewport here overrides the project's, so the project list alone would never reach 375 through this spec.
const VIEWPORTS = [
  { label: 'mobile', width: 375, height: 667 },
  { label: 'tablet', width: 768, height: 1024 },
  { label: 'desktop', width: 1280, height: 800 },
] as const;

const login = async (page: Page): Promise<void> => {
  await page.goto('/login');
  await page.locator('#login-email').fill(EMAIL);
  await page.locator('#login-password').fill(PASSWORD);
  const submit = page.getByRole('button', { name: /sign in|log in/i });
  await Promise.all([
    page.waitForURL((url) => !url.pathname.endsWith('/login'), { timeout: 15_000 }),
    submit.click(),
  ]);
};

interface Fit {
  readonly testId: string;
  /** Border-box width the control actually occupies. */
  readonly actual: number;
  /** Border-box width the browser itself would give this control at `width:auto` with only its selected option — i.e. text + padding + the UA's own arrow gutter. Derived, never a constant, so it is correct per browser engine and per font. */
  readonly needed: number;
  readonly selectedLabel: string;
}

/**
 * Measure each manual-trade select against the width its own selected option needs.
 *
 * The needed width is taken from a clone of the real control with `width:auto`, holding only the currently-selected option. Cloning carries the element's classes, so the font, padding and border resolve identically, and letting the UA size it at `auto` is what makes the arrow gutter a measured value rather than a magic number guessed per engine.
 *
 * @param page - The page with the manual-trade panel already visible.
 * @returns One record per select, with the width it has and the width it needs.
 */
const measureSelects = (page: Page): Promise<readonly Fit[]> =>
  page.evaluate(
    (ids: readonly string[]) => {
      return ids.map((testId) => {
        const node = document.querySelector<HTMLSelectElement>(`[data-testid="${testId}"]`);
        if (!node) throw new Error(`no select with data-testid="${testId}"`);
        const selectedLabel = node.options[node.selectedIndex]?.text ?? '';

        const probe = node.cloneNode(true) as HTMLSelectElement;
        // Keep only the selected option so the UA sizes to what is on screen, not to the widest option in the list.
        probe.replaceChildren(new Option(selectedLabel, 'probe'));
        // Inline styles beat the utility classes that force the real control to fill its column, so the clone reports its intrinsic width instead.
        probe.style.position = 'fixed';
        probe.style.left = '-10000px';
        probe.style.top = '0';
        probe.style.width = 'auto';
        probe.style.minWidth = '0';
        probe.style.maxWidth = 'none';
        probe.style.visibility = 'hidden';
        document.body.append(probe);
        const needed = probe.offsetWidth;
        probe.remove();

        return { testId, actual: node.offsetWidth, needed, selectedLabel };
      });
    },
    SELECT_IDS as unknown as string[],
  );

const openWorkspace = async (page: Page): Promise<void> => {
  await page.goto(`/accounts/${ACCOUNT_ID}?sym=${PROFILE_ID}:${SYMBOL}`);
  await expect(page.getByTestId('manual-trade-panel')).toBeVisible({ timeout: 10_000 });
  // "Coin (quantity)" is the longest option in the row; select it so the fit check measures the worst case the operator can actually put on screen.
  await page.getByTestId('manual-sizing').selectOption('quantity');
};

for (const { label, width, height } of VIEWPORTS) {
  test(`${label} (${width}px): every manual-trade select shows its selected option in full`, async ({
    page,
  }) => {
    await page.setViewportSize({ width, height });
    await login(page);
    await openWorkspace(page);

    const fits = await measureSelects(page);
    expect(fits).toHaveLength(SELECT_IDS.length);
    for (const fit of fits) {
      expect(
        fit.actual,
        `at ${width}px ${fit.testId} is ${fit.actual}px but "${fit.selectedLabel}" needs ${fit.needed}px`,
      ).toBeGreaterThanOrEqual(fit.needed);
    }

    // Fitting the text by widening the controls past their container would trade a clipped label for a card the operator has to scroll sideways. Scoped to the manual-trade card, not the document: a pre-existing overflow in some unrelated panel would otherwise fail this spec under a message pointing at the selects.
    const card = await page.evaluate(() => {
      const panel = document.querySelector<HTMLElement>('[data-testid="manual-trade-panel"]');
      if (!panel) throw new Error('no manual-trade-panel');
      const box = panel.parentElement ?? panel;
      return {
        panel: { scrollWidth: panel.scrollWidth, clientWidth: panel.clientWidth },
        box: { scrollWidth: box.scrollWidth, clientWidth: box.clientWidth },
      };
    });
    expect(
      card.panel.scrollWidth,
      `at ${width}px the manual-trade panel scrolls sideways (${card.panel.scrollWidth} > ${card.panel.clientWidth})`,
    ).toBeLessThanOrEqual(card.panel.clientWidth);
    expect(
      card.box.scrollWidth,
      `at ${width}px the card holding the manual-trade panel scrolls sideways (${card.box.scrollWidth} > ${card.box.clientWidth})`,
    ).toBeLessThanOrEqual(card.box.clientWidth);
  });
}
