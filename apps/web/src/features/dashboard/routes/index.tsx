import { useQuery } from '@tanstack/react-query';
import { createRoute, Link, useRouter } from '@tanstack/react-router';
import { AlertTriangle, ShieldAlert } from 'lucide-react';

import { cn } from '@/shared/lib/cn';
import { PnlValue } from '@/shared/components/pnl-value';
import { PanelStackSkeleton } from '@/shared/components/page-skeleton';
import { RouteErrorCard } from '@/shared/components/route-error-card';
import { Badge } from '@/shared/components/ui/badge';
import { Button } from '@/shared/components/ui/button';
import { formatLastTick, formatTickLatency } from '@/shared/lib/format-tick';
import { t } from '@/shared/lib/i18n';
import { aggregatePositionPnl, type QuotePnl } from '@/features/dashboard/lib/aggregate-pnl';
import { dashboardAggregateQueryOptions } from '@/features/dashboard/api/dashboard';
import { EquityPnlCard } from '@/features/dashboard/components/equity-pnl-card';
import { ProfileHealthStrip } from '@/features/dashboard/components/profile-health-strip';
import { PositionsOrdersPanel } from '@/features/dashboard/components/positions-orders-panel';
import { ScopedBalances } from '@/features/dashboard/components/scoped-balances';
import { ScopedKpiStrip } from '@/features/dashboard/components/scoped-kpi-strip';
import { SymbolTable } from '@/features/dashboard/components/symbol-table';
import { MarketTrendCard } from '@/features/dashboard/components/market-trend-card';
import { TechnicalsHealthPill } from '@/features/technicals/components/technicals-health-pill';
import { InvestigateButton } from '@/features/profile/components/investigate-button';
import { ProfileManageSheet } from '@/features/profile/components/profile-manage-sheet';
import { ProfileStatus } from '@/features/profile/components/profile-status';
import { useActiveAccountId } from '@/shared/lib/account-scope';
import { useScrollAnchor } from '@/shared/lib/use-scroll-anchor';

import { accountScopeRoute } from '@/features/account/routes/account-scope';

import type { DashboardAggregateRow } from '@app/contracts';

// The dashboard lives at the account index (`/accounts/$accountId`) unfocused —
// every profile of the account — and at the per-profile route
// (`/accounts/$accountId/profiles/$profileId`) focused on one. Both render the
// same overview; `focusedProfileId` is the only difference, so the panels stay
// a single source of truth.

export const accountOverviewRoute = createRoute({
  staticData: { title: 'Dashboard' },
  getParentRoute: () => accountScopeRoute,
  path: '/',
  component: AccountOverviewPage,
  errorComponent: IndexErrorComponent,
});

function AccountOverviewPage() {
  return <DashboardOverview focusedProfileId={null} />;
}

/**
 * The dashboard body. `focusedProfileId` null shows every profile of the active
 * account (the account overview); a profileId narrows every panel to that one
 * profile (the per-profile route renders this with its route param).
 */
