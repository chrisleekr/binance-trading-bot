// Controlled audit-log panel for one profile: the query, the category-grouped
// filter popover, per-row payload rendering, cursor pagination UI, the NDJSON
// export button, and the retention footer.
//
// Controlled: the caller owns the filter (`events`) and pagination (`page`)
// state and passes the toggle/clear/next/back handlers. The profile History
// page's Audit tab keeps that state in local component state.
// Cursor pagination because audit_logs receives writes between page-flips; an
// offset would re-show or skip rows.

import { useQuery } from '@tanstack/react-query';
import { Link } from '@tanstack/react-router';

import { Alert, AlertDescription, AlertTitle } from '@/shared/components/ui/alert';
import { Button } from '@/shared/components/ui/button';
import { Popover, PopoverContent, PopoverTrigger } from '@/shared/components/ui/popover';
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from '@/shared/components/ui/table';
import { cn } from '@/shared/lib/cn';
import { useActiveAccountId } from '@/shared/lib/account-scope';
import { formatInstant } from '@/shared/lib/format-time';
import { useTimezone } from '@/shared/context/timezone-context';
import { auditLogsExportUrl, fetchProfileAuditLogs } from '@/features/profile/api/audit-logs';
import {
  fetchRetentionStatus,
  retentionStatusQueryKey,
} from '@/features/profile/api/retention-status';
import { recommendationLabel } from '@/shared/lib/technicals-format';

import { titleCase } from '@app/contracts';
import { TableSkeleton } from '@/shared/components/page-skeleton';

/**
 * Event kinds whose payload carries a single `symbol`. When an audit row
 * matches one of these AND its payload has a string `symbol`, the row's
 * title links to that symbol's detail page so the audit log becomes a
 * navigable workflow rather than a flat list. `bulk-manual-order` is
 * excluded on purpose — its payload describes many symbols at once and
 * the link would be misleading.
 */
const SYMBOL_LINK_EVENTS: ReadonlySet<string> = new Set([
  'add-symbol',
  'archive-grid-trade',
  'cancel-order',
  'delete-archive',
  'delete-avg-entry-price',
  'disable-symbol',
  'enable-symbol',
  'manual-order',
  // The codebase emits per-symbol config edits as either `set-symbol-config`
  // or `reset-symbol-config` (apps/api/src/routes/symbols.ts); the prior
  // generic `reset-config` would never have matched a real row.
  'reset-symbol-config',
  'set-symbol-config',
  'reset-grid-trade',
  'set-avg-entry-price',
  'trigger-buy',
  'trigger-sell',
]);

/** Pull a string `symbol` from the audit payload, if shaped that way. */
function symbolFromPayload(payload: unknown): string | null {
  if (payload === null || typeof payload !== 'object') return null;
  const s = (payload as { symbol?: unknown }).symbol;
  return typeof s === 'string' && s.length > 0 ? s : null;
}

/**
 * Curated quick-filter events grouped by category. The panel surfaces these
 * through a single category-grouped multi-select popover so the strip doesn't
 * grow into a 20+ chip wall that wraps on desktop and overflows on mobile.
 * Other event kinds reach the filter through URL editing only — these are the
 * operationally common ones an operator scans for when investigating a state
 * change.
 */
const EVENT_CATEGORIES: readonly {
  readonly label: string;
  readonly events: readonly string[];
}[] = [
  {
    label: 'Orders',
    events: ['manual-order', 'bulk-manual-order', 'trigger-buy', 'trigger-sell', 'cancel-order'],
  },
  {
    label: 'Profile',
    events: [
      'start-profile',
      'stop-profile',
      'kill-switch-on',
      'kill-switch-off',
      'switch-strategy',
      'add-profile',
      'add-api-key',
    ],
  },
  {
    label: 'Symbols',
    events: [
      'add-symbol',
      'enable-symbol',
      'disable-symbol',
      'set-symbol-config',
      'reset-symbol-config',
      'reset-config',
    ],
  },
  { label: 'Position', events: ['set-avg-entry-price', 'delete-avg-entry-price'] },
];

