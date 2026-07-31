// Realised-P/L card — closed-trades total for a profile with a D/W/M/All period
// selector backed by the closed-trades endpoint. Number math is display-only and
// safe here: apps/web is barred from decimal.js and none of these values feed an
// order.
//
// The period is controlled by the parent so one toggle can drive both this card
// and the sibling KPI cards (#504).

import { useQuery } from '@tanstack/react-query';

import { closedTradesQueryOptions } from '@/features/dashboard/api/dashboard';
import { Card } from '@/shared/components/ui/card';
import { PnlValue, PNL_TONE } from '@/shared/components/pnl-value';
import { Button } from '@/shared/components/ui/button';
import { useTimezone } from '@/shared/context/timezone-context';
import { formatPercent, signOf } from '@/shared/lib/format';
import { formatDate } from '@/shared/lib/format-time';

import type { ClosedTradesPeriod } from '@app/contracts';

const PERIODS: readonly { readonly code: ClosedTradesPeriod; readonly label: string }[] = [
  { code: 'd', label: 'D' },
  { code: 'w', label: 'W' },
  { code: 'm', label: 'M' },
  { code: 'a', label: 'All' },
];

// Render a percent string with a leading `+` on gains. Non-finite input falls
// back to the raw string (an upstream "—"/blank passes through unchanged).
function signedPercent(value: string): string {
  const n = Number(value);
  return Number.isFinite(n) ? formatPercent(n, { sign: true }) : value;
}

function periodLabel(
  period: ClosedTradesPeriod,
  from: string,
  to: string,
  timeZone: string,
): string {
  if (period === 'a') return 'All time';
  // Same zone the server used to cut the period, so the label can never name a
  // different day than the total it captions.
  const fromLabel = formatDate(from, timeZone);
  const toLabel = formatDate(to, timeZone);
  // The 'd' period always has from===to, and 'w'/'m' collapse to one date
  // when the period starts today (e.g. on the 1st of the month). A repeated
  // `2026-12-01 – 2026-12-01` reads as a display bug; collapse to one date.
  return fromLabel === toLabel ? fromLabel : `${fromLabel} – ${toLabel}`;
}

/**
 * Realised-P/L card with a D/W/M/All period selector backed by the closed-trades
 * endpoint. The selected period is controlled by the parent (the scoped-KPI
 * strip) so the same toggle re-filters the sibling KPI cards (#504).
 */
export function RealisedPnlCard({
  profileId,
  period,
  onPeriodChange,
}: {
  readonly profileId: string;
  readonly period: ClosedTradesPeriod;
  readonly onPeriodChange: (period: ClosedTradesPeriod) => void;
}): React.JSX.Element {
  const timeZone = useTimezone();
  const query = useQuery(closedTradesQueryOptions(profileId, period, timeZone));
  const data = query.data;

  return (
    <Card>
      <section aria-labelledby="realised-pnl-heading" className="space-y-3">
        <h2 id="realised-pnl-heading" className="text-fg text-sm font-semibold">
          Realised P/L
        </h2>
        <div className="flex flex-wrap gap-1" role="group" aria-label="Period">
          {PERIODS.map((p) => (
            <Button
              key={p.code}
              type="button"
              variant={p.code === period ? 'default' : 'outline'}
              className="min-h-11 min-w-11 flex-1"
              aria-pressed={p.code === period}
              data-testid={`realised-period-${p.code}`}
              onClick={() => onPeriodChange(p.code)}
            >
              {p.label}
            </Button>
          ))}
        </div>
        {data ? (
          <div className="space-y-1">
            <div className="flex items-baseline gap-2">
              {data.tradeCount === 0 ? (
                // Zero closed trades has no denominator — a "0 / 0.00%" readout
                // reads as "broke even on N trades" rather than "no trades".
                <span
                  className="text-muted-fg text-3xl font-semibold tabular-nums"
                  data-testid="realised-total-profit"
                >
                  —
                </span>
              ) : (
                <>
                  <PnlValue
                    value={data.totalProfit}
                    className="text-3xl font-semibold tabular-nums"
                    testId="realised-total-profit"
                  />
                  <span
                    className={PNL_TONE[signOf(data.totalProfitPercent)]}
                    data-testid="realised-percent"
                  >
                    {signedPercent(data.totalProfitPercent)}
                  </span>
                </>
              )}
            </div>
            <p className="text-muted-fg text-sm" data-testid="realised-trade-count">
              {data.tradeCount === 0
                ? `No closed trades · ${periodLabel(period, data.from, data.to, timeZone)}`
                : `${data.tradeCount} closed trade${data.tradeCount === 1 ? '' : 's'} · ${periodLabel(period, data.from, data.to, timeZone)}`}
            </p>
          </div>
        ) : (
          <p className="text-muted-fg text-sm">
            {query.isLoading ? 'Loading…' : 'Realised P/L unavailable.'}
          </p>
        )}
      </section>
    </Card>
  );
}
