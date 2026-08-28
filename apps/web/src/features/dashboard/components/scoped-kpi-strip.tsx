// Scoped KPI strip — the at-a-glance numbers for one profile, shown on Home
// only when the top-bar scope is a single profile (not 'all'). Pairs the
// realised-P/L card the profile header uses with a labelled "Discovery" tile
// band (deployed cost, exposure cap, auto-symbol and holdings counts, realised
// and 7-day P/L, win rate, trade count), so the operator gets the per-profile
// auto-discovery readout without leaving the overview.
//
// One D/W/M/All toggle (owned here, rendered by the realised-P/L card) drives
// both the realised-P/L card and the time-rangeable KPI cards — realised, win
// rate and trades. Two card classes intentionally ignore the toggle: the
// gauge cards (deployed cost, exposure cap, auto symbols, open positions) are
// point-in-time "now" values with no historical series, so they are tagged
// "now"; the 7-day P/L card is its own fixed 7-day window, untagged because its
// label already names its span.

import { useQuery } from '@tanstack/react-query';
import { Link } from '@tanstack/react-router';
import { ChevronRight } from 'lucide-react';
import { useState } from 'react';

import {
  discoveryDashboardQueryOptions,
  discoveryScoreboardQueryOptions,
} from '@/features/profile/api/discovery';
import { RealisedPnlCard } from '@/features/profile/components/realised-pnl-card';
import { PnlValue } from '@/shared/components/pnl-value';
import { PnlBasisToggle } from '@/shared/components/pnl-basis-toggle';
import { RollupStatsLine } from '@/shared/components/rollup-stats-line';
import { useActiveAccountId } from '@/shared/lib/account-scope';
import { useTimezone } from '@/shared/context/timezone-context';
import { usePnlBasis } from '@/shared/hooks/use-pnl-basis';
import { formatBalanceMoney, formatWinRate } from '@/shared/lib/format';
import { t } from '@/shared/lib/i18n';
import { sourceLabel } from '@/shared/lib/rollup-stats';

import type { ClosedTradesPeriod } from '@app/contracts';

/** The three profile routes a KPI tile can resolve to. A literal union rather than `string`, so TanStack's typed Link checks them and re-nesting one of these routes fails the build instead of 404ing at runtime. */
type KpiTo =
  | '/accounts/$accountId/profiles/$profileId/history'
  | '/accounts/$accountId/profiles/$profileId/risk'
  | '/accounts/$accountId/profiles/$profileId/discovery';

/** Where a tile resolves. One object rather than loose props because every KpiTo route requires its params, so a `to` without them must not be expressible. */
interface KpiDest {
  readonly to: KpiTo;
  readonly params: { readonly accountId: string; readonly profileId: string };
  readonly search?: { readonly section: 'archive' };
}

/**
 * One KPI tile: a muted uppercase micro-label over a large mono value. `now` tags a point-in-time card that ignores the period toggle, so the operator isn't misled into reading it as a historical value.
 *
 * A tile with a `to` becomes a real `<Link>`, not a click handler: this app's dominant journey is symptom then fix, so a number the operator is alarmed by has to be the thing they click — and middle-click and copy-link have to work on it like every other deep link in the app. A tile without one is terminal by intent, which for this strip means the number's own detail is already on this page.
 *
 * @param label - The micro-label above the value.
 * @param testId - Suffix for the `scoped-kpi-` test hooks; also keys the `now` tag's hook.
 * @param now - Point-in-time value that ignores the period toggle, which the tag says out loud.
 * @param dest - Route, params, and tab this number resolves to; omitted for a terminal tile whose detail is already on the page.
 * @param children - The value.
 * @returns The tile, wrapped in a link when it has a destination.
 */
