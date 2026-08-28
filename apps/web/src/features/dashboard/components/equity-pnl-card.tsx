import { BenchmarkMode, type EquitySnapshotPoint } from '@app/contracts';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import {
  CartesianGrid,
  Legend,
  Line,
  LineChart,
  ResponsiveContainer,
  Tooltip,
  XAxis,
  YAxis,
} from 'recharts';

import { fetchEquitySnapshots } from '@/features/dashboard/api/equity-snapshots';
import { patchProfile } from '@/features/profile/api/profiles-mutations';
import { formatMoneyAmount, formatPercent } from '@/shared/lib/format';
import { formatDate, formatInstant } from '@/shared/lib/format-time';
import { useTimezone } from '@/shared/context/timezone-context';
import { LoadingRows } from '@/shared/components/page-skeleton';
import { Select } from '@/shared/components/ui/select';

interface ChartPoint {
  tsMs: number;
  netPnl: number;
  hold: number;
}

/**
 * Equal-weight basket return from the anchor's prices to a point's prices, over
 * the symbols present in BOTH maps (a coin fully exited the held set drops out).
 * Null when no symbol is comparable, so the caller can hold the line flat.
 */
const basketReturn = (
  anchor: Record<string, string> | null | undefined,
  point: Record<string, string> | null | undefined,
): number | null => {
  if (!anchor || !point) return null;
  let acc = 0;
  let n = 0;
  for (const [sym, base] of Object.entries(anchor)) {
    const b = Number(base);
    const cur = point[sym];
    if (cur === undefined || b <= 0) continue;
    acc += Number(cur) / b - 1;
    n += 1;
  }
  return n === 0 ? null : acc / n;
};

/**
 * Derive the chart series. `netPnl` is the profile's actual cumulative net-of-fee
 * profit. `hold` is the honest counterfactual: had the capital first deployed
 * been put into the chosen benchmark and held, this is the P/L it would have made
 * over the same window. The benchmark is BTC (`mode === 'btc'`) or an equal-weight
 * basket of the profile's own held symbols (`mode === 'basket'`) — the latter
 * measures skill against the coins actually picked, not just BTC's beta.
 *
 * Both lines anchor to the first point where capital was deployed (position cost
 * > 0), not the worker's first boot, so the comparison starts when money was put
 * in. When nothing was ever deployed the hold line stays flat at 0.
 */
export const toSeries = (
  points: readonly EquitySnapshotPoint[] | undefined,
  mode: BenchmarkMode,
): { series: ChartPoint[]; holdWindowPct: number | null; latestNetPnl: number | null } => {
  if (!points || points.length === 0) {
    return { series: [], holdWindowPct: null, latestNetPnl: null };
  }
  const deployedIdx = points.findIndex((p) => Number(p.positionCostQuote) > 0);
  const startIdx = deployedIdx === -1 ? 0 : deployedIdx;
  const anchor = points[startIdx];
  const last = points.at(-1);
  if (!anchor || !last) return { series: [], holdWindowPct: null, latestNetPnl: null };
  const windowed = points.slice(startIdx);
  const cost0 = Number(anchor.positionCostQuote);
  const netPnl0 = Number(anchor.netPnlQuote);
  const btc0 = Number(anchor.benchmarkPriceQuote);
  // The basket's constituents are the prices captured at its base point. Use the
  // first windowed point that actually has prices (normally the anchor), so a
  // transient missing-ticker at the deploy snapshot does not permanently shrink
  // the basket for the whole window.
  const basketBase = windowed.find(
    (p) => p.benchmarkPrices && Object.keys(p.benchmarkPrices).length > 0,
  )?.benchmarkPrices;
  const holdReturn = (p: EquitySnapshotPoint): number | null => {
    if (mode === 'basket') return basketReturn(basketBase, p.benchmarkPrices);
    const btc = Number(p.benchmarkPriceQuote);
    return btc0 > 0 && btc > 0 ? btc / btc0 - 1 : null;
  };
  const series = windowed.map((p): ChartPoint => {
    const r = holdReturn(p);
    return {
      tsMs: new Date(p.capturedAt).getTime(),
      netPnl: Number(p.netPnlQuote) - netPnl0,
      hold: r === null ? 0 : cost0 * r,
    };
  });
  const lastReturn = holdReturn(last);
  const holdWindowPct = lastReturn === null ? null : lastReturn * 100;
  return { series, holdWindowPct, latestNetPnl: Number(last.netPnlQuote) };
};

