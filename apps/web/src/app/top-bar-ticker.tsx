// TopBarTicker — the header's live trading ticker: an electronic-board marquee
// of open-position and open-order counts, unrealised and realised-today P/L per
// quote, and each held coin with its unrealised P/L (amount + percent). Scoped
// to live+enabled profiles (practice and paused profiles never reach it). On a
// phone it degrades to a single status icon since the marquee needs the width.

import { useQueries, useQuery } from '@tanstack/react-query';
import { Activity, Clock, ListOrdered, Wallet } from 'lucide-react';
import { useEffect, useRef } from 'react';

import { buildTickerMetrics } from '@/features/dashboard/lib/build-ticker-metrics';
import { useSymbolRows } from '@/features/dashboard/lib/use-symbol-rows';
import {
  closedTradesQueryOptions,
  dashboardAggregateQueryOptions,
} from '@/features/dashboard/api/dashboard';
import { useActiveAccountId } from '@/shared/lib/account-scope';
import { useTimezone } from '@/shared/context/timezone-context';
import { PnlPercent, PnlValue } from '@/shared/components/pnl-value';
import { cn } from '@/shared/lib/cn';
import { t } from '@/shared/lib/i18n';

import type {
  CoinHolding,
  RealisedEntry,
  TickerMetrics,
} from '@/features/dashboard/lib/build-ticker-metrics';
import type { DashboardAggregateRow, ProfileDashboardSymbol } from '@app/contracts';

const ICON = 'h-3.5 w-3.5 text-muted-fg';
const LABEL = 'text-[11px] font-semibold uppercase tracking-wider text-muted-fg';
const VALUE = 'font-mono text-xs tabular-nums';

// The track is two identical halves animated by -50%, so it loops with no seam.
// Each half is TICKER_RUNS/2 copies of the run, enough that even a flat account
// (the narrowest run) overflows a wide slot so the stream never shows a blank.
const TICKER_RUNS = 8;

// Constant scroll speed. The loop distance is one half of the doubled track, so
// the per-instance animation duration is (half width / this), set from a DOM
// measurement so the crawl reads the same however many coins the stream holds.
const TICKER_SPEED_PX_PER_SEC = 80;

/** One headline metric: a lucide glyph, a label, and a value slot. */
function Metric({
  icon,
  label,
  children,
}: {
  icon: React.ReactNode;
  label: string;
  children: React.ReactNode;
}) {
  return (
    <span className="flex items-center gap-1.5">
      {icon}
      <span className={LABEL}>{label}</span>
      {children}
    </span>
  );
}

/** A per-quote P/L readout (realised or unrealised), joined by a dot. When flat,
 * render a single muted zero so the slot reads as "nothing" rather than vanishing. */
function QuotePnlRow({
  entries,
  testIdPrefix,
}: {
  entries: TickerMetrics['unrealised'];
  testIdPrefix: string;
}) {
  return (
    <span className={VALUE}>
      {entries.length === 0 ? (
        <PnlValue value="0" />
      ) : (
        entries.map((q, i) => (
          <span key={q.quote}>
            {i > 0 ? <span className="text-muted-fg"> · </span> : null}
            <PnlValue value={q.pnl} unit={q.quote} testId={`${testIdPrefix}-${q.quote}`} />
          </span>
        ))
      )}
    </span>
  );
}

/** One held coin: base symbol, unrealised P/L amount, and percent in the same
 * green-up / red-down tone. */
function Coin({ holding }: { holding: CoinHolding }) {
  return (
    <span
      className="flex items-center gap-1.5"
      data-testid={`topbar-ticker-coin-${holding.symbol}`}
    >
      <span className={cn(VALUE, 'font-semibold text-fg')}>{holding.base}</span>
      <PnlValue value={holding.pnl} unit={holding.quote} className={VALUE} />
      {holding.pnlPercent !== '' && Number(holding.pnlPercent) !== 0 ? (
        <PnlPercent value={holding.pnlPercent} className={VALUE} />
      ) : null}
    </span>
  );
}

/** One run of the marquee: the summary metrics, then a chip per held coin. */
function TickerItems({ metrics }: { metrics: TickerMetrics }) {
  return (
    <>
      <Metric icon={<Activity className={ICON} aria-hidden />} label={t('topbar.ticker.positions')}>
        <span className={cn(VALUE, 'text-fg')}>{metrics.positions}</span>
      </Metric>
      <Metric icon={<ListOrdered className={ICON} aria-hidden />} label={t('topbar.ticker.orders')}>
        <span className={cn(VALUE, 'text-fg')}>{metrics.orders}</span>
      </Metric>
      <Metric icon={<Wallet className={ICON} aria-hidden />} label={t('topbar.ticker.unrealised')}>
        <QuotePnlRow entries={metrics.unrealised} testIdPrefix="topbar-ticker-unrealised" />
      </Metric>
      <Metric icon={<Clock className={ICON} aria-hidden />} label={t('topbar.ticker.realised')}>
        <QuotePnlRow entries={metrics.realised} testIdPrefix="topbar-ticker-realised" />
      </Metric>
      {metrics.holdings.map((h) => (
        <Coin key={h.symbol} holding={h} />
      ))}
    </>
  );
}

