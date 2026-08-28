// Past runs: the config-signature column. Two runs over the same window are indistinguishable in the table today, so an operator comparing "before" and "after" a config change has to open both. The fingerprint is the effective merged strategy config only, so equal codes mean the runs differed by window, not by settings.
//
// Driven through the real history hook and the real contract parse rather than by handing the table a hand-built row: the field has to survive `BacktestListResponse` to reach the cell, and zod strips a key the schema does not declare, so a contract that forgot it renders the placeholder here.

import { QueryClientProvider, useQueryClient } from '@tanstack/react-query';
import { render, screen, within } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { BacktestListItemSchema } from '@app/contracts';
import { createQueryClient } from '@/shared/lib/query-client';
import { setActiveAccountId } from '@/shared/lib/account-scope';
import { HistoryTab } from '@/features/backtest/components/history-tab';
import { useBacktestHistory } from '@/features/backtest/components/use-backtest-history';
import type { BacktestWorkbench } from '@/features/backtest/components/use-backtest-workbench';

const ACCOUNT_ID = '00000000-0000-4000-8000-0000000000ac';
const PROFILE_ID = '00000000-0000-4000-8000-000000000001';
const SIGNED_RUN = 'a1111111-1111-4111-8111-111111111111';
const UNSIGNED_RUN = 'a2222222-2222-4222-8222-222222222222';
const FINGERPRINT = '0123456789abcdef';

const listRow = (runId: string, configFingerprint: string | null) => ({
  runId,
  status: 'done',
  progress: 100,
  symbols: ['BTCUSDT'],
  createdAt: '2026-05-10T05:00:00.000Z',
  finishedAt: '2026-05-10T05:05:00.000Z',
  fromMs: 1_746_000_000_000,
  toMs: 1_746_086_400_000,
  totalReturnPct: 1.5,
  configFingerprint,
});

const json = (body: unknown): Response =>
  new Response(JSON.stringify(body), {
    status: 200,
    headers: { 'content-type': 'application/json' },
  });

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

const setUp = (): void => {
  const body = {
    items: [listRow(SIGNED_RUN, FINGERPRINT), listRow(UNSIGNED_RUN, null)],
    nextCursor: null,
    total: 2,
  };
  vi.stubGlobal(
    'fetch',
    vi.fn(async () => json(body)),
  );
  render(
    <QueryClientProvider client={createQueryClient()}>
      <Harness />
    </QueryClientProvider>,
  );
};

beforeEach(() => {
  setActiveAccountId(ACCOUNT_ID);
});

afterEach(() => {
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

describe('past runs: config fingerprint column', () => {
  it('carries the fingerprint on the list contract, so the api projection cannot drop it silently', () => {
    // The cells below are fed by a stubbed response; without this the whole column could render off a field no server is obliged to send.
    expect(Object.keys(BacktestListItemSchema.shape)).toContain('configFingerprint');
  });

  it('renders the signature as a short code carrying the full hash, under a column header', async () => {
    setUp();
    const cell = await screen.findByTestId(`backtest-config-${SIGNED_RUN}`);
    expect(within(cell).getByText(FINGERPRINT.slice(0, 8))).toBeInTheDocument();
    // The short code is a prefix; the whole hash stays reachable or two runs colliding on eight characters read as one config.
    expect(cell.querySelector(`[title="${FINGERPRINT}"]`)).not.toBeNull();
    // The header row is the one holding the select-all checkbox.
    const header = screen.getByTestId('backtest-select-all').parentElement as HTMLElement;
    expect(within(header).getByText('Config')).toBeInTheDocument();
  });

  it('renders a neutral placeholder for a run with no fingerprint', async () => {
    setUp();
    const cell = await screen.findByTestId(`backtest-config-${UNSIGNED_RUN}`);
    expect(cell).toHaveTextContent('—');
    expect(cell).not.toHaveTextContent(FINGERPRINT.slice(0, 8));
  });

  it('labels the cell in place at mobile width, where the column headers are hidden', async () => {
    // Below sm the header row is `hidden`, so an unlabelled cell is a bare hash. `sm:sr-only` (not `hidden`) keeps the label in the accessibility tree at every width, which is the pattern the two date cells beside it already use.
    setUp();
    const cell = await screen.findByTestId(`backtest-config-${SIGNED_RUN}`);
    const label = cell.querySelector('.sm\\:sr-only');
    expect(label?.textContent ?? '').toContain('Config');
  });
});
