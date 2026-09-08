// HistoryEquityCard — the period's P/L curve, its benchmark, and the operator actions marked on it.

import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { beforeEach, describe, expect, it, vi } from 'vitest';

import { AUDIT_LOG_MAX_LIMIT } from '@/features/profile/api/audit-logs';

const fetchEquitySnapshots = vi.fn();
const fetchProfileAuditLogs = vi.fn();
const patchProfile = vi.fn();

vi.mock('@/features/dashboard/api/equity-snapshots', () => ({
  fetchEquitySnapshots: (...a: unknown[]) => fetchEquitySnapshots(...a),
}));
// The real module spread in, so only the two functions this file drives are stubbed. `AUDIT_LOG_MAX_LIMIT` in particular has to be the REAL constant: a literal restated here is what the assertion below would then be comparing the card against, which passes at any value the route's cap is ever moved to.
vi.mock('@/features/profile/api/audit-logs', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@/features/profile/api/audit-logs')>()),
  fetchProfileAuditLogs: (...a: unknown[]) => fetchProfileAuditLogs(...a),
  auditLogsExportUrl: () => '/export',
}));
vi.mock('@/features/profile/api/profiles-mutations', () => ({
  patchProfile: (...a: unknown[]) => patchProfile(...a),
}));

// Recharts, reduced to the structure the marker layer is a claim about. Not for convenience: `ResponsiveContainer` measures its parent, and in jsdom that measures zero, so the real library renders NOTHING inside it — every child of the chart, the reference lines included, is unreachable to an assertion. Only the pass-through containers and `ReferenceLine` carry behaviour here; the rest are inert so the chart's own drawing is not what is being tested.
vi.mock('recharts', async () => {
  const { createElement } = await import('react');
  const pass = (p: { children?: React.ReactNode }): React.ReactNode =>
    createElement('div', null, p.children);
  const inert = (): null => null;
  return {
    ResponsiveContainer: pass,
    LineChart: pass,
    CartesianGrid: inert,
    XAxis: inert,
    YAxis: inert,
    Tooltip: inert,
    Legend: inert,
    Line: inert,
    // The x is the whole substance of a mark: a layer that drew the right NUMBER of lines at the wrong instants would satisfy a count and still put every change the operator made in the wrong place on the axis.
    ReferenceLine: (p: { x: number }): React.ReactNode =>
      createElement('div', { 'data-testid': 'history-equity-marker', 'data-x': String(p.x) }),
  };
});

const { HistoryEquityCard } = await import('@/features/profile/components/history-equity-card');

const PID = '00000000-0000-4000-8000-0000000000a1';
const FROM = '2026-05-01T00:00:00.000Z';
const TO = '2026-05-31T00:00:00.000Z';

const point = (
  capturedAt: string,
  netPnl: string,
  cost = '100',
  btc = '100',
  feeBasis: 'exact' | 'estimated' | 'unknown' = 'exact',
) => ({
  capturedAt,
  netPnlQuote: netPnl,
  realizedNetQuote: netPnl,
  positionValueQuote: '0',
  positionCostQuote: cost,
  benchmarkAsset: 'BTC',
  benchmarkPriceQuote: btc,
  feeBasis,
});

/** One audit entry as the marker layer reads it: an id, the event name, and the instant that decides where its mark lands. */
const auditRow = (id: string, event: string, createdAt: string) => ({
  id,
  event,
  actor: 'op',
  payload: {},
  ip: null,
  userAgent: null,
  createdAt,
});

const snapshots = (points: unknown[]) => ({
  profileId: PID,
  quoteAsset: 'USDT',
  benchmarkMode: 'btc',
  points,
});

function renderCard(): void {
  const qc = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  qc.setQueryData(['account-settings'], { timezone: 'UTC' });
  render(
    <QueryClientProvider client={qc}>
      <HistoryEquityCard profileId={PID} from={FROM} to={TO} />
    </QueryClientProvider>,
  );
}

beforeEach(() => {
  vi.clearAllMocks();
  fetchEquitySnapshots.mockResolvedValue(snapshots([]));
  fetchProfileAuditLogs.mockResolvedValue({ items: [], nextCursor: null });
});

