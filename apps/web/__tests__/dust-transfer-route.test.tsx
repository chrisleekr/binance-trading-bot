import { QueryClientProvider } from '@tanstack/react-query';
import {
  createMemoryHistory,
  createRoute,
  createRouter,
  RouterProvider,
} from '@tanstack/react-router';
import { act, fireEvent, render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { createQueryClient } from '@/shared/lib/query-client';
import { rootRoute } from '@/app/__root';
import { accountScopeRoute } from '@/features/account/routes/account-scope';
import { dustTransferRoute } from '@/features/account/routes/account.dust-transfer';

const ACCOUNT_ID = '00000000-0000-4000-8000-0000000000ac';
const TEST_ACCOUNT = {
  id: ACCOUNT_ID,
  name: 'Main',
  binanceMode: 'test' as const,
  apiKeyConfigured: true,
  createdAt: '2026-01-01T00:00:00.000Z',
};

const toastSuccess = vi.fn();
const toastError = vi.fn();
const toastInfo = vi.fn();
vi.mock('sonner', () => ({
  toast: {
    success: (m: string) => toastSuccess(m),
    error: (m: string) => toastError(m),
    info: (m: string) => toastInfo(m),
  },
  Toaster: () => null,
}));

type Json = unknown;

const json = (body: Json, status = 200): Response =>
  new Response(JSON.stringify(body), {
    status,
    headers: { 'content-type': 'application/json' },
  });

const stub = (path: string) =>
  createRoute({ getParentRoute: () => rootRoute, path, component: () => null });

const setUp = (responder: (url: string, init?: RequestInit) => Response | Promise<Response>) => {
  const fetchMock = vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
    const url =
      typeof input === 'string' ? input : input instanceof URL ? input.toString() : input.url;
    return responder(url, init);
  });
  vi.stubGlobal('fetch', fetchMock);
  const queryClient = createQueryClient();
  queryClient.setQueryData(['auth', 'onboarding-status'], { masterExists: true });
  queryClient.setQueryData(['accounts'], [TEST_ACCOUNT]);
  const indexStub = stub('/');
  const onboardingStub = stub('/onboarding');
  const loginStub = stub('/login');
  const accountStub = stub('/account');
  const router = createRouter({
    routeTree: rootRoute.addChildren([
      indexStub,
      onboardingStub,
      loginStub,
      accountStub,
      accountScopeRoute.addChildren([dustTransferRoute]),
    ]),
    context: { queryClient },
    history: createMemoryHistory({
      initialEntries: [`/accounts/${ACCOUNT_ID}/dust-transfer?profileId=p1`],
    }),
  });
  const utils = render(
    <QueryClientProvider client={queryClient}>
      <RouterProvider
        router={router as unknown as Parameters<typeof RouterProvider>[0]['router']}
      />
    </QueryClientProvider>,
  );
  return { fetchMock, ...utils };
};

const sampleAssets = [
  // Eligible — above threshold, can transfer, not BNB/BTC.
  {
    asset: 'XRP',
    free: '10',
    locked: '0',
    estimatedBTC: '0.0025',
    canDustTransfer: true,
  },
  {
    asset: 'ADA',
    free: '15',
    locked: '0',
    estimatedBTC: '0.0015',
    canDustTransfer: true,
  },
  // Below 0.001 threshold — must not appear.
  {
    asset: 'XLM',
    free: '5',
    locked: '0',
    estimatedBTC: '0.0001',
    canDustTransfer: true,
  },
  // canDustTransfer false — must not appear even if above threshold.
  {
    asset: 'DOGE',
    free: '100',
    locked: '0',
    estimatedBTC: '0.005',
    canDustTransfer: false,
  },
  // BNB itself — destination of the conversion, must not appear.
  {
    asset: 'BNB',
    free: '0.5',
    locked: '0',
    estimatedBTC: '0.01',
    canDustTransfer: true,
  },
];