/** Flat list of every event the popover catalogue knows about. Anything not
 * in here is rendered as an "extra" pill so URL-driven filters stay visible. */
const QUICK_FILTER_EVENTS: readonly string[] = EVENT_CATEGORIES.flatMap((c) => c.events);

export interface AuditPageState {
  readonly cursor: string | null;
  // Stack of cursors so Previous retraces the operator's path. The current
  // page's cursor isn't on the stack, it's `cursor`.
  readonly history: readonly (string | null)[];
}

export const initialAuditPage: AuditPageState = { cursor: null, history: [] };

/**
 * Specialised Technicals block. Renders a compact line summarising why
 * the strategy fired a force-sell this tick, so the operator does not have
 * to read the raw payload JSON. Mounted above the generic AuditPayload list
 * when the tick's payload carries a `technicals` key (produced by the strategy's
 * own `extractAudit`; for trailing-trade see `extractTTAudit`). Buy-gate vetoes
 * are not surfaced here: that "why no buy" answer rides the on-change
 * `entry-blocker` action_log, not a per-tick audit row.
 */
function TechnicalsAuditBlock({
  payload,
}: {
  readonly payload: Record<string, unknown>;
}): React.JSX.Element | null {
  const tv = payload['technicals'];
  if (typeof tv !== 'object' || tv === null) return null;
  const forceSell = (tv as Record<string, unknown>)['forceSell'] as
    | Record<string, unknown>
    | undefined;
  if (!forceSell) return null;
  return (
    <div
      // A force-sell triggers a real MARKET SELL: a danger (red) accent.
      className="border-danger border-l-2 pl-2 text-xs"
      data-testid="audit-technicals"
    >
      {forceSell ? (
        <p className="text-warning">
          <span className="font-medium">Technicals force-sell</span>
          {': '}
          {typeof forceSell['interval'] === 'string' ? `${forceSell['interval']} ` : ''}
          {recommendationLabel(forceSell['recommendation'])}
          {(() => {
            const win = forceSell['useOnlyWithinMin'];
            const age = forceSell['ageMs'];
            const winText = typeof win === 'number' ? `${win} min window` : null;
            const ageText =
              typeof age === 'number' ? `signal ${Math.round(age / 60_000)}m old` : null;
            if (winText && ageText) return ` (${winText}, ${ageText})`;
            if (winText) return ` (${winText})`;
            if (ageText) return ` (${ageText})`;
            return '';
          })()}
        </p>
      ) : null}
    </div>
  );
}

/** Render one audit payload value: scalars verbatim, objects/arrays as compact JSON. */
function renderAuditValue(value: unknown): string {
  if (value === null) return 'null';
  if (typeof value === 'object') return JSON.stringify(value);
  return String(value);
}

/**
 * Audit entry metadata as a readable key/value list rather than a raw
 * `JSON.stringify` blob — an operator scans an audit trail, not parses it.
 * An object payload renders as humanised-key rows; a bare scalar or array
 * still renders (compact) rather than vanishing; null / empty renders nothing.
 * `dt`/`dd` stay block-flow (no grid/flex) so the term/definition pairing
 * survives for assistive tech. Keys are humanised through the shared
 * `titleCase` so acronyms read correctly (`ttlSeconds` to "TTL Seconds").
 */
function AuditPayload({ payload }: { readonly payload: unknown }): React.JSX.Element | null {
  if (payload === undefined || payload === null) return null;
  if (typeof payload !== 'object' || Array.isArray(payload)) {
    return (
      <p className="text-muted-fg break-all font-mono text-xs" data-testid="audit-payload">
        {renderAuditValue(payload)}
      </p>
    );
  }
  // `profileId` is dropped: this panel is already scoped to one profile, so the
  // same id on every row is noise.
  const entries = Object.entries(payload as Record<string, unknown>).filter(
    ([key]) => key !== 'profileId',
  );
  if (entries.length === 0) return null;
  return (
    <dl className="space-y-0.5 text-xs" data-testid="audit-payload">
      {entries.map(([key, value]) => (
        <div key={key}>
          <dt className="text-muted-fg mr-3 inline-block w-32 align-top">{titleCase(key)}</dt>
          <dd className="inline break-all font-mono">{renderAuditValue(value)}</dd>
        </div>
      ))}
    </dl>
  );
}

