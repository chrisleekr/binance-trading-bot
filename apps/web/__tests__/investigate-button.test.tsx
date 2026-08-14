// The Investigate control is a diagnostic, so the properties worth pinning are
// honesty properties, not layout ones:
//
//   1. It asks first, and the question says the run changes nothing.
//   2. The ladder it shows is the server's ladder, from the very first response.
//   3. Nothing advances while the worker is frozen. A client-side progress timer
//      would pass a naive "does it move" check and fail this one, which is the
//      whole reason the check exists.
//   4. Closing the drawer neither cancels nor restarts the run.
//   5. A failed run reads as failed, never as a clean bill of health.
//   6. A finding links to the exact field that armed it.

import { QueryClientProvider } from '@tanstack/react-query';
import {
  createMemoryHistory,
  createRootRoute,
  createRoute,
  createRouter,
  Outlet,
  RouterProvider,
} from '@tanstack/react-router';
import { fireEvent, render, screen, waitFor } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import {
  DIAGNOSIS_STEPS,
  initialDiagnosisSteps,
  type DiagnosisRun,
  type ProfileDiagnosis,
} from '@app/contracts';

import { InvestigateButton } from '../src/features/profile/components/investigate-button.js';
import { createQueryClient } from '../src/shared/lib/query-client.js';

const PID = '00000000-0000-4000-8000-0000000000c1';
const ACCOUNT_ID = '00000000-0000-4000-8000-0000000000ac';
const RUN_ID = '00000000-0000-4000-8000-0000000000a1';

const run = (over: Partial<DiagnosisRun> = {}): DiagnosisRun => ({
  id: RUN_ID,
  status: 'queued',
  steps: initialDiagnosisSteps(),
  report: null,
  error: null,
  startedAtMs: 1_700_000_000_000,
  finishedAtMs: null,
  ...over,
});

/** The ladder mid-flight: the first rung resolved, the second in progress. */
const partway = (): DiagnosisRun['steps'] =>
  initialDiagnosisSteps().map((s, i) => {
    if (i === 0) return { ...s, status: 'ok' as const, line: 'The engine ticked 4s ago.' };
    if (i === 1) return { ...s, status: 'running' as const };
    return s;
  });

const json = (body: unknown): Response =>
  new Response(JSON.stringify(body), {
    status: 200,
    headers: { 'content-type': 'application/json' },
  });

interface Server {
  runs: DiagnosisRun[];
  posts: number;
}

/**
 * Stub the API with a mutable server. Tests move the server forward by hand,
 * which is what makes "frozen worker ⇒ frozen UI" assertable at all.
 */
const setUp = (initial: DiagnosisRun[] = []): Server => {
  const server: Server = { runs: initial, posts: 0 };
  vi.stubGlobal(
    'fetch',
    vi.fn(async (input: unknown, init?: { method?: string }) => {
      if ((init?.method ?? 'GET') === 'POST') {
        server.posts += 1;
        const started = run();
        server.runs = [started, ...server.runs];
        return json(started);
      }
      if (String(input).includes('/diagnosis/runs')) return json(server.runs);
      return json(null);
    }),
  );

  const qc = createQueryClient();
  const root = createRootRoute({
    component: () => (
      <>
        <InvestigateButton profileId={PID} />
        <Outlet />
      </>
    ),
  });
  const accountRoute = createRoute({
    getParentRoute: () => root,
    path: '/accounts/$accountId',
    component: () => <Outlet />,
  });
  const profileRoute = createRoute({
    getParentRoute: () => accountRoute,
    path: '/profiles/$profileId',
    component: () => <Outlet />,
  });
  const leaves = (['discovery', 'config', 'risk', 'general'] as const).map((path) =>
    createRoute({ getParentRoute: () => profileRoute, path: `/${path}`, component: () => null }),
  );
  const router = createRouter({
    routeTree: root.addChildren([
      createRoute({ getParentRoute: () => root, path: '/', component: () => null }),
      accountRoute.addChildren([profileRoute.addChildren(leaves)]),
    ]),
    history: createMemoryHistory({
      initialEntries: [`/accounts/${ACCOUNT_ID}/profiles/${PID}/config`],
    }),
  });
  render(
    <QueryClientProvider client={qc}>
      <RouterProvider
        router={router as unknown as Parameters<typeof RouterProvider>[0]['router']}
      />
    </QueryClientProvider>,
  );
  return server;
};

const openDrawer = async (): Promise<void> => {
  fireEvent.click(await screen.findByTestId('open-investigate'));
  await screen.findByTestId('investigate-sheet');
};

/** Reads the stub installed by {@link setUp}, so it must be called inside a test. */
const fetchCalls = (): number => (fetch as unknown as ReturnType<typeof vi.fn>).mock.calls.length;

const statuses = (): string[] =>
  DIAGNOSIS_STEPS.map(
    (id) => screen.getByTestId(`diagnosis-step-${id}`).getAttribute('data-status') ?? '',
  );

