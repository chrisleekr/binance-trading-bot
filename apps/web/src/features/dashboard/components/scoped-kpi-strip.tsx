// Scoped KPI strip — the at-a-glance numbers for one profile, shown on Home
// only when the top-bar scope is a single profile (not 'all'). Pairs the
// realised-P/L card the profile header uses with a labelled "Discovery" tile
// band (deployed cost, exposure cap, auto-symbol and holdings counts, realised
// and 7-day P/L, win rate, trade count), so the operator gets the per-profile
// auto-discovery readout without leaving the overview.
//
// One D/W/M/All toggle (owned here, rendered by the realised-P/L card) drives
// both the realised-P/L card and the time-rangeable KPI cards — realised, win
// rate and trades (#504). Two card classes intentionally ignore the toggle: the
// gauge cards (deployed cost, exposure cap, auto symbols, open positions) are
// point-in-time "now" values with no historical series, so they are tagged
// "now"; the 7-day P/L card is its own fixed 7-day window, untagged because its
// label already names its span.

import { useQuery } from '@tanstack/react-query';
import { useState } from 'react';

import {
  discoveryDashboardQueryOptions,
  discoveryScoreboardQueryOptions,
} from '@/features/profile/api/discovery';
import { RealisedPnlCard } from '@/features/profile/components/realised-pnl-card';
import { PnlValue } from '@/shared/components/pnl-value';
import { PnlBasisToggle } from '@/shared/components/pnl-basis-toggle';
import { RollupStatsLine } from '@/shared/components/rollup-stats-line';
import { useTimezone } from '@/shared/context/timezone-context';
import { usePnlBasis } from '@/shared/hooks/use-pnl-basis';
import { formatBalanceMoney, formatWinRate } from '@/shared/lib/format';
import { t } from '@/shared/lib/i18n';
import { sourceLabel } from '@/shared/lib/rollup-stats';

import type { ClosedTradesPeriod } from '@app/contracts';

/**
 * One KPI tile: a muted uppercase micro-label over a large mono value. `now`
 * tags a point-in-time card that ignores the period toggle (#504), so the
 * operator isn't misled into reading it as a historical value.
 */
function KpiCell({
  label,
  testId,
  now = false,
  children,
}: {
  label: string;
  testId: string;
  now?: boolean;
  children: React.ReactNode;
}) {
  return (
    <div className="bg-bg-elevated flex flex-col gap-1 p-3">
      <dt className="text-muted-fg flex items-center gap-1 text-[11px] font-semibold uppercase tracking-wider">
        {label}
        {now ? (
          <span
            className="rounded-xs bg-border text-muted-fg px-1 text-[9px] font-medium normal-case tracking-normal"
            data-testid={`scoped-kpi-${testId}-now`}
          >
            {t('home.scoped.now_tag')}
          </span>
        ) : null}
      </dt>
      <dd
        className="font-mono text-xl font-semibold tabular-nums"
        data-testid={`scoped-kpi-${testId}`}
      >
        {children}
      </dd>
    </div>
  );
}

/**
 * Per-profile KPI strip for the scoped Home view. Renders nothing until the
 * discovery dashboard resolves (or on error) so a slow/failed discovery read
 * never blanks the overview — the realised-P/L card still shows. The discovery
 * gauge supplies deployed cost basis and the exposure cap; the scoreboard
 * supplies win rate and the auto-trade count.
 */
