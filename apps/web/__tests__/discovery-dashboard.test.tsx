import { QueryClientProvider } from '@tanstack/react-query';
import { render, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { afterEach, describe, expect, it, vi } from 'vitest';

import { createQueryClient } from '@/shared/lib/query-client';
import { DiscoveryDashboard } from '@/features/profile/components/discovery-dashboard';

const json = (body: unknown, status = 200): Response =>
  new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } });

const config = {
  enabled: true,
  refreshPeriodMs: 900_000,
  blacklist: [],
  min24hPairVolumeUsd: '500000',
  min24hAssetVolumeUsd: '50000000',
  maxSpreadRatio: '0.003',
  changeMinPercent: '0',
  rankTopPercent: 30,
  rankExcludeTopPercent: 5,
  minAgeDays: 30,
  maxAutoSymbols: 5,
  minHoldMinutes: 120,
  trendConfirm: {
    adxPeriod: 14,
    adxMin: '25',
    emaPeriod: 20,
    volSmaPeriod: 20,
    volMultiple: '1.5',
  },
};
const dashboard = {
  config,
  quoteAsset: 'USDT',
  scoreboard: {
    realizedProfit: '123.45',
    realizedProfitPercent: '2.5',
    tradeCount: 8,
    winRate: 0.75,
    realizedProfit7d: '40.00',
    tradeCount7d: 3,
  },
  gauge: { deployedQuote: '5000.00', maxAccountExposureQuote: '10000', autoSymbolCount: 3 },
};

const setUp = (
  responder: (url: string, init?: RequestInit) => Response,
): { calls: { url: string; method: string; body: unknown }[] } => {
  const calls: { url: string; method: string; body: unknown }[] = [];
  const fetchMock = vi.fn((input: RequestInfo | URL, init?: RequestInit) => {
    const url =
      typeof input === 'string' ? input : input instanceof URL ? input.toString() : input.url;
    let body: unknown;
    if (typeof init?.body === 'string') body = JSON.parse(init.body);
    calls.push({ url, method: init?.method ?? 'GET', body });
    return Promise.resolve(responder(url, init));
  });
  vi.stubGlobal('fetch', fetchMock);
  render(
    <QueryClientProvider client={createQueryClient()}>
      <DiscoveryDashboard profileId="p1" />
    </QueryClientProvider>,
  );
  return { calls };
};