export function DashboardOverview({ focusedProfileId }: { focusedProfileId: string | null }) {
  const accountId = useActiveAccountId();
  const { data, error, isLoading, refetch } = useQuery({
    ...dashboardAggregateQueryOptions(accountId ?? ''),
    enabled: accountId !== null,
  });

  // WebKit/Safari never shipped scroll anchoring, so a polled reflow (a card
  // resizes on the 5-10s tick) shoves a scrolled reader off their spot while
  // Chrome absorbs it. The shim holds the top-most visible element in place.
  const scrollerRef = useScrollAnchor<HTMLDivElement>();

  if (error) {
    return (
      <RouteErrorCard
        error={error instanceof Error ? error : new Error(t('home.error.title'))}
        onRetry={() => {
          void refetch();
        }}
      />
    );
  }

  // Guard the first paint. Without it `data` is undefined during load, the
  // empty-state check below is skipped, and the full layout renders with
  // profiles=[] — a zeroed dashboard flashed before real numbers arrive.
  //
  // The placeholder carries the loaded view's scroller and padding, not just
  // its own text: the shell drops <main>'s scroll on this route, so a loading
  // branch that skips them leaves nothing scrollable under a thumb for the
  // length of the fetch. Shape mirrors the real stack — KPI strip, equity,
  // positions, symbol table.
  if (isLoading) {
    return (
      <section
        className="min-h-0 flex-1 overflow-y-auto p-4"
        aria-label={t('nav.home')}
        data-testid="dashboard-loading"
      >
        <PanelStackSkeleton shape={[2, 3, 5, 6]} />
      </section>
    );
  }

  const profiles = data?.profiles ?? [];

  if (data && profiles.length === 0) return <EmptyState />;

  // Narrow the overview to the focused profile. Null (account overview) and a
  // stale id no longer in the list both show every profile.
  const focused =
    focusedProfileId !== null && profiles.some((p) => p.profileId === focusedProfileId)
      ? focusedProfileId
      : null;
  const visible = focused === null ? profiles : profiles.filter((p) => p.profileId === focused);

  // The overview owns its own scroll+padding (the shell drops <main>'s here).
  return (
    <div
      ref={scrollerRef}
      className="min-h-0 flex-1 overflow-y-auto p-4"
      data-testid="terminal-overview"
    >
      <OverviewPanel rows={visible} focusedProfileId={focused} />
    </div>
  );
}

/** Today's home body. The terminal layout renders it verbatim when no symbol is selected. */
function OverviewPanel({
  rows: visible,
  focusedProfileId,
}: {
  rows: readonly DashboardAggregateRow[];
  focusedProfileId: string | null;
}) {
  return (
    <section className="space-y-4" aria-label={t('nav.home')}>
      <header className="flex flex-wrap items-center justify-between gap-3">
        <div className="flex items-center gap-3">
          <h1 className="text-xl font-semibold">{t('home.heading')}</h1>
          {/* Global Technicals compute-job health pill — same component the
              symbol-detail panel uses, so an operator sees an upstream throttle
              from the dashboard without having to drill into a symbol. */}
          <TechnicalsHealthPill clock={Date.now} testId="dashboard-tv-technicals-health" />
        </div>
        <div className="flex flex-wrap items-center justify-end gap-2">
          {/* Scoped to one profile: its enabled/notifier status reads here,
              on the right of the overview header where the profile is the subject. */}
          {focusedProfileId !== null ? <ProfileStatus profileId={focusedProfileId} /> : null}
          {/* "Why isn't it trading?" — a first-class action, so it is a visible
              button rather than a Manage-menu entry, and it sits here on the
              profile landing page instead of repeating on every sub-page. */}
          {focusedProfileId !== null ? <InvestigateButton profileId={focusedProfileId} /> : null}
          {/* Manage actions sit beside the status pill — one tap opens the full
              action set in the slide-over (off the glance scroll). */}
          {focusedProfileId !== null ? <ProfileManageSheet profileId={focusedProfileId} /> : null}
          {/* No New-profile button here: the action lives in the profile switcher,
              where the operator already goes to change profile. A second entry
              point in the header only competed with the trading controls. */}
        </div>
      </header>

      {/* Consolidated live-health line: replaces the two stacked red panels
          (gate + edge). One coloured line by default; expands to the full
          scorecards. The loudest alert sits right under the header. */}
      {focusedProfileId !== null ? <ProfileHealthStrip profileId={focusedProfileId} /> : null}

      {/* Single full-width column: the account band and market tape stack rather
          than sharing a row. Both are @container-aware, so their inner grids open
          up to the full page width instead of folding for a half-width cell. */}
      <SummaryBand rows={visible} />
      <MarketTrendCard />

      {/* Per-profile analytics, stacked full-width below the context band. The
          KPI strip's discovery tiles open to four columns at this width; the
          equity curve spans the row beneath them. Scoped only. */}
      {focusedProfileId !== null ? <ScopedKpiStrip profileId={focusedProfileId} /> : null}
      {focusedProfileId !== null ? <EquityPnlCard profileId={focusedProfileId} /> : null}

      {/* "Your money now": open positions + the actual resting orders. Renders
          nothing when both are empty, so it never adds a blank block. */}
      <PositionsOrdersPanel rows={visible} />

      {/* The flat symbol list is the operator's home base — every row is one
          click into that symbol. The profile roster drops below it only in
          account-overview scope; focused on one profile it would be a single
          redundant row. */}
      <SymbolTable rows={visible} focusedProfileId={focusedProfileId} />

      {/* Wallet balances span the row — the Manage actions moved to the header
          (beside the status badge). Account-overview scope renders nothing. */}
      {focusedProfileId !== null ? <ScopedBalances profileId={focusedProfileId} /> : null}

      {focusedProfileId === null ? <ProfilesPanel rows={visible} /> : null}
    </section>
  );
}