const useEquitySnapshots = (profileId: string) =>
  useQuery({
    queryKey: ['equity-snapshots', profileId],
    queryFn: () => fetchEquitySnapshots(profileId),
    refetchInterval: 60_000,
  });

export function EquityPnlCard({ profileId }: { profileId: string }): React.JSX.Element {
  const timeZone = useTimezone();
  const queryClient = useQueryClient();
  const { data, isPending, isError } = useEquitySnapshots(profileId);
  const mode: BenchmarkMode = data?.benchmarkMode ?? 'btc';
  const { series, holdWindowPct, latestNetPnl } = toSeries(data?.points, mode);
  const quote = data?.quoteAsset ?? '';
  const holdLabel = mode === 'basket' ? 'your basket' : 'BTC';

  const setMode = useMutation({
    mutationFn: (benchmarkMode: BenchmarkMode) => patchProfile(profileId, { benchmarkMode }),
    onSuccess: () => queryClient.invalidateQueries({ queryKey: ['equity-snapshots', profileId] }),
  });

  return (
    <section
      aria-labelledby="equity-pnl-h"
      className="space-y-2 rounded-md border border-border bg-bg-elevated p-3"
      data-testid="equity-pnl-card"
    >
      <div className="flex flex-wrap items-baseline justify-between gap-x-3 gap-y-1">
        <div className="flex flex-wrap items-baseline gap-x-2 gap-y-1">
          <h2
            id="equity-pnl-h"
            className="text-[11px] font-semibold tracking-wider text-muted-fg uppercase"
          >
            Profit vs holding {holdLabel}
          </h2>
          <label className="flex items-center gap-1 text-xs text-muted-fg">
            <span className="sr-only">Benchmark</span>
            <Select
              variant="sm"
              data-testid="equity-benchmark-mode"
              aria-label="Benchmark to compare against"
              value={mode}
              disabled={setMode.isPending}
              onChange={(e) => setMode.mutate(BenchmarkMode.parse(e.target.value))}
            >
              <option value="btc">vs BTC</option>
              <option value="basket">vs my basket</option>
            </Select>
          </label>
        </div>
        {latestNetPnl !== null ? (
          <div className="text-xs">
            <span className="text-muted-fg">Net P/L </span>
            <span
              className={`font-mono font-medium tabular-nums ${latestNetPnl < 0 ? 'text-down' : 'text-up'}`}
            >
              {formatMoneyAmount(String(latestNetPnl))} {quote}
            </span>
            {holdWindowPct !== null ? (
              <span className="text-muted-fg">
                {mode === 'basket' ? ' · Basket this window ' : ' · BTC this window '}
                <span className={holdWindowPct < 0 ? 'text-down' : 'text-up'}>
                  {formatPercent(holdWindowPct)}
                </span>
              </span>
            ) : null}
          </div>
        ) : null}
      </div>
      <p className="text-xs text-muted-fg">
        Change over this window: your net profit after fees (green), against what holding{' '}
        {holdLabel} with the capital you had deployed at the start of this window would have made
        (orange). Both start from zero on the left, so when green is above orange the bot is beating
        buy-and-hold here.
      </p>
      {isError ? (
        <p className="text-sm text-down">Could not load the profit history.</p>
      ) : isPending ? (
        <LoadingRows />
      ) : series.length === 0 ? (
        <p className="text-sm text-muted-fg">
          No profit history yet — the first point is recorded within 15 minutes of the worker
          running.
        </p>
      ) : (
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
                formatter={(v, name) => [`${formatMoneyAmount(String(Number(v)))} ${quote}`, name]}
              />
              <Legend wrapperStyle={{ fontSize: 11 }} />
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
      )}
    </section>
  );
}
