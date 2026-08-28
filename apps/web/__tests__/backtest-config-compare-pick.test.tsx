// Picking the two runs to compare. The diff panel itself is pinned elsewhere; what is pinned here is the affordance that reaches it, because the pick is two-step and a two-step pick that silently arms nothing is indistinguishable from a dead button.
//
// The list already carries each run's fingerprint, so the drawer's only extra cost is the two run details it fetches for their resolved configs. Those are seeded into the query cache here rather than served from a stubbed response: what this file is about is the wiring from the row button to the rendered diff, and a schema-complete run-detail body would put a hundred lines of unrelated fixture between the click and the assertion.

import { QueryClientProvider, useQueryClient, type QueryClient } from '@tanstack/react-query';
import { render, screen, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { createQueryClient } from '@/shared/lib/query-client';
import { setActiveAccountId } from '@/shared/lib/account-scope';
import { backtestRunQueryKey } from '@/features/backtest/api/backtest';
import { HistoryTab } from '@/features/backtest/components/history-tab';
import { useBacktestHistory } from '@/features/backtest/components/use-backtest-history';
import type { BacktestWorkbench } from '@/features/backtest/components/use-backtest-workbench';

const ACCOUNT_ID = '00000000-0000-4000-8000-0000000000ac';
const PROFILE_ID = '00000000-0000-4000-8000-000000000001';
const RUN_A = 'a1111111-1111-4111-8111-111111111111';
const RUN_B = 'a2222222-2222-4222-8222-222222222222';

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

// The api declines on purpose with a 503, which the shared query client deliberately does NOT retry. A retried status would leave the drawer in its loading branch for the length of the backoff and the error assertion would race it.
const declined = (): Response =>
  new Response(JSON.stringify({ error: { code: 'SERVICE_UNAVAILABLE', message: 'declined' } }), {
    status: 503,
    headers: { 'content-type': 'application/json' },
  });

const idleMutation = { isPending: false, variables: undefined, mutate: () => undefined };

/** Seed one run's detail so the drawer's fetch resolves from cache the moment it is enabled. */
const seedDetail = (qc: QueryClient, runId: string, resolvedConfig: Record<string, unknown>) => {
  qc.setQueryData(backtestRunQueryKey(PROFILE_ID, runId), { result: { resolvedConfig } });
};

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
    profileId: PROFILE_ID,
    history,
    run: { activeRunId: null, abort: idleMutation, retry: idleMutation },
    compare: { unpinBaseline: idleMutation, baselineBacktestRunId: null },
    selectRun: () => undefined,
  } as unknown as BacktestWorkbench;
  return <HistoryTab wb={wb} />;
}

/**
 * How the two run details behave. `seeded` puts both in the cache so the drawer resolves on the click; the other two leave one or both to the stubbed request, which is the only way to reach the drawer's error and loading branches.
 */
type DetailMode = 'seeded' | 'declined' | 'second-in-flight';

const setUp = (
  fingerprintB: string | null = 'fp-b',
  detail: DetailMode = 'seeded',
): QueryClient => {
  const queryClient = createQueryClient();
  if (detail !== 'declined')
    seedDetail(queryClient, RUN_A, { buy: { triggerPercentage: '1.005' } });
  if (detail === 'seeded') seedDetail(queryClient, RUN_B, { buy: { triggerPercentage: '1.02' } });
  vi.stubGlobal(
    'fetch',
    vi.fn(async (input: RequestInfo | URL) => {
      const url = String(input);
      // Only the run-detail requests carry a run id; the list request never does.
      if (url.includes(RUN_A) || url.includes(RUN_B)) {
        if (detail === 'declined') return declined();
        // Never settles: the second side is still in flight, which is what the loading branch is for.
        return new Promise<Response>(() => undefined);
      }
      return json({
        items: [listRow(RUN_A, 'fp-a'), listRow(RUN_B, fingerprintB)],
        nextCursor: null,
        total: 2,
      });
    }),
  );
  render(
    <QueryClientProvider client={queryClient}>
      <Harness />
    </QueryClientProvider>,
  );
  return queryClient;
};

