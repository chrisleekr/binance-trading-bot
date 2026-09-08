// Everything known about one closed trade, in one sheet: its totals, how long it was held, the individual fills behind it, and whatever the operator changed while it was open.
//
// The fills and the audit entries are fetched only when the sheet opens. The list endpoint deliberately ships no `orders` — each element embeds a whole raw Binance payload — so a page of 25 rows would otherwise carry megabytes for a detail almost none of them will be asked for.

import { useQuery } from '@tanstack/react-query';

import { PnlPercent, PnlValue, UnavailablePnl } from '@/shared/components/pnl-value';
import { Skeleton } from '@/shared/components/ui/skeleton';
import {
  Sheet,
  SheetContent,
  SheetDescription,
  SheetHeader,
  SheetTitle,
} from '@/shared/components/ui/sheet';
import { formatAmount, formatHoldDuration } from '@/shared/lib/format';
import { formatInstant } from '@/shared/lib/format-time';
import { glossExitIntent } from '@/shared/lib/gloss-exit-intent';
import { fetchArchiveDetail } from '@/features/profile/api/archive';
import { AUDIT_LOG_MAX_LIMIT, fetchProfileAuditLogs } from '@/features/profile/api/audit-logs';
import {
  holdMsOf,
  unavailablePnlGlyph,
  unavailablePnlLabel,
  type RowPnl,
} from '@/features/profile/lib/archive-view-model';

import type { TradeArchiveResponse } from '@app/contracts';

/** One archive row with its basis-resolved P/L, as the ledger renders it. */
export type ArchiveDetailRow = TradeArchiveResponse & { readonly pnl: RowPnl };

/**
 * One labelled line of the sheet's summary list.
 *
 * A `<dt>`/`<dd>` pair rather than two spans, because the sheet's whole top half is a term-and-value list and a screen reader reading it as loose text loses which figure belongs to which label.
 *
 * @param label - The operator-facing name of the figure, glossed here rather than in a hover title: this sheet is read on a phone, where there is no hover.
 * @param testId - Stamped on the VALUE cell, not the row, so an assertion reads the figure without the label's text coming along with it.
 * @param children - The value itself, rendered by the caller so a withheld figure can carry its own marker instead of a formatted number.
 * @returns The labelled row.
 */
function DetailRow({
  label,
  testId,
  children,
}: {
  readonly label: string;
  readonly testId: string;
  readonly children: React.ReactNode;
}): React.JSX.Element {
  return (
    <div className="flex items-baseline justify-between gap-3 border-b border-border py-2 last:border-0">
      <dt className="text-sm text-muted-fg">{label}</dt>
      <dd className="min-w-0 text-right font-mono text-sm tabular-nums" data-testid={testId}>
        {children}
      </dd>
    </div>
  );
}

/**
 * The detail sheet for one archived cycle.
 *
 * @param profileId - Profile that owns the row, for the two detail reads.
 * @param row - The row to describe, or `null` when nothing is open. Re-read from the list by the caller rather than captured, so the sheet follows a basis toggle and closes when its row is deleted.
 * @param timeZone - The operator's display zone, or undefined while settings resolve — in which case times render as nothing rather than in the wrong zone.
 * @param onClose - Called when the sheet is dismissed.
 * @returns The sheet.
 */