function KpiCell({
  label,
  testId,
  now = false,
  dest,
  children,
}: {
  label: string;
  testId: string;
  now?: boolean;
  dest?: KpiDest;
  children: React.ReactNode;
}) {
  const nowTag = now ? (
    <span
      className="rounded-xs bg-border px-1 text-[9px] font-medium tracking-normal text-muted-fg normal-case"
      data-testid={`scoped-kpi-${testId}-now`}
    >
      {t('home.scoped.now_tag')}
    </span>
  ) : null;
  const value = (
    <dd
      className="font-mono text-xl font-semibold tabular-nums"
      data-testid={`scoped-kpi-${testId}`}
    >
      {children}
    </dd>
  );
  const dtClass =
    'flex items-center gap-1 text-[11px] font-semibold tracking-wider text-muted-fg uppercase';
  if (dest === undefined)
    return (
      <div className="flex flex-col gap-1 bg-bg-elevated p-3">
        <dt className={dtClass}>
          {label}
          {nowTag}
        </dt>
        {value}
      </div>
    );
  return (
    // The link lives inside the `dt` and stretches over the tile with `after:inset-0`. It cannot be a child of the group `div`: a `dl`'s div group is restricted to dt/dd plus script-supporting elements exactly as the `dl` itself is, so an anchor there is invalid either way and breaks the term-to-value pairing assistive tech builds from it. A `dt` takes phrasing content, so this is the one placement that is legal, keeps the whole tile clickable, and makes the label the link's real text instead of an empty anchor wearing an aria-label.
    <div className="group relative flex flex-col gap-1 bg-bg-elevated p-3 hover:bg-surface-alt">
      <dt className={dtClass}>
        <Link
          to={dest.to}
          params={dest.params}
          {...(dest.search ? { search: dest.search } : {})}
          data-testid={`scoped-kpi-${testId}-link`}
          className="after:absolute after:inset-0 focus-visible:outline-none focus-visible:after:ring-2 focus-visible:after:ring-focus focus-visible:after:ring-inset"
        >
          {label}
        </Link>
        {nowTag}
        <ChevronRight
          className="absolute top-3 right-2 h-3.5 w-3.5 text-muted-fg opacity-0 transition-opacity group-hover:opacity-100"
          aria-hidden="true"
        />
      </dt>
      {value}
    </div>
  );
}

/**
 * Per-profile KPI strip for the scoped Home view. Renders nothing until the
 * discovery dashboard resolves (or on error) so a slow/failed discovery read
 * never blanks the overview — the realised-P/L card still shows. The discovery
 * gauge supplies deployed cost basis, the exposure cap and the rotatable-coin count; the scoreboard supplies win rate and the trade count.
 */
