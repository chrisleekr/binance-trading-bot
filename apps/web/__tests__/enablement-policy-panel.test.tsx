import { QueryClientProvider } from '@tanstack/react-query';
import { render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { toast } from 'sonner';
import { describe, expect, it, vi, afterEach } from 'vitest';

import { DEFAULT_ENABLEMENT_POLICY, type ProfileResponse } from '@app/contracts';
import * as profileApi from '@/features/profile/api/profile';
import { EnablementPolicyPanel } from '@/features/profile/components/enablement-policy-panel';
import { createQueryClient } from '@/shared/lib/query-client';

vi.mock('sonner', () => ({ toast: { error: vi.fn(), success: vi.fn() } }));

const PID = '00000000-0000-4000-8000-0000000000c1';

const profile = (policy = DEFAULT_ENABLEMENT_POLICY): ProfileResponse =>
  ({
    id: PID,
    accountId: '00000000-0000-4000-8000-000000000002',
    name: 'p',
    strategyName: 'trailing-trade',
    strategyVersion: '2.0.0',
    config: {},
    enabled: false,
    binanceMode: 'live',
    quoteAsset: 'USDT',
    benchmarkMode: 'btc',
    baselineBacktestRunId: null,
    enablementPolicy: policy,
    createdAt: '2026-06-20T00:00:00.000Z',
    updatedAt: '2026-06-20T00:00:00.000Z',
  }) as ProfileResponse;

const renderPanel = (): void => {
  const qc = createQueryClient();
  render(
    <QueryClientProvider client={qc}>
      <EnablementPolicyPanel profileId={PID} />
    </QueryClientProvider>,
  );
};

const expandAdvanced = async (): Promise<void> => {
  await userEvent.click(await screen.findByTestId('gate-advanced-toggle'));
};

afterEach(() => vi.restoreAllMocks());

describe('<EnablementPolicyPanel>', () => {
  it('shows the essentials but keeps advanced thresholds collapsed until expanded', async () => {
    vi.spyOn(profileApi, 'fetchProfile').mockResolvedValue(profile());
    renderPanel();

    // Essentials render immediately.
    expect(await screen.findByLabelText('Min profit factor')).toBeInTheDocument();
    // Advanced fields stay mounted inside the collapsed <details> (so the form
    // state and validation still see them) but are hidden until expanded.
    expect(screen.getByLabelText('Min closed trades')).not.toBeVisible();
    expect(screen.getByTestId('monitor-mode-warn')).not.toBeVisible();

    await expandAdvanced();
    expect(screen.getByLabelText('Min closed trades')).toBeVisible();
    expect(screen.getByTestId('monitor-mode-warn')).toBeVisible();
  });

  it('seeds fields from the profile policy and saves an edited advanced threshold', async () => {
    vi.spyOn(profileApi, 'fetchProfile').mockResolvedValue(profile());
    const patch = vi.spyOn(profileApi, 'patchProfile').mockResolvedValue(profile());
    renderPanel();

    await screen.findByLabelText('Min profit factor');
    await expandAdvanced();
    const trades = screen.getByLabelText('Min closed trades');
    expect(trades).toHaveValue(100);

    await userEvent.clear(trades);
    await userEvent.type(trades, '50');
    await userEvent.click(screen.getByTestId('enablement-policy-save'));

    await waitFor(() =>
      expect(patch).toHaveBeenCalledWith(PID, {
        enablementPolicy: { ...DEFAULT_ENABLEMENT_POLICY, minTrades: 50 },
      }),
    );
    await waitFor(() => expect(toast.success).toHaveBeenCalledWith('Live gate saved.'));
  });

  it('switches the edge-decay monitor mode and saves it', async () => {
    vi.spyOn(profileApi, 'fetchProfile').mockResolvedValue(profile());
    const patch = vi.spyOn(profileApi, 'patchProfile').mockResolvedValue(profile());
    renderPanel();

    await screen.findByLabelText('Min profit factor');
    await expandAdvanced();
    await userEvent.click(screen.getByTestId('monitor-mode-off'));
    await userEvent.click(screen.getByTestId('enablement-policy-save'));

    await waitFor(() =>
      expect(patch).toHaveBeenCalledWith(PID, {
        enablementPolicy: {
          ...DEFAULT_ENABLEMENT_POLICY,
          monitor: { ...DEFAULT_ENABLEMENT_POLICY.monitor, mode: 'off' },
        },
      }),
    );
  });

  it('hides the out-of-sample trade floor when the check is turned off, and saves it off', async () => {
    vi.spyOn(profileApi, 'fetchProfile').mockResolvedValue(profile());
    const patch = vi.spyOn(profileApi, 'patchProfile').mockResolvedValue(profile());
    renderPanel();

    await screen.findByLabelText('Min profit factor');
    await expandAdvanced();
    // Seeded on (default), so the floor field is visible.
    expect(screen.getByLabelText('Min out-of-sample trades')).toBeInTheDocument();
    await userEvent.click(screen.getByLabelText('Require out-of-sample validation'));
    expect(screen.queryByLabelText('Min out-of-sample trades')).not.toBeInTheDocument();

    await userEvent.click(screen.getByTestId('enablement-policy-save'));
    await waitFor(() =>
      expect(patch).toHaveBeenCalledWith(PID, {
        enablementPolicy: { ...DEFAULT_ENABLEMENT_POLICY, requireOutOfSample: false },
      }),
    );
  });

  it('hides the monitor thresholds when the monitor is off', async () => {
    vi.spyOn(profileApi, 'fetchProfile').mockResolvedValue(profile());
    renderPanel();

    await screen.findByLabelText('Min profit factor');
    await expandAdvanced();
    await userEvent.click(screen.getByTestId('monitor-mode-off'));
    expect(screen.queryByLabelText('Min live trades')).not.toBeInTheDocument();
  });

  it('toasts and does not close when the save fails', async () => {
    vi.spyOn(profileApi, 'fetchProfile').mockResolvedValue(profile());
    vi.spyOn(profileApi, 'patchProfile').mockRejectedValue(new Error('save boom'));
    vi.mocked(toast.error).mockClear();
    renderPanel();

    await screen.findByLabelText('Min profit factor');
    await userEvent.click(screen.getByTestId('enablement-policy-save'));

    await waitFor(() => expect(toast.error).toHaveBeenCalledWith('save boom'));
    // The panel stays put — no navigation/close on failure.
    expect(screen.getByTestId('enablement-policy-panel')).toBeInTheDocument();
  });
});
