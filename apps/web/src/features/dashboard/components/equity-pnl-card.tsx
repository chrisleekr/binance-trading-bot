import { BenchmarkMode } from '@app/contracts';
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
import { toSeries } from '@/shared/lib/equity-series';
import { patchProfile } from '@/features/profile/api/profiles-mutations';
import { formatMoneyAmount, formatPercent } from '@/shared/lib/format';
import { formatDate, formatInstant } from '@/shared/lib/format-time';
import { useTimezone } from '@/shared/context/timezone-context';
import { LoadingRows } from '@/shared/components/page-skeleton';
import { Select } from '@/shared/components/ui/select';

/** Headline caveat when a plotted point rests on a commission Binance never reported. Shared with the History chart so both say the same thing about the same fault. */
export const FEES_MISSING_NOTE = ' · some fees missing, so real profit is lower than shown';

/**
 * The profile's equity-snapshot series, shared by this card and the overview's "Profit so far" tile so both read one cached request.
 *
 * @param profileId - The profile whose snapshots to read.
 * @returns The React Query result for the default (unbounded) window.
 */
export const useEquitySnapshots = (profileId: string) =>
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
  const { series, holdWindowPct, latestNetPnl, feeBasis } = toSeries(data?.points, mode);
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
            {/* The line already subtracts every fee it knows of. `unknown` means a charge was never reported, so the figure is too high, not "before fees": saying "fees not accounted" under a Net label read as the chart ignoring fees altogether. */}
            {feeBasis !== 'exact' ? (
              <span className="text-muted-fg" data-testid="equity-fee-basis">
                {feeBasis === 'unknown' ? FEES_MISSING_NOTE : ' · some fees estimated'}
              </span>
            ) : null}
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
