import { useCallback, useMemo, useState } from 'react';

import { useQueries, type UseQueryResult } from '@tanstack/react-query';

import { cn } from '@/shared/lib/cn';
import { fetchProfileActionErrors } from '@/features/profile/api/action-logs';
import { fetchProfileAuditLogs } from '@/features/profile/api/audit-logs';
import {
  discoveryDashboardQueryOptions,
  fetchDiscoveryDashboard,
} from '@/features/profile/api/discovery';
import { readFailureReason } from '@/features/dashboard/lib/action-log-ctx';
import { formatLastTick } from '@/shared/lib/format-tick';
import { t } from '@/shared/lib/i18n';

import type { ActionLogEntry, AuditLogEntry, DiscoveryActivityEntry } from '@app/contracts';
import type { DashboardAggregateRow } from '@app/contracts';

/**
 * One row in the merged feed. A discriminated union so an audit row and a
 * discovery cron ADD/REMOVE row coexist in one sorted stream while rendering
 * and categorisation stay branch-clean. `time` is the ISO sort key for both
 * variants; `profileName` attributes the row in the account-wide view.
 */
type FeedItem =
  | {
      readonly kind: 'audit';
      readonly time: string;
      readonly profileName: string;
      readonly entry: AuditLogEntry;
    }
  | {
      readonly kind: 'discovery';
      readonly time: string;
      readonly profileName: string;
      readonly entry: DiscoveryActivityEntry;
    }
  | {
      readonly kind: 'error';
      readonly time: string;
      readonly profileName: string;
      readonly entry: ActionLogEntry;
    };

/** How many merged rows the account-wide feed shows. */
const FEED_LIMIT = 12;

type FeedCategory = 'trades' | 'discovery' | 'errors' | 'other';
type FeedFilter = 'all' | 'trades' | 'discovery' | 'errors';

const FILTER_CHIPS: readonly FeedFilter[] = ['all', 'trades', 'discovery', 'errors'];

/**
 * Coarse client-side bucket for one feed item, so the chips filter without a
 * server round-trip. Discovery cron rows are always discovery; otherwise the
 * audit event token decides: order events are trades, operator symbol-management
 * events are discovery-adjacent, everything else is other.
 */
function categorize(item: FeedItem): FeedCategory {
  if (item.kind === 'discovery') return 'discovery';
  if (item.kind === 'error') return 'errors';
  const event = item.entry.event;
  if (
    event === 'manual-order' ||
    event === 'trigger-buy' ||
    event === 'trigger-sell' ||
    event === 'cancel-order'
  )
    return 'trades';
  if (
    event.startsWith('discovery.') ||
    event === 'add-symbol' ||
    event === 'enable-symbol' ||
    event === 'disable-symbol' ||
    event === 'pin-symbol' ||
    event === 'unpin-symbol'
  )
    return 'discovery';
  return 'other';
}

/**
 * Turn a dotted/underscored event token (e.g. `order.placed`, `api_key.replaced`)
 * into a plain sentence-case phrase. A per-event renderer is deferred until the
 * operator needs payload detail; a readable phrase beats raw `JSON.stringify` here.
 */
function humanizeEvent(event: string): string {
  const words = event.replace(/[._-]/g, ' ').trim();
  return words.charAt(0).toUpperCase() + words.slice(1);
}

/**
 * Account-wide activity feed. Two per-profile sources merge into one stream:
 * the audit log (operator actions) and the discovery dashboard's activity
 * (cron ADD/REMOVE of auto-discovered symbols). The discovery rows make the
 * feed's Discovery chip match what the profile's discovery page shows, instead
 * of only operator symbol-management. Both sources fan out one query per
 * profile (a handful, single-account), merge, and sort by recency. Answers the
 * operator's "what did the bot do while I was away?" without drilling in.
 */
