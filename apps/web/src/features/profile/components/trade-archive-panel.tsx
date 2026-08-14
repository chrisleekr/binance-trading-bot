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

import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { useEffect, useState } from 'react';

import { Trash2 } from 'lucide-react';

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
import { Tabs, TabsList, TabsTrigger } from '@/shared/components/ui/tabs';
import { Badge } from '@/shared/components/ui/badge';
import { PnlValue } from '@/shared/components/pnl-value';
import { PnlBasisToggle } from '@/shared/components/pnl-basis-toggle';
import { RollupStatsLine } from '@/shared/components/rollup-stats-line';
import { usePnlBasis } from '@/shared/hooks/use-pnl-basis';
import { errorMessage } from '@/shared/lib/api';
import { formatInstant } from '@/shared/lib/format-time';
import { useTimezone } from '@/shared/context/timezone-context';
import { exitIntentLabel, glossExitIntent } from '@/shared/lib/gloss-exit-intent';
import { sourceLabel } from '@/shared/lib/rollup-stats';
import {
  backfillTradeArchive,
  deleteArchiveEntry,
  dismissUnreconstructable,
  fetchProfileArchive,
} from '@/features/profile/api/archive';

import type { ArchivePeriod, TradeArchiveResponse, UnreconstructableReason } from '@app/contracts';
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

const PERIODS: readonly { value: ArchivePeriod; label: string }[] = [
  { value: 'a', label: 'All time' },
  { value: 'd', label: 'Today' },
  { value: 'w', label: 'This week' },
  { value: 'm', label: 'This month' },
];

interface PageState {
  readonly cursor: string | null;
  readonly history: readonly (string | null)[];
}

const initialPage: PageState = { cursor: null, history: [] };

/**
 * One bucket's share of all closing P/L for its quote coin, as a whole-number
 * percent of the absolute-P/L total (so losers and winners both count toward
 * the denominator and the shares read honestly). This is a display ratio, not
 * a money value, so plain Number parsing is fine here; the P/L itself always
 * renders from the verbatim decimal string via PnlValue.
 */
function intentShare(
  buckets: readonly { quoteAsset: string; profitSum: string }[],
  bucket: { quoteAsset: string; profitSum: string },
): number {
  const total = buckets
    .filter((b) => b.quoteAsset === bucket.quoteAsset)
    .reduce((sum, b) => sum + Math.abs(Number(b.profitSum)), 0);
  if (total === 0) return 0;
  return Math.round((Math.abs(Number(bucket.profitSum)) / total) * 100);
}

/**
 * Stand-in for a P/L the bot could not work out. A cycle whose sale had no
 * recorded purchase price contributes nothing to `profit`, so the stored number
 * is an under-count — and an under-count of zero renders as a confident
 * "+0.00", turning a real trade into a flat one. Say the number is missing
 * instead of showing one nobody measured.
 *
 * Module-level, not nested in the panel's render body: a component declared
 * inside another's render remounts its whole subtree on every render.
 */
function UnavailablePnl({ testId }: { readonly testId?: string }): React.JSX.Element {
  return (
    <span className="text-[11px] font-normal text-muted-fg italic" data-testid={testId}>
      P/L unavailable
    </span>
  );
}