export function ScopedKpiStrip({ profileId }: { readonly profileId: string }): React.JSX.Element {
  const { basis, setBasis } = usePnlBasis();
  const [period, setPeriod] = useState<ClosedTradesPeriod>('d');
  // The server resolves the D/W/M boundary in this zone, so it must be the
  // operator's configured zone, not the browser's.
  const timeZone = useTimezone();
  const { data } = useQuery(discoveryDashboardQueryOptions(profileId));
  // Period-ranged numbers come from a separate small query so toggling the
  // period doesn't re-fetch the whole dashboard (universe + activity).
  const { data: scoreboard } = useQuery(
    discoveryScoreboardQueryOptions(profileId, period, timeZone),
  );
  const bySource = scoreboard?.bySource ?? [];

  return (
    <section
      aria-labelledby="scoped-kpi-heading"
      data-testid="scoped-kpi-strip"
      className="@container space-y-2"
    >
      <h2
        id="scoped-kpi-heading"
        className="text-muted-fg text-[11px] font-semibold uppercase tracking-wider"
      >
        {t('home.scoped.title')}
      </h2>
      <RealisedPnlCard profileId={profileId} period={period} onPeriodChange={setPeriod} />
      {data ? (
        <>
          <div className="flex flex-wrap items-center justify-between gap-2">
            <h3 className="text-muted-fg text-[11px] font-semibold uppercase tracking-wider">
              {t('home.scoped.discovery_title')}
            </h3>
            <PnlBasisToggle basis={basis} onBasisChange={setBasis} />
          </div>
          <dl
            className="@3xl:grid-cols-4 border-border bg-border grid grid-cols-2 gap-px border"
            aria-label={t('home.scoped.discovery_title')}
          >
            <KpiCell label={t('home.scoped.deployed')} testId="deployed" now>
              {formatBalanceMoney(data.gauge.deployedQuote)}
            </KpiCell>
            <KpiCell label={t('home.scoped.exposure_cap')} testId="exposure-cap" now>
              {data.gauge.maxAccountExposureQuote != null
                ? formatBalanceMoney(data.gauge.maxAccountExposureQuote)
                : '—'}
            </KpiCell>
            <KpiCell label={t('home.scoped.auto_symbols')} testId="auto-symbols" now>
              {data.gauge.autoSymbolCount}
            </KpiCell>
            <KpiCell label={t('home.scoped.holdings')} testId="holdings" now>
              {data.holdings.length}
            </KpiCell>
            <KpiCell label={t('home.scoped.realised')} testId="realised">
              {scoreboard ? (
                <PnlValue
                  value={basis === 'net' ? scoreboard.netProfit : scoreboard.realizedProfit}
                  unit={data.quoteAsset}
                />
              ) : (
                '—'
              )}
            </KpiCell>
            <KpiCell label={t('home.scoped.realised_7d')} testId="realised-7d">
              <PnlValue
                value={
                  basis === 'net' ? data.scoreboard.netProfit7d : data.scoreboard.realizedProfit7d
                }
                unit={data.quoteAsset}
              />
            </KpiCell>
            <KpiCell label={t('home.scoped.win_rate')} testId="win-rate">
              {scoreboard && scoreboard.tradeCount > 0 ? formatWinRate(scoreboard.winRate) : '—'}
            </KpiCell>
            <KpiCell label={t('home.scoped.trades')} testId="trades">
              {scoreboard ? scoreboard.tradeCount : '—'}
            </KpiCell>
          </dl>
          {bySource.length > 0 ? (
            <section
              data-testid="scoped-by-source"
              aria-label={t('home.scoped.by_source_title')}
              className="space-y-2"
            >
              <div>
                <h3 className="text-muted-fg text-[11px] font-semibold uppercase tracking-wider">
                  {t('home.scoped.by_source_title')}
                </h3>
                <p className="text-muted-fg text-xs">{t('home.scoped.by_source_desc')}</p>
              </div>
              <ul className="border-border bg-bg-elevated space-y-2 border p-3">
                {bySource.map((b) => (
                  <li
                    key={b.source}
                    className="space-y-0.5"
                    data-testid={`scoped-source-${b.source}`}
                  >
                    <div className="flex items-center justify-between gap-3 text-xs">
                      <span className="text-muted-fg min-w-0 flex-1 truncate">
                        {sourceLabel(b.source)}
                      </span>
                      <span className="w-24 text-right font-mono tabular-nums">
                        <PnlValue
                          value={basis === 'net' ? b.netProfit : b.realizedProfit}
                          unit={data.quoteAsset}
                        />
                      </span>
                    </div>
                    <RollupStatsLine bucket={b} />
                  </li>
                ))}
              </ul>
            </section>
          ) : null}
        </>
      ) : null}
    </section>
  );
}
