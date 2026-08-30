// Phone rendering of the closed-trade archive. The desktop table carries nine columns, which below `md` collapses into a horizontal scroll strip: the operator drags sideways to read a single trade and the page itself overflows. So below `md` each trade renders as a compact two-line row — symbol and the number that matters on line one, why it closed and when on line two — and the full figures move into a sheet the row opens.
//
// Which of the two LISTS renders is a pure CSS decision made by the caller (`md:hidden` here, `hidden md:block` on the table). No `matchMedia` behind that: a JS breakpoint would re-render the whole list on every resize and would disagree with the CSS breakpoint during hydration.
//
// The detail sheet is the one thing CSS cannot decide, which is why the single media query below exists. Radix portals `SheetContent` to `<body>`, outside the caller's `md:hidden` wrapper, so widening past `md` leaves an open sheet sitting over the desktop table with nothing in the tree able to hide it. Hiding it with a breakpoint class would be worse than the bug, because an invisible dialog still traps focus and still swallows Escape. So the sheet is CLOSED when the query turns true, which is also what an operator resizing into the desktop layout is asking for.
//
// The row button and its `RowActions` kebab are SIBLINGS. Nesting the kebab inside the row button would nest one <button> in another, which React refuses to hydrate quietly and which leaves the destructive action reachable only by also triggering the row.

import { useEffect, useState } from 'react';

import { Trash2 } from 'lucide-react';

import { PnlPercent, PnlValue, UnavailablePnl } from '@/shared/components/pnl-value';
import { LoadingStatus } from '@/shared/components/page-skeleton';
import { RowActions } from '@/shared/components/row-actions';
import { Badge } from '@/shared/components/ui/badge';
import {
  Sheet,
  SheetContent,
  SheetDescription,
  SheetHeader,
  SheetTitle,
} from '@/shared/components/ui/sheet';
import { Skeleton } from '@/shared/components/ui/skeleton';
import { formatAmount } from '@/shared/lib/format';
import { formatInstant } from '@/shared/lib/format-time';
import { exitIntentLabel, glossExitIntent } from '@/shared/lib/gloss-exit-intent';
import {
  unavailablePnlGlyph,
  unavailablePnlLabel,
  type RowPnl,
} from '@/features/profile/lib/archive-view-model';

import type { TradeArchiveResponse } from '@app/contracts';

// Tailwind's `md`, spelled out because the config is not readable at runtime. The UNIT is the part that matters: `md:hidden` compiles to `48rem`, and rem is relative to the root font size, so a reader who has raised their browser's default font moves the CSS breakpoint without moving a `px` query written to match it. That drift is this bug all over again — the list swaps to the desktop table while the sheet stays open over it.
const MD_QUERY = '(min-width: 48rem)';

/** An archive row with its P/L already resolved onto the operator's chosen basis. Resolved once by the panel and passed down, never re-derived here: two independent resolutions could pair a Net amount with a Recorded percentage. */
export type ArchiveCompactRow = TradeArchiveResponse & { readonly pnl: RowPnl };

/** One label/value pair in the detail sheet. Module-level because a component declared inside another's render body remounts its subtree on every render. */
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
    <div className="flex items-baseline justify-between gap-3 border-b border-border py-2 last:border-b-0">
      <dt className="shrink-0 text-xs text-muted-fg">{label}</dt>
      <dd className="min-w-0 text-right font-mono text-sm tabular-nums" data-testid={testId}>
        {children}
      </dd>
    </div>
  );
}

/**
 * Compact per-trade rows for viewports below `md`, plus the detail sheet they open.
 *
 * @param rows - Archive rows in display order, each already carrying its basis-resolved P/L.
 * @param timeZone - The operator's display timezone, or `undefined` while account settings are still resolving — in which case no time is rendered rather than a wrong-zone one.
 * @param onDelete - Called with the row whose Delete was chosen. The caller owns the confirm dialog, so this list never destroys anything on its own.
 * @returns The list and its sheet.
 */
