// Where candidate coins drop out, per scan.
//
// Two ladders, two charts, never one. The ticker ladder counts over every coin
// on the exchange; the candidate ladder counts only over the shortlist whose
// price history was actually fetched. Different denominators, so a single
// graphic would render the seam between them as a collapse when it is the
// design.
//
// The ladders are proportional bars rather than a Recharts BarChart: they are
// eleven labelled rows across the two, not a plotted series, and at 375px a category axis wide
// enough for "Tight enough bid/ask spread" leaves no room for the bar. The
// history strip below is a real time series and does use Recharts.

import { useQuery } from '@tanstack/react-query';
import {
  CartesianGrid,
  Line,
  LineChart,
  ResponsiveContainer,
  Tooltip,
  XAxis,
  YAxis,
} from 'recharts';
import { funnelStageLabel, largestDrop, worstChoke, type DiagnosisFunnel } from '@app/contracts';

import { discoveryFunnelQueryOptions } from '@/features/profile/api/diagnosis';
import { Panel } from '@/shared/components/panel';
import { LoadingRows } from '@/shared/components/page-skeleton';
import { useTimezone } from '@/shared/context/timezone-context';
import { formatClock, formatInstant } from '@/shared/lib/format-time';

interface Rung {
  stage: string;
  label: string;
  survivors: number;
  /** Share of the rung above that made it through. Null for the first rung. */
  kept: number | null;
}

/** Annotate a ladder with each rung's pass rate against the rung above it. */
export const toRungs = (
  stages: readonly { readonly stage: string; readonly survivors: number }[],
): Rung[] =>
  stages.map((s, i) => {
    const before = stages[i - 1]?.survivors;
    return {
      stage: s.stage,
      label: funnelStageLabel(s.stage),
      survivors: s.survivors,
      kept: before === undefined || before <= 0 ? null : s.survivors / before,
    };
  });

const pct = (v: number): string => `${Math.round(v * 100)}%`;

function Ladder({
  rungs,
  chokeStage,
  denominator,
  testId,
}: {
  readonly rungs: Rung[];
  readonly chokeStage: string | null;
  readonly denominator: string;
  readonly testId: string;
}): React.JSX.Element {
  // Bars are scaled against this ladder's own first rung, which is what
  // "counted over" in the caption names. Scaling both ladders to one maximum
  // would draw the change of denominator as a cliff.
  const top = rungs[0]?.survivors ?? 0;

  return (
    <div data-testid={testId}>
      <p className="mb-2 text-xs text-muted-fg">{denominator}</p>
      <ul className="space-y-1.5">
        {rungs.map((r) => {
          const isChoke = r.stage === chokeStage;
          return (
            <li key={r.stage} data-testid={`funnel-rung-${r.stage}`} data-survivors={r.survivors}>
              <div className="flex items-baseline justify-between gap-2 text-xs">
                <span className={isChoke ? 'font-medium text-danger' : ''}>{r.label}</span>
                <span className="shrink-0 text-muted-fg tabular-nums">
                  {r.survivors}
                  {r.kept === null ? '' : ` · ${pct(r.kept)} kept`}
                </span>
              </div>
              <div className="mt-1 h-1.5 w-full overflow-hidden rounded-sm bg-muted">
                <div
                  className={`h-full rounded-sm ${isChoke ? 'bg-danger' : 'bg-accent'}`}
                  style={{ width: `${top > 0 ? (r.survivors / top) * 100 : 0}%` }}
                />
              </div>
            </li>
          );
        })}
      </ul>
    </div>
  );
}

