// Paginated grid-trade archive for one profile: period selector, the recovery
// nudge, the per-row Delete confirm, and cursor pagination. Rendered as the
// Archive tab of the profile History page.
//
// Recovery, two states: coins not yet backfilled show in the actionable
// "Recover all" warning (a fan-out over the per-symbol backfill that polls
// until the set drains). Coins a backfill already tried and could not rebuild
// move to a quiet, non-actionable note with a reason, so an unrecoverable coin
// explains itself instead of nagging in the warning forever. Each note coin can
// be hidden (server-side, per profile) and revealed again via "Show hidden". The
// free-text form is an advanced fallback for a coin traded entirely outside the bot.
//
// Cursor pagination because new archive entries land continuously while the
// operator pages through; an offset would re-show or skip rows.

import { skipToken, useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { useEffect, useRef, useState } from 'react';

import { Eye, Trash2 } from 'lucide-react';

import { ActionBanner, type ActionBannerState } from '@/shared/components/action-banner';
import { FormActions } from '@/shared/components/form-actions';
import { RowActions } from '@/shared/components/row-actions';
import { Alert, AlertDescription, AlertTitle } from '@/shared/components/ui/alert';
import { Button } from '@/shared/components/ui/button';
import { Input } from '@/shared/components/ui/input';
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogHeader,
  DialogTitle,
} from '@/shared/components/ui/dialog';
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from '@/shared/components/ui/table';
import { Badge } from '@/shared/components/ui/badge';
import { PnlPercent, PnlValue, UnavailablePnl } from '@/shared/components/pnl-value';
import { PnlBasisToggle } from '@/shared/components/pnl-basis-toggle';
import {
  ArchivePeriodPicker,
  EMPTY_RANGE,
  rangeBounds,
  type CustomRange,
  type PeriodChoice,
} from '@/features/profile/components/archive-period-picker';
import { EdgeGrid } from '@/features/profile/components/edge-grid';
import { HistoryEquityCard } from '@/features/profile/components/history-equity-card';
import { HistoryVerdict } from '@/features/profile/components/history-verdict';
import { useCursorPager } from '@/shared/hooks/use-cursor-pager';
import { usePnlBasis, type PnlBasis } from '@/shared/hooks/use-pnl-basis';
import { errorMessage } from '@/shared/lib/api';
import { formatAmount, formatHoldDuration } from '@/shared/lib/format';
import { formatInstant } from '@/shared/lib/format-time';
import { exitIntentLabel, glossExitIntent } from '@/shared/lib/gloss-exit-intent';
import { sourceLabel } from '@/shared/lib/rollup-stats';
import { accountSettingsQueryOptions } from '@/features/account/api/account-settings';
import {
  archiveExportUrl,
  backfillTradeArchive,
  deleteArchiveEntry,
  dismissUnreconstructable,
  fetchProfileArchive,
  type ArchiveFilter,
} from '@/features/profile/api/archive';
import {
  holdMsOf,
  rowPnl,
  sharesOfPnl,
  unavailablePnlGlyph,
  unavailablePnlLabel,
} from '@/features/profile/lib/archive-view-model';
import {
  ArchiveCompactList,
  ArchiveCompactSkeleton,
} from '@/features/profile/components/archive-compact-list';
import { ArchiveDetailSheet } from '@/features/profile/components/archive-detail-sheet';

import { SymbolSource } from '@app/contracts';

import type {
  ArchiveSort,
  ArchiveSortDir,
  TradeArchiveResponse,
  UnreconstructableReason,
} from '@app/contracts';
import { TableSkeleton } from '@/shared/components/page-skeleton';

/** Plain-language reason a coin's closed P/L can't be reconstructed from Binance history. */
function glossUnreconstructable(reason: UnreconstructableReason): string {
  switch (reason) {
    case 'orphan-sells':
      return 'sold without a recorded buy — the buy predates the bot';
    case 'overshoot':
      return 'sold more than was bought here — surplus from a pre-history position';
    case 'open-or-pre-history':
      return 'an open or pre-history position with no closed cycle';
    case 'symbol-unavailable':
      return 'Binance no longer lists this coin, so its history can no longer be read';
  }
}

/**
 * A ledger column header that orders the whole selection, not the page.
 *
 * Module level because `react/no-unstable-nested-components` is armed: a component declared inside the panel's render body is a new type on every render, so React unmounts and remounts its subtree — which on WebKit clamps the ledger's scroll position on every poll.
 *
 * @param label - Column heading.
 * @param sortKey - The key this header orders by.
 * @param sort - The key currently ordering the ledger.
 * @param dir - Its direction, rendered as the arrow and announced through `aria-sort`.
 * @param onSortBy - Applies this header's key.
 * @returns The header cell.
 */