/**
 * Single-line summary of one prune cron's last receipt. "Never run" when
 * the worker has not yet committed since its last restart. Pure
 * presentation; the data fetch lives here so the panel only pays for one
 * extra HTTP poll regardless of receipt count.
 */
function RetentionFooter(): React.JSX.Element | null {
  const q = useQuery({
    queryKey: retentionStatusQueryKey(),
    queryFn: fetchRetentionStatus,
    // The receipt only changes once per cron tick (default: daily). A 60s
    // poll is plenty so the operator sees the new sweep without holding
    // a manual refresh.
    refetchInterval: 60_000,
    staleTime: 60_000,
  });
  if (q.isLoading) return null;
  if (q.error || !q.data) {
    // Surface the failure rather than silently dropping the footer — the
    // audit view is the operator's only "is retention healthy" view.
    return (
      <p className="text-muted-fg pt-2 text-xs" data-testid="audit-retention-footer">
        Retention status unavailable
      </p>
    );
  }
  const describe = (
    label: string,
    r: { ranAtMs: number; deleted: number; retentionDays: number } | null,
  ): string => {
    if (r === null) return `${label}: never run`;
    const ageS = Math.max(0, Math.floor((Date.now() - r.ranAtMs) / 1_000));
    const age =
      ageS < 60
        ? `${ageS}s ago`
        : ageS < 3600
          ? `${Math.floor(ageS / 60)}m ago`
          : `${Math.floor(ageS / 3600)}h ago`;
    return `${label}: ${r.deleted} pruned ${age} (retain ${r.retentionDays}d)`;
  };
  return (
    <p className="text-muted-fg pt-2 text-xs" data-testid="audit-retention-footer">
      {describe('Audit', q.data.auditPrune)} · {describe('Action log', q.data.actionLogPrune)}
    </p>
  );
}

/**
 * Controlled audit-log panel. The caller owns the filter and pagination state;
 * this component owns the query, the filter popover UI, the table, the export
 * button, and the retention footer. `events` is the active filter (sorted by
 * the caller is not required — the query key sorts a copy); `onToggleEvent` /
 * `onClearEvents` mutate it; `page` plus `onNext` / `onBack` drive cursor
 * pagination.
 */