function HistoryStrip({ funnel }: { readonly funnel: DiagnosisFunnel }): React.JSX.Element | null {
  const timeZone = useTimezone();
  // One point is not a trend, and the whole reason this strip exists is telling
  // an unlucky scan from a choke that repeats.
  if (funnel.history.length < 2) return null;

  return (
    <div data-testid="funnel-history">
      <p className="mb-2 text-xs text-muted-fg">
        Eligible and added, per scan. A gap is a scan that recorded no counts, not a scan that found
        nothing.
      </p>
      <div className="h-[140px] w-full">
        <ResponsiveContainer width="100%" height="100%">
          <LineChart data={[...funnel.history]} margin={{ left: 4, right: 8, top: 4 }}>
            <CartesianGrid stroke="var(--border)" strokeDasharray="3 3" />
            <XAxis
              dataKey="atMs"
              type="number"
              domain={['dataMin', 'dataMax']}
              tick={{ fontSize: 11 }}
              tickFormatter={(v: number) => formatClock(v, timeZone)}
            />
            <YAxis tick={{ fontSize: 11 }} width={32} allowDecimals={false} />
            <Tooltip labelFormatter={(v) => formatClock(Number(v), timeZone)} />
            {/* connectNulls stays off: bridging an unrecorded scan would draw a
                line through counts that were never measured. */}
            <Line
              type="monotone"
              dataKey="eligible"
              name="Eligible"
              stroke="var(--accent)"
              dot={false}
              connectNulls={false}
              isAnimationActive={false}
            />
            <Line
              type="monotone"
              dataKey="added"
              name="Added"
              stroke="var(--up)"
              dot={false}
              connectNulls={false}
              isAnimationActive={false}
            />
          </LineChart>
        </ResponsiveContainer>
      </div>
    </div>
  );
}

export function DiscoveryFunnelPanel({
  profileId,
}: {
  readonly profileId: string;
}): React.JSX.Element | null {
  const timeZone = useTimezone();
  const query = useQuery(discoveryFunnelQueryOptions(profileId));

  if (query.isLoading) return <LoadingRows rows={4} />;
  // Advisory surface, so a failed read must not take the discovery page with it
  // — but it says so rather than vanishing. A panel that disappears on error is
  // indistinguishable from a profile that has never scanned.
  if (query.isError) {
    return (
      <Panel title="Where candidates drop out" testId="discovery-funnel">
        <p className="text-sm text-muted-fg" data-testid="funnel-error">
          Could not load the scan counts. The scan itself is unaffected.
        </p>
      </Panel>
    );
  }

  const funnel = query.data?.funnel ?? null;
  if (funnel === null) {
    return (
      <Panel title="Where candidates drop out" testId="discovery-funnel">
        <p className="text-sm text-muted-fg" data-testid="funnel-unknown">
          No scan has recorded stage counts yet, so there is nothing to show. That is not the same
          as a scan that found nothing.
        </p>
      </Panel>
    );
  }

  const ticker = toRungs(funnel.ticker);
  const candidate = toRungs(funnel.candidate);
  // The same functions the investigation uses to name the choke, not a second
  // copy of the rule, so the highlighted rung here and the finding in the report
  // cannot disagree. Each ladder is searched within its own denominator; the
  // seam between them is not a drop.
  const worst = worstChoke(
    largestDrop(ticker.map((r) => [r.stage, r.survivors] as const)),
    largestDrop(candidate.map((r) => [r.stage, r.survivors] as const)),
  );

  return (
    <Panel
      title="Where candidates drop out"
      description={`From the scan at ${formatInstant(funnel.latestAtMs, timeZone)}.`}
      testId="discovery-funnel"
    >
      <div className="space-y-6">
        {worst === null ? null : (
          <p className="text-sm" data-testid="funnel-choke" data-stage={worst.stage}>
            Most coins are lost at{' '}
            <span className="font-medium text-danger">{funnelStageLabel(worst.stage)}</span>:{' '}
            {worst.before - worst.after} of {worst.before} dropped there.
          </p>
        )}

        <Ladder
          rungs={ticker}
          chokeStage={worst?.stage ?? null}
          denominator="Counted over every coin on the exchange."
          testId="funnel-ticker"
        />

        <div className="border-t border-border pt-4">
          <p className="mb-2 text-xs text-muted-fg">
            The count restarts here. Only the coins that survived above have their price history
            fetched, so these stages count over that shortlist, not over the exchange — a smaller
            number here is the design, not a further collapse.
          </p>
          <Ladder
            rungs={candidate}
            chokeStage={worst?.stage ?? null}
            denominator="Counted over the shortlist above."
            testId="funnel-candidate"
          />
        </div>

        <HistoryStrip funnel={funnel} />
      </div>
    </Panel>
  );
}