/** Shared marquee data: live counts, realised + unrealised P/L, holdings. Counts
 * and realised come from the cached dashboard aggregate plus per-live-profile
 * closed-trades polls. Holdings and unrealised come from the same live,
 * 5s-polled per-profile dashboard the symbol table reads, so the ticker never
 * drifts from the table. React Query dedupes the shared keys, so the desktop and
 * mobile placements do not double-fetch. */
function useTickerMetrics(): TickerMetrics {
  const accountId = useActiveAccountId() ?? '';
  // "Realised today" is a day boundary — it must be the operator's day, not the
  // browser's.
  const timeZone = useTimezone();
  const { data } = useQuery({
    ...dashboardAggregateQueryOptions(accountId),
    enabled: accountId !== '',
  });
  const rows: readonly DashboardAggregateRow[] = data?.profiles ?? [];
  const liveRows = rows.filter((r) => r.binanceMode === 'live' && r.enabled);

  const closed = useQueries({
    queries: liveRows.map((r) => closedTradesQueryOptions(r.profileId, 'd', timeZone)),
  });
  const realised: RealisedEntry[] = closed.flatMap((q, i) => {
    const row = liveRows[i];
    if (!q.data || !row) return [];
    return [
      { profileId: row.profileId, quoteAsset: row.quoteAsset, totalProfit: q.data.totalProfit },
    ];
  });

  // Only live+enabled rows are fanned out, so every returned symbol belongs to a
  // live+enabled profile — no further scoping is needed downstream.
  const merged = useSymbolRows(liveRows);
  const liveSymbols: ProfileDashboardSymbol[] = merged.items.map((r) => r.sym);

  return buildTickerMetrics(rows, realised, liveSymbols);
}

/**
 * The scrolling track: TICKER_RUNS identical runs (two halves) so a -50%
 * translate loops with no seam, with the duration measured from the track width
 * for a constant pixel speed. Only the first run is exposed to assistive tech.
 */
function TickerMarquee({ metrics }: { metrics: TickerMetrics }) {
  // Re-measure only when the content's structure changes (a coin opens/closes,
  // a count or quote appears), not on every price tick, so a steady stream is
  // not restarted by routine P/L updates.
  const trackRef = useRef<HTMLDivElement>(null);
  const contentSig = [
    metrics.positions,
    metrics.orders,
    metrics.unrealised.length,
    metrics.realised.length,
    metrics.holdings.map((h) => h.symbol).join(','),
  ].join('|');
  useEffect(() => {
    const el = trackRef.current;
    if (!el) return;
    const half = el.scrollWidth / 2;
    if (half <= 0) return;
    el.style.setProperty('--ticker-duration', `${(half / TICKER_SPEED_PX_PER_SEC).toFixed(1)}s`);
  }, [contentSig]);

  return (
    <div ref={trackRef} className="flex shrink-0 animate-ticker items-center whitespace-nowrap">
      {Array.from({ length: TICKER_RUNS }, (_, i) => (
        <span
          key={i}
          aria-hidden={i > 0 ? true : undefined}
          className="flex items-center gap-4 pr-10"
        >
          <TickerItems metrics={metrics} />
        </span>
      ))}
    </div>
  );
}

/**
 * Desktop ticker: fills the empty middle slot of the header (md+). min-w-0 clips
 * the overflow so the stream reads as it scrolls.
 */
export function TopBarTicker() {
  const metrics = useTickerMetrics();
  return (
    <div
      data-testid="topbar-ticker"
      className="hidden min-w-0 flex-1 items-center overflow-hidden md:flex"
    >
      <TickerMarquee metrics={metrics} />
    </div>
  );
}

/**
 * Mobile ticker: a phone has no room for the strip inside the header, so the same
 * marquee rides a full-width bar directly under the top bar (mobile only). The
 * narrow viewport makes the content overflow, so the crawl reads cleanly.
 */
export function TopBarTickerBar() {
  const metrics = useTickerMetrics();
  return (
    <div
      data-testid="topbar-ticker-mobile"
      aria-label={t('topbar.ticker.label')}
      className="flex items-center overflow-hidden border-b border-border bg-bg-elevated px-4 py-1.5 md:hidden"
    >
      <TickerMarquee metrics={metrics} />
    </div>
  );
}
