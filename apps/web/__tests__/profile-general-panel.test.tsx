// ProfileGeneralPanel — the profile's General settings page body: inline name and
// quote edits, enable/stop confirm dialogs, and the destructive delete with
// its 409 force path. These behaviours moved here from the Manage card; the tests
// moved with them. The embedded ApiKeyPanel has its own test and is stubbed out.

import { QueryClientProvider, type QueryClient } from '@tanstack/react-query';
import {
  createMemoryHistory,
  createRootRoute,
  createRoute,
  createRouter,
  Outlet,
  RouterProvider,
} from '@tanstack/react-router';
import { render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { toast } from 'sonner';

import { ApiError } from '@/shared/lib/api';
import { createQueryClient } from '@/shared/lib/query-client';
import * as profileApi from '@/features/profile/api/profile-dashboard';
import * as profilesMutations from '@/features/profile/api/profiles-mutations';
import { ProfileGeneralPanel } from '@/features/profile/components/profile-general-panel';

import type { DashboardAggregateResponse } from '@app/contracts';

vi.mock('sonner', () => ({ toast: { error: vi.fn(), success: vi.fn() } }));
// The API-key form has its own test; stub it so this suite stays on the
// lifecycle/admin controls and makes no network call.
vi.mock('@/features/profile/components/api-key-panel', () => ({
  ApiKeyPanel: () => <div data-testid="api-key-panel-stub" />,
}));

const PID = '00000000-0000-4000-8000-0000000000c1';
// Matches the global test-setup default active account; the aggregate cache is
// keyed by it, so the panel reads the same key it would at runtime.
const ACCOUNT_ID = '00000000-0000-4000-8000-0000000000ac';

const aggregate = (
  overrides: Partial<DashboardAggregateResponse['profiles'][number]> = {},
): DashboardAggregateResponse => ({
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
      ...overrides,
    },
  ],
});

const SIBLING_PID = '00000000-0000-4000-8000-0000000000c2';
let dashboardAggregate = aggregate({});

// Adds a second profile under the same account so the delete dialog has a
// handoff target to offer. The sibling itself carries no exposure.
const withSibling = (agg: DashboardAggregateResponse): DashboardAggregateResponse => ({
  profiles: [
    ...agg.profiles,
    {
      ...agg.profiles[0]!,
      profileId: SIBLING_PID,
      name: 'eth-real',
      openOrderCount: 0,
      openPositionCount: 0,
    },
  ],
});

const setUp = (agg: DashboardAggregateResponse): QueryClient => {
  dashboardAggregate = agg;
  const qc = createQueryClient();
  qc.setQueryData(['dashboard-aggregate', ACCOUNT_ID], agg);
  const root = createRootRoute({
    component: () => (
      <>
        <ProfileGeneralPanel profileId={PID} />
        <Outlet />
      </>
    ),
  });
  const router = createRouter({
    routeTree: root.addChildren([
      createRoute({
        getParentRoute: () => root,
        path: '/',
        component: () => <output data-testid="route-index" />,
      }),
    ]),
    history: createMemoryHistory({ initialEntries: ['/'] }),
  });
  render(
    <QueryClientProvider client={qc}>
      <RouterProvider
        router={router as unknown as Parameters<typeof RouterProvider>[0]['router']}
      />
    </QueryClientProvider>,
  );
  return qc;
};

const deferTargetedInvalidation = (queryClient: QueryClient) => {
  let resolve!: () => void;
  let reject!: (error: Error) => void;
  const promise = new Promise<void>((resolvePromise, rejectPromise) => {
    resolve = resolvePromise;
    reject = rejectPromise;
  });
  const invalidate = vi
    .spyOn(queryClient, 'invalidateQueries')
    .mockImplementation((filters) => (filters?.queryKey ? promise : Promise.resolve()));
  return { invalidate, resolve, reject };
};