/**
 * At-a-glance account band. Unrealised P/L is the headline the operator opens
 * the app to see; the open-position and open-order counts sit beside it. P/L is grouped per quote
 * asset (no fake cross-quote sum) and never combines test and live funds into
 * a single equity number — that honesty constraint is why there is no one
 * "account value" hero here.
 */
function SummaryBand({ rows }: { rows: readonly DashboardAggregateRow[] }) {
  const openOrders = rows.reduce((sum, r) => sum + r.openOrderCount, 0);
  const positions = rows.reduce((sum, r) => sum + r.openPositionCount, 0);
  // Real money is the headline; testnet (practice) funds are never summed into
  // it. The practice line only appears when a testnet profile actually holds a
  // position, so the common live-only case stays clean.
  const livePnl = aggregatePositionPnl(
    rows.filter((r) => r.binanceMode === 'live').flatMap((r) => r.positions),
  );
  const practicePnl = aggregatePositionPnl(
    rows.filter((r) => r.binanceMode === 'test').flatMap((r) => r.positions),
  );

  return (
    // @container so the columns collapse on the band's own width, not the
    // viewport — it reads correctly in a half-width desktop grid cell. The
    // section heading aligns this band's box with the Market trend box beside it
    // (both sit below an uppercase label).
    <section className="@container space-y-2" aria-label={t('home.stats.title')}>
      <h2 className="text-[11px] font-semibold tracking-wider text-muted-fg uppercase">
        {t('home.stats.title')}
      </h2>
      {/* 1px-gap grid: the border colour shows through the gaps, so the strip
          reads as one bordered terminal band with hairline dividers (borders
          over whitespace), not three floating cards. */}
      <dl
        className="grid grid-cols-2 gap-px border border-border bg-border @2xl:grid-cols-3"
        data-testid="dashboard-order-stats"
      >
        {/* The P/L hero spans the full row on phones and one column on desktop,
            leaving positions + open-orders to fill the remaining pair. */}
        <div className="col-span-2 flex flex-col gap-1 bg-bg-elevated p-3 @2xl:col-span-1">
          <dt className="text-[11px] font-semibold tracking-wider text-muted-fg uppercase">
            {t('home.summary.unrealised')}
          </dt>
          <dd
            className="font-mono text-xl font-semibold tabular-nums"
            data-testid="dashboard-stat-unrealised"
          >
            <QuotePnlList items={livePnl} />
          </dd>
          {practicePnl.length > 0 ? (
            <dd
              className="font-mono text-xs text-muted-fg tabular-nums"
              data-testid="dashboard-stat-unrealised-practice"
            >
              <span className="font-sans">{t('home.summary.practice')} </span>
              <QuotePnlList items={practicePnl} />
            </dd>
          ) : null}
        </div>
        <Stat label={t('home.summary.positions')} testId="positions">
          {positions}
        </Stat>
        <Stat label={t('home.summary.open_orders')} testId="open-orders">
          {openOrders}
        </Stat>
      </dl>
    </section>
  );
}

