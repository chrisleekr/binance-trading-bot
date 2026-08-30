// /profiles/$profileId/history — the profile's trade history, one page with
// four tabs: Archive (closed-trade rollup + Binance backfill + P/L by exit),
// Audit (what the operator changed), Logs (what the bot did and why), and
// Activity (the merged event feed). This was the HISTORY dock; it outgrew a
// 240px drawer, so it is its own page reached from the sidebar's expanded
// profile or the phone's Profiles sheet, alongside Backtest.
//
// Audit and Logs are different records and stay separate tabs: Audit answers
// "who changed this", Logs answers "why did it act". Merging them would bury the
// handful of operator actions under the worker's own volume.

import { useQuery } from '@tanstack/react-query';
import { createRoute, useNavigate } from '@tanstack/react-router';
import { useState } from 'react';

import { Page } from '@/shared/components/page';
import { ProfilePageHeader } from '@/features/profile/components/profile-page-header';
import { Tabs, TabsList, TabsTrigger } from '@/shared/components/ui/tabs';
import { t } from '@/shared/lib/i18n';
import { isOneOf, oneOf } from '@/shared/lib/search-param';
import { dashboardAggregateQueryOptions } from '@/features/dashboard/api/dashboard';
import { ActivityFeed } from '@/features/dashboard/components/activity-feed';
import { TradeArchivePanel } from '@/features/profile/components/trade-archive-panel';
import {
  AuditLogPanel,
  initialAuditPage,
  type AuditPageState,
} from '@/features/profile/components/audit-log-panel';
import { LogViewerPanel } from '@/features/profile/components/log-viewer-panel';
import { TickTracePanel } from '@/features/profile/components/tick-trace-panel';
import { profileDetailRoute } from '@/features/profile/routes/profiles.$profileId';

type Tab = 'archive' | 'audit' | 'logs' | 'activity';

/**
 * `?section=` makes a tab linkable and reloadable. Named `section`, not `view`:
 * TanStack merges search-param types router-wide, and the Backtest route already
 * owns a `view` whose values are a different set.
 */
export interface HistorySearch {
  section?: Tab;
}

const TAB_IDS = ['archive', 'audit', 'logs', 'activity'] as const;
const isTab = isOneOf(TAB_IDS);

const TABS: readonly {
  id: Tab;
  labelKey:
    'history.tab.archive' | 'history.tab.audit' | 'history.tab.logs' | 'history.tab.activity';
}[] = [
  { id: 'archive', labelKey: 'history.tab.archive' },
  { id: 'audit', labelKey: 'history.tab.audit' },
  { id: 'logs', labelKey: 'history.tab.logs' },
  { id: 'activity', labelKey: 'history.tab.activity' },
];

function HistoryPage(): React.JSX.Element {
  const { accountId, profileId } = historyRoute.useParams();
  const navigate = useNavigate();
  // The tab lives in the URL rather than component state: a bookmarked audit
  // view has to come back as the audit view, and the docs capture addresses each
  // tab by URL rather than by clicking through.
  // Re-validated at the read site rather than trusted from validateSearch —
  // see `oneOf` for why the router cannot strip an unrecognised value.
  const tab = oneOf(historyRoute.useSearch().section, TAB_IDS, 'archive');
  const setTab = (next: Tab): void => {
    void navigate({ to: '.', search: { section: next }, replace: true });
  };

  const aggregate = useQuery({
    ...dashboardAggregateQueryOptions(accountId),
    enabled: accountId !== '',
  });
  const rows = (aggregate.data?.profiles ?? []).filter((p) => p.profileId === profileId);

  return (
    <Page className="space-y-4">
      <ProfilePageHeader profileId={profileId} title="History" />

      <Tabs value={tab} onValueChange={(v) => setTab(v as Tab)}>
        <TabsList aria-label="History view">
          {TABS.map((entry) => (
            <TabsTrigger key={entry.id} value={entry.id} data-testid={`history-tab-${entry.id}`}>
              {t(entry.labelKey)}
            </TabsTrigger>
          ))}
        </TabsList>
      </Tabs>

      {tab === 'archive' ? (
        <TradeArchivePanel profileId={profileId} />
      ) : tab === 'audit' ? (
        <HistoryAuditTab profileId={profileId} />
      ) : tab === 'logs' ? (
        <div className="space-y-4">
          <LogViewerPanel profileId={profileId} />
          <TickTracePanel profileId={profileId} symbol={null} />
        </div>
      ) : (
        <ActivityFeed rows={rows} />
      )}
    </Page>
  );
}

/** Audit tab: owns the filter + pagination state the AuditLogPanel needs. */
function HistoryAuditTab({ profileId }: { profileId: string }): React.JSX.Element {
  const [events, setEvents] = useState<readonly string[]>([]);
  const [page, setPage] = useState<AuditPageState>(initialAuditPage);

  const toggleEvent = (kind: string): void => {
    setEvents((prev) => (prev.includes(kind) ? prev.filter((e) => e !== kind) : [...prev, kind]));
    setPage(initialAuditPage);
  };
  const clearEvents = (): void => {
    setEvents([]);
    setPage(initialAuditPage);
  };
  const onNext = (nextCursor: string): void => {
    setPage((p) => ({ cursor: nextCursor, history: [...p.history, p.cursor] }));
  };
  const onBack = (): void => {
    setPage((p) => {
      const last = p.history.at(-1);
      if (last === undefined) return p;
      return { cursor: last, history: p.history.slice(0, -1) };
    });
  };

  return (
    <AuditLogPanel
      profileId={profileId}
      events={events}
      onToggleEvent={toggleEvent}
      onClearEvents={clearEvents}
      page={page}
      onNext={onNext}
      onBack={onBack}
    />
  );
}

export const historyRoute = createRoute({
  staticData: { title: 'History' },
  getParentRoute: () => profileDetailRoute,
  path: 'history',
  component: HistoryPage,
  // An unknown value falls back to the default rather than erroring, so a stale
  // link still lands somewhere useful.
  validateSearch: (search: Record<string, unknown>): HistorySearch =>
    isTab(search['section']) ? { section: search['section'] } : {},
});