describe('<ProfileGeneralPanel>', () => {
  beforeEach(() => {
    dashboardAggregate = { profiles: [] };
    vi.stubGlobal(
      'fetch',
      vi.fn(async (input: RequestInfo | URL) => {
        const url = String(input);
        if (url.endsWith('/dashboard-aggregate')) {
          return new Response(JSON.stringify(dashboardAggregate), {
            status: 200,
            headers: { 'content-type': 'application/json' },
          });
        }
        throw new Error(`unexpected profile-general-panel request: ${url}`);
      }),
    );
  });
  afterEach(() => vi.restoreAllMocks());

  it('renames the profile inline, PATCHes the new name, and toasts success', async () => {
    const patch = vi.spyOn(profilesMutations, 'patchProfile').mockResolvedValue({} as never);
    vi.mocked(toast.success).mockClear();
    setUp(aggregate({ name: 'btc-real' }));
    await screen.findByTestId('profile-general-panel');

    const input = screen.getByTestId('profile-general-name-input');
    expect(input).toHaveValue('btc-real');
    // Save is disabled until the name actually changes.
    expect(screen.getByTestId('profile-general-name-save')).toBeDisabled();
    await userEvent.clear(input);
    await userEvent.type(input, 'btc-live');
    await userEvent.click(screen.getByTestId('profile-general-name-save'));

    await waitFor(() => expect(patch).toHaveBeenCalledWith(PID, { name: 'btc-live' }));
    await waitFor(() => expect(toast.success).toHaveBeenCalledWith('Saved.'));
  });

  it('changes the quote currency inline, PATCHes it uppercased, and toasts success', async () => {
    const patch = vi.spyOn(profilesMutations, 'patchProfile').mockResolvedValue({} as never);
    vi.mocked(toast.success).mockClear();
    setUp(aggregate({ quoteAsset: 'USDT' }));
    await screen.findByTestId('profile-general-panel');

    const input = screen.getByTestId('profile-general-quote-input');
    expect(input).toHaveValue('USDT');
    await userEvent.clear(input);
    await userEvent.type(input, 'btc');
    await userEvent.click(screen.getByTestId('profile-general-quote-save'));

    await waitFor(() => expect(patch).toHaveBeenCalledWith(PID, { quoteAsset: 'BTC' }));
    await waitFor(() => expect(toast.success).toHaveBeenCalledWith('Saved.'));
  });

  it('toasts a successful rename before its targeted invalidation settles', async () => {
    const patch = vi.spyOn(profilesMutations, 'patchProfile').mockResolvedValue({} as never);
    vi.mocked(toast.success).mockClear();
    const queryClient = setUp(aggregate({ name: 'btc-real' }));
    const invalidation = deferTargetedInvalidation(queryClient);
    await screen.findByTestId('profile-general-panel');

    const input = screen.getByTestId('profile-general-name-input');
    await userEvent.clear(input);
    await userEvent.type(input, 'btc-live');
    const save = screen.getByTestId('profile-general-name-save');
    await userEvent.click(save);

    await waitFor(() =>
      expect(invalidation.invalidate).toHaveBeenCalledWith({
        queryKey: ['dashboard-aggregate', ACCOUNT_ID],
      }),
    );
    try {
      expect(toast.success).toHaveBeenCalledWith('Saved.');
      expect(save).toBeDisabled();
      expect(save).toHaveTextContent('Working…');
      await userEvent.click(save);
      expect(patch).toHaveBeenCalledTimes(1);
    } finally {
      queryClient.setQueryData(
        ['dashboard-aggregate', ACCOUNT_ID],
        aggregate({ name: 'btc-live' }),
      );
      invalidation.resolve();
    }
    await waitFor(() => expect(save).toHaveTextContent('Save'));
    expect(save).toBeDisabled();
  });

  it('toasts an uppercased quote save before invalidation and keeps its rejection awaited', async () => {
    const patch = vi.spyOn(profilesMutations, 'patchProfile').mockResolvedValue({} as never);
    vi.mocked(toast.error).mockClear();
    vi.mocked(toast.success).mockClear();
    const queryClient = setUp(aggregate({ quoteAsset: 'USDT' }));
    const invalidation = deferTargetedInvalidation(queryClient);
    await screen.findByTestId('profile-general-panel');

    const input = screen.getByTestId('profile-general-quote-input');
    await userEvent.clear(input);
    await userEvent.type(input, 'btc');
    const save = screen.getByTestId('profile-general-quote-save');
    await userEvent.click(save);

    await waitFor(() => expect(patch).toHaveBeenCalledWith(PID, { quoteAsset: 'BTC' }));
    await waitFor(() =>
      expect(invalidation.invalidate).toHaveBeenCalledWith({
        queryKey: profileApi.profileDashboardQueryKey(PID),
      }),
    );
    expect(toast.success).toHaveBeenCalledWith('Saved.');
    expect(save).toBeDisabled();
    invalidation.reject(new Error('refresh failed'));
    await waitFor(() => expect(toast.error).toHaveBeenCalledWith('refresh failed'));
  });

  it('renders no settings body until the aggregate row resolves', () => {
    // Empty cache — no setQueryData. The panel must not render its body (it shows
    // a brief Loading line, then nothing if the profile is absent).
    const qc = createQueryClient();
    render(
      <QueryClientProvider client={qc}>
        <ProfileGeneralPanel profileId={PID} />
      </QueryClientProvider>,
    );
    expect(screen.queryByTestId('profile-general-panel')).toBeNull();
  });

  it('stops this profile through the confirm dialog (per-profile kill)', async () => {
    const enable = vi.spyOn(profileApi, 'enableKillSwitch').mockResolvedValue(undefined);
    setUp(aggregate({ killSwitch: false }));
    await screen.findByTestId('profile-general-panel');

    await userEvent.click(screen.getByTestId('profile-general-kill'));
    expect(await screen.findByTestId('profile-general-kill-dialog')).toBeInTheDocument();
    expect(enable).not.toHaveBeenCalled();
    await userEvent.click(screen.getByTestId('profile-general-kill-confirm'));
    await waitFor(() => expect(enable).toHaveBeenCalledWith(PID));
  });

  it('resumes this profile when its kill switch is already engaged', async () => {
    const disable = vi.spyOn(profileApi, 'disableKillSwitch').mockResolvedValue(undefined);
    setUp(aggregate({ killSwitch: true }));
    await screen.findByTestId('profile-general-panel');

    await userEvent.click(screen.getByTestId('profile-general-kill'));
    await userEvent.click(await screen.findByTestId('profile-general-kill-confirm'));
    await waitFor(() => expect(disable).toHaveBeenCalledWith(PID));
  });

  it('enables a disabled profile through the confirm dialog (POST /start)', async () => {
    const start = vi.spyOn(profilesMutations, 'startProfile').mockResolvedValue(undefined);
    setUp(aggregate({ enabled: false }));
    await screen.findByTestId('profile-general-panel');

    await userEvent.click(screen.getByTestId('profile-general-enable'));
    expect(await screen.findByTestId('profile-general-enable-dialog')).toBeInTheDocument();
    expect(start).not.toHaveBeenCalled();
    await userEvent.click(screen.getByTestId('profile-general-enable-confirm'));
    await waitFor(() => expect(start).toHaveBeenCalledWith(PID));
  });

  it('disables an enabled profile through the confirm dialog (POST /stop)', async () => {
    const stop = vi.spyOn(profilesMutations, 'stopProfile').mockResolvedValue(undefined);
    setUp(aggregate({ enabled: true }));
    await screen.findByTestId('profile-general-panel');

    await userEvent.click(screen.getByTestId('profile-general-enable'));
    await userEvent.click(await screen.findByTestId('profile-general-enable-confirm'));
    await waitFor(() => expect(stop).toHaveBeenCalledWith(PID));
  });

  it('surfaces a toast and closes the dialog when enabling rejects', async () => {
    vi.spyOn(profilesMutations, 'startProfile').mockRejectedValue(new Error('nope'));
    vi.mocked(toast.error).mockClear();
    setUp(aggregate({ enabled: false }));
    await screen.findByTestId('profile-general-panel');

    await userEvent.click(screen.getByTestId('profile-general-enable'));
    await userEvent.click(await screen.findByTestId('profile-general-enable-confirm'));
    await waitFor(() => expect(toast.error).toHaveBeenCalledWith('nope'));
    await waitFor(() => expect(screen.queryByTestId('profile-general-enable-dialog')).toBeNull());
  });

  it('closes the dialog and toasts the gate block when the edge gate rejects', async () => {
    const msg =
      'Cannot go live yet: the backtest does not clear the edge gate — profit factor 0.32 (need >= 1.1).';
    vi.spyOn(profilesMutations, 'startProfile').mockRejectedValue(
      new ApiError(409, 'CONFLICT', msg, { reason: 'edge-gate', failure: 'thresholds' }),
    );
    vi.mocked(toast.error).mockClear();
    setUp(aggregate({ enabled: false }));
    await screen.findByTestId('profile-general-panel');

    await userEvent.click(screen.getByTestId('profile-general-enable'));
    await userEvent.click(await screen.findByTestId('profile-general-enable-confirm'));

    await waitFor(() => expect(toast.error).toHaveBeenCalledWith(msg));
    await waitFor(() =>
      expect(screen.queryByTestId('profile-general-enable-dialog')).not.toBeInTheDocument(),
    );
  });

  it('surfaces a toast and closes the dialog when the per-profile kill rejects', async () => {
    vi.spyOn(profileApi, 'enableKillSwitch').mockRejectedValue(new Error('boom'));
    vi.mocked(toast.error).mockClear();
    setUp(aggregate({ killSwitch: false }));
    await screen.findByTestId('profile-general-panel');

    await userEvent.click(screen.getByTestId('profile-general-kill'));
    await userEvent.click(await screen.findByTestId('profile-general-kill-confirm'));
    await waitFor(() => expect(toast.error).toHaveBeenCalledWith('boom'));
    await waitFor(() => expect(screen.queryByTestId('profile-general-kill-dialog')).toBeNull());
  });

  it('deletes the profile via the confirm dialog (names the profile, no disposition needed)', async () => {
    const del = vi.spyOn(profilesMutations, 'deleteProfile').mockResolvedValue(undefined);
    setUp(aggregate({ name: 'btc-real' }));
    await screen.findByTestId('profile-general-panel');

    await userEvent.click(screen.getByTestId('profile-general-delete'));
    const dialog = await screen.findByTestId('profile-general-delete-dialog');
    expect(dialog).toHaveTextContent('btc-real');
    expect(del).not.toHaveBeenCalled();
    await userEvent.click(screen.getByTestId('profile-general-delete-confirm'));

    // No disposition: a profile with no exposure has nothing to dispose of.
    await waitFor(() => expect(del).toHaveBeenCalledWith(PID, undefined));
    await waitFor(() => expect(screen.queryByTestId('profile-general-delete-dialog')).toBeNull());
  });

  it('surfaces a toast and closes the dialog on a non-conflict delete error', async () => {
    vi.spyOn(profilesMutations, 'deleteProfile').mockRejectedValue(new Error('nope'));
    vi.mocked(toast.error).mockClear();
    setUp(aggregate());
    await screen.findByTestId('profile-general-panel');

    await userEvent.click(screen.getByTestId('profile-general-delete'));
    await userEvent.click(await screen.findByTestId('profile-general-delete-confirm'));

    await waitFor(() => expect(toast.error).toHaveBeenCalled());
    await waitFor(() => expect(screen.queryByTestId('profile-general-delete-dialog')).toBeNull());
  });

  // INTENTIONAL BEHAVIOUR CHANGE: the second click used to FORCE the delete,
  // abandoning the resting orders on Binance. It now asks the worker to cancel
  // them first — there is no force button left to click.
  it('on a 409 shows the open counts and disposes of the orders on the second click', async () => {
    const del = vi
      .spyOn(profilesMutations, 'deleteProfile')
      .mockRejectedValueOnce(
        new ApiError(409, 'CONFLICT', 'still open', { openOrderCount: 2, openPositionCount: 1 }),
      )
      .mockResolvedValueOnce(undefined);
    setUp(aggregate());
    await screen.findByTestId('profile-general-panel');

    await userEvent.click(screen.getByTestId('profile-general-delete'));
    await userEvent.click(await screen.findByTestId('profile-general-delete-confirm'));

    const dispose = await screen.findByTestId('profile-general-delete-dispose');
    expect(screen.queryByTestId('profile-general-delete-force')).toBeNull();
    const dialog = screen.getByTestId('profile-general-delete-dialog');
    expect(dialog).toHaveTextContent('2');
    expect(dialog).toHaveTextContent('1');
    expect(del).toHaveBeenCalledWith(PID, undefined);

    await userEvent.click(dispose);
    await waitFor(() => expect(del).toHaveBeenCalledWith(PID, 'cancel-orders'));
  });

  it('hands the position off to another profile when handoff is chosen on a 409', async () => {
    const del = vi
      .spyOn(profilesMutations, 'deleteProfile')
      .mockRejectedValueOnce(
        new ApiError(409, 'CONFLICT', 'still open', { openOrderCount: 2, openPositionCount: 1 }),
      )
      .mockResolvedValueOnce(undefined);
    setUp(withSibling(aggregate()));
    await screen.findByTestId('profile-general-panel');

    await userEvent.click(screen.getByTestId('profile-general-delete'));
    await userEvent.click(await screen.findByTestId('profile-general-delete-confirm'));

    // Escalated to the exposure step; pick handoff and a target profile.
    await userEvent.click(await screen.findByTestId('profile-general-delete-disposition-handoff'));
    await userEvent.selectOptions(
      screen.getByTestId('profile-general-delete-handoff-target'),
      SIBLING_PID,
    );
    await userEvent.click(screen.getByTestId('profile-general-delete-dispose'));

    await waitFor(() => expect(del).toHaveBeenCalledWith(PID, 'handoff', SIBLING_PID));
  });

  it('keeps the dispose button disabled on handoff until a target is picked', async () => {
    vi.spyOn(profilesMutations, 'deleteProfile').mockRejectedValueOnce(
      new ApiError(409, 'CONFLICT', 'still open', { openOrderCount: 1, openPositionCount: 0 }),
    );
    setUp(withSibling(aggregate()));
    await screen.findByTestId('profile-general-panel');

    await userEvent.click(screen.getByTestId('profile-general-delete'));
    await userEvent.click(await screen.findByTestId('profile-general-delete-confirm'));

    await userEvent.click(await screen.findByTestId('profile-general-delete-disposition-handoff'));
    expect(screen.getByTestId('profile-general-delete-dispose')).toBeDisabled();

    await userEvent.selectOptions(
      screen.getByTestId('profile-general-delete-handoff-target'),
      SIBLING_PID,
    );
    expect(screen.getByTestId('profile-general-delete-dispose')).toBeEnabled();
  });

  it('offers only cancel-orders when there is no other profile to hand off to', async () => {
    vi.spyOn(profilesMutations, 'deleteProfile').mockRejectedValueOnce(
      new ApiError(409, 'CONFLICT', 'still open', { openOrderCount: 1, openPositionCount: 0 }),
    );
    // Single-profile aggregate: no sibling, so handoff is impossible.
    setUp(aggregate());
    await screen.findByTestId('profile-general-panel');

    await userEvent.click(screen.getByTestId('profile-general-delete'));
    await userEvent.click(await screen.findByTestId('profile-general-delete-confirm'));

    await screen.findByTestId('profile-general-delete-dispose');
    expect(screen.queryByTestId('profile-general-delete-disposition-handoff')).toBeNull();
    expect(screen.getByTestId('profile-general-delete-dispose')).toBeEnabled();
  });

  it('disables the confirm button while the delete is in flight', async () => {
    let resolveDelete: () => void = () => undefined;
    vi.spyOn(profilesMutations, 'deleteProfile').mockReturnValue(
      new Promise<void>((resolve) => {
        resolveDelete = resolve;
      }),
    );
    setUp(aggregate());
    await screen.findByTestId('profile-general-panel');

    await userEvent.click(screen.getByTestId('profile-general-delete'));
    await userEvent.click(await screen.findByTestId('profile-general-delete-confirm'));

    await waitFor(() =>
      expect(screen.getByTestId('profile-general-delete-confirm')).toBeDisabled(),
    );

    resolveDelete();
    await waitFor(() => expect(screen.queryByTestId('profile-general-delete-dialog')).toBeNull());
  });
});
