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
import userEvent from '@testing-library/user-event';
import { afterEach, describe, expect, it, vi } from 'vitest';

import { ONBOARDING_STATUS_QUERY_KEY } from '@/features/auth/api/auth';
import { diagnosisRunsQueryKey } from '@/features/profile/api/diagnosis';
import { createQueryClient } from '@/shared/lib/query-client';
import { ProfileManageSheet } from '@/features/profile/components/profile-manage-sheet';

import type { DashboardAggregateResponse } from '@app/contracts';

vi.mock('sonner', () => ({ toast: { error: vi.fn(), success: vi.fn() } }));

const PID = '00000000-0000-4000-8000-0000000000c1';

const aggregate = (): DashboardAggregateResponse => ({
  profiles: [
    {
      profileId: PID,
      name: 'btc-real',
      enabled: true,
      binanceMode: 'live',
      quoteAsset: 'USDT',
      lastTickAt: null,
      lastTickLatencyMs: null,
      apiKeyConfigured: true,
      lastTickError: null,
      killSwitch: false,
      openOrderCount: 0,
      openOrders: [],
      openPositionCount: 0,
      positions: [],
    },
  ],
});

const setUp = (demoMode = false): void => {
  const qc = createQueryClient();
  qc.setQueryData(['dashboard-aggregate'], aggregate());
  // Where `useDemoMode` reads from; seeded rather than fetched, the query being staleTime-Infinity.
  qc.setQueryData(ONBOARDING_STATUS_QUERY_KEY, { masterExists: true, demoMode });
  // The investigation drawer stays mounted (closed) alongside the manage sheet
  // and rehydrates the newest run; an empty history keeps it off the network and
  // on the confirm step.
  qc.setQueryData(diagnosisRunsQueryKey(PID), []);
  const root = createRootRoute({
    component: () => (
      <>
        <ProfileManageSheet profileId={PID} />
        <Outlet />
      </>
    ),
  });
  const router = createRouter({
    routeTree: root.addChildren([
      createRoute({ getParentRoute: () => root, path: '/', component: () => null }),
    ]),
    context: { queryClient: qc },
    history: createMemoryHistory({ initialEntries: ['/'] }),
  });
  render(
    <QueryClientProvider client={qc}>
      <RouterProvider
        router={router as unknown as Parameters<typeof RouterProvider>[0]['router']}
      />
    </QueryClientProvider>,
  );
};

describe('ProfileManageSheet', () => {
  afterEach(() => vi.restoreAllMocks());

  it('keeps the action set off the page until the slide-over is opened', async () => {
    setUp();
    expect(await screen.findByTestId('open-manage-sheet')).toBeInTheDocument();
    // Radix only mounts the sheet content when open, so the card is absent first.
    expect(screen.queryByTestId('manage-sheet')).toBeNull();

    await userEvent.click(screen.getByTestId('open-manage-sheet'));

    expect(await screen.findByTestId('manage-sheet')).toBeInTheDocument();
    expect(screen.getByRole('heading', { name: 'Manage profile' })).toBeInTheDocument();
  });

  it('hands over to the investigation drawer without ever stacking two dialogs', async () => {
    // Both drawers are Radix modal dialogs. Rendering the second inside the
    // first leaves two focus traps on one document and a `pointer-events: none`
    // that the inner dialog's unmount does not clear, which locks the page.
    setUp();
    await userEvent.click(await screen.findByTestId('open-manage-sheet'));
    await screen.findByTestId('manage-sheet');

    await userEvent.click(screen.getByTestId('profile-manage-investigate'));

    expect(await screen.findByTestId('investigate-sheet')).toBeInTheDocument();
    expect(screen.queryByTestId('manage-sheet')).toBeNull();
    // The whole invariant in one number. `pointer-events: none` on the body is
    // NOT checked here: Radix sets it for any open modal, so it is the correct
    // state mid-handover; what matters is that it is released on close, which
    // the next test asserts.
    expect(screen.getAllByRole('dialog')).toHaveLength(1);
  });

  it('hands over a drawer with no start control in the live demo', async () => {
    // The second entry point into the same drawer. Both are asserted because the demo guard belongs to the drawer, not to whichever caller opened it, and only one of the two is covered by investigate-button.test.tsx.
    setUp(true);
    await userEvent.click(await screen.findByTestId('open-manage-sheet'));
    await userEvent.click(await screen.findByTestId('profile-manage-investigate'));

    expect(await screen.findByTestId('investigate-sheet')).toBeInTheDocument();
    // Text, not presence: a missing i18n key renders as the key itself and would satisfy a node-only check.
    expect(await screen.findByTestId('investigate-demo-unavailable')).toHaveTextContent(
      /turned off in the live demo/,
    );
    expect(screen.queryByTestId('diagnosis-start')).toBeNull();
  });

  it('returns the page to the operator when the investigation drawer closes', async () => {
    // The handover must not leave the page unusable: closing the second drawer
    // has to release the body, not hand back the first drawer's locked state.
    setUp();
    await userEvent.click(await screen.findByTestId('open-manage-sheet'));
    await userEvent.click(await screen.findByTestId('profile-manage-investigate'));
    await screen.findByTestId('investigate-sheet');

    fireEvent.keyDown(document.body, { key: 'Escape' });

    await waitFor(() => expect(screen.queryByTestId('investigate-sheet')).toBeNull());
    expect(screen.queryAllByRole('dialog')).toHaveLength(0);
    await waitFor(() => expect(document.body.style.pointerEvents).not.toBe('none'));
  });
});