export function TradeArchivePanel({ profileId }: { profileId: string }): React.JSX.Element {
  const queryClient = useQueryClient();
  const timeZone = useTimezone();

  const { basis, setBasis } = usePnlBasis();
  const [period, setPeriod] = useState<ArchivePeriod>('a');
  const [page, setPage] = useState<PageState>(initialPage);
  const [confirming, setConfirming] = useState<TradeArchiveResponse | null>(null);
  const [banner, setBanner] = useState<ActionBannerState | null>(null);
  const [backfillSymbol, setBackfillSymbol] = useState('');
  // While a recover-all is in flight the worker reconstructs in the background,
  // so the list polls until the missing-coin set drains (or a coin that has no
  // complete round-trip stalls it out — see the timeout in the effect below).
  const [recovering, setRecovering] = useState(false);
  // Reveal operator-hidden unreconstructable coins (local view toggle; the
  // hidden state itself is server-side per profile).
  const [showHidden, setShowHidden] = useState(false);

  const queryKey = ['profile', 'archive', profileId, period, page.cursor, timeZone];

  const list = useQuery({
    queryKey,
    queryFn: () => fetchProfileArchive(profileId, period, page.cursor, timeZone),
    refetchInterval: recovering ? 3000 : false,
  });

  const items = list.data?.items ?? [];
  const nextCursor = list.data?.nextCursor ?? null;
  const recoverableSymbols = list.data?.recoverableSymbols ?? [];
  const unreconstructableSymbols = list.data?.unreconstructableSymbols ?? [];
  const unreconstructableVisible = unreconstructableSymbols.filter((u) => !u.dismissed);
  const unreconstructableHidden = unreconstructableSymbols.filter((u) => u.dismissed);
  const byIntent = list.data?.byIntent ?? [];
  const bySource = list.data?.bySource ?? [];

  // Stop polling when the recoverable set drains (each coin either archived or
  // moved to the "no recoverable history" note), or after a 45s lull. The
  // timeout re-arms whenever the set shrinks, so genuine progress keeps polling.
  useEffect(() => {
    if (!recovering) return;
    if (recoverableSymbols.length === 0) {
      setRecovering(false);
      // Don't paint over a partial-failure banner from onRecoverAll: if some
      // coins failed to enqueue, that error stays the visible message.
      setBanner((b) => (b?.kind === 'err' ? b : { kind: 'ok', message: 'Recovery finished.' }));
      return;
    }
    const stop = setTimeout(() => setRecovering(false), 45_000);
    return () => clearTimeout(stop);
  }, [recovering, recoverableSymbols.length]);

  // Collapse the "Show hidden" reveal once the hidden set empties, so a future
  // hide doesn't re-open it already expanded from stale local state.
  useEffect(() => {
    if (unreconstructableHidden.length === 0) setShowHidden(false);
  }, [unreconstructableHidden.length]);

  const onRecoverAll = async (): Promise<void> => {
    if (recovering || recoverableSymbols.length === 0) return;
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

  const onPeriodChange = (next: ArchivePeriod): void => {
    setPeriod(next);
    setPage(initialPage);
  };

  const onNext = (): void => {
    if (!nextCursor) return;
    setPage((p) => ({ cursor: nextCursor, history: [...p.history, p.cursor] }));
  };

  const onBack = (): void => {
    setPage((p) => {
      const last = p.history.at(-1);
      if (last === undefined) return p;
      return { cursor: last, history: p.history.slice(0, -1) };
    });
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
      <div className="flex flex-wrap items-center gap-x-4 gap-y-2">
        <div className="flex items-center gap-3">
          <span className="text-xs text-muted-fg">Period</span>
          <Tabs value={period} onValueChange={(v) => onPeriodChange(v as ArchivePeriod)}>
            <TabsList>
              {PERIODS.map((p) => (
                <TabsTrigger
                  key={p.value}
                  value={p.value}
                  data-testid={`archive-period-${p.value}`}
                >
                  {p.label}
                </TabsTrigger>
              ))}
            </TabsList>
          </Tabs>
        </div>
        <PnlBasisToggle basis={basis} onBasisChange={setBasis} />
      </div>

      {/* Actionable warning: only coins we haven't yet found unrecoverable. */}
      {recoverableSymbols.length > 0 ? (
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

      {byIntent.length > 0 ? (
        <section
          className="space-y-2 rounded-md border border-border p-3"
          data-testid="archive-by-intent"
          aria-label="Profit and loss by exit reason"
        >
          <div>
            <p className="text-sm font-medium text-fg">P/L by exit reason</p>
            <p className="text-xs text-muted-fg">
              How every trade in this period closed, grouped by why it sold. Win%, PF (profit
              factor), and expectancy are all net of Binance fees — above PF 1 and positive
              expectancy makes money after costs. Share is the bucket's portion of all closing P/L
              for the quote coin.
            </p>
          </div>
          <ul className="space-y-2">
            {byIntent.map((b) => (
              <li
                key={`${b.quoteAsset}-${b.intent}`}
                className="space-y-0.5"
                data-testid={`archive-intent-${b.quoteAsset}-${b.intent}`}
              >
                <div className="flex items-center justify-between gap-3 text-xs">
                  <span className="min-w-0 flex-1 truncate text-muted-fg">
                    {glossExitIntent(b.intent)}
                  </span>
                  <span className="w-24 text-right font-mono tabular-nums">
                    <PnlValue
                      value={basis === 'net' ? b.netProfit : b.profitSum}
                      unit={b.quoteAsset}
                    />
                  </span>
                </div>
                <div className="flex items-center justify-between gap-3">
                  <RollupStatsLine bucket={b} />
                  <span className="text-[11px] text-muted-fg tabular-nums">
                    {intentShare(byIntent, b)}% of P/L
                  </span>
                </div>
              </li>
            ))}
          </ul>
        </section>
      ) : null}

      {bySource.length > 0 ? (
        <section
          className="space-y-2 rounded-md border border-border p-3"
          data-testid="archive-by-source"
          aria-label="Profit and loss by source"
        >
          <div>
            <p className="text-sm font-medium text-fg">P/L by source</p>
            <p className="text-xs text-muted-fg">
              Discovery (coins the bot auto-found) vs manual (coins you pinned) — which one is the
              edge and which is the drag. P/L follows the Net/Gross toggle; win%, PF, and expectancy
              are always net of fees.
            </p>
          </div>
          <ul className="space-y-2">
            {bySource.map((b) => (
              <li
                key={`${b.quoteAsset}-${b.source}`}
                className="space-y-0.5"
                data-testid={`archive-source-${b.quoteAsset}-${b.source}`}
              >
                <div className="flex items-center justify-between gap-3 text-xs">
                  <span className="min-w-0 flex-1 truncate text-muted-fg">
                    {sourceLabel(b.source)}
                  </span>
                  <span className="w-24 text-right font-mono tabular-nums">
                    <PnlValue
                      value={basis === 'net' ? b.netProfit : b.profitSum}
                      unit={b.quoteAsset}
                    />
                  </span>
                </div>
                <RollupStatsLine bucket={b} />
              </li>
            ))}
          </ul>
        </section>
      ) : null}

      {list.isLoading ? <TableSkeleton /> : null}

      {list.error ? (
        <Alert variant="danger">
          <AlertTitle>Failed to load archive</AlertTitle>
          <AlertDescription>
            {list.error instanceof Error ? list.error.message : 'unknown'}
          </AlertDescription>
        </Alert>
      ) : null}

      {list.isSuccess && items.length === 0 ? (
        <p className="text-sm text-muted-fg">No archive entries for this period.</p>
      ) : null}

      {/* Always-visible gloss for the "P/L unavailable" rows. A hover title is
          invisible on touch, so the explanation renders inline once above the
          table rather than per row (which would drown the list). */}
      {items.some((row) => row.missingCostBasis > 0) ? (
        <p className="text-xs text-muted-fg" data-testid="archive-pnl-unavailable-note">
          Some trades below show <span className="italic">P/L unavailable</span>: the bot has no
          record of what that coin originally cost, so it cannot work out the profit or loss. On
          those rows the Buy and Sell figures only count the part it could match, so they read low
          too, and the totals above count those trades as zero.
        </p>
      ) : null}

      {items.length > 0 ? (
        <div className="rounded-md border border-border">
          <Table data-testid="archive-list" className="text-xs">
            <TableHeader>
              <TableRow>
                <TableHead>Symbol</TableHead>
                <TableHead>Exit</TableHead>
                <TableHead className="text-right">Buy</TableHead>
                <TableHead className="text-right">Sell</TableHead>
                <TableHead className="text-right">{basis === 'net' ? 'Net PnL' : 'PnL'}</TableHead>
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
                <TableHead className="text-right">Time</TableHead>
                <TableHead className="w-10 text-right" />
              </TableRow>
            </TableHeader>
            <TableBody>
              {items.map((row) => (
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
                    {row.totalBuyQuote}
                    <span className="ml-1 text-muted-fg">{row.quoteAsset}</span>
                  </TableCell>
                  <TableCell
                    className="text-right font-mono text-muted-fg tabular-nums"
                    data-testid={`archive-sell-${row.id}`}
                  >
                    {row.totalSellQuote}
                    <span className="ml-1 text-muted-fg">{row.quoteAsset}</span>
                  </TableCell>
                  <TableCell
                    className="text-right font-mono tabular-nums"
                    data-testid={`archive-profit-${row.id}`}
                  >
                    {row.missingCostBasis > 0 ? (
                      <UnavailablePnl testId={`archive-pnl-unavailable-${row.id}`} />
                    ) : (
                      <PnlValue
                        value={basis === 'net' ? row.netProfit : row.profit}
                        unit={row.quoteAsset}
                      />
                    )}
                  </TableCell>
                  <TableCell
                    className="text-right font-mono tabular-nums"
                    data-testid={`archive-percent-${row.id}`}
                  >
                    {row.missingCostBasis > 0 ? (
                      <span className="text-muted-fg">—</span>
                    ) : (
                      <>
                        <PnlValue value={row.profitPercent} />
                        <span className="text-muted-fg">%</span>
                      </>
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
                            {amount} <span className="text-muted-fg">{asset}</span>
                          </div>
                        ))}
                  </TableCell>
                  <TableCell className="text-right font-mono whitespace-nowrap text-muted-fg tabular-nums">
                    {formatInstant(row.archivedAt, timeZone)}
                  </TableCell>
                  <TableCell className="text-right">
                    <RowActions
                      label={`Actions for ${row.symbol} archive entry`}
                      testId={`archive-row-actions-${row.id}`}
                      actions={[
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
      ) : null}

      <ActionBanner banner={banner} />

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
          <span className="font-mono text-xs text-muted-fg tabular-nums">
            Page {page.history.length + 1}
          </span>
          <Button
            type="button"
            variant="ghost"
            size="default"
            onClick={onNext}
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
              {confirming
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