/** One summary tile: a muted label over a large mono value. */
function Stat({
  label,
  testId,
  children,
  className,
}: {
  label: string;
  testId: string;
  children: React.ReactNode;
  className?: string;
}) {
  return (
    <div className={cn('flex flex-col gap-1 bg-bg-elevated p-3', className)}>
      <dt className="text-[11px] font-semibold tracking-wider text-muted-fg uppercase">{label}</dt>
      <dd
        className="font-mono text-xl font-semibold tabular-nums"
        data-testid={`dashboard-stat-${testId}`}
      >
        {children}
      </dd>
    </div>
  );
}

/** Per-quote unrealised P/L. Em-dash when flat; one labelled total per quote otherwise. */
function QuotePnlList({ items }: { items: readonly QuotePnl[] }) {
  if (items.length === 0) return <PnlValue value={null} />;
  return (
    <>
      {items.map((q, i) => (
        <span key={q.quote}>
          {i > 0 ? <span className="text-base text-muted-fg"> · </span> : null}
          <PnlValue value={q.pnl} unit={q.quote} />
        </span>
      ))}
    </>
  );
}

function ProfilesPanel({ rows }: { rows: readonly DashboardAggregateRow[] }) {
  return (
    <section aria-labelledby="profiles-heading" className="space-y-3">
      <h2
        id="profiles-heading"
        className="text-[11px] font-semibold tracking-wider text-muted-fg uppercase"
      >
        {t('home.profiles.title')}
      </h2>
      <ul
        className="divide-y divide-border border border-border bg-bg-elevated"
        data-testid="profile-cards"
      >
        {rows.map((row) => (
          <li key={row.profileId}>
            <ProfileRow row={row} />
            <AwaitingTickHint row={row} />
          </li>
        ))}
      </ul>
    </section>
  );
}

function EmptyState() {
  const router = useRouter();
  const accountId = useActiveAccountId() ?? '';
  return (
    <section
      className="mx-auto flex max-w-md flex-col items-center gap-3 border border-border bg-bg-elevated p-6 text-center"
      data-testid="home-empty"
    >
      <h2 className="text-lg font-semibold">{t('home.empty.title')}</h2>
      <p className="text-sm text-muted-fg">{t('home.empty.body')}</p>
      <Button
        variant="primary"
        onClick={() => {
          void router.navigate({ to: '/accounts/$accountId/profiles/new', params: { accountId } });
        }}
      >
        {t('home.empty.cta')}
      </Button>
    </section>
  );
}

/**
 * Inline hint rendered below a profile row when no first tick has been
 * observed yet. Three branches, in priority order:
 *
 * 1. `!apiKeyConfigured` — the operator hasn't configured a Binance key.
 *    Link to the account's /api-key route with "configure API key" copy.
 * 2. `lastTickError` is set despite an API key being present — the cold-
 *    load or first-tick attempt failed; the most actionable next step is
 *    to re-check the key's IP allowlist / permissions on the Binance side.
 * 3. Neither — silent. The row already shows "Never" in the Last tick
 *    cell, which is the right read for a brand-new profile mid-bootstrap.
 *
 * Rendered as a sibling of the row `<button>` rather than inside it; a
 * `<Link>` nested inside an interactive `<button>` is invalid HTML and
 * would not be reachable by AT in the right tab order.
 */
function AwaitingTickHint({ row }: { row: DashboardAggregateRow }) {
  const accountId = useActiveAccountId() ?? '';
  if (row.lastTickAt !== null) return null;
  const variant: 'no-key' | 'key-error' | null = !row.apiKeyConfigured
    ? 'no-key'
    : row.lastTickError !== null
      ? 'key-error'
      : null;
  if (variant === null) return null;
  const linkCopy =
    variant === 'no-key'
      ? t('home.card.last_tick.configure_key')
      : t('home.card.last_tick.check_permissions');
  return (
    <p
      data-testid={`profile-card-${row.profileId}-awaiting-hint`}
      data-variant={variant}
      className="border-t border-border px-4 py-2 text-xs text-muted-fg"
    >
      {t('home.card.last_tick.awaiting')}
      {' · '}
      <Link
        to="/accounts/$accountId/api-key"
        params={{ accountId }}
        className="text-accent underline"
        data-testid={`profile-card-${row.profileId}-awaiting-hint-link`}
      >
        {linkCopy}
      </Link>
    </p>
  );
}

