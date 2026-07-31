// ProfileStatus — the per-profile status pill (enabled/disabled) and
// notifier-gap dot shown inline in the scoped overview's PROFILE heading.
// This behaviour moved here from the deleted top-bar ProfileControls.

import { QueryClientProvider } from '@tanstack/react-query';
import { render, screen } from '@testing-library/react';
import { afterEach, describe, expect, it } from 'vitest';

import { createQueryClient } from '@/shared/lib/query-client';
import { ProfileStatus } from '@/features/profile/components/profile-status';
import { profileDashboardQueryKey } from '@/features/profile/api/profile-dashboard';

import type { DashboardAggregateResponse } from '@app/contracts';

const PID = '00000000-0000-4000-8000-0000000000c1';
// Matches the global test-setup default active account; the aggregate cache is
// keyed by it, so ProfileStatus reads the same key it would at runtime.
const ACCOUNT_ID = '00000000-0000-4000-8000-0000000000ac';

const row = (
  overrides: Partial<DashboardAggregateResponse['profiles'][number]> = {},
): DashboardAggregateResponse['profiles'][number] => ({
  profileId: PID,
  name: 'Real',
  enabled: true,
  binanceMode: 'live',
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
});

const renderStatus = (
  rowOverrides: Partial<DashboardAggregateResponse['profiles'][number]>,
  notifierCount: number,
  withRow = true,
): void => {
  const qc = createQueryClient();
  qc.setQueryData(['dashboard-aggregate', ACCOUNT_ID], {
    profiles: withRow ? [row(rowOverrides)] : [],
  });
  qc.setQueryData(profileDashboardQueryKey(PID), {
    profileId: PID,
    enabled: true,
    binanceMode: 'live',
    balances: [],
    totalProfit: '0',
    enabledNotifierCount: notifierCount,
    symbols: [],
    cachedAt: '2026-06-04T00:00:00.000Z',
  });
  render(
    <QueryClientProvider client={qc}>
      <ProfileStatus profileId={PID} />
    </QueryClientProvider>,
  );
};

afterEach(() => {
  window.localStorage.clear();
});

describe('<ProfileStatus>', () => {
  it('shows the enabled pill', async () => {
    renderStatus({}, 1);
    expect(await screen.findByTestId('profile-status-state')).toHaveTextContent(/Enabled/i);
  });

  it('shows the notifier-gap dot on a live profile with zero enabled notifiers', async () => {
    renderStatus({ binanceMode: 'live' }, 0);
    expect(await screen.findByTestId('profile-status-notifier-gap')).toBeInTheDocument();
  });

  it('hides the notifier-gap dot when a notifier is enabled', async () => {
    renderStatus({ binanceMode: 'live' }, 2);
    await screen.findByTestId('profile-status-state');
    expect(screen.queryByTestId('profile-status-notifier-gap')).toBeNull();
  });

  it('renders nothing when the profile row has not loaded', () => {
    renderStatus({}, 1, false);
    expect(screen.queryByTestId('profile-status')).toBeNull();
  });
});