export function ActivityFeed({ rows }: { rows: readonly DashboardAggregateRow[] }) {
  const [filter, setFilter] = useState<FeedFilter>('all');

  // Each combine is memoized so useQueries re-runs it only when `rows` or a
  // query result changes, and TanStack then structurally shares the output —
  // keeping `items` referentially stable so the merge `useMemo` below holds.
  const auditCombine = useCallback(
    (queries: UseQueryResult<Awaited<ReturnType<typeof fetchProfileAuditLogs>>>[]) => {
      const items: FeedItem[] = [];
      const failedProfiles: string[] = [];
      queries.forEach((q, i) => {
        const profileName = rows[i]?.name ?? '';
        if (q.isError && profileName) failedProfiles.push(profileName);
        for (const entry of q.data?.items ?? [])
          items.push({ kind: 'audit', time: entry.createdAt, profileName, entry });
      });
      return {
        items,
        isLoading: queries.some((q) => q.isLoading),
        isError: queries.length > 0 && queries.every((q) => q.isError),
        anyError: queries.some((q) => q.isError),
        failedProfiles,
      };
    },
    [rows],
  );
  const audit = useQueries({
    queries: rows.map((r) => ({
      queryKey: ['audit-logs', r.profileId, 'recent'] as const,
      queryFn: () => fetchProfileAuditLogs(r.profileId, null),
    })),
    combine: auditCombine,
  });

  // Discovery activity is best-effort: a profile may have discovery disabled,
  // so a failure here neither blocks nor flags the feed. The audit source owns
  // the partial-load signal.
  const discoveryCombine = useCallback(
    (queries: UseQueryResult<Awaited<ReturnType<typeof fetchDiscoveryDashboard>>>[]) => {
      const items: FeedItem[] = [];
      queries.forEach((q, i) => {
        const profileName = rows[i]?.name ?? '';
        for (const entry of q.data?.activity ?? [])
          items.push({ kind: 'discovery', time: entry.time, profileName, entry });
      });
      return { items, isLoading: queries.some((q) => q.isLoading) };
    },
    [rows],
  );
  const discovery = useQueries({
    queries: rows.map((r) => discoveryDashboardQueryOptions(r.profileId)),
    combine: discoveryCombine,
  });

  // Action-log errors are best-effort, like discovery: a transient failure
  // neither blocks nor flags the feed. The audit source owns the partial
  // signal; surfacing failures here would double-count the same outage.
  const errorsCombine = useCallback(
    (queries: UseQueryResult<Awaited<ReturnType<typeof fetchProfileActionErrors>>>[]) => {
      const items: FeedItem[] = [];
      queries.forEach((q, i) => {
        const profileName = rows[i]?.name ?? '';
        for (const entry of q.data?.items ?? [])
          items.push({ kind: 'error', time: entry.time, profileName, entry });
      });
      return { items, isLoading: queries.some((q) => q.isLoading) };
    },
    [rows],
  );
  const errors = useQueries({
    queries: rows.map((r) => ({
      queryKey: ['action-errors', r.profileId, 'recent'] as const,
      queryFn: () => fetchProfileActionErrors(r.profileId),
    })),
    combine: errorsCombine,
  });

  const isLoading = audit.isLoading || discovery.isLoading || errors.isLoading;
  // One profile's audit failing must not silently vanish from an account-wide
  // feed (invariant: no silent failures). Flag a partial load so the operator
  // knows the feed is incomplete rather than empty.
  const isPartial = !audit.isError && audit.anyError;

  // Filter BEFORE truncating: slicing first would hide a matching-category row
  // whenever the newest FEED_LIMIT items all belong to another category. Memoized
  // on the three (now referentially stable) item arrays + filter so the merge and
  // sort don't re-run on every render under the 5s aggregate poll.
  const visible = useMemo(() => {
    const merged = [...audit.items, ...discovery.items, ...errors.items].sort((a, b) =>
      b.time.localeCompare(a.time),
    );
    return merged
      .filter((item) => filter === 'all' || categorize(item) === filter)
      .slice(0, FEED_LIMIT);
  }, [audit.items, discovery.items, errors.items, filter]);

  // Heading sits outside the bordered box, mirroring the ProfilesPanel beside
  // it on the dashboard so the two paired columns read as the same component.
  return (
    <section aria-labelledby="activity-heading" data-testid="activity-feed" className="space-y-3">
      <h2
        id="activity-heading"
        className="text-muted-fg text-[11px] font-semibold uppercase tracking-wider"
      >
        {t('home.activity.title')}
      </h2>
      {/* Coarse category chips. 'all' is the default and applies no filter, so
          the feed reads the same as before unless the operator narrows it. */}
      <div role="tablist" className="flex flex-wrap gap-1.5">
        {FILTER_CHIPS.map((chip) => {
          const active = filter === chip;
          return (
            <button
              key={chip}
              type="button"
              role="tab"
              aria-selected={active}
              data-testid={`activity-filter-${chip}`}
              onClick={() => setFilter(chip)}
              className={cn(
                'rounded-full border px-2.5 py-0.5 text-xs',
                active
                  ? 'border-accent bg-accent text-accent-fg'
                  : 'border-border text-muted-fg hover:text-fg',
              )}
            >
              {t(`activity.filter.${chip}`)}
            </button>
          );
        })}
      </div>
      <div className="border-border bg-bg-elevated border">
        {audit.isError ? (
          <p className="text-muted-fg px-4 py-6 text-sm">{t('home.activity.error')}</p>
        ) : isLoading ? (
          <p className="text-muted-fg px-4 py-6 text-sm">{t('home.activity.loading')}</p>
        ) : visible.length === 0 && !isPartial ? (
          <p className="text-muted-fg px-4 py-6 text-sm">{t('home.activity.empty')}</p>
        ) : (
          <>
            {isPartial ? (
              <p
                data-testid="activity-partial"
                className="border-border text-warning border-b px-4 py-2 text-xs"
              >
                ⚠ {t('home.activity.partial')}
                {audit.failedProfiles.length > 0 ? ` (${audit.failedProfiles.join(', ')})` : ''}
              </p>
            ) : null}
            <ul className="divide-border divide-y">
              {visible.map((item, i) => (
                <li
                  key={
                    item.kind === 'audit'
                      ? item.entry.id
                      : item.kind === 'discovery'
                        ? `${item.time}-${item.entry.symbol}-${item.entry.action}-${i}`
                        : `${item.time}-${item.entry.symbol ?? ''}-${item.entry.msg}-${i}`
                  }
                  className="flex items-baseline gap-3 px-4 py-2.5 text-sm"
                >
                  <span
                    className={cn(
                      'mt-1.5 inline-block h-2 w-2 shrink-0 rounded-full',
                      item.kind === 'error' ? 'bg-danger' : 'bg-muted-fg',
                    )}
                    aria-hidden
                  />
                  <span className="min-w-0 flex-1">
                    {item.kind === 'audit' ? (
                      <span className="text-fg">{humanizeEvent(item.entry.event)}</span>
                    ) : item.kind === 'error' ? (
                      <ErrorRow entry={item.entry} />
                    ) : (
                      <span className="text-fg">
                        {item.entry.action === 'add' ? 'Discovery added' : 'Discovery removed'}{' '}
                        <span className="font-mono">{item.entry.symbol}</span>
                        {item.entry.msg ? (
                          <span className="text-muted-fg"> — {item.entry.msg}</span>
                        ) : null}
                      </span>
                    )}{' '}
                    <span className="text-muted-fg">· {item.profileName}</span>
                  </span>
                  <time
                    dateTime={item.time}
                    className="text-muted-fg shrink-0 font-mono text-xs tabular-nums"
                  >
                    {formatLastTick(item.time)}
                  </time>
                </li>
              ))}
            </ul>
          </>
        )}
      </div>
    </section>
  );
}

/**
 * One failed-action row. The reason gets its own line rather than being appended
 * to the message: "1 order action failed" tells the operator nothing on its own,
 * and "insufficient balance" is the whole answer — inlining it buries the answer
 * in the noise.
 */
function ErrorRow({ entry }: { entry: ActionLogEntry }) {
  const reason = readFailureReason(entry);
  return (
    <span className="text-fg flex flex-col">
      <span>
        {entry.symbol ? <span className="font-mono">{entry.symbol} </span> : null}
        <span className="text-danger">{entry.msg}</span>
      </span>
      {reason ? <span className="text-muted-fg text-xs">{reason}</span> : null}
    </span>
  );
}