/** Health-dot colour for a profile, by signal priority: kill > error > live > idle. */
function healthTone(row: DashboardAggregateRow): string {
  if (row.killSwitch || row.lastTickError !== null) return 'bg-danger';
  if (row.lastTickAt !== null) return 'bg-success';
  return 'bg-muted-fg';
}

function ProfileRow({ row }: { row: DashboardAggregateRow }) {
  const router = useRouter();
  const accountId = useActiveAccountId() ?? '';
  const pnlByQuote = aggregatePositionPnl(row.positions);
  const onOpen = (): void => {
    void router.navigate({
      to: '/accounts/$accountId/profiles/$profileId',
      params: { accountId, profileId: row.profileId },
    });
  };
  return (
    <button
      type="button"
      onClick={onOpen}
      data-testid={`profile-card-${row.profileId}`}
      aria-label={`Open profile ${row.name} — ${
        row.killSwitch
          ? 'kill-switch active'
          : row.lastTickError !== null
            ? 'tick error'
            : row.lastTickAt !== null
              ? 'ticking'
              : 'idle'
      }`}
      className="flex w-full items-center gap-3 px-4 py-3 text-left hover:bg-surface-alt focus-visible:ring-2 focus-visible:ring-focus focus-visible:outline-none focus-visible:ring-inset"
    >
      <span
        className={cn('h-2 w-2 shrink-0 rounded-full', healthTone(row))}
        aria-hidden
        title={row.killSwitch ? t('home.card.kill_switch') : undefined}
      />
      <div className="min-w-0 flex-1">
        <div className="flex flex-wrap items-center gap-2">
          <span className="truncate font-medium text-fg">{row.name}</span>
          <Badge
            variant={row.enabled ? 'secondary' : 'outline'}
            data-testid={`profile-card-${row.profileId}-state`}
          >
            {row.enabled ? t('home.card.enabled') : t('home.card.disabled')}
          </Badge>
          {/* Testnet uses practice funds; flag it so a real-money profile is
              never mistaken for it. Live renders no badge (the common case). */}
          {row.binanceMode === 'test' && (
            <Badge variant="outline" data-testid={`profile-card-${row.profileId}-testnet`}>
              {t('home.card.testnet')}
            </Badge>
          )}
          {row.killSwitch && (
            <Badge
              variant="outline"
              data-testid={`profile-card-${row.profileId}-killswitch`}
              className="gap-1 border-danger text-danger"
            >
              <ShieldAlert className="h-3 w-3" aria-hidden="true" />
              {t('home.card.kill_switch')}
            </Badge>
          )}
          {/* Disabling a profile stops it ticking but does NOT cancel its resting
              orders on Binance. Flag that dangerous half-state so the operator
              knows exposure is still live. */}
          {!row.enabled && (row.openOrderCount > 0 || row.openPositionCount > 0) && (
            <Badge
              variant="warning"
              data-testid={`profile-card-${row.profileId}-exposure`}
              className="gap-1"
            >
              <AlertTriangle className="h-3 w-3" aria-hidden="true" />
              {t('home.card.exposure_warning')}
            </Badge>
          )}
        </div>
        <p className="mt-0.5 truncate text-xs text-muted-fg">
          {formatLastTick(row.lastTickAt)} · {formatTickLatency(row.lastTickLatencyMs)} ·{' '}
          {row.openPositionCount} pos · {row.openOrderCount} orders
        </p>
      </div>
      <div
        className="shrink-0 text-right text-sm"
        data-testid={`profile-card-${row.profileId}-pnl`}
      >
        <QuotePnlList items={pnlByQuote} />
      </div>
    </button>
  );
}

function IndexErrorComponent({ error, reset }: { error: Error; reset: () => void }) {
  const router = useRouter();
  return (
    <RouteErrorCard
      error={error}
      onRetry={() => {
        reset();
        void router.invalidate();
      }}
    />
  );
}