export function ArchiveCompactList({
  rows,
  timeZone,
  onDelete,
}: {
  readonly rows: readonly ArchiveCompactRow[];
  readonly timeZone: string | undefined;
  readonly onDelete: (row: ArchiveCompactRow) => void;
}): React.JSX.Element {
  // The open row is tracked by id and re-read from `rows`, not captured as an object: the sheet then follows a basis toggle and a background refetch, and closes by itself when the row it is showing is deleted out from under it.
  const [detailId, setDetailId] = useState<string | null>(null);
  const detail = rows.find((row) => row.id === detailId) ?? null;

  // Only on the crossing INTO desktop. A `change` also fires going the other way, and closing the sheet on that one would shut it under an operator who merely rotated a phone or opened a keyboard.
  useEffect(() => {
    const query = window.matchMedia(MD_QUERY);
    const closeOnDesktop = (event: MediaQueryListEvent): void => {
      if (event.matches) setDetailId(null);
    };
    query.addEventListener('change', closeOnDesktop);
    return () => query.removeEventListener('change', closeOnDesktop);
  }, []);

  return (
    <>
      <ul
        className="divide-y divide-border rounded-md border border-border"
        data-testid="archive-card-list"
      >
        {rows.map((row) => (
          <li key={row.id} className="flex items-center gap-1 pr-1 pl-3">
            <button
              type="button"
              onClick={() => setDetailId(row.id)}
              data-testid={`archive-card-${row.id}`}
              // Column gap rather than `space-y`: the sr-only span below is absolutely positioned, so it is not a flex item and cannot open a gap — whereas `space-y`'s `> * + *` would still count it and push the first visible line down.
              className="flex min-h-11 min-w-0 flex-1 flex-col justify-center gap-0.5 py-2 text-left focus-visible:ring-2 focus-visible:ring-focus focus-visible:outline-none"
            >
              {/* The visible content is the accessible name; this says what activating it does, which the numbers alone do not. */}
              <span className="sr-only">Trade details for </span>
              <span className="flex items-baseline justify-between gap-2">
                <span className="min-w-0 truncate text-sm font-medium text-fg">{row.symbol}</span>
                <span className="shrink-0 font-mono text-xs tabular-nums">
                  {row.pnl.available ? (
                    <>
                      <PnlValue
                        value={row.pnl.pnl}
                        unit={row.quoteAsset}
                        testId={`archive-card-profit-${row.id}`}
                      />
                      {/* The same caveat the table column carries, and it belongs here more than there: this is the renderer the operator actually reads at 375px, so a marker only the desktop table shows is a marker most sessions never see. A word rather than a tint, so a screen reader reads it aloud. */}
                      {row.pnl.estimated ? (
                        <span
                          className="ml-1 text-[11px] text-muted-fg"
                          title="A commission in this total was reconstructed from Binance's rate table rather than the charge it reported."
                          data-testid={`archive-card-pnl-estimated-${row.id}`}
                        >
                          est
                        </span>
                      ) : null}
                    </>
                  ) : (
                    <UnavailablePnl
                      testId={`archive-card-pnl-unavailable-${row.id}`}
                      glyph={unavailablePnlGlyph(row.pnl.reason)}
                      description={unavailablePnlLabel(row.pnl.reason)}
                    />
                  )}
                </span>
              </span>
              <span className="flex items-baseline justify-between gap-2">
                <Badge
                  variant={row.exitIntent === 'grid-stop-loss' ? 'danger' : 'secondary'}
                  className="min-w-0 shrink truncate"
                >
                  {exitIntentLabel(row.exitIntent)}
                </Badge>
                <span className="shrink-0 font-mono text-[11px] whitespace-nowrap text-muted-fg tabular-nums">
                  {timeZone === undefined ? null : formatInstant(row.archivedAt, timeZone)}
                </span>
              </span>
            </button>
            <RowActions
              label={`Actions for ${row.symbol} archive entry`}
              testId={`archive-card-actions-${row.id}`}
              actions={[
                {
                  key: 'delete',
                  label: 'Delete',
                  icon: <Trash2 className="h-4 w-4" aria-hidden="true" />,
                  destructive: true,
                  onSelect: () => onDelete(row),
                  testId: `archive-card-delete-${row.id}`,
                },
              ]}
            />
          </li>
        ))}
      </ul>

      <Sheet
        open={detail !== null}
        onOpenChange={(next) => {
          if (!next) setDetailId(null);
        }}
      >
        <SheetContent
          side="bottom"
          className="max-h-[85svh] overflow-y-auto"
          data-testid="archive-detail-sheet"
        >
          {detail === null ? null : (
            <>
              <SheetHeader>
                <SheetTitle>{detail.symbol}</SheetTitle>
                <SheetDescription>{glossExitIntent(detail.exitIntent)}</SheetDescription>
              </SheetHeader>
              <dl className="mt-4">
                <DetailRow label="Buy total" testId="archive-detail-buy">
                  {formatAmount(detail.totalBuyQuote)}
                  <span className="ml-1 text-muted-fg">{detail.quoteAsset}</span>
                </DetailRow>
                <DetailRow label="Sell total" testId="archive-detail-sell">
                  {formatAmount(detail.totalSellQuote)}
                  <span className="ml-1 text-muted-fg">{detail.quoteAsset}</span>
                </DetailRow>
                <DetailRow label="P/L" testId="archive-detail-profit">
                  {detail.pnl.available ? (
                    <PnlValue value={detail.pnl.pnl} unit={detail.quoteAsset} />
                  ) : (
                    <UnavailablePnl
                      glyph={unavailablePnlGlyph(detail.pnl.reason)}
                      description={unavailablePnlLabel(detail.pnl.reason)}
                    />
                  )}
                </DetailRow>
                <DetailRow label="P/L %" testId="archive-detail-percent">
                  {detail.pnl.available ? (
                    <PnlPercent value={detail.pnl.pnlPercent} />
                  ) : (
                    <span className="text-muted-fg">—</span>
                  )}
                </DetailRow>
                {/* "Fees" alone is jargon on first read; the gloss travels with the value because a hover title is invisible on touch, which is the only place this sheet renders. */}
                <DetailRow label="Fees (commission paid to Binance)" testId="archive-detail-fees">
                  {Object.keys(detail.fees).length === 0
                    ? '—'
                    : Object.entries(detail.fees).map(([asset, amount]) => (
                        <div key={asset}>
                          {formatAmount(amount)} <span className="text-muted-fg">{asset}</span>
                        </div>
                      ))}
                </DetailRow>
                {/* Renders nothing, not an em dash, when the zone is unknown — matching the compact row and the table cell. A settings refetch can fail after rows have loaded, and an em dash would read as "this trade has no time" rather than "the app does not know your zone yet". */}
                <DetailRow label="Archived" testId="archive-detail-time">
                  {timeZone === undefined ? null : formatInstant(detail.archivedAt, timeZone)}
                </DetailRow>
              </dl>
            </>
          )}
        </SheetContent>
      </Sheet>
    </>
  );
}

/**
 * Loading placeholder shaped like the compact rows above, for the same reason those rows exist: the shell owns the only scroll surface, so a loading branch with no height leaves a phone with nothing under the thumb and the app reads as frozen for the length of the fetch.
 *
 * Six rows, fixed. That is a phone screenful of the loaded list, and this placeholder stands in for exactly one surface — a row-count prop whose only call site passes no argument would be configurability nobody asked for.
 *
 * @returns The announced placeholder stack.
 */
export function ArchiveCompactSkeleton(): React.JSX.Element {
  const rows = 6;
  return (
    <LoadingStatus>
      <div className="divide-y divide-border rounded-md border border-border">
        {Array.from({ length: rows }, (_, i) => (
          <div key={i} className="flex min-h-11 items-center gap-3 px-3 py-2">
            <div className="min-w-0 flex-1 space-y-1.5">
              <Skeleton className="h-3 w-24" />
              <Skeleton className="h-3 w-16" />
            </div>
            <Skeleton className="h-3 w-16 shrink-0" />
          </div>
        ))}
      </div>
    </LoadingStatus>
  );
}