function SortHeader({
  label,
  sortKey,
  sort,
  dir,
  onSortBy,
}: {
  readonly label: string;
  readonly sortKey: ArchiveSort;
  readonly sort: ArchiveSort;
  readonly dir: ArchiveSortDir;
  readonly onSortBy: (key: ArchiveSort) => void;
}): React.JSX.Element {
  const active = sort === sortKey;
  return (
    <TableHead
      className="text-right"
      aria-sort={active ? (dir === 'desc' ? 'descending' : 'ascending') : 'none'}
    >
      <button
        type="button"
        onClick={() => onSortBy(sortKey)}
        data-testid={`archive-sort-${sortKey}`}
        className="min-h-11 w-full text-right hover:text-fg focus-visible:ring-2 focus-visible:ring-focus focus-visible:outline-none"
      >
        {label}
        {active ? (dir === 'desc' ? ' ▼' : ' ▲') : ''}
      </button>
    </TableHead>
  );
}

/**
 * What the active row filter narrowed the ledger to, in the operator's words.
 *
 * @param filter - The applied filter, at most one dimension of it set.
 * @returns A sentence fragment naming the dimension and its value, or null when nothing is filtered.
 */
function filterLabel(filter: ArchiveFilter): string | null {
  if (filter.exitIntent !== undefined) return `exit reason: ${glossExitIntent(filter.exitIntent)}`;
  if (filter.source !== undefined) return `source: ${sourceLabel(filter.source)}`;
  if (filter.symbol !== undefined) return `coin: ${filter.symbol}`;
  return null;
}