describe('<InvestigateButton>', () => {
  afterEach(() => {
    vi.unstubAllGlobals();
    vi.useRealTimers();
  });

  it('asks before it runs, and the question says the run changes nothing', async () => {
    const server = setUp();
    await openDrawer();

    const confirm = await screen.findByTestId('diagnosis-confirm');
    expect(confirm).toHaveTextContent(/read-only/i);
    expect(confirm).toHaveTextContent(/nothing is paused, bought, sold, or changed/i);
    // Opening the drawer must not itself start anything.
    expect(server.posts).toBe(0);
  });

  it('renders the whole ladder from the first response, not once the worker writes', async () => {
    const server = setUp();
    await openDrawer();
    fireEvent.click(screen.getByTestId('diagnosis-start'));

    await screen.findByTestId('diagnosis-run');
    expect(server.posts).toBe(1);
    // Nine rungs, all pending: the operator sees what will be checked before any
    // of it has been checked.
    expect(statuses()).toEqual(DIAGNOSIS_STEPS.map(() => 'pending'));
  });

  it('does not advance a single step while the worker is frozen', async () => {
    const server = setUp([run({ status: 'running', steps: partway() })]);
    await openDrawer();
    await screen.findByTestId('diagnosis-run');
    expect(statuses().slice(0, 3)).toEqual(['ok', 'running', 'pending']);

    // Real time, real polls: wait until the client has re-read the run several
    // times and been told exactly the same thing each time. A bar driven by a
    // local timer would have walked the ladder forward over these seconds; a
    // display driven by the worker's writes cannot.
    await waitFor(() => expect(fetchCalls()).toBeGreaterThanOrEqual(3));
    expect(statuses().slice(0, 3)).toEqual(['ok', 'running', 'pending']);

    // The worker writes, and only then does the display move.
    server.runs = [
      run({
        status: 'running',
        steps: initialDiagnosisSteps().map((s, i) =>
          i < 3 ? { ...s, status: 'ok' as const, line: 'checked' } : s,
        ),
      }),
    ];
    await waitFor(() => expect(statuses().slice(0, 3)).toEqual(['ok', 'ok', 'ok']));
  });

  it('keeps the run alive across a close, and reopening does not restart it', async () => {
    const server = setUp();
    await openDrawer();
    fireEvent.click(screen.getByTestId('diagnosis-start'));
    await screen.findByTestId('diagnosis-run');

    fireEvent.keyDown(document.body, { key: 'Escape' });
    await waitFor(() => expect(screen.queryByTestId('investigate-sheet')).toBeNull());
    // The header keeps saying so while it runs.
    expect(await screen.findByTestId('open-investigate')).toHaveTextContent(/investigating/i);

    await openDrawer();
    expect(await screen.findByTestId('diagnosis-run')).toBeInTheDocument();
    expect(screen.queryByTestId('diagnosis-confirm')).toBeNull();
    expect(server.posts).toBe(1);
  });

  it('shows a failed run as failed, never as a clean result', async () => {
    setUp([run({ status: 'error', error: 'The engine did not answer.', finishedAtMs: 2 })]);
    await openDrawer();

    expect(await screen.findByTestId('diagnosis-error')).toHaveTextContent(
      'The engine did not answer.',
    );
    expect(screen.queryByTestId('diagnosis-verdict')).toBeNull();
  });

  it('links a finding to the exact field that armed it', async () => {
    const report: ProfileDiagnosis = {
      asOfMs: 1_700_000_100_000,
      verdict: 'blocked',
      headline: 'Nothing clears the trend filter.',
      steps: initialDiagnosisSteps(),
      items: [
        {
          id: 'trend-confirm',
          condition: 'candidate-funnel',
          code: 'trend',
          severity: 'blocking',
          title: 'Every candidate dies at the trend check',
          detail: null,
          sinceMs: 1_700_000_000_000,
          evidence: ['10 of 10 candidates failed at trend'],
          symbols: [],
          lever: {
            label: 'Volume multiple',
            path: 'trendConfirm.volMultiple',
            value: '2.5',
            surface: 'discovery',
          },
        },
      ],
      funnel: null,
      timeline: [],
    };
    setUp([run({ status: 'done', report, finishedAtMs: 1_700_000_100_000 })]);
    await openDrawer();

    const link = await screen.findByTestId('diagnosis-lever-trendConfirm.volMultiple');
    // Asserted on the href, not the label: the deep link is the contract, and a
    // renamed field must not be able to pass this while pointing nowhere.
    expect(link).toHaveAttribute(
      'href',
      `/accounts/${ACCOUNT_ID}/profiles/${PID}/discovery?focus=trendConfirm.volMultiple`,
    );
    expect(screen.getByTestId('diagnosis-verdict')).toHaveAttribute('data-verdict', 'blocked');
    // The duration is measured from the report, so it reads the same on a reload.
    expect(screen.getByTestId('diagnosis-item-since')).toHaveTextContent('for 1m');
  });
});