describe('DustTransferPage', () => {
  beforeEach(() => {
    vi.spyOn(console, 'error').mockImplementation(() => undefined);
    // The toast spies are module-scoped, so a `not.toHaveBeenCalled()` here would
    // otherwise be answered by whichever earlier test last fired one.
    toastSuccess.mockClear();
    toastError.mockClear();
    toastInfo.mockClear();
  });
  afterEach(() => {
    vi.unstubAllGlobals();
    vi.restoreAllMocks();
  });

  it('shows only dust-eligible assets above 0.001 BTC, excluding BNB/BTC', async () => {
    setUp((url) => {
      if (url.endsWith('/profiles/p1/dust-transfer')) return json(sampleAssets);
      return json({}, 404);
    });
    expect(await screen.findByLabelText('XRP', undefined, { timeout: 5000 })).toBeInTheDocument();
    expect(screen.getByLabelText('ADA')).toBeInTheDocument();
    expect(screen.queryByLabelText('XLM')).not.toBeInTheDocument();
    expect(screen.queryByLabelText('DOGE')).not.toBeInTheDocument();
    expect(screen.queryByLabelText('BNB')).not.toBeInTheDocument();
  });

  it('renders the recent-conversions history with status labels and BNB received', async () => {
    setUp((url) => {
      if (url.endsWith('/dust-transfer/history'))
        return json([
          {
            id: 'aaaaaaaa-bbbb-4ccc-8ddd-eeeeeeeeeeee',
            requestedAssets: ['XRP'],
            convertedAssets: ['XRP'],
            bnbReceived: '0.5',
            status: 'done',
            createdAt: '2026-07-09T00:00:00.000Z',
            consumedAt: '2026-07-09T01:00:00.000Z',
          },
          {
            id: 'bbbbbbbb-cccc-4ddd-8eee-ffffffffffff',
            requestedAssets: ['ADA'],
            convertedAssets: null,
            bnbReceived: null,
            status: 'processing',
            createdAt: '2026-07-09T00:00:00.000Z',
            consumedAt: null,
          },
          {
            id: 'cccccccc-dddd-4eee-8fff-000000000000',
            requestedAssets: ['DOT'],
            convertedAssets: null,
            bnbReceived: null,
            status: 'pending',
            createdAt: '2026-07-09T00:00:00.000Z',
            consumedAt: null,
          },
        ]);
      if (url.endsWith('/profiles/p1/dust-transfer')) return json(sampleAssets);
      return json({}, 404);
    });
    expect(await screen.findByText(/Converted 1 asset/i)).toBeInTheDocument();
    expect(screen.getByText('Converting…')).toBeInTheDocument();
    expect(screen.getByText('Queued')).toBeInTheDocument();
    expect(screen.getByText(/→ 0.5 BNB/)).toBeInTheDocument();
  });

  it('renders conversion timestamps in the operator timezone, not system-local (#619 C5)', async () => {
    // Regression guard for the "dust transfer shows system date/time only" report:
    // the history timestamp must render in the operator's configured zone only.
    // With Asia/Seoul (UTC+9) a 00:00Z instant reads "2026-07-09 09:00 GMT+9",
    // with no UTC anchor; a regression that dropped the timeZone argument or
    // re-added the UTC copy would fail this.
    setUp((url) => {
      if (url.includes('/account/settings')) return json({ timezone: 'Asia/Seoul' });
      if (url.endsWith('/dust-transfer/history'))
        return json([
          {
            id: 'aaaaaaaa-bbbb-4ccc-8ddd-eeeeeeeeeeee',
            requestedAssets: ['XRP'],
            convertedAssets: ['XRP'],
            bnbReceived: '0.5',
            status: 'done',
            createdAt: '2026-07-09T00:00:00.000Z',
            consumedAt: '2026-07-09T01:00:00.000Z',
          },
        ]);
      if (url.endsWith('/profiles/p1/dust-transfer')) return json(sampleAssets);
      return json({}, 404);
    });
    const stamp = await screen.findByText(/2026-07-09 09:00/, undefined, { timeout: 5000 });
    expect(stamp).toBeInTheDocument();
    expect(stamp.textContent).not.toContain('UTC'); // configured zone only, no UTC anchor
  });

  it('updates the running BTC preview as assets are toggled', async () => {
    setUp((url) => {
      if (url.endsWith('/profiles/p1/dust-transfer')) return json(sampleAssets);
      return json({}, 404);
    });
    const user = userEvent.setup();
    await screen.findByLabelText('XRP', undefined, { timeout: 5000 });
    // Read the running preview by its sibling — the "N selected" sibling pins the row
    // we care about so the per-row balance text never aliases the assertion.
    const preview = (): HTMLElement => {
      const selectedLabel = screen.getByText(/selected$/i);
      const row = selectedLabel.parentElement;
      if (!row) throw new Error('preview row missing');
      const value = row.querySelector('span:last-child');
      if (!value) throw new Error('preview value missing');
      return value as HTMLElement;
    };
    await user.click(screen.getByLabelText('XRP'));
    expect(preview().textContent).toBe('0.0025 BTC');
    await user.click(screen.getByLabelText('ADA'));
    expect(preview().textContent).toBe('0.004 BTC');
  });

  it('submits the selected asset symbols and shows the override-id banner', async () => {
    let submittedBody: unknown;
    setUp(async (url, init) => {
      if (init?.method === 'POST' && url.endsWith('/profiles/p1/dust-transfer')) {
        submittedBody = JSON.parse(String(init.body ?? '{}'));
        return json({
          scheduledAt: new Date().toISOString(),
          // Real-shape UUID v4: third group starts with 4, fourth group with 8/9/a/b.
          overrideActionId: 'aaaaaaaa-bbbb-4ccc-8ddd-eeeeeeeeeeee',
          createdAt: new Date().toISOString(),
        });
      }
      if (url.endsWith('/profiles/p1/dust-transfer')) return json(sampleAssets);
      return json({}, 404);
    });
    const user = userEvent.setup();
    await screen.findByLabelText('XRP', undefined, { timeout: 5000 });
    await user.click(screen.getByLabelText('XRP'));
    await user.click(screen.getByLabelText('ADA'));
    await user.click(screen.getByRole('button', { name: /convert to BNB/i }));
    await waitFor(() => {
      expect(submittedBody).toEqual({ assets: ['XRP', 'ADA'] });
    });
    // The success surface is a Sonner toast carrying "Scheduled — override <8>…".
    await waitFor(() =>
      expect(toastSuccess).toHaveBeenCalledWith(expect.stringMatching(/scheduled.*aaaaaaaa/i)),
    );
  });

  const queuedHistory = [
    {
      id: 'dddddddd-eeee-4fff-8000-111111111111',
      requestedAssets: ['XRP'],
      convertedAssets: null,
      bnbReceived: null,
      status: 'pending',
      createdAt: '2026-07-09T00:00:00.000Z',
      consumedAt: null,
    },
  ];

  /** Serves the eligible list and whatever history rows a visibility test needs. */
  const setUpWithHistory = (history: unknown): void => {
    setUp((url) => {
      if (url.endsWith('/dust-transfer/history')) return json(history);
      if (url.endsWith('/profiles/p1/dust-transfer')) return json(sampleAssets);
      return json({}, 404);
    });
  };

  it('hides the cancel affordance when every conversion has finished', async () => {
    // The mount rule is one predicate with nothing else pinning its false side:
    // inverted, it offers a destructive "cancel" on conversions that already
    // moved the balance, which reads as an undo the bot cannot perform.
    setUpWithHistory([
      { ...queuedHistory[0], status: 'done', consumedAt: '2026-07-09T00:05:00.000Z' },
    ]);

    // Asserted only after a sibling of the panel has rendered. Before the history
    // read lands, nothing is on screen and the absence would hold for any rule.
    expect(
      await screen.findByText('Recent conversions', undefined, { timeout: 5000 }),
    ).toBeVisible();
    expect(screen.queryByTestId('dust-cancel-open')).not.toBeInTheDocument();
  });

  it('offers cancel while a conversion is already being processed', async () => {
    // The claimed row is where cancelling matters most: the route, not the page,
    // decides whether the worker's claim is still live, and rows can be stacked
    // behind it that nothing else can clear.
    setUpWithHistory([{ ...queuedHistory[0], status: 'processing' }]);

    expect(
      await screen.findByTestId('dust-cancel-open', undefined, { timeout: 5000 }),
    ).toBeInTheDocument();
  });

  it('cancels a queued conversion and refreshes both the eligible list and the history', async () => {
    // Without this the operator can only wait: a mis-clicked conversion moves
    // real balances and there is no other way back. Both reads have to be
    // refreshed, because the cancelled row is what the history is showing.
    const calls: string[] = [];
    const { fetchMock } = setUp((url, init) => {
      const method = init?.method ?? 'GET';
      if (url.endsWith('/profiles/p1/dust-transfer')) {
        calls.push(`${method} list`);
        if (method === 'DELETE') return new Response(null, { status: 204 });
        return json(sampleAssets);
      }
      if (url.endsWith('/dust-transfer/history')) {
        calls.push('GET history');
        return json(queuedHistory);
      }
      return json({}, 404);
    });
    const user = userEvent.setup();
    await user.click(await screen.findByTestId('dust-cancel-open', undefined, { timeout: 5000 }));
    await user.click(screen.getByTestId('dust-cancel-confirm'));

    await waitFor(() => expect(calls).toContain('DELETE list'));
    const after = calls.slice(calls.indexOf('DELETE list') + 1);
    expect(after).toContain('GET list');
    expect(after).toContain('GET history');
    expect(fetchMock).toHaveBeenCalled();
    expect(toastError).not.toHaveBeenCalled();
  });

  it('fires one DELETE when the confirm button is clicked twice in the same tick', async () => {
    // `isPending` only flips on the next render, so the disabled attribute cannot
    // catch a second click landing in the same tick — a ref is what does, and
    // nothing else in this suite would notice if it were dropped. The second
    // DELETE is not harmless: it lands after the first has emptied the queue, so
    // an operator who double-clicks can get a 409 about someone else's row, or a
    // 204 that reports nothing when their conversions did in fact go.
    let deletes = 0;
    setUp((url, init) => {
      const method = init?.method ?? 'GET';
      if (url.endsWith('/profiles/p1/dust-transfer')) {
        if (method === 'DELETE') {
          deletes += 1;
          return new Response(null, { status: 204 });
        }
        return json(sampleAssets);
      }
      if (url.endsWith('/dust-transfer/history')) return json(queuedHistory);
      return json({}, 404);
    });
    const user = userEvent.setup();
    await user.click(await screen.findByTestId('dust-cancel-open', undefined, { timeout: 5000 }));

    // fireEvent, not userEvent: each `await user.click` yields, which is exactly
    // the render the guard exists to survive without.
    const confirm = screen.getByTestId('dust-cancel-confirm');
    act(() => {
      fireEvent.click(confirm);
      fireEvent.click(confirm);
    });

    await waitFor(() => expect(deletes).toBeGreaterThan(0));
    expect(deletes).toBe(1);
  });

  it('reports the server sentence and no success when the conversion is already running', async () => {
    // A 409 means the balance is already moving. Reporting it as a cancellation
    // is the one answer the operator cannot recover from, because they act on
    // it by looking away. It is not an error either: nothing broke, so an error
    // toast would tell them to retry something that only needs waiting out.
    setUp((url, init) => {
      const method = init?.method ?? 'GET';
      if (url.endsWith('/profiles/p1/dust-transfer')) {
        if (method === 'DELETE')
          return json(
            { error: { code: 'CONFLICT', message: 'the bot is already converting this dust' } },
            409,
          );
        return json(sampleAssets);
      }
      if (url.endsWith('/dust-transfer/history')) return json(queuedHistory);
      return json({}, 404);
    });
    const user = userEvent.setup();
    await user.click(await screen.findByTestId('dust-cancel-open', undefined, { timeout: 5000 }));
    await user.click(screen.getByTestId('dust-cancel-confirm'));

    await waitFor(() =>
      expect(toastInfo).toHaveBeenCalledWith(
        expect.stringMatching(/already converting this dust/i),
      ),
    );
    expect(toastSuccess).not.toHaveBeenCalled();
    expect(toastError).not.toHaveBeenCalled();
  });

  it('disables the submit button while no asset is selected', async () => {
    setUp((url) => {
      if (url.endsWith('/profiles/p1/dust-transfer')) return json(sampleAssets);
      return json({}, 404);
    });
    await screen.findByLabelText('XRP', undefined, { timeout: 5000 });
    expect(screen.getByRole('button', { name: /convert to BNB/i })).toBeDisabled();
  });
});
