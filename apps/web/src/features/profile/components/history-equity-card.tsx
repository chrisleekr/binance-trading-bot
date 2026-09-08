// The shape of the period: cumulative net P/L against buy-and-hold, with the operator's own config changes marked on the same axis.
//
// Recharts rather than the backtest page's `EquityAreaChart`, which declares one `addSeries` returning only `setData`, exposes `AreaSeries` alone and has no marker layer: this chart needs two series and a marker per operator action, and its sibling on Home already plots exactly this pair in Recharts.
//
// The fold is `toSeries`, shared verbatim with the Home card, so the two surfaces cannot disagree about what the window made.

import { BenchmarkMode, type FeeBasis } from '@app/contracts';
import { keepPreviousData, useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import {
  CartesianGrid,
  Legend,
  Line,
  LineChart,
  ReferenceLine,
  ResponsiveContainer,
  Tooltip,
  XAxis,
  YAxis,
} from 'recharts';

import { fetchEquitySnapshots } from '@/features/dashboard/api/equity-snapshots';
import { AUDIT_LOG_MAX_LIMIT, fetchProfileAuditLogs } from '@/features/profile/api/audit-logs';
import { patchProfile } from '@/features/profile/api/profiles-mutations';
import { LoadingRows } from '@/shared/components/page-skeleton';
import { Select } from '@/shared/components/ui/select';
import { useTimezone } from '@/shared/context/timezone-context';
import { toSeries } from '@/shared/lib/equity-series';
import { maxDrawdown } from '@/shared/lib/live-scorecard';
import { formatMoneyAmount, formatPercent } from '@/shared/lib/format';
import { formatDate, formatInstant } from '@/shared/lib/format-time';

/**
 * The audit events worth a mark on the P/L axis: the ones that change what the bot will do next.
 *
 * Deliberately not every audited action. A marker per cancelled order turns the axis into a picket fence and buries the handful of changes that actually explain a bend in the curve, so the filter is applied server-side and this list is the whole of it.
 */
const CONFIG_EVENTS: readonly string[] = [
  'set-discovery-config',
  'set-symbol-config',
  'reset-symbol-config',
  'reset-config',
  'switch-strategy',
  'kill-switch-on',
  'kill-switch-off',
];

/** What the footnote appends about the window's fee evidence. Keyed by tier so every tier's wording is stated in one place; `exact` deliberately adds nothing, since a complete window has no caveat to make. */
const FEE_NOTE: Record<FeeBasis, string> = {
  exact: '',
  estimated: ' · fees partly estimated',
  unknown: ' · fees not accounted',
};

/** One operator action placed on the time axis. */
interface Marker {
  readonly id: string;
  readonly tsMs: number;
  readonly event: string;
}

/**
 * Cumulative P/L for one window, against holding the benchmark, with the operator's config changes marked.
 *
 * @param profileId - The profile whose series to plot.
 * @param from - Inclusive ISO start of the window the rollups above were taken over, echoed by the archive response so both read the same period.
 * @param to - Inclusive ISO end of that same window; both the snapshot read and the action read bound on it inclusively.
 * @returns The card, or its loading / empty state.
 */
export function HistoryEquityCard({
  profileId,
  from,
  to,
}: {
  readonly profileId: string;
  readonly from: string;
  readonly to: string;
}): React.JSX.Element {
  const timeZone = useTimezone();
  const queryClient = useQueryClient();

  // Both reads keep the previous window's answer on screen while the next one loads. Not a polish: `to` is the archive response's own resolved end, and for every preset the server resolves that to the instant it answered, so each refetch of the ledger above hands this card a `to` it has never seen. Without this the whole chart falls back to its skeleton on every one of them, which during a recovery is every three seconds.
  const snapshots = useQuery({
    // The window is part of the key: two periods are two different series, and one cached under the other's key plots a window the operator did not ask for.
    queryKey: ['equity-snapshots', profileId, from, to],
    queryFn: () => fetchEquitySnapshots(profileId, { from, to }),
    placeholderData: keepPreviousData,
  });
  const actions = useQuery({
    // The route's maximum, not its default: this is a marker layer over a whole window, and a default-sized page silently plots the newest 25 changes bunched against the right-hand edge while the footnote reports 25 as the number of changes made.
    queryKey: ['profile', 'audit-logs', profileId, 'config-markers', from, to],
    queryFn: () =>
      fetchProfileAuditLogs(profileId, null, CONFIG_EVENTS, { from, to }, AUDIT_LOG_MAX_LIMIT),
    placeholderData: keepPreviousData,
  });

  const mode: BenchmarkMode = snapshots.data?.benchmarkMode ?? 'btc';
  const { series, holdWindowPct, feeBasis } = toSeries(snapshots.data?.points, mode);
  const quote = snapshots.data?.quoteAsset ?? '';
  const holdLabel = mode === 'basket' ? 'your basket' : 'BTC';
  // Measured over the PLOTTED points, not the raw read. `toSeries` drops everything before capital was first deployed in this window, so a drawdown folded over the raw points reports a drop the operator cannot find on the curve beside it. A difference between two cumulative values, so the rebasing `toSeries` applies leaves it unchanged.
  const drawdown = maxDrawdown(series.map((p) => p.netPnl));

  const setMode = useMutation({
    mutationFn: (benchmarkMode: BenchmarkMode) => patchProfile(profileId, { benchmarkMode }),
    onSuccess: () => queryClient.invalidateQueries({ queryKey: ['equity-snapshots', profileId] }),
  });

  // Anchored to the SERIES, not to the requested window: `toSeries` drops every instant before capital was first deployed, so the plotted domain starts later than `from` and a marker placed outside it would be drawn against an axis that does not contain it.
  const firstMs = series[0]?.tsMs ?? 0;
  const lastMs = series.at(-1)?.tsMs ?? 0;
  const markers: Marker[] = (actions.data?.items ?? [])
    .map((item) => ({ id: item.id, tsMs: new Date(item.createdAt).getTime(), event: item.event }))
    .filter((m) => Number.isFinite(m.tsMs) && m.tsMs >= firstMs && m.tsMs <= lastMs);
  // A non-null continuation token means the window holds changes past the page that was read, so the axis carries some of them and the footnote must not name a count it would be stating as the total.
  const markersPartial = (actions.data?.nextCursor ?? null) !== null;

  return (
    <section
      aria-labelledby="history-equity-h"
      className="space-y-2 rounded-md border border-border p-3"
      data-testid="history-equity-card"
    >
      <div className="flex flex-wrap items-baseline justify-between gap-x-3 gap-y-1">
        <h2 id="history-equity-h" className="text-sm font-medium text-fg">
          P/L over time
        </h2>
        <label className="flex items-center gap-1 text-xs text-muted-fg">
          {/* Named as the profile's setting, not as a view toggle: it is the same stored `benchmarkMode` the Home card writes, so changing it here changes it there. */}
          <span>This profile compares against</span>
          <Select
            variant="sm"
            data-testid="history-benchmark-mode"
            aria-label="Benchmark this profile is compared against"
            value={mode}
            disabled={setMode.isPending}
            onChange={(e) => setMode.mutate(BenchmarkMode.parse(e.target.value))}
          >
            <option value="btc">BTC</option>
            <option value="basket">my basket</option>
          </Select>
        </label>
      </div>

      <p className="text-xs text-muted-fg">
        Your net profit after fees (green) against what holding {holdLabel} with the capital you had
        deployed at the start of this window would have made (orange). Both start from zero on the
        left, so green above orange is the bot beating buy-and-hold over this period. Each mark on
        the axis is a change you made.
      </p>

      {snapshots.isError ? (
        <p className="text-sm text-danger">Could not load the profit history.</p>
      ) : snapshots.isPending ? (
        <LoadingRows />
      ) : series.length === 0 ? (
        <p className="text-sm text-muted-fg" data-testid="history-equity-empty">
          No profit history in this period — the first point is recorded within 15 minutes of the
          worker running.
        </p>
      ) : (
        <>
          <div className="h-48 w-full sm:h-64">
            <ResponsiveContainer width="100%" height="100%">
              <LineChart data={series} margin={{ top: 8, right: 12, bottom: 4, left: 4 }}>
                <CartesianGrid stroke="var(--border)" strokeDasharray="3 3" />
                <XAxis
                  type="number"
                  dataKey="tsMs"
                  domain={['dataMin', 'dataMax']}
                  scale="time"
                  tick={{ fontSize: 11 }}
                  tickFormatter={(ms: number) => formatDate(ms, timeZone)}
                />
                <YAxis tick={{ fontSize: 11 }} width={48} />
                <Tooltip
                  labelFormatter={(ms) => formatInstant(Number(ms), timeZone)}
                  formatter={(v, name) => [
                    `${formatMoneyAmount(String(Number(v)))} ${quote}`,
                    name,
                  ]}
                />
                <Legend wrapperStyle={{ fontSize: 11 }} />
                {markers.map((m) => (
                  <ReferenceLine
                    key={m.id}
                    x={m.tsMs}
                    stroke="var(--muted-fg)"
                    strokeDasharray="2 2"
                    label={{ value: '▲', position: 'insideBottom', fontSize: 10 }}
                  />
                ))}
                <Line
                  type="monotone"
                  dataKey="netPnl"
                  name="Net P/L"
                  stroke="var(--up)"
                  dot={false}
                  isAnimationActive={false}
                />
                <Line
                  type="monotone"
                  dataKey="hold"
                  name={mode === 'basket' ? 'Hold basket' : 'Hold BTC'}
                  stroke="var(--warning)"
                  dot={false}
                  isAnimationActive={false}
                />
              </LineChart>
            </ResponsiveContainer>
          </div>

          <p className="text-[11px] text-muted-fg" data-testid="history-equity-footnote">
            Worst drop from a high point in this window: {formatMoneyAmount(String(drawdown))}{' '}
            {quote}
            {holdWindowPct !== null
              ? ` · ${mode === 'basket' ? 'your basket' : 'BTC'} moved ${formatPercent(holdWindowPct)} over the same window`
              : ''}
            {FEE_NOTE[feeBasis]}
            {markersPartial
              ? ' · only your most recent changes in this window are marked on the axis'
              : markers.length > 0
                ? ` · ${markers.length} change${markers.length === 1 ? '' : 's'} you made, marked on the axis`
                : ''}
          </p>
        </>
      )}
    </section>
  );
}
