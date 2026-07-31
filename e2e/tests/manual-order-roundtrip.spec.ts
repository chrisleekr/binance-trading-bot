// Manual MARKET buy round-trip. Drives the SPA the same way an operator
// would, then asserts the worker actually placed an order on Binance:
//
//   login → /profiles/$id/symbols/$sym → fill manual-trade form →
//   Review → Confirm → expect 202 with overrideActionId →
//   poll /api/profiles/$id/symbols/$sym/orders until count climbs.
//
// The orders poll is the load-bearing assertion. A successful 202 only
// proves the API enqueued the override; without the orders-row check
// the test would pass even if the worker dropped the job into DLQ
// (the failure mode #168 was supposed to unblock).
//
// Gated by env, not by E2E_FULL_STACK. The full-stack flag spins
// docker compose in global-setup — that conflicts with the native
// `bun run dev` workflow this spec is designed for. Setting the four
// E2E_USER_*/E2E_PROFILE_ID/E2E_SYMBOL vars is the explicit opt-in.

import { expect, test, type APIRequestContext, type Page } from '@playwright/test';

const EMAIL = process.env['E2E_USER_EMAIL'] ?? '';
const PASSWORD = process.env['E2E_USER_PASSWORD'] ?? '';
const ACCOUNT_ID = process.env['E2E_ACCOUNT_ID'] ?? '';
const PROFILE_ID = process.env['E2E_PROFILE_ID'] ?? '';
const SYMBOL = process.env['E2E_SYMBOL'] ?? '';
const QUOTE_AMOUNT = process.env['E2E_QUOTE_AMOUNT'] ?? '20';
const ENABLED = EMAIL && PASSWORD && ACCOUNT_ID && PROFILE_ID && SYMBOL;

test.skip(
  !ENABLED,
  'manual-order spec requires E2E_USER_EMAIL/PASSWORD + E2E_ACCOUNT_ID + E2E_PROFILE_ID + E2E_SYMBOL',
);

interface OrderRow {
  readonly id: string;
  readonly status: string;
}
interface OrderList {
  readonly items: readonly OrderRow[];
}

const fetchOrders = async (req: APIRequestContext): Promise<readonly OrderRow[]> => {
  const res = await req.get(
    `/api/accounts/${ACCOUNT_ID}/profiles/${PROFILE_ID}/symbols/${SYMBOL}/orders`,
  );
  if (!res.ok()) {
    throw new Error(`GET /orders -> ${res.status()} ${await res.text()}`);
  }
  const body = (await res.json()) as OrderList;
  return body.items ?? [];
};

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

test('manual MARKET buy: api 202 → ui banner → worker creates order row', async ({ page }) => {
  await login(page);

  // Snapshot the pre-existing orders so the post-condition is a strict
  // count climb rather than a "non-empty" check — the user may already
  // have historical orders for this symbol.
  const baseline = await fetchOrders(page.request);
  const baselineCount = baseline.length;

  // The symbol's manual-trade surface is now the dashboard workspace, opened
  // by `?sym=<profileId>:<SYMBOL>` (the old per-symbol route redirects here).
  await page.goto(`/accounts/${ACCOUNT_ID}?sym=${PROFILE_ID}:${SYMBOL}`);
  await expect(page.getByTestId('manual-trade-panel')).toBeVisible({ timeout: 10_000 });

  await page.getByTestId('manual-side').selectOption('BUY');
  await page.getByTestId('manual-type').selectOption('MARKET');
  await page.getByTestId('manual-sizing').selectOption('quoteAmount');
  await page.getByTestId('manual-amount').fill(QUOTE_AMOUNT);
  await page.getByTestId('manual-review').click();

  // Arm the waiter BEFORE clicking Confirm: the fetch is fired
  // synchronously from the click handler and a late attach can miss
  // the response on a fast network.
  const responsePromise = page.waitForResponse(
    (res) =>
      res
        .url()
        .includes(
          `/accounts/${ACCOUNT_ID}/profiles/${PROFILE_ID}/symbols/${SYMBOL}/manual-order`,
        ) && res.request().method() === 'POST',
    { timeout: 15_000 },
  );
  await page.getByTestId('manual-confirm').click();
  const response = await responsePromise;

  const responseText = await response.text();
  expect(response.status(), `manual-order body: ${responseText}`).toBe(202);
  const body = JSON.parse(responseText) as { scheduledAt: string; overrideActionId: string };
  expect(body.scheduledAt).toMatch(/^\d{4}-\d{2}-\d{2}T/);
  expect(body.overrideActionId).toMatch(/^[0-9a-f-]{36}$/i);

  await expect(page.getByText(/scheduled at/i)).toBeVisible({ timeout: 5_000 });

  // Worker-side ack: override-action lands in queue, executor places
  // the order on Binance testnet, executionReport WS pushes back, an
  // orders row materialises. MARKET orders fill instantly so the row
  // may be NEW briefly then FILLED — count is the only stable signal.
  // 30s is generous: dev-host latency to Binance + WS roundtrip is
  // typically < 3s. A timeout here is the bug surface.
  await expect
    .poll(async () => (await fetchOrders(page.request)).length, {
      message: `worker did not produce an orders row within 30s (baseline=${baselineCount})`,
      timeout: 30_000,
      intervals: [1_000, 1_500, 2_000, 3_000, 5_000],
    })
    .toBeGreaterThan(baselineCount);
});