export function TradeArchivePanel({ profileId }: { profileId: string }): React.JSX.Element {
  const queryClient = useQueryClient();
  // TimezoneProvider owns the request; this observer reads the same query state so the archive cannot run against its temporary UTC fallback.
  const settings = useQuery({ ...accountSettingsQueryOptions, enabled: false });
  const timeZone = settings.isSuccess ? settings.data.timezone : undefined;

  const { basis, setBasis } = usePnlBasis();
  const [period, setPeriod] = useState<PeriodChoice>('a');
  // The custom window's two edges, kept while a preset is in force so switching back to `Custom` returns the operator to the range they built rather than to a blank pair.
  const [range, setRange] = useState<CustomRange>(EMPTY_RANGE);
  // Which rows the ledger shows, and in what order. Server-side, not a client filter over the page: the ledger is paged, so filtering what arrived would hide matching rows on every page but the current one and call the result "3 stop-loss exits".
  const [filter, setFilter] = useState<ArchiveFilter>({});
  const [sort, setSort] = useState<ArchiveSort>('archivedAt');
  const [dir, setDir] = useState<ArchiveSortDir>('desc');
  const pager = useCursorPager();
  // A summary row that narrows the ledger brings the result into view. A ref avoids putting a second, competing piece of view state in the URL beside `?section=`.
  const ledgerRef = useRef<HTMLDivElement | null>(null);
  const [confirming, setConfirming] = useState<TradeArchiveResponse | null>(null);
  // Tracked by id and re-read from the current page, so the open sheet follows a basis toggle and a background refetch instead of freezing the row as it was when clicked.
  const [detailId, setDetailId] = useState<string | null>(null);
  const [banner, setBanner] = useState<ActionBannerState | null>(null);
  const [backfillSymbol, setBackfillSymbol] = useState('');
  // While a recover-all is in flight the worker reconstructs in the background,
  // so the list polls until the missing-coin set drains (or a coin that has no
  // complete round-trip stalls it out — see the timeout in the effect below).
  const [recovering, setRecovering] = useState(false);
  // Reveal operator-hidden unreconstructable coins (local view toggle; the
  // hidden state itself is server-side per profile).
  const [showHidden, setShowHidden] = useState(false);

  // Everything that scopes the read, in one object the key and the request are both built from — so a new filter cannot reach the server without also reaching the cache key. `'full'` is in it explicitly: a rollup response and a full one are different answers to the same URL, and this component renders a page. No collision exists today only because the rollup callers happen to use a different key root, which is not an invariant anything enforces.
  const selection = {
    // `'a'` under a custom window, not the last preset: the server falls back to `period`'s own start for an edge the range leaves open, so carrying a stale `'w'` here would silently floor an open-ended `from` at this week rather than at the beginning of the archive.
    period: period === 'custom' ? ('a' as const) : period,
    cursor: pager.cursor,
    tz: timeZone ?? '',
    view: 'full' as const,
    sort,
    dir,
    ...rangeBounds(period, range),
    ...filter,
  };
  const queryKey = ['profile', 'archive', profileId, { ...selection, tz: timeZone }];

  const list = useQuery({
    queryKey,
    // The full view, explicitly: every default below depends on it.
    queryFn: timeZone === undefined ? skipToken : () => fetchProfileArchive(profileId, selection),
    refetchInterval: recovering ? 3000 : false,
  });

  // These two defaults are safe ONLY because the query above always asks for the full view, so a response reaching this component always carried a page. Under `rollup` they would be a lie of the kind the line below refuses: `[]` would claim the window holds no trades and `null` would claim end-of-stream, neither of which a rollup-only read checked. If this query ever takes its view from a prop, these have to branch on `undefined` too.
  const items = list.data?.items ?? [];
  const nextCursor = list.data?.nextCursor ?? null;
  // Left possibly-undefined on purpose, never defaulted to `[]`. Absent means this response did not compute the set; `[]` means it did and every coin is accounted for. Only the second is evidence a recovery finished, so collapsing them would let a response that answered a different question close out a recovery that has not happened.
  const recoverableSymbols = list.data?.recoverableSymbols;
  const unreconstructableSymbols = list.data?.unreconstructableSymbols ?? [];
  const unreconstructableVisible = unreconstructableSymbols.filter((u) => !u.dismissed);
  const unreconstructableHidden = unreconstructableSymbols.filter((u) => u.dismissed);
  // The window the server resolved for this period, echoed back so the curve below plots exactly the range these rollups were taken over.
  const windowFrom = list.data?.from;
  const windowTo = list.data?.to;
  // Read once, so the chip that says what is filtered and the export that carries the filter can never disagree.
  const activeFilter = filterLabel(filter);
  const byIntent = list.data?.byIntent ?? [];
  const bySource = list.data?.bySource ?? [];
  // Basis resolved once per row, so the amount cell and the percent cell beside
  // it can never disagree about which P/L they are showing.
  const rows = items.map((row) => ({ ...row, pnl: rowPnl(row, basis) }));

  // Stop polling when the recoverable set drains (each coin either archived or
  // moved to the "no recoverable history" note), or after a 45s lull. The
  // timeout re-arms whenever the set shrinks, so genuine progress keeps polling.
  useEffect(() => {
    if (!recovering) return;
    // An empty ARRAY ends the recovery; an absent one does not.
    if (recoverableSymbols?.length === 0) {
      const finish = setTimeout(() => {
        setRecovering(false);
        // Keep a partial-failure banner when some coins did not enqueue.
        setBanner((b) => (b?.kind === 'err' ? b : { kind: 'ok', message: 'Recovery finished.' }));
      }, 0);
      return () => clearTimeout(finish);
    }
    const stop = setTimeout(() => setRecovering(false), 45_000);
    return () => clearTimeout(stop);
  }, [recovering, recoverableSymbols?.length]);

  // Collapse the "Show hidden" reveal once the hidden set empties, so a future
  // hide doesn't re-open it already expanded from stale local state.
  useEffect(() => {
    if (unreconstructableHidden.length !== 0) return;
    const collapse = setTimeout(() => setShowHidden(false), 0);
    return () => clearTimeout(collapse);
  }, [unreconstructableHidden.length]);

  const onRecoverAll = async (): Promise<void> => {
    if (recovering || recoverableSymbols === undefined || recoverableSymbols.length === 0) return;
    const targets = recoverableSymbols;
    setRecovering(true);
    setBanner(null);
    const results = await Promise.allSettled(
      targets.map((s) => backfillTradeArchive(profileId, s)),
    );
    const failed = results.filter((r) => r.status === 'rejected').length;
    if (failed > 0) {
      setBanner({
        kind: 'err',
        message: `${failed} of ${targets.length} could not start — they stay listed; try again.`,
      });
    }
    await queryClient.invalidateQueries({ queryKey: ['profile', 'archive', profileId] });
  };

  // Show the rows selected from an edge summary. `scrollIntoView` is optional-called because the test DOM does not implement it.
  const scrollToLedger = (): void => {
    ledgerRef.current?.scrollIntoView?.({ block: 'start' });
  };

  const onPeriodChange = (next: PeriodChoice): void => {
    setPeriod(next);
    pager.reset();
  };

  // Both the keyset boundary and the derived-sort offset name a position in one particular set, so either one addresses nothing once the window moves. The server refuses a replayed offset with a 422 rather than mis-paging, which would surface here as the ledger's generic load failure; resetting is what keeps that from being reachable at all.
  const onRangeChange = (next: CustomRange): void => {
    setRange(next);
    pager.reset();
  };

  // One filter at a time, replacing rather than intersecting: two dimensions ANDed together produce empty results the operator cannot explain, and the chip that says what is applied has room to say one thing honestly.
  const applyFilter = (next: ArchiveFilter): void => {
    setFilter(next);
    pager.reset();
    scrollToLedger();
  };
  const onFilterExit = (exitIntent: string): void => applyFilter({ exitIntent });
  const onFilterSource = (source: string): void => {
    // The rollup ships `source` as a free string because the column is text with a CHECK rather than an enum, while the filter the API accepts is one of three values. A value outside that set could only come from a row written by something that is not this bot, and sending it would fail validation and blank the page — so the tile stays inert rather than taking the ledger down.
    const parsed = SymbolSource.safeParse(source);
    if (parsed.success) applyFilter({ source: parsed.data });
  };

  // The P/L column's sort key follows the basis it is showing, so changing the basis has to move an active sort with it. Left alone, the header's arrow and `aria-sort` vanished while the rows kept the other key's order — a table sorted by a column that says it is not — and the pager's cursor addressed a sequence the request no longer asks for.
  const onBasisChange = (next: PnlBasis): void => {
    setBasis(next);
    const moved = next === 'net' ? 'netProfit' : 'profit';
    const from = next === 'net' ? 'profit' : 'netProfit';
    if (sort === from) setSort(moved);
    pager.reset();
  };

  // Descending first on every key: each one answers "which is biggest / newest", and an ascending first click would open on the least interesting row.
  const onSortBy = (key: ArchiveSort): void => {
    if (sort === key) setDir((d) => (d === 'desc' ? 'asc' : 'desc'));
    else {
      setSort(key);
      setDir('desc');
    }
    pager.reset();
  };

  const remove = useMutation({
    mutationFn: (archiveId: string) => deleteArchiveEntry(profileId, archiveId),
    onSuccess: async () => {
      setBanner({ kind: 'ok', message: 'Entry removed.' });
      setConfirming(null);
      await queryClient.invalidateQueries({ queryKey: ['profile', 'archive', profileId] });
    },
    onError: (err) => {
      setBanner({ kind: 'err', message: errorMessage(err) });
    },
  });

  const backfill = useMutation({
    mutationFn: (symbol: string) => backfillTradeArchive(profileId, symbol),
    onSuccess: async () => {
      // The worker reconstructs in the background; rows appear once it finishes.
      setBanner({
        kind: 'ok',
        message: `Backfill started for ${backfillSymbol.toUpperCase()}. Reconstructed trades appear here shortly.`,
      });
      setBackfillSymbol('');
      await queryClient.invalidateQueries({ queryKey: ['profile', 'archive', profileId] });
    },
    onError: (err) => {
      setBanner({ kind: 'err', message: errorMessage(err) });
    },
  });

  const dismiss = useMutation({
    mutationFn: (v: { symbol: string; dismissed: boolean }) =>
      dismissUnreconstructable(profileId, v.symbol, v.dismissed),
    onSuccess: async () => {
      await queryClient.invalidateQueries({ queryKey: ['profile', 'archive', profileId] });
    },
    onError: (err) => {
      setBanner({ kind: 'err', message: errorMessage(err) });
    },
  });

  return (
    <div className="space-y-4">
      <div className="flex flex-wrap items-start gap-x-4 gap-y-2">
        <ArchivePeriodPicker
          choice={period}
          range={range}
          onChoiceChange={onPeriodChange}
          onRangeChange={onRangeChange}
          from={windowFrom}
          to={windowTo}
          timeZone={timeZone ?? 'UTC'}
        />
        <PnlBasisToggle basis={basis} onBasisChange={onBasisChange} />
      </div>

      <HistoryVerdict buckets={bySource} basis={basis} />

      {windowFrom !== undefined && windowTo !== undefined ? (
        <HistoryEquityCard profileId={profileId} from={windowFrom} to={windowTo} />
      ) : null}

      {/* Actionable warning: only coins we haven't yet found unrecoverable. */}
      {recoverableSymbols !== undefined && recoverableSymbols.length > 0 ? (
        <Alert variant="warning" data-testid="archive-missing-nudge">
          <AlertTitle>Trade history incomplete</AlertTitle>
          <AlertDescription className="space-y-3">
            <p>
              {recoverableSymbols.length} coin
              {recoverableSymbols.length === 1 ? ' has' : 's have'} fills on Binance but no saved
              profit/loss here. Recover {recoverableSymbols.length === 1 ? 'it' : 'them'} in one
              click.
            </p>
            {/* The sweep enumerates RUNNING profiles only, so a paused profile
                never self-repairs. Promising an automatic retry without that
                caveat leaves the operator waiting on a pass that never runs. */}
            <p className="text-xs">
              While this profile is running, the bot also retries by itself every 15 minutes. A
              paused profile is not retried.
            </p>
            <ul className="flex flex-wrap gap-1.5" data-testid="missing-symbol-chips">
              {recoverableSymbols.map((s) => (
                <li key={s}>
                  <Badge variant="outline" data-testid={`missing-symbol-${s}`}>
                    {s}
                  </Badge>
                </li>
              ))}
            </ul>
            <Button
              type="button"
              variant="default"
              size="sm"
              disabled={recovering}
              onClick={() => void onRecoverAll()}
              data-testid="recover-all"
            >
              {recovering ? 'Recovering…' : `Recover all ${recoverableSymbols.length}`}
            </Button>
          </AlertDescription>
        </Alert>
      ) : null}

      {/* Quiet, non-actionable note: coins a backfill already tried and could
          not rebuild. Neutral styling (not a warning) and NO recover button —
          there is nothing to do, just an honest reason so they are not silently
          dropped. */}
      {unreconstructableVisible.length > 0 || unreconstructableHidden.length > 0 ? (
        <div
          className="space-y-2 rounded-md border border-border p-3"
          data-testid="archive-unreconstructable-note"
        >
          {unreconstructableVisible.length > 0 ? (
            <>
              <p className="text-xs text-muted-fg">
                {unreconstructableVisible.length} coin
                {unreconstructableVisible.length === 1 ? ' has' : 's have'} fills with no
                reconstructable closed profit/loss — there is no complete buy → sell cycle to
                recover.
              </p>
              <ul className="space-y-1" data-testid="unreconstructable-list">
                {unreconstructableVisible.map((u) => (
                  <li
                    key={u.symbol}
                    className="flex items-baseline gap-2 text-xs"
                    data-testid={`unreconstructable-${u.symbol}`}
                  >
                    <Badge variant="secondary" className="shrink-0">
                      {u.symbol}
                    </Badge>
                    <span className="flex-1 text-muted-fg">{glossUnreconstructable(u.reason)}</span>
                    <button
                      type="button"
                      onClick={() => dismiss.mutate({ symbol: u.symbol, dismissed: true })}
                      disabled={dismiss.isPending}
                      aria-label={`Hide ${u.symbol}`}
                      title="Hide"
                      data-testid={`unreconstructable-hide-${u.symbol}`}
                      className="shrink-0 px-1 text-muted-fg hover:text-fg focus-visible:ring-2 focus-visible:ring-focus focus-visible:outline-none"
                    >
                      ✕
                    </button>
                  </li>
                ))}
              </ul>
            </>
          ) : null}

          {unreconstructableHidden.length > 0 ? (
            <div className="space-y-1">
              <button
                type="button"
                onClick={() => setShowHidden((s) => !s)}
                data-testid="unreconstructable-show-hidden"
                className="text-xs text-muted-fg hover:text-fg focus-visible:ring-2 focus-visible:ring-focus focus-visible:outline-none"
              >
                {showHidden ? '▾ Hidden' : '▸ Show hidden'} ({unreconstructableHidden.length})
              </button>
              {showHidden ? (
                <ul className="space-y-1" data-testid="unreconstructable-hidden-list">
                  {unreconstructableHidden.map((u) => (
                    <li
                      key={u.symbol}
                      className="flex items-baseline gap-2 text-xs opacity-70"
                      data-testid={`unreconstructable-hidden-${u.symbol}`}
                    >
                      <Badge variant="outline" className="shrink-0">
                        {u.symbol}
                      </Badge>
                      <span className="flex-1 text-muted-fg">
                        {glossUnreconstructable(u.reason)}
                      </span>
                      <button
                        type="button"
                        onClick={() => dismiss.mutate({ symbol: u.symbol, dismissed: false })}
                        disabled={dismiss.isPending}
                        aria-label={`Show ${u.symbol} again`}
                        title="Show again"
                        data-testid={`unreconstructable-unhide-${u.symbol}`}
                        className="shrink-0 px-1 text-muted-fg hover:text-fg focus-visible:ring-2 focus-visible:ring-focus focus-visible:outline-none"
                      >
                        ↺
                      </button>
                    </li>
                  ))}
                </ul>
              ) : null}
            </div>
          ) : null}
        </div>
      ) : null}

      {/* Fallback for a coin traded entirely outside the bot: it has no
          `applied_fills` row, so it never appears in the nudge list above. */}
      <details className="rounded-md border border-border p-3" data-testid="backfill-advanced">
        <summary className="cursor-pointer text-sm font-medium text-fg">
          Recover a specific coin
        </summary>
        <form
          className="mt-2 space-y-2"
          onSubmit={(e) => {
            e.preventDefault();
            const symbol = backfillSymbol.trim().toUpperCase();
            if (symbol.length > 0 && !backfill.isPending) backfill.mutate(symbol);
          }}
        >
          <p className="text-xs text-muted-fg">
            Rebuilds completed trades from your Binance trade history for one coin not in the list
            above. Safe to re-run. The coin need not still be active.
          </p>
          <div className="flex gap-2">
            <Input
              value={backfillSymbol}
              onChange={(e) => setBackfillSymbol(e.target.value)}
              placeholder="e.g. WLDUSDT"
              aria-label="Symbol to backfill"
              data-testid="backfill-symbol"
              className="max-w-[12rem] uppercase"
            />
            <Button
              type="submit"
              variant="outline"
              size="sm"
              disabled={backfillSymbol.trim().length === 0 || backfill.isPending}
              data-testid="backfill-submit"
            >
              {backfill.isPending ? 'Starting…' : 'Backfill'}
            </Button>
          </div>
        </form>
      </details>

      <EdgeGrid
        dimension="intent"
        title="P/L by exit reason"
        rows={sharesOfPnl(byIntent, basis)}
        basis={basis}
        labelOf={(b) => glossExitIntent(b.intent)}
        valueOf={(b) => b.intent}
        onSelect={onFilterExit}
      />

      <EdgeGrid
        dimension="source"
        title="P/L by source"
        rows={sharesOfPnl(bySource, basis)}
        basis={basis}
        labelOf={(b) => sourceLabel(b.source)}
        valueOf={(b) => b.source}
        onSelect={onFilterSource}
      />

      {/* Above the ledger, not inside it: a filter that matched nothing still has to be visible and clearable, and it is exactly then that the ledger renders nothing at all. */}
      <div className="flex flex-wrap items-center justify-between gap-2">
        <div className="flex items-center gap-2">
          <p className="text-sm font-medium text-fg">Trades</p>
          {activeFilter === null ? null : (
            <span
              className="flex items-center gap-1 rounded-md bg-bg-elevated px-2 py-1 text-xs text-muted-fg"
              data-testid="archive-filter-chip"
            >
              {activeFilter}
              <Button
                type="button"
                variant="ghost"
                size="sm"
                onClick={() => applyFilter({})}
                data-testid="archive-filter-clear"
              >
                Clear
              </Button>
            </span>
          )}
        </div>
        {/* An anchor the browser navigates, not a fetch: the response is a streamed attachment, and buffering it through JS would hold the file in memory and lose the server's filename. `download` is advisory here — the server sends its own content-disposition. */}
        {/* Withheld until the zone resolves, the same gate the list read is behind. `selection.tz` stands in an empty string meanwhile, which the export route refuses at its boundary, so a link rendered now is one that answers a 422 to the one click it invites. */}
        {timeZone === undefined ? (
          <span className="text-xs text-muted-fg" data-testid="archive-export-pending">
            Export these trades
          </span>
        ) : (
          <a
            href={archiveExportUrl(profileId, selection)}
            download
            className="text-xs text-muted-fg underline underline-offset-2 hover:text-fg"
            data-testid="archive-export"
          >
            Export these trades
          </a>
        )}
      </div>

      {settings.isPending || list.isLoading ? (
        <>
          {/* Two placeholders, one per breakpoint, matching the two renders of the loaded list below. Only one is ever in the accessibility tree: `hidden` is display:none, so the other's `role="status"` is not announced. */}
          <div className="md:hidden" data-testid="archive-card-skeleton">
            <ArchiveCompactSkeleton />
          </div>
          <div className="hidden md:block" data-testid="archive-table-skeleton">
            <TableSkeleton />
          </div>
        </>
      ) : null}

      {settings.error ? (
        <Alert variant="danger">
          <AlertTitle>Could not load display settings</AlertTitle>
          <AlertDescription>
            Trade history needs your saved timezone before it can load.
          </AlertDescription>
        </Alert>
      ) : null}

      {list.error ? (
        <Alert variant="danger">
          <AlertTitle>Failed to load archive</AlertTitle>
          <AlertDescription>
            {list.error instanceof Error ? list.error.message : 'unknown'}
          </AlertDescription>
        </Alert>
      ) : null}

      {list.isSuccess && items.length === 0 ? (
        <p className="text-sm text-muted-fg" data-testid="archive-empty">
          {activeFilter === null
            ? 'No archive entries for this period.'
            : `No trades in this period with ${activeFilter}.`}
        </p>
      ) : null}

      {items.length > 0 ? (
        <div className="space-y-4" ref={ledgerRef} data-testid="archive-ledger">
          {/* Below md the nine-column table is a horizontal scroll strip, so the same rows render compactly with the full figures one tap away. `rows` is passed through rather than re-derived so both renders read the same basis. */}
          <div className="md:hidden">
            <ArchiveCompactList
              profileId={profileId}
              rows={rows}
              timeZone={timeZone}
              onDelete={setConfirming}
            />
          </div>
          <div className="hidden rounded-md border border-border md:block">
            <Table data-testid="archive-list" className="text-xs">
              <TableHeader>
                <TableRow>
                  <SortHeader
                    label="Symbol"
                    sortKey="symbol"
                    sort={sort}
                    dir={dir}
                    onSortBy={onSortBy}
                  />
                  <TableHead>Exit</TableHead>
                  <TableHead className="text-right">Buy</TableHead>
                  <TableHead className="text-right">Sell</TableHead>
                  {/* The P/L header orders by whichever P/L it is showing, so the column and its ordering cannot disagree about which number is biggest. */}
                  <SortHeader
                    label={basis === 'net' ? 'Net P/L' : 'Recorded P/L'}
                    sortKey={basis === 'net' ? 'netProfit' : 'profit'}
                    sort={sort}
                    dir={dir}
                    onSortBy={onSortBy}
                  />
                  <TableHead className="text-right">PnL%</TableHead>
                  <TableHead className="text-right" title="Commission paid to Binance, per asset">
                    <div className="leading-tight">
                      Fees
                      {/* Always-visible gloss: a hover title is invisible on touch
                        screens, so the explanation must render inline too. */}
                      <span className="block text-[11px] font-normal text-muted-fg">
                        commission paid to Binance
                      </span>
                    </div>
                  </TableHead>
                  <SortHeader
                    label="Held"
                    sortKey="holdMs"
                    sort={sort}
                    dir={dir}
                    onSortBy={onSortBy}
                  />
                  <SortHeader
                    label="Time"
                    sortKey="archivedAt"
                    sort={sort}
                    dir={dir}
                    onSortBy={onSortBy}
                  />
                  <TableHead className="w-10 text-right" />
                </TableRow>
              </TableHeader>
              <TableBody>
                {rows.map((row) => (
                  <TableRow key={row.id}>
                    <TableCell className="font-medium text-fg">{row.symbol}</TableCell>
                    <TableCell>
                      <Badge
                        variant={row.exitIntent === 'grid-stop-loss' ? 'danger' : 'secondary'}
                        title={glossExitIntent(row.exitIntent)}
                        data-testid={`archive-exit-${row.id}`}
                      >
                        {exitIntentLabel(row.exitIntent)}
                      </Badge>
                    </TableCell>
                    <TableCell
                      className="text-right font-mono text-muted-fg tabular-nums"
                      data-testid={`archive-buy-${row.id}`}
                    >
                      {formatAmount(row.totalBuyQuote)}
                      <span className="ml-1 text-muted-fg">{row.quoteAsset}</span>
                    </TableCell>
                    <TableCell
                      className="text-right font-mono text-muted-fg tabular-nums"
                      data-testid={`archive-sell-${row.id}`}
                    >
                      {formatAmount(row.totalSellQuote)}
                      <span className="ml-1 text-muted-fg">{row.quoteAsset}</span>
                    </TableCell>
                    <TableCell
                      className="text-right font-mono tabular-nums"
                      data-testid={`archive-profit-${row.id}`}
                    >
                      {row.pnl.available ? (
                        <>
                          <PnlValue value={row.pnl.pnl} unit={row.quoteAsset} />
                          {/* Abbreviated because it sits in a numeric table column, but still a word rather than a tint: `title` carries the full sentence for anyone who stops on it, and a screen reader reads the abbreviation aloud instead of skipping a colour. */}
                          {row.pnl.estimated ? (
                            <span
                              className="ml-1 text-[11px] text-muted-fg"
                              title="A commission in this total was reconstructed from Binance's rate table rather than the charge it reported."
                              data-testid={`archive-pnl-estimated-${row.id}`}
                            >
                              est
                            </span>
                          ) : null}
                        </>
                      ) : (
                        <UnavailablePnl
                          testId={`archive-pnl-unavailable-${row.id}`}
                          glyph={unavailablePnlGlyph(row.pnl.reason)}
                          description={unavailablePnlLabel(row.pnl.reason)}
                        />
                      )}
                    </TableCell>
                    <TableCell
                      className="text-right font-mono tabular-nums"
                      data-testid={`archive-percent-${row.id}`}
                    >
                      {row.pnl.available ? (
                        <PnlPercent value={row.pnl.pnlPercent} />
                      ) : (
                        <span className="text-muted-fg">—</span>
                      )}
                    </TableCell>
                    <TableCell
                      className="text-right font-mono text-muted-fg tabular-nums"
                      data-testid={`archive-fees-${row.id}`}
                    >
                      {Object.keys(row.fees).length === 0
                        ? '—'
                        : Object.entries(row.fees).map(([asset, amount]) => (
                            <div key={asset}>
                              {formatAmount(amount)} <span className="text-muted-fg">{asset}</span>
                            </div>
                          ))}
                    </TableCell>
                    <TableCell
                      className="text-right font-mono whitespace-nowrap text-muted-fg tabular-nums"
                      data-testid={`archive-hold-${row.id}`}
                      title={
                        row.entryAt === null
                          ? 'This cycle was rebuilt from Binance history, which carries no open time.'
                          : undefined
                      }
                    >
                      {formatHoldDuration(holdMsOf(row))}
                    </TableCell>
                    <TableCell className="text-right font-mono whitespace-nowrap text-muted-fg tabular-nums">
                      {timeZone === undefined ? null : formatInstant(row.archivedAt, timeZone)}
                    </TableCell>
                    <TableCell className="text-right">
                      <RowActions
                        label={`Actions for ${row.symbol} archive entry`}
                        testId={`archive-row-actions-${row.id}`}
                        actions={[
                          {
                            key: 'details',
                            label: 'View details',
                            icon: <Eye className="h-4 w-4" aria-hidden="true" />,
                            onSelect: () => setDetailId(row.id),
                            testId: `archive-details-${row.id}`,
                          },
                          {
                            key: 'delete',
                            label: 'Delete',
                            icon: <Trash2 className="h-4 w-4" aria-hidden="true" />,
                            destructive: true,
                            onSelect: () => setConfirming(row),
                            testId: `archive-delete-${row.id}`,
                          },
                        ]}
                      />
                    </TableCell>
                  </TableRow>
                ))}
              </TableBody>
            </Table>
          </div>
        </div>
      ) : null}

      {/* The desktop table's counterpart to the compact list's sheet. Both render the same component; only one of the two lists is ever mounted, because the choice between them is a CSS one. */}
      <ArchiveDetailSheet
        profileId={profileId}
        row={rows.find((r) => r.id === detailId) ?? null}
        timeZone={timeZone}
        onClose={() => setDetailId(null)}
      />

      <ActionBanner banner={banner} />

      {items.length > 0 ? (
        <div className="flex items-center justify-between">
          <Button
            type="button"
            variant="ghost"
            size="default"
            onClick={pager.back}
            disabled={!pager.canGoBack}
          >
            ‹ Prev
          </Button>
          <span className="font-mono text-xs text-muted-fg tabular-nums">
            Page {pager.pageNumber}
          </span>
          <Button
            type="button"
            variant="ghost"
            size="default"
            onClick={() => {
              if (nextCursor) pager.next(nextCursor);
            }}
            disabled={nextCursor === null}
          >
            Next ›
          </Button>
        </div>
      ) : null}

      <Dialog
        open={confirming !== null}
        onOpenChange={(o) => {
          if (!o && !remove.isPending) setConfirming(null);
        }}
      >
        <DialogContent>
          <DialogHeader>
            <DialogTitle>Delete archive entry?</DialogTitle>
            <DialogDescription>
              {confirming && timeZone !== undefined
                ? `${confirming.symbol} archived ${formatInstant(confirming.archivedAt, timeZone)}. This is audit-logged and cannot be undone.`
                : null}
            </DialogDescription>
          </DialogHeader>
          <FormActions>
            <Button
              type="button"
              variant="ghost"
              disabled={remove.isPending}
              onClick={() => setConfirming(null)}
            >
              Cancel
            </Button>
            <Button
              type="button"
              variant="destructive"
              disabled={remove.isPending}
              onClick={() => {
                if (confirming) remove.mutate(confirming.id);
              }}
            >
              {remove.isPending ? 'Deleting…' : 'Confirm'}
            </Button>
          </FormActions>
        </DialogContent>
      </Dialog>
    </div>
  );
}