export function AuditLogPanel({
  profileId,
  events,
  onToggleEvent,
  onClearEvents,
  page,
  onNext,
  onBack,
}: {
  readonly profileId: string;
  readonly events: readonly string[];
  readonly onToggleEvent: (kind: string) => void;
  readonly onClearEvents: () => void;
  readonly page: AuditPageState;
  readonly onNext: (nextCursor: string) => void;
  readonly onBack: () => void;
}): React.JSX.Element {
  const timeZone = useTimezone();
  const accountId = useActiveAccountId() ?? '';
  // Stable key part: a sorted copy so two filter arrays describing the same
  // set share a cache entry.
  const eventsKey = events.slice().sort().join(',');

  const list = useQuery({
    queryKey: ['profile', 'audit-logs', profileId, page.cursor, eventsKey],
    queryFn: () => fetchProfileAuditLogs(profileId, page.cursor, events),
  });

  const items = list.data?.items ?? [];
  const nextCursor = list.data?.nextCursor ?? null;

  return (
    <div className="space-y-4">
      <div className="flex flex-wrap items-center justify-between gap-3">
        <AuditFilterControl events={events} onToggle={onToggleEvent} onClear={onClearEvents} />
        <div className="flex items-center gap-3">
          {/* The export is deliberately the complete log, not the on-screen
              filter (a partial audit trail would be misleading). Say so when a
              filter is active so the operator isn't surprised by the contents. */}
          {events.length > 0 ? (
            <span className="text-muted-fg text-xs" data-testid="audit-export-note">
              Exports the complete log, not the current filter.
            </span>
          ) : null}
          {/* `asChild` renders the real <a download> with the button styling —
              the browser owns the streaming export response, and the single
              <a> is valid HTML (no nested interactive elements). */}
          <Button asChild variant="default" size="sm">
            <a
              href={auditLogsExportUrl(accountId, profileId)}
              download
              data-testid="audit-export-link"
              title="Downloads the complete audit log as NDJSON, regardless of the filter above."
            >
              Export NDJSON
            </a>
          </Button>
        </div>
      </div>

      {list.isLoading ? <TableSkeleton /> : null}

      {list.error ? (
        <Alert variant="danger">
          <AlertTitle>Failed to load audit log</AlertTitle>
          <AlertDescription>
            {list.error instanceof Error ? list.error.message : 'unknown'}
          </AlertDescription>
        </Alert>
      ) : null}

      {list.isSuccess && items.length === 0 ? (
        <p className="text-muted-fg text-sm">No audit entries for this profile.</p>
      ) : null}

      {items.length > 0 ? (
        <div className="border-border rounded-md border">
          <Table data-testid="audit-list" className="text-xs">
            <TableHeader>
              <TableRow>
                <TableHead>Timestamp</TableHead>
                <TableHead>Event</TableHead>
              </TableRow>
            </TableHeader>
            <TableBody>
              {items.map((item) => {
                const symbol = SYMBOL_LINK_EVENTS.has(item.event)
                  ? symbolFromPayload(item.payload)
                  : null;
                const hasPayload = item.payload !== undefined && item.payload !== null;
                return (
                  <TableRow key={item.id} className="border-b-0 align-top">
                    {/* UTC anchor plus the operator's configured zone, so the
                        same audit row reads identically across deployments
                        regardless of browser locale. */}
                    <TableCell className="text-muted-fg w-44 whitespace-nowrap font-mono tabular-nums">
                      {formatInstant(item.createdAt, timeZone)}
                    </TableCell>
                    <TableCell className="border-border space-y-1 border-b">
                      {symbol !== null ? (
                        <Link
                          to="/accounts/$accountId/profiles/$profileId/symbols/$symbol"
                          params={{ accountId, profileId, symbol }}
                          className="text-fg font-medium underline-offset-2 hover:underline"
                          data-testid="audit-row-symbol-link"
                        >
                          {titleCase(item.event)} · {symbol}
                        </Link>
                      ) : (
                        <span className="text-fg font-medium">{titleCase(item.event)}</span>
                      )}
                      {typeof item.payload === 'object' && item.payload !== null ? (
                        <TechnicalsAuditBlock payload={item.payload as Record<string, unknown>} />
                      ) : null}
                      {hasPayload ? <AuditPayload payload={item.payload} /> : null}
                    </TableCell>
                  </TableRow>
                );
              })}
            </TableBody>
          </Table>
        </div>
      ) : null}

      {items.length > 0 ? (
        <div className="flex items-center justify-between">
          <Button
            type="button"
            variant="ghost"
            size="default"
            onClick={onBack}
            disabled={page.history.length === 0}
          >
            ‹ Prev
          </Button>
          <span className="text-muted-fg font-mono text-xs tabular-nums">
            Page {page.history.length + 1}
          </span>
          <Button
            type="button"
            variant="ghost"
            size="default"
            onClick={() => {
              if (nextCursor) onNext(nextCursor);
            }}
            disabled={nextCursor === null}
          >
            Next ›
          </Button>
        </div>
      ) : null}

      <RetentionFooter />
    </div>
  );
}

