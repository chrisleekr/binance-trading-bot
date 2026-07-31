import { QueryClientProvider } from '@tanstack/react-query';
import {
  createMemoryHistory,
  createRoute,
  createRouter,
  RouterProvider,
} from '@tanstack/react-router';
import { render, screen, waitFor } from '@testing-library/react';
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
vi.mock('sonner', () => ({
  toast: { success: (m: string) => toastSuccess(m), error: (m: string) => toastError(m) },
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

  it('disables the submit button while no asset is selected', async () => {
    setUp((url) => {
      if (url.endsWith('/profiles/p1/dust-transfer')) return json(sampleAssets);
      return json({}, 404);
    });
    await screen.findByLabelText('XRP', undefined, { timeout: 5000 });
    expect(screen.getByRole('button', { name: /convert to BNB/i })).toBeDisabled();
  });
});