beforeEach(() => {
  setActiveAccountId(ACCOUNT_ID);
});

afterEach(() => {
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

describe('past runs: picking two runs to compare their configs', () => {
  it('arms one run, then opens the diff against the second with the value from each side', async () => {
    setUp();
    const user = userEvent.setup();
    await user.click(await screen.findByTestId(`backtest-compare-config-${RUN_A}`));
    // Arming alone must not open anything: the operator has named one run, not asked a question.
    expect(screen.queryByTestId('backtest-config-compare-sheet')).toBeNull();

    await user.click(screen.getByTestId(`backtest-compare-config-${RUN_B}`));
    const sheet = await screen.findByTestId('backtest-config-compare-sheet');
    expect(sheet).toHaveTextContent('buy.triggerPercentage');
    // Both values, not just the path: "these differ" is the half the fingerprint already told them.
    expect(sheet).toHaveTextContent('1.005');
    expect(sheet).toHaveTextContent('1.02');
  });

  it('disarms when the same row is picked twice, rather than comparing a run with itself', async () => {
    setUp();
    const user = userEvent.setup();
    const armed = await screen.findByTestId(`backtest-compare-config-${RUN_A}`);
    await user.click(armed);
    expect(armed).toHaveAttribute('aria-pressed', 'true');
    await user.click(armed);
    expect(armed).toHaveAttribute('aria-pressed', 'false');
    expect(screen.queryByTestId('backtest-config-compare-sheet')).toBeNull();
  });

  it('offers the pick on a run with no fingerprint, so the unavailable answer is reachable', async () => {
    // A blank Config cell reads as a rendering fault unless the operator can ask and be told the run predates the stamping. Hiding the control there is what would make that answer unreachable.
    setUp(null);
    const user = userEvent.setup();
    await user.click(await screen.findByTestId(`backtest-compare-config-${RUN_A}`));
    await user.click(screen.getByTestId(`backtest-compare-config-${RUN_B}`));
    const sheet = await screen.findByTestId('backtest-config-compare-sheet');
    expect(sheet).toHaveTextContent('config is unavailable');
    expect(sheet.textContent ?? '').not.toMatch(/identical/i);
  });

  it('refuses the comparison outright when a run detail could not be loaded', async () => {
    // A failed side arrives at the diff as a null resolved config, which the diff reads as "this run never recorded one" — a permanent fact about the run rather than a request that failed. Diffing against half the input is the reading that turns a transient fetch failure into a claim about the operator's settings.
    setUp('fp-b', 'declined');
    const user = userEvent.setup();
    await user.click(await screen.findByTestId(`backtest-compare-config-${RUN_A}`));
    await user.click(screen.getByTestId(`backtest-compare-config-${RUN_B}`));
    expect(await screen.findByTestId('backtest-config-compare-error')).toBeInTheDocument();
    expect(screen.queryByTestId('backtest-config-diff')).toBeNull();
    expect(screen.queryByTestId('backtest-config-diff-unavailable')).toBeNull();
  });

  it('holds the placeholder while the second run detail is still in flight', async () => {
    // The same null-config seam, reached from the other direction: an unresolved side must not be rendered as an answer either, and "unavailable" published mid-fetch is a wrong answer the operator has no reason to doubt.
    setUp('fp-b', 'second-in-flight');
    const user = userEvent.setup();
    await user.click(await screen.findByTestId(`backtest-compare-config-${RUN_A}`));
    await user.click(screen.getByTestId(`backtest-compare-config-${RUN_B}`));
    const sheet = await screen.findByTestId('backtest-config-compare-sheet');
    expect(within(sheet).getByRole('status')).toBeInTheDocument();
    expect(screen.queryByTestId('backtest-config-diff')).toBeNull();
    expect(screen.queryByTestId('backtest-config-diff-unavailable')).toBeNull();
    expect(screen.queryByTestId('backtest-config-compare-error')).toBeNull();
  });
});