export function ScopedKpiStrip({ profileId }: { readonly profileId: string }): React.JSX.Element {
  const accountId = useActiveAccountId() ?? '';
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
  const ids = { accountId, profileId };
  // Realised, win rate and trades all read the closed-trade ledger, so they land on the Archive tab rather than History's default. The strip's D/W/M period does not travel with them: History's `validateSearch` accepts only `section`, so Archive applies its own window.
  const toArchive = {
    to: '/accounts/$accountId/profiles/$profileId/history',
    params: ids,
    search: { section: 'archive' },
  } as const;
  const toRisk = { to: '/accounts/$accountId/profiles/$profileId/risk', params: ids } as const;
  const toDiscovery = {
    to: '/accounts/$accountId/profiles/$profileId/discovery',
    params: ids,
  } as const;

  return (
    <section
      aria-labelledby="scoped-kpi-heading"
      data-testid="scoped-kpi-strip"
      className="@container space-y-2"
    >
      <h2
        id="scoped-kpi-heading"
        className="text-[11px] font-semibold tracking-wider text-muted-fg uppercase"
      >
        {t('home.scoped.title')}
      </h2>
      <RealisedPnlCard profileId={profileId} period={period} onPeriodChange={setPeriod} />
      {data ? (
        <>
          <div className="flex flex-wrap items-center justify-between gap-2">
            <h3 className="text-[11px] font-semibold tracking-wider text-muted-fg uppercase">
              {t('home.scoped.discovery_title')}
            </h3>
            <PnlBasisToggle basis={basis} onBasisChange={setBasis} />
          </div>
          <dl
            className="grid grid-cols-2 gap-px border border-border bg-border @3xl:grid-cols-4"
            aria-label={t('home.scoped.discovery_title')}
          >
            <KpiCell label={t('home.scoped.deployed')} testId="deployed" now dest={toRisk}>
              {formatBalanceMoney(data.gauge.deployedQuote)}
            </KpiCell>
            <KpiCell label={t('home.scoped.exposure_cap')} testId="exposure-cap" now dest={toRisk}>
              {data.gauge.maxAccountExposureQuote != null
                ? formatBalanceMoney(data.gauge.maxAccountExposureQuote)
                : '—'}
            </KpiCell>
            {/* Counts every coin discovery may rotate out, which is every UNPINNED binding — a coin the operator added and then unpinned, or one the bot re-created to recover an untracked position, counts here too. The label therefore states rotation, never provenance; the tile links to Discovery, where the pinned set is listed separately. */}
            <KpiCell
              label={t('home.scoped.auto_symbols')}
              testId="auto-symbols"
              now
              dest={toDiscovery}
            >
              {data.gauge.autoSymbolCount}
            </KpiCell>
            {/* Terminal by intent: the holdings this counts are listed further down
                this same page, so a link would point at the page you are on. */}
            <KpiCell label={t('home.scoped.holdings')} testId="holdings" now>
              {data.holdings.length}
            </KpiCell>
            <KpiCell label={t('home.scoped.realised')} testId="realised" dest={toArchive}>
              {scoreboard ? (
                basis === 'net' && scoreboard.feeBasis === 'unknown' ? (
                  <span className="text-sm text-muted-fg">Unavailable</span>
                ) : (
                  <PnlValue
                    value={basis === 'net' ? scoreboard.netProfit : scoreboard.realizedProfit}
                    unit={data.quoteAsset}
                  />
                )
              ) : (
                '—'
              )}
            </KpiCell>
            <KpiCell label={t('home.scoped.realised_7d')} testId="realised-7d" dest={toArchive}>
              {basis === 'net' && data.scoreboard.feeBasis7d === 'unknown' ? (
                <span className="text-sm text-muted-fg">Unavailable</span>
              ) : (
                <PnlValue
                  value={
                    basis === 'net' ? data.scoreboard.netProfit7d : data.scoreboard.realizedProfit7d
                  }
                  unit={data.quoteAsset}
                />
              )}
            </KpiCell>
            <KpiCell label={t('home.scoped.win_rate')} testId="win-rate" dest={toArchive}>
              {scoreboard && scoreboard.feeBasis !== 'unknown' && scoreboard.tradeCount > 0
                ? formatWinRate(scoreboard.winRate)
                : '—'}
            </KpiCell>
            <KpiCell label={t('home.scoped.trades')} testId="trades" dest={toArchive}>
              {scoreboard ? scoreboard.tradeCount : '—'}
            </KpiCell>
          </dl>
          {/* One note under the strip rather than a mark per cell: the cells hold a figure and a label with no room for a caveat, and the same reconstructed commission is behind both Realised readings, so a single sentence is the honest scope. Only under Net — the Recorded basis does not subtract fees, so no tier applies to it. */}
          {basis === 'net' &&
          (scoreboard?.feeBasis === 'estimated' || data.scoreboard.feeBasis7d === 'estimated') ? (
            <p className="text-xs text-muted-fg" data-testid="scoped-fees-estimated">
              A commission in these Net figures was reconstructed from Binance's rate table rather
              than the charge it reported, so they are estimates.
            </p>
          ) : null}
          {bySource.length > 0 ? (
            <section
              data-testid="scoped-by-source"
              aria-label={t('home.scoped.by_source_title')}
              className="space-y-2"
            >
              <div>
                <h3 className="text-[11px] font-semibold tracking-wider text-muted-fg uppercase">
                  {t('home.scoped.by_source_title')}
                </h3>
                <p className="text-xs text-muted-fg">{t('home.scoped.by_source_desc')}</p>
              </div>
              <ul className="space-y-2 border border-border bg-bg-elevated p-3">
                {bySource.map((b) => (
                  <li
                    key={b.source}
                    className="space-y-0.5"
                    data-testid={`scoped-source-${b.source}`}
                  >
                    <div className="flex items-center justify-between gap-3 text-xs">
                      <span className="min-w-0 flex-1 truncate text-muted-fg">
                        {sourceLabel(b.source)}
                      </span>
                      <span className="w-24 text-right font-mono tabular-nums">
                        {basis === 'net' && b.feeBasis === 'unknown' ? (
                          <span className="text-muted-fg">Unavailable</span>
                        ) : (
                          <PnlValue
                            value={basis === 'net' ? b.netProfit : b.realizedProfit}
                            unit={data.quoteAsset}
                          />
                        )}
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
