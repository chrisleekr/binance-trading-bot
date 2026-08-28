import { QueryClientProvider } from '@tanstack/react-query';
import { render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { afterEach, describe, expect, it, vi } from 'vitest';

import { createQueryClient } from '@/shared/lib/query-client';
import { profileDashboardQueryKey } from '@/features/profile/api/profile-dashboard';
import { RiskPanel } from '@/features/profile/components/risk-panel';

const json = (body: unknown, status = 200): Response =>
  new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } });

interface Status {
  halted: boolean;
  todayRealizedPnl: string;
  limitQuote: string | null;
  resetsAtMs: number | null;
}
const dashboard = (status: Status, configInvalid = false, quoteAsset = 'USDT') => ({
  config: { dailyLossLimitQuote: status.limitQuote ?? '0' },
  configInvalid,
  quoteAsset,
  status,
});

/**
 * The profile-dashboard payload the panel reads equity from: quote cash (free + locked of the profile's own quote asset) plus the account-wide deployed cost basis. Mirrors the derivation the config panel already uses.
 *
 * @param quoteAsset - The profile's quote asset, which selects which balance row counts as cash.
 * @param free - Free balance of that quote asset, as a decimal string.
 * @param deployedQuote - Account-wide deployed cost basis in that quote asset, as a decimal string.
 * @param balances - Full balance set, overriding the single quote row built from `free`. Pass `[]` for a lapsed snapshot (nothing is known) and a set with no quote row for a genuine zero quote balance — the writer overwrites the whole set, so absence from a present snapshot is evidence, not ignorance.
 * @returns A minimal ProfileDashboardResponse-shaped object suitable for seeding the query cache.
 */
const profileDashboard = (
  quoteAsset: string,
  free: string,
  deployedQuote: string,
  balances?: readonly { asset: string; free: string; locked: string }[],
) => ({
  profileId: 'p1',
  enabled: true,
  binanceMode: 'test' as const,
  quoteAsset,
  balances: balances ?? [{ asset: quoteAsset, free, locked: '0' }],
  deployedQuote,
  totalProfit: '0',
  enabledNotifierCount: 0,
  symbols: [],
  cachedAt: '2026-06-19T00:00:00.000Z',
});

/**
 * Mount the panel over a stubbed risk-dashboard read.
 *
 * @param body - The risk-dashboard payload every fetch resolves to.
 * @param equity - Optional profile-dashboard payload seeded into the cache; omit it to model the equity-unknown case (a cold cache), which must not be read as evidence the limit is unreachable.
 * @returns The stubbed `fetch`, so a test can assert on the requests the panel made.
 */
const setUp = (
  body: unknown,
  equity?: ReturnType<typeof profileDashboard>,
): { fetchMock: ReturnType<typeof vi.fn> } => {
  const fetchMock = vi.fn(() => Promise.resolve(json(body)));
  vi.stubGlobal('fetch', fetchMock);
  const queryClient = createQueryClient();
  if (equity) queryClient.setQueryData(profileDashboardQueryKey('p1'), equity);
  render(
    <QueryClientProvider client={queryClient}>
      <RiskPanel profileId="p1" />
    </QueryClientProvider>,
  );
  return { fetchMock };
};