export function ArchiveDetailSheet({
  profileId,
  row,
  timeZone,
  onClose,
}: {
  readonly profileId: string;
  readonly row: ArchiveDetailRow | null;
  readonly timeZone: string | undefined;
  readonly onClose: () => void;
}): React.JSX.Element {
  const archiveId = row?.id ?? null;
  const fills = useQuery({
    queryKey: ['profile', 'archive', profileId, 'detail', archiveId],
    queryFn: () => fetchArchiveDetail(profileId, archiveId ?? ''),
    // Only once a row is open. The list is what pays for an eager fetch here, one request per visible row.
    enabled: archiveId !== null,
  });

  // The cycle's own window, which exists only when both ends are stamped. A cycle that cannot say when it opened cannot claim which changes happened during it, so the section is absent rather than showing the whole log.
  const from = row?.entryAt ?? null;
  const to = row?.exitAt ?? null;
  const during = useQuery({
    queryKey: ['profile', 'audit', profileId, 'during', from, to],
    // The route's maximum, not its default: this list claims to be everything the operator changed while the cycle was open, and a default-sized page would answer that claim with the newest 25 and no mark saying so.
    queryFn: () =>
      fetchProfileAuditLogs(
        profileId,
        null,
        [],
        { from: from ?? '', to: to ?? '' },
        AUDIT_LOG_MAX_LIMIT,
      ),
    enabled: archiveId !== null && from !== null && to !== null,
  });

  return (
    <Sheet
      open={row !== null}
      onOpenChange={(next) => {
        if (!next) onClose();
      }}
    >
      <SheetContent
        side="bottom"
        className="max-h-[85svh] overflow-y-auto"
        data-testid="archive-detail-sheet"
      >
        {row === null ? null : (
          <>
            <SheetHeader>
              <SheetTitle>{row.symbol}</SheetTitle>
              <SheetDescription>{glossExitIntent(row.exitIntent)}</SheetDescription>
            </SheetHeader>
            <dl className="mt-4">
              <DetailRow label="Buy total" testId="archive-detail-buy">
                {formatAmount(row.totalBuyQuote)}
                <span className="ml-1 text-muted-fg">{row.quoteAsset}</span>
              </DetailRow>
              <DetailRow label="Sell total" testId="archive-detail-sell">
                {formatAmount(row.totalSellQuote)}
                <span className="ml-1 text-muted-fg">{row.quoteAsset}</span>
              </DetailRow>
              <DetailRow label="P/L" testId="archive-detail-profit">
                {row.pnl.available ? (
                  <PnlValue value={row.pnl.pnl} unit={row.quoteAsset} />
                ) : (
                  <UnavailablePnl
                    glyph={unavailablePnlGlyph(row.pnl.reason)}
                    description={unavailablePnlLabel(row.pnl.reason)}
                  />
                )}
              </DetailRow>
              <DetailRow label="P/L %" testId="archive-detail-percent">
                {row.pnl.available ? (
                  <PnlPercent value={row.pnl.pnlPercent} />
                ) : (
                  <span className="text-muted-fg">—</span>
                )}
              </DetailRow>
              {/* "Fees" alone is jargon on first read; the gloss travels with the value because a hover title is invisible on touch, which is where this sheet is mostly read. */}
              <DetailRow label="Fees (commission paid to Binance)" testId="archive-detail-fees">
                {Object.keys(row.fees).length === 0
                  ? '—'
                  : Object.entries(row.fees).map(([asset, amount]) => (
                      <div key={asset}>
                        {formatAmount(amount)} <span className="text-muted-fg">{asset}</span>
                      </div>
                    ))}
              </DetailRow>
              <DetailRow label="Held for" testId="archive-detail-hold">
                {formatHoldDuration(holdMsOf(row))}
                {row.entryAt === null ? (
                  <span className="ml-1 text-[11px] text-muted-fg">
                    rebuilt from history, no open time
                  </span>
                ) : null}
              </DetailRow>
              {/* Renders nothing, not an em dash, when the zone is unknown — matching the compact row and the table cell. A settings refetch can fail after rows have loaded, and an em dash would read as "this trade has no time" rather than "the app does not know your zone yet". */}
              <DetailRow label="Archived" testId="archive-detail-time">
                {timeZone === undefined ? null : formatInstant(row.archivedAt, timeZone)}
              </DetailRow>
            </dl>

            <section className="mt-4" aria-labelledby="archive-detail-fills-h">
              <h3 id="archive-detail-fills-h" className="text-sm font-medium text-fg">
                Orders in this trade
              </h3>
              {fills.isPending ? (
                // A height-carrying placeholder, not a line of copy: the sheet is a scroll surface of its own, and a zero-height loading branch collapses it under the thumb for the length of the fetch.
                <div className="mt-1 space-y-1" data-testid="archive-detail-fills-skeleton">
                  <Skeleton className="h-4 w-full" />
                  <Skeleton className="h-4 w-full" />
                </div>
              ) : fills.isError ? (
                // Named, not swallowed: the totals above came from the same row, so an operator who cannot see the fills needs to know the list failed rather than assume the trade had none.
                <p className="mt-1 text-xs text-danger-fg" data-testid="archive-detail-fills-error">
                  Could not load the orders behind this trade.
                </p>
              ) : fills.data.orders.length === 0 ? (
                <p className="mt-1 text-xs text-muted-fg">
                  This trade was rebuilt from Binance history, so its individual orders were not
                  recorded.
                </p>
              ) : (
                <ul className="mt-1 space-y-1" data-testid="archive-detail-fills">
                  {fills.data.orders.map((o) => (
                    <li
                      key={o.orderId}
                      className="flex items-baseline justify-between gap-2 text-xs"
                      data-testid={`archive-detail-fill-${o.orderId}`}
                    >
                      <span className="min-w-0 truncate text-muted-fg">
                        {o.side ?? '—'} · {o.intent} · {o.status}
                      </span>
                      <span className="shrink-0 font-mono tabular-nums">
                        {o.cummulativeQuoteQty === null ? '—' : formatAmount(o.cummulativeQuoteQty)}
                        <span className="ml-1 text-muted-fg">{row.quoteAsset}</span>
                      </span>
                    </li>
                  ))}
                </ul>
              )}
            </section>

            {from === null || to === null ? null : (
              <section className="mt-4" aria-labelledby="archive-detail-during-h">
                <h3 id="archive-detail-during-h" className="text-sm font-medium text-fg">
                  What you changed while it was open
                </h3>
                {during.isPending ? (
                  <div className="mt-1 space-y-1" data-testid="archive-detail-during-skeleton">
                    <Skeleton className="h-4 w-full" />
                  </div>
                ) : during.isError || during.data.items.length === 0 ? (
                  <p
                    className="mt-1 text-xs text-muted-fg"
                    data-testid="archive-detail-during-none"
                  >
                    {during.isError
                      ? 'Could not load your changes for this window.'
                      : 'You changed nothing while this trade was open.'}
                  </p>
                ) : (
                  <ul className="mt-1 space-y-1" data-testid="archive-detail-during">
                    {during.data.items.map((a) => (
                      <li
                        key={a.id}
                        className="flex items-baseline justify-between gap-2 text-xs"
                        data-testid={`archive-detail-during-${a.id}`}
                      >
                        <span className="min-w-0 truncate text-muted-fg">{a.event}</span>
                        <span className="shrink-0 font-mono text-[11px] tabular-nums">
                          {timeZone === undefined ? null : formatInstant(a.createdAt, timeZone)}
                        </span>
                      </li>
                    ))}
                    {/* A continuation token means the window holds changes past this page. The heading claims completeness, so the shortfall is stated rather than left to be inferred from a list that simply stops. */}
                    {(during.data.nextCursor ?? null) !== null ? (
                      <li
                        className="text-[11px] text-muted-fg"
                        data-testid="archive-detail-during-partial"
                      >
                        Only your most recent changes in this window are listed.
                      </li>
                    ) : null}
                  </ul>
                )}
              </section>
            )}
          </>
        )}
      </SheetContent>
    </Sheet>
  );
}
