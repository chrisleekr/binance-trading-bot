// Layout-stability gate: no route may move the reader while it polls.
//
// The dashboard refetches on a timer across every panel. If a poll re-render
// changes layout above the fold — or worse, rebuilds a subtree instead of
// updating it — the browser clamps `scrollTop` to the shorter content and never
// restores it when the height comes back. A reader parked at the bottom is
// dragged upward, once per poll, forever. That shipped once: a component
// declared inside its parent's render body gave the market-trend card a new
// identity every second, so React tore the card out of the overview and rebuilt
// it on the countdown tick.
//
// The measurement blocks `useScrollAnchor`'s corrections for the duration.
// That is the point: with the shim live the drift is repaired a frame later and
// the page looks stable on Blink and desktop WebKit, which is exactly why the
// defect survived review. Blocking the shim measures whether the page holds
// still on its own. `shimWrites` is therefore an assertion too — a correction
// the shim *wanted* to make is a reflow that should not have happened.
//
// Gated by env, not E2E_FULL_STACK: like profile-controls, these drive a stack
// the operator already has running (`bun run dev` or compose). CI runs only the
// no-stack smoke subset, so this does not gate merges today — it is the tool
// that reproduces and proves the class.
//
// E2E_USER_PASSWORD must be a throwaway local credential. Playwright records
// every action's arguments into the trace, and `retain-on-failure` is on in
// playwright.config.ts, so a failing run writes the password in cleartext under
// e2e/test-results/ — never attach that directory to an issue or MR.
// Playwright declines to mask password fields by design (microsoft/playwright#35848).

import { test, expect } from '@playwright/test';

const EMAIL = process.env['E2E_USER_EMAIL'] ?? '';
const PASSWORD = process.env['E2E_USER_PASSWORD'] ?? '';
const ACCOUNT_ID = process.env['E2E_ACCOUNT_ID'] ?? '';
const PROFILE_ID = process.env['E2E_PROFILE_ID'] ?? '';
const ENABLED = EMAIL && PASSWORD && ACCOUNT_ID && PROFILE_ID;

// One full cycle of the slowest poll on these surfaces. Equity P/L and the edge
// verdict refetch at 60s (equity-pnl-card.tsx, use-edge-verdict.ts), gate status
// at 30s; a shorter window never observes the heaviest refetches, which are the
// ones most likely to change page height.
const WATCH_MS = 65_000;

test.describe.configure({ mode: 'serial' });
test.skip(
  !ENABLED,
  'scroll-stability specs require E2E_USER_EMAIL/PASSWORD + E2E_ACCOUNT_ID + E2E_PROFILE_ID',
);

const ROUTES: readonly { readonly label: string; readonly path: string }[] = [
  { label: 'account overview', path: `/accounts/${ACCOUNT_ID}` },
  { label: 'profile overview', path: `/accounts/${ACCOUNT_ID}/profiles/${PROFILE_ID}` },
  { label: 'profile discovery', path: `/accounts/${ACCOUNT_ID}/profiles/${PROFILE_ID}/discovery` },
  { label: 'profile config', path: `/accounts/${ACCOUNT_ID}/profiles/${PROFILE_ID}/config` },
];

test.beforeEach(async ({ page }) => {
  await page.goto('/login');
  await page.locator('#login-email').fill(EMAIL);
  await page.locator('#login-password').fill(PASSWORD);
  await Promise.all([
    page.waitForURL((url) => !url.pathname.endsWith('/login'), { timeout: 15_000 }),
    page.getByRole('button', { name: /sign in|log in/i }).click(),
  ]);
});