afterEach(() => {
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

describe('RiskPanel', () => {
  it('shows the Off state with no limit', async () => {
    setUp(dashboard({ halted: false, todayRealizedPnl: '0', limitQuote: null, resetsAtMs: null }));
    expect(await screen.findByTestId('risk-off-badge')).toBeInTheDocument();
    expect(screen.getByTestId('risk-limit')).toHaveTextContent(/off/i);
  });

  it('shows the Armed state with the configured limit and today’s P/L', async () => {
    setUp(
      dashboard({ halted: false, todayRealizedPnl: '-3.5', limitQuote: '20', resetsAtMs: null }),
    );
    expect(await screen.findByTestId('risk-armed-badge')).toBeInTheDocument();
    expect(screen.getByTestId('risk-limit')).toHaveTextContent(/20.00 USDT/);
    expect(screen.getByTestId('risk-today-pnl')).toHaveTextContent(/-3.50 USDT/);
  });

  it('shows the paused badge and reset time when halted', async () => {
    const resetsAtMs = Date.UTC(2026, 5, 19);
    setUp(dashboard({ halted: true, todayRealizedPnl: '-21', limitQuote: '20', resetsAtMs }));
    expect(await screen.findByTestId('risk-paused-badge')).toBeInTheDocument();
    expect(screen.getByTestId('risk-paused-detail')).toHaveTextContent(/new buys are paused/i);
  });

  it('warns when the stored config is invalid', async () => {
    setUp(
      dashboard({ halted: false, todayRealizedPnl: '0', limitQuote: null, resetsAtMs: null }, true),
    );
    expect(await screen.findByTestId('risk-config-invalid')).toBeInTheDocument();
  });
});

describe('RiskPanel on a sub-unit quote asset', () => {
  it('renders a loss smaller than half a cent instead of collapsing it to 0.00', async () => {
    // A BTC-quoted profile can lose 0.0031 BTC — real money — and a hard 2-decimal readout prints "-0.00 BTC", which reads as "nothing happened today".
    setUp(
      dashboard(
        { halted: false, todayRealizedPnl: '-0.00312', limitQuote: '0.0075', resetsAtMs: null },
        false,
        'BTC',
      ),
      profileDashboard('BTC', '1', '0'),
    );
    expect(await screen.findByTestId('risk-today-pnl')).toHaveTextContent('-0.00312 BTC');
    expect(screen.getByTestId('risk-today-pnl')).not.toHaveTextContent('-0.00 BTC');
  });

  it('keeps the daily loss limit at the shared money precision, not a hard 2dp', async () => {
    setUp(
      dashboard(
        { halted: false, todayRealizedPnl: '-0.00312', limitQuote: '0.0075', resetsAtMs: null },
        false,
        'BTC',
      ),
      profileDashboard('BTC', '1', '0'),
    );
    expect(await screen.findByTestId('risk-limit')).toHaveTextContent('0.0075 BTC');
  });

  it('still shows two fraction digits for a whole-unit quote value', async () => {
    // Characterization pin: -3.5 and 20 on USDT render identically under the old hard `toFixed(2)` and the new shared formatter, so this was green before the change. It is here to say the swap is not "more digits everywhere" — a whole-unit figure must stay at 2dp — and it fails if a later precision tweak starts printing noise on a USDT readout.
    setUp(
      dashboard({ halted: false, todayRealizedPnl: '-3.5', limitQuote: '20', resetsAtMs: null }),
      profileDashboard('USDT', '1000', '0'),
    );
    expect(await screen.findByTestId('risk-limit')).toHaveTextContent('20.00 USDT');
    expect(screen.getByTestId('risk-today-pnl')).toHaveTextContent('-3.50 USDT');
  });
});

describe('RiskPanel daily-loss limit control', () => {
  it('names the profile quote asset inside the limit control', async () => {
    setUp(
      dashboard(
        { halted: false, todayRealizedPnl: '0', limitQuote: '0.01', resetsAtMs: null },
        false,
        'BTC',
      ),
      profileDashboard('BTC', '1', '0'),
    );
    const input = await screen.findByLabelText('Daily Loss Limit Quote');
    const control = input.parentElement;
    expect(control).not.toBeNull();
    // A bare number field cannot say what unit it is in; the operator types "0.01" and has no way to know whether that is BTC or dollars.
    expect(control).toHaveTextContent('BTC');
  });

  it('writes the profile’s own quote asset into the helper text, not a hard-coded USDT', async () => {
    setUp(
      dashboard(
        { halted: false, todayRealizedPnl: '0', limitQuote: '0.01', resetsAtMs: null },
        false,
        'BTC',
      ),
      profileDashboard('BTC', '1', '0'),
    );
    const help = await screen.findByText(/Most realised loss/);
    expect(help).toHaveTextContent('BTC');
    // Doubles as the drift alarm on the contract sentence: if the schema copy stops carrying a quote-currency phrase to rewrite, this catches it.
    expect(help).not.toHaveTextContent('USDT');
  });

  it('warns, but does not block, when the saved limit is above the account’s equity', async () => {
    // Equity is 100 USDT (60 cash + 40 deployed) and 80 is already lost today, so 420 more would have to land to reach a 500 limit. The breaker is decorative. That is worth saying — but it is the operator's account, so it must not be a hard stop.
    setUp(
      dashboard({ halted: false, todayRealizedPnl: '-80', limitQuote: '500', resetsAtMs: null }),
      profileDashboard('USDT', '60', '40'),
    );
    const warning = await screen.findByTestId('risk-limit-warning');
    // Both figures asserted: the headroom is the one number the fix computes, and 500 appearing here instead of 420 would mean the subtraction never happened.
    expect(warning).toHaveTextContent('420.00 USDT');
    expect(warning).toHaveTextContent('100.00 USDT');
    expect(warning).not.toHaveTextContent('500.00 USDT');
    expect(screen.getByRole('button', { name: 'Save' })).toBeEnabled();
  });

  it('lets the operator save a limit above equity', async () => {
    const user = userEvent.setup();
    const { fetchMock } = setUp(
      dashboard({ halted: false, todayRealizedPnl: '0', limitQuote: '500', resetsAtMs: null }),
      profileDashboard('USDT', '60', '40'),
    );
    await screen.findByTestId('risk-limit-warning');
    await user.click(screen.getByRole('button', { name: 'Save' }));
    await waitFor(() =>
      expect(
        fetchMock.mock.calls.some(
          ([, init]) => (init as RequestInit | undefined)?.method === 'PATCH',
        ),
      ).toBe(true),
    );
  });
});

describe('RiskPanel breaker state badge', () => {
  it('reports the limit as unreachable rather than Armed when it exceeds equity', async () => {
    setUp(
      dashboard({ halted: false, todayRealizedPnl: '0', limitQuote: '500', resetsAtMs: null }),
      profileDashboard('USDT', '60', '40'),
    );
    const badge = await screen.findByTestId('risk-unreachable-badge');
    expect(badge).toHaveTextContent(/limit above equity/i);
    // "Armed" claims the breaker will fire. It cannot, so it must not say so.
    expect(screen.queryByTestId('risk-armed-badge')).toBeNull();
  });

  it('stays Armed when the limit is within equity', async () => {
    setUp(
      dashboard({ halted: false, todayRealizedPnl: '0', limitQuote: '20', resetsAtMs: null }),
      profileDashboard('USDT', '60', '40'),
    );
    expect(await screen.findByTestId('risk-armed-badge')).toBeInTheDocument();
    expect(screen.queryByTestId('risk-unreachable-badge')).toBeNull();
  });

  it('stays Armed when the loss still needed to trip is within equity, even though the raw limit is not', async () => {
    // The worker trips on the day's CUMULATIVE realised P/L, and equity already reflects the 80 lost so far. Only 20 more is needed and 60 is still there, so the breaker is reachable. Comparing the raw 100 limit against the 60 that remains would count today's loss twice and cry wolf on exactly the day the badge gets read.
    setUp(
      dashboard({ halted: false, todayRealizedPnl: '-80', limitQuote: '100', resetsAtMs: null }),
      profileDashboard('USDT', '60', '0'),
    );
    expect(await screen.findByTestId('risk-armed-badge')).toBeInTheDocument();
    expect(screen.queryByTestId('risk-unreachable-badge')).toBeNull();
    expect(screen.queryByTestId('risk-limit-warning')).toBeNull();
  });

  it('reports unreachable when a present balance snapshot holds no quote asset at all', async () => {
    // A populated snapshot is authoritative: the writer overwrites the whole balance set, so an asset that is absent is genuinely zero. Treating that as "unknown" would void the badge for exactly the accounts whose limit is most obviously out of reach.
    setUp(
      dashboard({ halted: false, todayRealizedPnl: '0', limitQuote: '500', resetsAtMs: null }),
      profileDashboard('USDT', '0', '0', [{ asset: 'BTC', free: '0.5', locked: '0' }]),
    );
    expect(await screen.findByTestId('risk-unreachable-badge')).toBeInTheDocument();
    expect(screen.queryByTestId('risk-armed-badge')).toBeNull();
  });

  it('stays Armed when the balance snapshot is empty, which is ignorance rather than a zero balance', async () => {
    // Characterization pin: green before the change too, since the old code also returned null here (no quote row). It now guards the explicit `balances.length === 0` arm, which is the only thing separating "the cache lapsed" from "the account really holds none of this asset".
    setUp(
      dashboard({ halted: false, todayRealizedPnl: '0', limitQuote: '500', resetsAtMs: null }),
      profileDashboard('USDT', '0', '0', []),
    );
    expect(await screen.findByTestId('risk-armed-badge')).toBeInTheDocument();
    expect(screen.queryByTestId('risk-unreachable-badge')).toBeNull();
  });

  it('reads a lower-case profile quote asset against the upper-case balance keys', async () => {
    // Binance keys balances by upper-case asset; `profiles.quote_asset` is stored lower or mixed case by design. A case-sensitive match finds no row, so equity collapses to the deployed figure alone and the panel states a balance the account does not have — a false claim about a live safety control, which is worse than the silence it replaced.
    setUp(
      dashboard({ halted: false, todayRealizedPnl: '0', limitQuote: '50', resetsAtMs: null }),
      // Balances keyed UPPER-case, quote asset stored lower-case: the real skew. The helper's default balance row copies whatever casing is passed, which would match under either implementation and prove nothing. Equity is 100 here, so a 50 limit is reachable — but a case-sensitive match finds no cash row, drops equity to the deployed 40, and flips the badge.
      profileDashboard('usdt', '60', '40', [{ asset: 'USDT', free: '60', locked: '0' }]),
    );
    expect(await screen.findByTestId('risk-armed-badge')).toBeInTheDocument();
    expect(screen.queryByTestId('risk-unreachable-badge')).toBeNull();
  });

  it('counts a profitable day as raising the bar, not as no movement at all', async () => {
    // The worker trips on SIGNED cumulative P/L, so a 50 gain means 150 of loss is now needed, not 100. Equity already contains that gain, so discarding it on this side of the comparison understates the headroom and hides a limit that genuinely cannot be reached today.
    setUp(
      dashboard({ halted: false, todayRealizedPnl: '50', limitQuote: '100', resetsAtMs: null }),
      profileDashboard('USDT', '140', '0'),
    );
    expect(await screen.findByTestId('risk-unreachable-badge')).toBeInTheDocument();
    expect(screen.queryByTestId('risk-armed-badge')).toBeNull();
  });

  it('stays Armed when equity is unknown, however large the limit', async () => {
    // The worker halts at this threshold whatever the browser knows. A cold dashboard cache is absence of evidence, not evidence the breaker is dead, and telling the operator a live safety control is inert would be worse than saying nothing. Unreachability shows only on positive evidence.
    setUp(dashboard({ halted: false, todayRealizedPnl: '0', limitQuote: '500', resetsAtMs: null }));
    expect(await screen.findByTestId('risk-armed-badge')).toBeInTheDocument();
    expect(screen.queryByTestId('risk-unreachable-badge')).toBeNull();
  });

  it('reports Entries paused ahead of unreachable when the breaker has tripped', async () => {
    setUp(
      dashboard({
        halted: true,
        todayRealizedPnl: '-80',
        limitQuote: '500',
        resetsAtMs: Date.UTC(2026, 5, 19),
      }),
      profileDashboard('USDT', '60', '40'),
    );
    expect(await screen.findByTestId('risk-paused-badge')).toBeInTheDocument();
    expect(screen.queryByTestId('risk-unreachable-badge')).toBeNull();
    expect(screen.queryByTestId('risk-armed-badge')).toBeNull();
  });

  it('reports Off with no limit, whatever the equity', async () => {
    setUp(
      dashboard({ halted: false, todayRealizedPnl: '0', limitQuote: null, resetsAtMs: null }),
      profileDashboard('USDT', '60', '40'),
    );
    expect(await screen.findByTestId('risk-off-badge')).toBeInTheDocument();
    expect(screen.queryByTestId('risk-unreachable-badge')).toBeNull();
  });
});