/**
 * Filter control above the audit list. A single popover trigger replaces the
 * previous 20+ chip strip (which wrapped on desktop and overflowed on
 * mobile); inside, events are grouped by category (Orders / Profile /
 * Symbols / Position) so the operator can scan by intent instead of
 * eyeballing a flat alphabet. Currently-active filters render as removable
 * pills next to the trigger so the active set stays visible without opening
 * the popover.
 */
function AuditFilterControl({
  events,
  onToggle,
  onClear,
}: {
  readonly events: readonly string[];
  readonly onToggle: (kind: string) => void;
  readonly onClear: () => void;
}): React.JSX.Element {
  const anyActive = events.length > 0;
  return (
    <div data-testid="audit-filter-chips" className="flex flex-wrap items-center gap-1.5">
      <Popover>
        <PopoverTrigger asChild>
          <button
            type="button"
            data-testid="audit-filter-popover-trigger"
            aria-haspopup="dialog"
            className={cn(
              'border-border hover:text-fg inline-flex shrink-0 items-center gap-1.5 whitespace-nowrap rounded-full border px-2.5 py-0.5 text-xs',
              anyActive ? 'bg-bg-elevated text-fg' : 'text-muted-fg',
            )}
          >
            <span>Events</span>
            {anyActive ? (
              <span
                aria-label={`${events.length} filter${events.length === 1 ? '' : 's'} active`}
                className="bg-accent text-accent-fg inline-flex h-4 min-w-4 items-center justify-center rounded-full px-1 text-xs font-medium"
              >
                {events.length}
              </span>
            ) : null}
          </button>
        </PopoverTrigger>
        <PopoverContent
          align="start"
          className="w-72 p-3"
          data-testid="audit-filter-popover-content"
        >
          <div className="flex items-center justify-between pb-2">
            <span className="text-muted-fg text-xs">Filter events</span>
            <button
              type="button"
              onClick={onClear}
              disabled={!anyActive}
              data-testid="audit-filter-chip-clear-all"
              className="text-muted-fg hover:text-fg text-xs underline disabled:cursor-not-allowed disabled:opacity-50"
            >
              Clear all
            </button>
          </div>
          <div className="max-h-80 space-y-3 overflow-y-auto">
            {EVENT_CATEGORIES.map((cat) => (
              <fieldset key={cat.label} className="space-y-1">
                <legend className="text-muted-fg text-xs font-medium">{cat.label}</legend>
                <div className="grid grid-cols-1 gap-1">
                  {cat.events.map((kind) => {
                    const active = events.includes(kind);
                    return (
                      <label
                        key={kind}
                        className="hover:bg-bg-elevated flex cursor-pointer items-center gap-2 rounded px-1.5 py-1 text-xs"
                      >
                        <input
                          type="checkbox"
                          checked={active}
                          onChange={() => onToggle(kind)}
                          data-testid={`audit-filter-checkbox-${kind}`}
                          className="accent-accent size-3.5"
                        />
                        <span>{titleCase(kind)}</span>
                      </label>
                    );
                  })}
                </div>
              </fieldset>
            ))}
          </div>
        </PopoverContent>
      </Popover>
      {/* Active filters surface as removable pills so the current selection
          stays visible without opening the popover. Includes both catalogued
          events and URL-only "extra" events. */}
      {events.map((kind) => (
        <button
          key={kind}
          type="button"
          onClick={() => onToggle(kind)}
          data-testid={
            QUICK_FILTER_EVENTS.includes(kind)
              ? `audit-filter-chip-active-${kind}`
              : `audit-filter-chip-extra-${kind}`
          }
          aria-label={`Remove filter ${titleCase(kind)}`}
          className="ring-fg/40 bg-accent text-accent-fg inline-flex shrink-0 items-center gap-1 whitespace-nowrap rounded-full border border-transparent px-2.5 py-0.5 text-xs ring-1"
        >
          <span>{titleCase(kind)}</span>
          <span aria-hidden="true" className="text-accent-fg/80">
            ×
          </span>
        </button>
      ))}
    </div>
  );
}
