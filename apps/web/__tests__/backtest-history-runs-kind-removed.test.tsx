// The History toolbar's run-type filter is gone. Nothing stored on a backtest run distinguishes a manual run from any other — every row is operator-created — so the control was a labelled no-op: it repainted itself, re-issued the query, and returned the same page. A filter that cannot fail to match is worse than no filter, because the operator reads the unchanged list as an answer.
//
// The remaining outcome filter and rows-per-page control are asserted here too: they share the toolbar and the same page-reset path, so removing their neighbour is exactly the edit that can break them.

import { QueryClientProvider, useQueryClient } from '@tanstack/react-query';
import { render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { createQueryClient } from '@/shared/lib/query-client';
import { setActiveAccountId } from '@/shared/lib/account-scope';
import { HistoryTab } from '@/features/backtest/components/history-tab';
import * as historyModule from '@/features/backtest/components/use-backtest-history';
import { useBacktestHistory } from '@/features/backtest/components/use-backtest-history';
import type { BacktestWorkbench } from '@/features/backtest/components/use-backtest-workbench';

const ACCOUNT_ID = '00000000-0000-4000-8000-0000000000ac';
const PROFILE_ID = '00000000-0000-4000-8000-000000000001';
const RUN_ID = 'b1111111-1111-4111-8111-111111111111';

const listRow = {
  runId: RUN_ID,
  status: 'done',
  progress: 100,
  symbols: ['BTCUSDT'],
  createdAt: '2026-05-10T05:00:00.000Z',
  finishedAt: '2026-05-10T05:05:00.000Z',
  fromMs: 1_746_000_000_000,
  toMs: 1_746_086_400_000,
  totalReturnPct: 1.5,
};

const idleMutation = { isPending: false, variables: undefined, mutate: () => undefined };

function Harness(): React.JSX.Element {
  const queryClient = useQueryClient();
  const history = useBacktestHistory({
    profileId: PROFILE_ID,
    activeRunId: null,
    showRun: () => undefined,
    setBanner: () => undefined,
    baselineBacktestRunId: null,
    queryClient,
  });
  const wb = {
    history,
    run: { activeRunId: null, abort: idleMutation, retry: idleMutation },
    compare: { unpinBaseline: idleMutation, baselineBacktestRunId: null },
    selectRun: () => undefined,
  } as unknown as BacktestWorkbench;
  return <HistoryTab wb={wb} />;
}

const setUp = (): { urls: string[] } => {
  const urls: string[] = [];
  vi.stubGlobal(
    'fetch',
    vi.fn(async (input: RequestInfo | URL) => {
      const url =
        typeof input === 'string' ? input : input instanceof URL ? input.toString() : input.url;
      urls.push(url);
      return new Response(JSON.stringify({ items: [listRow], nextCursor: null, total: 1 }), {
        status: 200,
        headers: { 'content-type': 'application/json' },
      });
    }),
  );
  render(
    <QueryClientProvider client={createQueryClient()}>
      <Harness />
    </QueryClientProvider>,
  );
  return { urls };
};

beforeEach(() => {
  setActiveAccountId(ACCOUNT_ID);
});

afterEach(() => {
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

describe('backtest History: the run-kind filter is gone', () => {
  it('presents no run-type filter group in the toolbar', async () => {
    setUp();
    await screen.findByTestId('bt-runs-filter-all');
    expect(screen.queryByTestId('bt-runs-kind-all')).toBeNull();
    expect(screen.queryByTestId('bt-runs-kind-manual')).toBeNull();
    expect(screen.queryByRole('group', { name: 'Filter runs by type' })).toBeNull();
  });

  it('exports no run-kind vocabulary for another surface to re-mount the control from', () => {
    expect(historyModule).not.toHaveProperty('RUNS_KIND_FILTERS');
  });

  it('sends no kind param on any request the remaining toolbar can produce', async () => {
    const { urls } = setUp();
    const user = userEvent.setup();
    await screen.findByTestId('bt-runs-filter-all');

    await user.click(screen.getByTestId('bt-runs-filter-profit'));
    await waitFor(() => expect(urls.some((u) => u.includes('filter=profit'))).toBe(true));
    await user.selectOptions(screen.getByTestId('bt-runs-page-size'), '25');
    await waitFor(() => expect(urls.some((u) => u.includes('limit=25'))).toBe(true));

    expect(urls.filter((u) => u.includes('kind='))).toEqual([]);
  });

  it('keeps the outcome filter narrowing and paginating from the first page', async () => {
    const { urls } = setUp();
    const user = userEvent.setup();
    await screen.findByTestId('bt-runs-filter-all');
    // The default page is param-free: page size equals the server default and "All" sends no filter.
    expect(urls.some((u) => !u.includes('filter=') && !u.includes('limit='))).toBe(true);

    await user.click(screen.getByTestId('bt-runs-filter-error'));
    await waitFor(() => expect(urls.some((u) => u.includes('filter=error'))).toBe(true));
    expect(screen.getByTestId('bt-runs-filter-error')).toHaveAttribute('aria-pressed', 'true');
    // Changing the filter resets to the first page; a stale cursor from the previous query would page into rows the new filter never matched.
    expect(
      urls.filter((u) => u.includes('filter=error')).every((u) => !u.includes('cursor=')),
    ).toBe(true);
  });
});