afterEach(() => {
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

describe('DiscoveryDashboard', () => {
  it('renders the scoreboard + gauge from the discovery endpoint', async () => {
    setUp((url) => (url.endsWith('/profiles/p1/discovery') ? json(dashboard) : json({}, 404)));
    const board = await screen.findByTestId('discovery-scoreboard');
    expect(within(board).getByTestId('discovery-net-pl')).toHaveTextContent('+123.45');
    // Win rate now renders via the shared formatWinRate (2-dp house style),
    // matching the scoped KPI strip — was an ad-hoc integer round.
    expect(within(board).getByText('75.00%')).toBeInTheDocument();
    const gauge = screen.getByTestId('discovery-gauge');
    expect(within(gauge).getByTestId('discovery-auto-count')).toHaveTextContent('3');
  });

  it('toggling the switch PATCHes the config with enabled flipped', async () => {
    const { calls } = setUp((url) => {
      if (url.endsWith('/profiles/p1/discovery')) return json(dashboard);
      if (url.endsWith('/profiles/p1/discovery-config'))
        return json({ ...dashboard, config: { ...config, enabled: false } });
      return json({}, 404);
    });
    await screen.findByTestId('discovery-scoreboard');
    await userEvent.click(screen.getByLabelText('toggle discovery'));
    await waitFor(() => {
      const patch = calls.find((c) => c.method === 'PATCH');
      expect(patch).toBeDefined();
      expect((patch?.body as { enabled: boolean }).enabled).toBe(false);
    });
  });

  it('renders nothing when the discovery endpoint errors (does not break the page)', async () => {
    setUp(() => json({ error: { code: 'NOT_FOUND', message: 'profile' } }, 404));
    await waitFor(() =>
      expect(screen.queryByTestId('discovery-dashboard')).not.toBeInTheDocument(),
    );
  });

  it('warns when the stored config is invalid, instead of presenting defaults silently', async () => {
    // The API returns safe defaults + configInvalid:true when an out-of-band DB
    // edit left an unparseable config; the dashboard must surface that the saved
    // settings are not applied, not pretend the defaults are the real config.
    const invalid = { ...dashboard, configInvalid: true, config: { ...config, enabled: false } };
    setUp((url) => (url.endsWith('/profiles/p1/discovery') ? json(invalid) : json({}, 404)));
    const warning = await screen.findByTestId('discovery-config-invalid');
    expect(warning).toHaveTextContent(/not being applied/i);
  });

  const ALL = ['quote', 'blacklist', 'liquidity', 'spread', 'changeBand', 'age', 'trend'];
  const rich = {
    ...dashboard,
    universe: {
      computedAtMs: 1_700_000_000_000,
      candidates: [
        {
          symbol: 'WINUSDT',
          gainerScore: '22',
          passed: ALL,
          failedAt: null,
          disposition: 'added',
          // Added but waiting for the dip — the per-coin entry-blocker the
          // dashboard glosses so the operator sees why a slot isn't entering.
          entryBlocker: {
            reason: 'awaiting-trigger-price',
            detail: { windowLow: '95', currentPrice: '96' },
          },
        },
        {
          symbol: 'FADEUSDT',
          gainerScore: '1',
          passed: ['quote', 'blacklist', 'liquidity', 'spread', 'changeBand', 'age'],
          failedAt: 'trend',
          disposition: 'faded-removed',
          entryBlocker: null,
        },
        {
          symbol: 'PUMPUSDT',
          gainerScore: '80',
          passed: ['quote', 'blacklist', 'liquidity', 'spread'],
          failedAt: 'changeBand',
          disposition: 'rejected',
          entryBlocker: null,
        },
      ],
    },
    // Both held-disposition symbols are still in the live auto-set.
    autoSymbols: ['WINUSDT', 'FADEUSDT'],
    activity: [
      { time: '2026-06-09T00:00:00.000Z', symbol: 'WINUSDT', action: 'add', msg: 'added' },
      { time: '2026-06-08T00:00:00.000Z', symbol: 'OLDUSDT', action: 'remove', msg: 'removed' },
    ],
  };
  const richResponder = (url: string): Response => {
    if (url.endsWith('/symbols/WINUSDT/pin'))
      return json({ symbol: 'WINUSDT', overrideConfig: null, source: 'manual' });
    if (url.endsWith('/symbols/WINUSDT/force-eject'))
      return json({
        scheduledAt: '2026-06-09T00:00:00.000Z',
        overrideActionId: '00000000-0000-4000-8000-000000000001',
      });
    if (url.endsWith('/discovery') || url.endsWith('/discovery-config')) return json(rich);
    return json({}, 404);
  };

  it('renders the live-universe breakdown with dispositions and reasons', async () => {
    setUp(richResponder);
    const u = await screen.findByTestId('discovery-universe');
    expect(within(u).getByTestId('disposition-WINUSDT')).toHaveTextContent('added');
    expect(within(u).getByTestId('disposition-PUMPUSDT')).toHaveTextContent('out');
    expect(within(u).getByText(/24h move outside the gain band/)).toBeInTheDocument();
    // The filters a failed candidate cleared are listed so the operator sees how far it got.
    expect(
      within(u).getByText('passed quote asset, blocklist, liquidity, spread'),
    ).toBeInTheDocument();
  });

  it('shows the entry-blocker gloss for an auto pick that is not buying', async () => {
    setUp(richResponder);
    const u = await screen.findByTestId('discovery-universe');
    const win = within(u).getByTestId('universe-WINUSDT');
    // WINUSDT is added and held in the live auto-set but is waiting for the dip;
    // the row glosses its awaiting-trigger-price blocker in plain language.
    expect(
      within(win).getByText(/Waiting for the price to dip to your buy trigger/),
    ).toBeInTheDocument();
    // FADEUSDT is live-auto with a null blocker — no gloss line, and the generic
    // fallback must not leak onto a row that has no reason to show one.
    const fade = within(u).getByTestId('universe-FADEUSDT');
    expect(within(fade).queryByText(/Waiting for the price to dip/)).not.toBeInTheDocument();
    expect(within(fade).queryByText(/not buying this coin right now/i)).not.toBeInTheDocument();
  });

  it('glosses the trend rejection in plain language (no "trend filter" jargon)', async () => {
    const trendFail = {
      ...dashboard,
      universe: {
        computedAtMs: 1_700_000_000_000,
        candidates: [
          {
            symbol: 'CHOPUSDT',
            gainerScore: '7',
            passed: ['quote', 'blacklist', 'liquidity', 'spread', 'changeBand', 'age'],
            failedAt: 'trend',
            disposition: 'rejected',
          },
        ],
      },
    };
    setUp((url) => (url.endsWith('/profiles/p1/discovery') ? json(trendFail) : json({}, 404)));
    const u = await screen.findByTestId('discovery-universe');
    expect(within(u).getByText(/not in a confirmed uptrend/)).toBeInTheDocument();
    expect(within(u).queryByText(/trend filter/)).not.toBeInTheDocument();
    expect(
      within(u).getByText(
        'passed quote asset, blocklist, liquidity, spread, 24h gain band, listing age',
      ),
    ).toBeInTheDocument();
  });

  it('reassures when discovery is on but nothing qualified (0 auto symbols)', async () => {
    const flat = {
      ...dashboard,
      gauge: { ...dashboard.gauge, autoSymbolCount: 0 },
      universe: { computedAtMs: 1_700_000_000_000, candidates: [] },
    };
    setUp((url) => (url.endsWith('/profiles/p1/discovery') ? json(flat) : json({}, 404)));
    const note = await screen.findByTestId('discovery-zero-note');
    expect(note).toHaveTextContent(/Scanning every 15 min/);
    expect(note).toHaveTextContent(/normal when the market is flat/);
  });

  it('shows first-scan-pending in the zero-state when there is no universe yet', async () => {
    const fresh = { ...dashboard, gauge: { ...dashboard.gauge, autoSymbolCount: 0 } };
    setUp((url) => (url.endsWith('/profiles/p1/discovery') ? json(fresh) : json({}, 404)));
    const note = await screen.findByTestId('discovery-zero-note');
    expect(note).toHaveTextContent('First scan pending');
  });

  it('formats an hour-scale scan period as hours, not minutes', async () => {
    const hourly = {
      ...dashboard,
      config: { ...config, refreshPeriodMs: 3_600_000 },
      gauge: { ...dashboard.gauge, autoSymbolCount: 0 },
      universe: { computedAtMs: 1_700_000_000_000, candidates: [] },
    };
    setUp((url) => (url.endsWith('/profiles/p1/discovery') ? json(hourly) : json({}, 404)));
    const note = await screen.findByTestId('discovery-zero-note');
    expect(note).toHaveTextContent('Scanning every 1 h');
  });

  it('does not show the zero-state note when auto symbols are held', async () => {
    setUp((url) => (url.endsWith('/profiles/p1/discovery') ? json(dashboard) : json({}, 404)));
    await screen.findByTestId('discovery-gauge');
    expect(screen.queryByTestId('discovery-zero-note')).not.toBeInTheDocument();
  });

  it('discovery settings editor submits the full config including the unchanged enabled flag', async () => {
    const { calls } = setUp(richResponder);
    await screen.findByTestId('discovery-config-editor');
    await userEvent.click(screen.getByText('Discovery settings'));
    // `enabled` is owned by the card's on/off switch, never the editor form:
    // no second control that could diverge from the switch.
    expect(screen.queryByLabelText(/^Enabled$/i)).not.toBeInTheDocument();
    await userEvent.click(screen.getByRole('button', { name: 'Save settings' }));
    await waitFor(() => {
      const patch = calls.find((c) => c.method === 'PATCH' && c.url.endsWith('/discovery-config'));
      expect(patch).toBeDefined();
      const body = patch?.body as {
        enabled: boolean;
        maxAutoSymbols: number;
        trendConfirm: { adxMin: string };
      };
      expect(body.enabled).toBe(true);
      expect(body.maxAutoSymbols).toBe(5);
      expect(body.trendConfirm.adxMin).toBe('25');
    });
  });

  it('renders the enterOnAdd toggle with its plain-language risk note and PATCHes it on', async () => {
    const { calls } = setUp(richResponder);
    await screen.findByTestId('discovery-config-editor');
    await userEvent.click(screen.getByText('Discovery settings'));
    // The toggle and its risk note are schema-driven (AutoForm renders the
    // DiscoveryConfigSchema describe() text inline under the field), so this
    // guards that the operator sees the risk before opting in.
    const toggle = screen.getByLabelText('Enter On Add');
    expect(toggle).toBeInTheDocument();
    expect(screen.getByText(/skips short-interval confirmation/i)).toBeInTheDocument();
    await userEvent.click(toggle);
    await userEvent.click(screen.getByRole('button', { name: 'Save settings' }));
    await waitFor(() => {
      const patch = calls.find((c) => c.method === 'PATCH' && c.url.endsWith('/discovery-config'));
      expect((patch?.body as { enterOnAdd: boolean }).enterOnAdd).toBe(true);
    });
  });

  it('editing a discovery field and saving PATCHes the new value', async () => {
    const { calls } = setUp(richResponder);
    await screen.findByTestId('discovery-config-editor');
    await userEvent.click(screen.getByText('Discovery settings'));
    const input = screen.getByLabelText('Min 24h volume on this market (USD)');
    await userEvent.clear(input);
    await userEvent.type(input, '5000000');
    await userEvent.click(screen.getByRole('button', { name: 'Save settings' }));
    await waitFor(() => {
      const patch = calls.find((c) => c.method === 'PATCH' && c.url.endsWith('/discovery-config'));
      expect((patch?.body as { min24hPairVolumeUsd: string }).min24hPairVolumeUsd).toBe('5000000');
    });
  });

  it('blocking a candidate PATCHes the config with the symbol added to the blacklist', async () => {
    const { calls } = setUp(richResponder);
    await screen.findByTestId('discovery-universe');
    await userEvent.click(screen.getByLabelText('Block PUMPUSDT'));
    await waitFor(() => {
      const patch = calls.find((c) => c.method === 'PATCH' && c.url.endsWith('/discovery-config'));
      expect((patch?.body as { blacklist: string[] }).blacklist).toContain('PUMPUSDT');
    });
  });

  it('ejecting a held symbol confirms then POSTs force-eject with the blocklist choice', async () => {
    const { calls } = setUp(richResponder);
    await screen.findByTestId('discovery-universe');
    await userEvent.click(screen.getByLabelText('Eject WINUSDT'));
    await userEvent.click(await screen.findByLabelText('Also block from re-adding'));
    await userEvent.click(screen.getByRole('button', { name: 'Eject' }));
    await waitFor(() => {
      const post = calls.find((c) => c.url.endsWith('/force-eject'));
      expect(post?.method).toBe('POST');
      expect((post?.body as { blocklist: boolean }).blocklist).toBe(true);
    });
  });

  it('pinning a held universe symbol POSTs /pin', async () => {
    const { calls } = setUp(richResponder);
    await screen.findByTestId('discovery-universe');
    await userEvent.click(screen.getByLabelText('Pin WINUSDT'));
    await waitFor(() =>
      expect(calls.find((c) => c.url.endsWith('/symbols/WINUSDT/pin'))?.method).toBe('POST'),
    );
  });

  it('renders recent discovery activity', async () => {
    setUp(richResponder);
    const feed = await screen.findByTestId('discovery-activity');
    expect(within(feed).getByText('WINUSDT')).toBeInTheDocument();
    expect(within(feed).getByText('OLDUSDT')).toBeInTheDocument();
  });

  it('flags added-but-not-entered coins so a running-but-flat set is not read as profit', async () => {
    // `rich` has autoSymbolCount 3 and no holdings → discovery added coins the
    // strategy has not bought yet.
    setUp(richResponder);
    const note = await screen.findByTestId('discovery-waiting-note');
    expect(note).toHaveTextContent(/none have entered a position yet/);
    // The held WINUSDT row carries the per-coin "waiting for entry" status.
    const u = screen.getByTestId('discovery-universe');
    const win = within(u).getByTestId('universe-WINUSDT');
    expect(within(win).getByTestId('position-status')).toHaveTextContent(/no position yet/);
  });

  it('shows the deployed cost basis for an auto symbol that holds a position', async () => {
    const withHolding = {
      ...rich,
      holdings: [{ symbol: 'WINUSDT', quantity: '10', avgEntryPrice: '2', quoteCostBasis: '20' }],
    };
    setUp((url) =>
      url.endsWith('/discovery') || url.endsWith('/discovery-config')
        ? json(withHolding)
        : json({}, 404),
    );
    const u = await screen.findByTestId('discovery-universe');
    // WINUSDT holds → cost basis; FADEUSDT is flat → waiting.
    expect(
      within(within(u).getByTestId('universe-WINUSDT')).getByTestId('position-status'),
    ).toHaveTextContent(/holding · ≈ 20.00 USDT/);
    expect(
      within(within(u).getByTestId('universe-FADEUSDT')).getByTestId('position-status'),
    ).toHaveTextContent(/no position yet/);
    // At least one position is held, so the added-but-waiting note is gone.
    expect(screen.queryByTestId('discovery-waiting-note')).not.toBeInTheDocument();
  });

  it('reconciles a held row that has left the live auto-set (pinned/removed since the scan)', async () => {
    // The frozen scan still tags WINUSDT 'added', but it is no longer in the
    // live auto-set, so the row must drop Pin/Eject and read "no longer auto"
    // rather than appearing held with controls that look like they do nothing.
    const reconciled = { ...rich, autoSymbols: ['FADEUSDT'] };
    setUp((url) =>
      url.endsWith('/discovery') || url.endsWith('/discovery-config')
        ? json(reconciled)
        : json({}, 404),
    );
    const u = await screen.findByTestId('discovery-universe');
    const win = within(u).getByTestId('universe-WINUSDT');
    expect(within(win).getByTestId('disposition-WINUSDT')).toHaveTextContent('no longer auto');
    expect(within(win).getByText(/no longer in the auto-set/)).toBeInTheDocument();
    expect(within(win).queryByLabelText('Pin WINUSDT')).not.toBeInTheDocument();
    expect(within(win).queryByLabelText('Eject WINUSDT')).not.toBeInTheDocument();
    // It is no longer discovery's to manage, so the holding/waiting line is gone.
    expect(within(win).queryByTestId('position-status')).not.toBeInTheDocument();
    // Block stays available, and FADEUSDT (still auto) keeps its controls.
    expect(within(win).getByLabelText('Block WINUSDT')).toBeInTheDocument();
    expect(
      within(within(u).getByTestId('universe-FADEUSDT')).getByLabelText('Eject FADEUSDT'),
    ).toBeInTheDocument();
  });

  // The pinned-symbols list gives the operator's manual symbols a visible home
  // in the discovery panel; auto symbols already appear in the universe list.
  const symbolRows = [
    { symbol: 'XPLUSDT', overrideConfig: null, source: 'manual' },
    { symbol: 'TAOUSDT', overrideConfig: null, source: 'manual' },
    { symbol: 'WINUSDT', overrideConfig: null, source: 'auto' },
  ];
  const manualResponder =
    (rows: typeof symbolRows) =>
    (url: string, init?: RequestInit): Response => {
      const method = init?.method ?? 'GET';
      if (url.endsWith('/profiles/p1/symbols') && method === 'GET') return json(rows);
      if (url.endsWith('/symbols/XPLUSDT/unpin'))
        return json({ symbol: 'XPLUSDT', overrideConfig: null, source: 'auto' });
      if (url.endsWith('/profiles/p1/symbols/XPLUSDT') && method === 'DELETE')
        return new Response(null, { status: 204 });
      if (url.endsWith('/discovery') || url.endsWith('/discovery-config')) return json(dashboard);
      return json({}, 404);
    };
  // Once the mutating call for `dropped` is seen, later roster GETs omit it — proves the
  // mutation's invalidate() refetches the list and the row leaves, not just that the request fired.
  const droppingResponder = (dropped: string) => {
    let mutated = false;
    return (url: string, init?: RequestInit): Response => {
      const method = init?.method ?? 'GET';
      if (url.endsWith('/profiles/p1/symbols') && method === 'GET')
        return json(mutated ? symbolRows.filter((r) => r.symbol !== dropped) : symbolRows);
      if (url.endsWith(`/symbols/${dropped}/unpin`)) {
        mutated = true;
        return json({ symbol: dropped, overrideConfig: null, source: 'auto' });
      }
      if (url.endsWith(`/profiles/p1/symbols/${dropped}`) && method === 'DELETE') {
        mutated = true;
        return new Response(null, { status: 204 });
      }
      if (url.endsWith('/discovery') || url.endsWith('/discovery-config')) return json(dashboard);
      return json({}, 404);
    };
  };

  it('lists the pinned (manual) symbols and excludes auto ones', async () => {
    setUp(manualResponder(symbolRows));
    const section = await screen.findByTestId('manual-symbols');
    expect(within(section).getByText('Pinned symbols')).toBeInTheDocument();
    expect(within(section).getByTestId('manual-XPLUSDT')).toBeInTheDocument();
    expect(within(section).getByTestId('manual-TAOUSDT')).toBeInTheDocument();
    // WINUSDT is source=auto — it belongs to the live-universe list, not here.
    expect(within(section).queryByTestId('manual-WINUSDT')).not.toBeInTheDocument();
  });

  it('shows an empty state when there are no pinned symbols', async () => {
    setUp(manualResponder(symbolRows.filter((r) => r.source === 'auto')));
    const section = await screen.findByTestId('manual-symbols');
    expect(within(section).getByTestId('manual-symbols-empty')).toBeInTheDocument();
  });

  it('unpinning a pinned symbol POSTs /unpin and drops it from the list on refetch', async () => {
    const { calls } = setUp(droppingResponder('XPLUSDT'));
    const section = await screen.findByTestId('manual-symbols');
    expect(within(section).getByTestId('manual-XPLUSDT')).toBeInTheDocument();
    await userEvent.click(screen.getByLabelText('Unpin XPLUSDT'));
    await waitFor(() =>
      expect(calls.find((c) => c.url.endsWith('/symbols/XPLUSDT/unpin'))?.method).toBe('POST'),
    );
    // invalidate() refetches the roster, now without XPLUSDT.
    await waitFor(() =>
      expect(within(section).queryByTestId('manual-XPLUSDT')).not.toBeInTheDocument(),
    );
  });

  it('removing a pinned symbol confirms, DELETEs the binding, and drops it from the list', async () => {
    const { calls } = setUp(droppingResponder('XPLUSDT'));
    const section = await screen.findByTestId('manual-symbols');
    await userEvent.click(screen.getByLabelText('Remove XPLUSDT'));
    // The confirm dialog's button has the exact name "Remove" (the row button is
    // "Remove XPLUSDT"), so this targets the confirmation, not the opener.
    await userEvent.click(await screen.findByRole('button', { name: 'Remove' }));
    await waitFor(() => {
      const del = calls.find((c) => c.url.endsWith('/profiles/p1/symbols/XPLUSDT'));
      expect(del?.method).toBe('DELETE');
    });
    await waitFor(() =>
      expect(within(section).queryByTestId('manual-XPLUSDT')).not.toBeInTheDocument(),
    );
  });

  it('hides the pinned-symbols section (does not break the panel) when the roster read fails', async () => {
    // The roster query errors while the dashboard query succeeds: the section stays absent
    // rather than rendering a broken state, and the rest of the panel still renders.
    setUp((url) => {
      if (url.endsWith('/profiles/p1/symbols'))
        return json({ error: { code: 'NOT_FOUND', message: 'x' } }, 404);
      if (url.endsWith('/profiles/p1/discovery')) return json(dashboard);
      return json({}, 404);
    });
    await screen.findByTestId('discovery-dashboard');
    await waitFor(() => expect(screen.queryByTestId('manual-symbols')).not.toBeInTheDocument());
  });
});