for (const { label, path } of ROUTES) {
  test(`${label} holds the reader still while it polls`, async ({ page }) => {
    test.setTimeout(120_000);
    await page.goto(path);
    // Let the first paint and the first round of polls land, so the baseline is
    // a settled page rather than one still filling in.
    await page.waitForTimeout(5_000);

    const parked = await page.evaluate(() => {
      // The scroller under the reader's thumb is the one useScrollAnchor is
      // bound to, and it marks itself. Picking by tree position instead would
      // land on whichever panel happens to come last in the document — several
      // routes carry `max-h-* overflow-y-auto` panels — and then the probe would
      // watch an element no poll reflows and the shim never writes to, which
      // reads as a pass no matter how badly the page drifts.
      const el = document.querySelector('[data-scroll-anchor]');
      if (!el || el.scrollHeight <= el.clientHeight + 8) return null;

      const native = Object.getOwnPropertyDescriptor(Element.prototype, 'scrollTop');
      if (!native?.get || !native.set) return null;
      const read = (): number => (native.get as () => number).call(el);

      (native.set as (v: number) => void).call(el, el.scrollHeight);
      const start = read();

      const probe = {
        shimWrites: 0,
        teardowns: 0,
        min: start,
        max: start,
        running: true,
      };
      (window as unknown as { __probe: typeof probe }).__probe = probe;
      // Held so the closing evaluate can prove it is still THE anchored
      // scroller. If the element is replaced mid-watch, this reference goes
      // detached and every metric below reads 0 — a detached node never
      // scrolls, the swallowing setter is on the old node, and the observer
      // does not see its own target's removal. All three assertions would pass
      // while the live page drifted freely.
      (window as unknown as { __probeEl: Element }).__probeEl = el;

      // Swallow every programmatic write from here on, counting them. The page
      // must hold still without the shim's help.
      Object.defineProperty(el, 'scrollTop', {
        configurable: true,
        get: read,
        set: () => {
          probe.shimWrites += 1;
        },
      });

      // Only a removal that SHORTENS the scroller can make the browser clamp
      // scrollTop, which is the defect this spec is about. Counting every
      // removal would fail the run on ordinary data arrival — a filled order
      // leaving the open list, an audit row rolling off — while blaming a
      // teardown that never happened, and a gate that cries wolf gets ignored.
      let lastHeight = el.scrollHeight;
      new MutationObserver((records) => {
        const height = el.scrollHeight;
        if (height < lastHeight && records.some((r) => r.removedNodes.length > 0)) {
          probe.teardowns += 1;
        }
        lastHeight = height;
      }).observe(el, { childList: true, subtree: true });

      const sample = (): void => {
        const top = read();
        probe.min = Math.min(probe.min, top);
        probe.max = Math.max(probe.max, top);
        if (probe.running) requestAnimationFrame(sample);
      };
      requestAnimationFrame(sample);
      return { start, scrollHeight: el.scrollHeight };
    });

    expect(
      parked,
      `${label}: no anchored scroller with overflowing content — the probe measured nothing`,
    ).not.toBeNull();

    await page.waitForTimeout(WATCH_MS);

    const result = await page.evaluate(() => {
      const probe = (
        window as unknown as {
          __probe: { shimWrites: number; teardowns: number; min: number; max: number };
        }
      ).__probe;
      (probe as unknown as { running: boolean }).running = false;
      const el = (window as unknown as { __probeEl: Element }).__probeEl;
      return {
        drift: Math.round(probe.max - probe.min),
        shimWrites: probe.shimWrites,
        teardowns: probe.teardowns,
        stillCurrent: el.isConnected && document.querySelector('[data-scroll-anchor]') === el,
      };
    });

    expect(
      result.stillCurrent,
      `${label}: the anchored scroller was replaced mid-watch — the probe measured a detached node, so the zeros below prove nothing`,
    ).toBe(true);
    expect(result.drift, `${label}: reader moved while polling`).toBe(0);
    expect(result.teardowns, `${label}: a subtree was torn down instead of updated`).toBe(0);
    expect(result.shimWrites, `${label}: the scroll-anchor shim had to correct a reflow`).toBe(0);
  });
}