describe('<HistoryEquityCard>', () => {
  it('reads both series for the window the rollups were taken over', async () => {
    renderCard();
    await screen.findByTestId('history-equity-card');
    await waitFor(() => expect(fetchEquitySnapshots).toHaveBeenCalled());
    // Both reads are bounded by the same window, or the curve and the marks on it describe different periods.
    expect(fetchEquitySnapshots).toHaveBeenCalledWith(PID, { from: FROM, to: TO });
    const [, , events, window, limit] = fetchProfileAuditLogs.mock.calls[0] as [
      string,
      null,
      readonly string[],
      { from: string; to: string },
      number,
    ];
    expect(window).toEqual({ from: FROM, to: TO });
    // The route's maximum, not its UI-sized default: a marker layer that takes the default plots the newest 25 changes bunched against the right-hand edge of the axis and reports that number as the count of changes made.
    expect(limit).toBe(AUDIT_LOG_MAX_LIMIT);
    // Config-shaped events only: a mark per cancelled order buries the handful of changes that explain a bend in the curve.
    expect(events).toContain('set-discovery-config');
    expect(events).not.toContain('cancel-order');
  });

  it('says the period has no history rather than drawing an empty axis', async () => {
    renderCard();
    expect(await screen.findByTestId('history-equity-empty')).toBeInTheDocument();
  });

  it('marks only the operator actions that fall inside the plotted span', async () => {
    // `toSeries` drops every instant before capital was first deployed, so the plotted span starts later than the requested window. A mark outside it would be drawn against an axis that does not contain it.
    fetchEquitySnapshots.mockResolvedValue(
      snapshots([
        point('2026-05-01T00:00:00.000Z', '0', '0'),
        point('2026-05-10T00:00:00.000Z', '5'),
        point('2026-05-20T00:00:00.000Z', '9'),
      ]),
    );
    fetchProfileAuditLogs.mockResolvedValue({
      items: [
        {
          id: 'a1',
          event: 'reset-config',
          actor: 'op',
          payload: {},
          ip: null,
          userAgent: null,
          createdAt: '2026-05-02T00:00:00.000Z',
        },
        {
          id: 'a2',
          event: 'switch-strategy',
          actor: 'op',
          payload: {},
          ip: null,
          userAgent: null,
          createdAt: '2026-05-15T00:00:00.000Z',
        },
      ],
      nextCursor: null,
    });
    renderCard();
    // One of the two actions predates the first deployed point, so only one is marked.
    expect(await screen.findByTestId('history-equity-footnote')).toHaveTextContent(
      '1 change you made, marked on the axis',
    );
  });

  it('draws one mark per in-window action, each at that action’s own instant', async () => {
    // The footnote next door is derived from `markers.length`, so it survives a marker layer that draws nothing at all. What the operator is promised is a mark ON THE AXIS at the moment of each change, and only a position can be evidence of that.
    fetchEquitySnapshots.mockResolvedValue(
      snapshots([
        point('2026-05-01T00:00:00.000Z', '0', '0'),
        point('2026-05-10T00:00:00.000Z', '5'),
        point('2026-05-20T00:00:00.000Z', '9'),
      ]),
    );
    fetchProfileAuditLogs.mockResolvedValue({
      items: [
        auditRow('a1', 'reset-config', '2026-05-02T00:00:00.000Z'),
        auditRow('a2', 'switch-strategy', '2026-05-12T00:00:00.000Z'),
        auditRow('a3', 'kill-switch-on', '2026-05-18T00:00:00.000Z'),
      ],
      nextCursor: null,
    });
    renderCard();

    const marks = await screen.findAllByTestId('history-equity-marker');
    // `a1` predates the first deployed point, so the plotted span does not contain it: two marks, not three.
    expect(marks.map((m) => m.getAttribute('data-x'))).toEqual([
      String(Date.parse('2026-05-12T00:00:00.000Z')),
      String(Date.parse('2026-05-18T00:00:00.000Z')),
    ]);
  });

  it('qualifies the curve when its weakest point rests on a reconstructed fee, and again when none could be read', async () => {
    // Two different sentences for two different faults, and the direction of a mix-up matters: calling an unaccounted commission "partly estimated" tells the operator a charge was priced when it was never seen at all.
    fetchEquitySnapshots.mockResolvedValue(
      snapshots([
        point('2026-05-10T00:00:00.000Z', '5'),
        point('2026-05-20T00:00:00.000Z', '9', '100', '100', 'estimated'),
      ]),
    );
    renderCard();
    expect(await screen.findByTestId('history-equity-footnote')).toHaveTextContent(
      'fees partly estimated',
    );
  });

  it('says the fees were never accounted when the window’s weakest point could value none', async () => {
    fetchEquitySnapshots.mockResolvedValue(
      snapshots([
        point('2026-05-10T00:00:00.000Z', '5', '100', '100', 'estimated'),
        point('2026-05-20T00:00:00.000Z', '9', '100', '100', 'unknown'),
      ]),
    );
    renderCard();
    // `unknown` is the weaker of the two tiers in the window, and the line describes the whole of it.
    const footnote = await screen.findByTestId('history-equity-footnote');
    expect(footnote).toHaveTextContent('fees not accounted');
    expect(footnote.textContent ?? '').not.toContain('partly estimated');
  });

  it('leaves a fully-evidenced window unqualified, so the two notes above mean something', async () => {
    fetchEquitySnapshots.mockResolvedValue(
      snapshots([point('2026-05-10T00:00:00.000Z', '5'), point('2026-05-20T00:00:00.000Z', '9')]),
    );
    renderCard();
    const footnote = await screen.findByTestId('history-equity-footnote');
    expect(footnote.textContent ?? '').not.toContain('fees');
  });

  it('refuses to name a count when the window holds changes past the page it read', async () => {
    // The whole point of the marker layer is "here is what you changed". A truncated read reported its own page size as the number of changes made, which is a claim about the window that the response explicitly said it had not finished answering.
    fetchEquitySnapshots.mockResolvedValue(
      snapshots([point('2026-05-10T00:00:00.000Z', '5'), point('2026-05-20T00:00:00.000Z', '9')]),
    );
    fetchProfileAuditLogs.mockResolvedValue({
      items: [
        {
          id: 'a1',
          event: 'reset-config',
          actor: 'op',
          payload: {},
          ip: null,
          userAgent: null,
          createdAt: '2026-05-15T00:00:00.000Z',
        },
      ],
      nextCursor: '2026-05-15T00:00:00.000Z__a1',
    });
    renderCard();
    const footnote = await screen.findByTestId('history-equity-footnote');
    expect(footnote).toHaveTextContent('only your most recent changes in this window are marked');
    expect(footnote.textContent ?? '').not.toContain('1 change you made');
  });

  it('writes the benchmark to the profile rather than keeping a second copy of it', async () => {
    // The selector edits the profile's own persisted setting, the same one the Home card writes. A per-chart toggle would let two surfaces disagree about what the orange line is.
    fetchEquitySnapshots.mockResolvedValue(
      snapshots([point('2026-05-10T00:00:00.000Z', '5'), point('2026-05-20T00:00:00.000Z', '9')]),
    );
    patchProfile.mockResolvedValue({});
    renderCard();
    const select = await screen.findByTestId('history-benchmark-mode');
    await userEvent.selectOptions(select, 'basket');
    expect(patchProfile).toHaveBeenCalledWith(PID, { benchmarkMode: 'basket' });
  });

  it('reports the window’s worst drawdown beside the curve', async () => {
    fetchEquitySnapshots.mockResolvedValue(
      snapshots([
        point('2026-05-10T00:00:00.000Z', '10'),
        point('2026-05-12T00:00:00.000Z', '2'),
        point('2026-05-20T00:00:00.000Z', '6'),
      ]),
    );
    renderCard();
    // Peak 10 down to 2 is the worst give-back in the window, whatever it recovered to afterwards.
    expect(await screen.findByTestId('history-equity-footnote')).toHaveTextContent('8');
  });

  it('measures the drawdown over the PLOTTED curve, not over the points before capital went in', async () => {
    fetchEquitySnapshots.mockResolvedValue(
      snapshots([
        // Nothing deployed yet, and a 50-unit give-back across the pair. `toSeries` drops both, so the curve the operator is looking at never shows this fall.
        point('2026-05-02T00:00:00.000Z', '60', '0'),
        point('2026-05-03T00:00:00.000Z', '10', '0'),
        // Capital in: the plotted curve starts here and gives back 4.
        point('2026-05-10T00:00:00.000Z', '10', '100'),
        point('2026-05-12T00:00:00.000Z', '6', '100'),
        point('2026-05-20T00:00:00.000Z', '9', '100'),
      ]),
    );
    renderCard();
    const footnote = await screen.findByTestId('history-equity-footnote');
    // 4, the fall on the line that is drawn. Reporting 54 names a drop the operator cannot find anywhere on the chart it sits under.
    expect(footnote).toHaveTextContent('Worst drop from a high point in this window: 4.00 USDT');
  });

  it('drops the previous window’s marks while the action read for the new one is still in flight', async () => {
    // What `keepPreviousData` costs: the two reads key on the same window but resolve independently, so the snapshot read landing first draws the NEW curve under the PREVIOUS window's marks, and the footnote states that window's change count as fact. The domain filter does not catch it — an overlapping window contains those instants, which is exactly the All-time-to-This-month case.
    fetchEquitySnapshots.mockResolvedValue(
      snapshots([
        point('2026-05-01T00:00:00.000Z', '0', '0'),
        point('2026-05-10T00:00:00.000Z', '5'),
        point('2026-05-20T00:00:00.000Z', '9'),
      ]),
    );
    fetchProfileAuditLogs.mockResolvedValue({
      items: [auditRow('a1', 'switch-strategy', '2026-05-15T00:00:00.000Z')],
      nextCursor: null,
    });
    const qc = new QueryClient({ defaultOptions: { queries: { retry: false } } });
    qc.setQueryData(['account-settings'], { timezone: 'UTC' });
    const { rerender } = render(
      <QueryClientProvider client={qc}>
        <HistoryEquityCard profileId={PID} from={'2026-01-01T00:00:00.000Z'} to={TO} />
      </QueryClientProvider>,
    );
    await waitFor(() => expect(screen.getAllByTestId('history-equity-marker')).toHaveLength(1));

    // A narrower window that still contains the old action's instant. Its snapshots resolve; its actions do not.
    fetchProfileAuditLogs.mockReturnValue(new Promise(() => {}));
    rerender(
      <QueryClientProvider client={qc}>
        <HistoryEquityCard profileId={PID} from={FROM} to={TO} />
      </QueryClientProvider>,
    );

    await waitFor(() => expect(screen.queryByTestId('history-equity-marker')).toBeNull());
    // The CURVE stays, which is the whole point of the placeholder and the half a marker assertion cannot see: a regression that blanked the card while the audit read was in flight would satisfy every line above.
    expect(screen.queryByTestId('history-equity-empty')).toBeNull();
    const footnote = screen.getByTestId('history-equity-footnote');
    expect(footnote).toHaveTextContent('Worst drop from a high point in this window');
    // And the footnote stops claiming a count for the marks it is no longer drawing.
    expect(footnote.textContent ?? '').not.toContain('marked on the axis');
  });

  it('keeps the previous window on screen while a re-resolved one loads', async () => {
    // The archive response's `to` is the instant the SERVER answered, for every preset, so each refetch of the ledger above hands this card a window it has never seen and re-keys both reads. Without the placeholder the whole card falls back to its skeleton on every one of them, which during an archive recovery is every three seconds.
    fetchEquitySnapshots.mockResolvedValue(
      snapshots([point('2026-05-10T00:00:00.000Z', '10'), point('2026-05-20T00:00:00.000Z', '6')]),
    );
    const qc = new QueryClient({ defaultOptions: { queries: { retry: false } } });
    qc.setQueryData(['account-settings'], { timezone: 'UTC' });
    const { rerender } = render(
      <QueryClientProvider client={qc}>
        <HistoryEquityCard profileId={PID} from={FROM} to={TO} />
      </QueryClientProvider>,
    );
    await screen.findByTestId('history-equity-footnote');

    // The same window, one millisecond later — which is the only thing that changes between two consecutive ledger refetches.
    let resolveNext: (v: unknown) => void = () => {};
    fetchEquitySnapshots.mockReturnValue(
      new Promise((resolve) => {
        resolveNext = resolve;
      }),
    );
    rerender(
      <QueryClientProvider client={qc}>
        <HistoryEquityCard profileId={PID} from={FROM} to={'2026-05-31T00:00:00.001Z'} />
      </QueryClientProvider>,
    );

    // Still the curve, not the skeleton, while the new window is in flight.
    expect(screen.getByTestId('history-equity-footnote')).toBeInTheDocument();
    resolveNext(snapshots([point('2026-05-10T00:00:00.000Z', '10')]));
    await waitFor(() => expect(fetchEquitySnapshots).toHaveBeenCalledTimes(2));
  });
});
