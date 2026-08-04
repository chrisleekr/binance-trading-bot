// Loading placeholders that mirror the real page furniture: a PageHeader-sized
// title block followed by Panel-shaped boxes carrying the same border,
// elevation and internal rhythm as `Panel`. Mirroring the finished layout
// rather than showing a bare frame or a lone spinner is what lets the operator
// read where things will land before the data arrives.
//
// Height is the point, not the decoration. The shell owns the only scroll
// surface and the document itself never scrolls, so a loading screen with no
// height leaves nothing under the thumb to drag: on a phone the app reads as
// frozen for the whole fetch rather than as busy. These blocks give the
// scroller a real range from the first frame.

import { Skeleton } from '@/shared/components/ui/skeleton';
import { t } from '@/shared/lib/i18n';

/**
 * The announcement every placeholder carries. Exactly one per loading surface:
 * the bars themselves are `aria-hidden`, and a live region per bar (or per
 * panel in a stack) would make a screen reader read "Loading" once for every
 * box on the page.
 */
function LoadingStatus({ children }: { readonly children: React.ReactNode }): React.JSX.Element {
  return (
    <div role="status" aria-live="polite">
      <span className="sr-only">{t('common.loading')}</span>
      {children}
    </div>
  );
}

/** Bare field-row bars. Silent — a caller above supplies the announcement. */
function FieldRows({ rows }: { readonly rows: number }): React.JSX.Element {
  return (
    <div className="space-y-3">
      {Array.from({ length: rows }, (_, i) => (
        <div key={i} className="flex items-center gap-3">
          <Skeleton className="h-3 w-24 shrink-0" />
          <Skeleton className="h-8 flex-1" />
        </div>
      ))}
    </div>
  );
}

/**
 * Field-row placeholders for a surface that already draws its own frame.
 * Use inside a `Panel` in place of a one-line "Loading…", which occupies no
 * height and so leaves the page unscrollable for the length of the fetch.
 */
export function LoadingRows({ rows = 3 }: { readonly rows?: number }): React.JSX.Element {
  return (
    <LoadingStatus>
      <FieldRows rows={rows} />
    </LoadingStatus>
  );
}

/**
 * One tall block sized by the caller, for surfaces whose loaded body is a
 * single unbroken area rather than a list or a field stack — a chart canvas, a
 * stats strip, a ladder. Field rows there would read as content that never
 * arrives; a solid block of the finished height does not.
 *
 * The caller must pass an explicit height (`h-[300px]`, `h-48`, …): matching
 * the loaded body is the whole point, and there is no sensible default for it.
 */
export function BlockSkeleton({ className }: { readonly className: string }): React.JSX.Element {
  return (
    <LoadingStatus>
      <Skeleton className={className} />
    </LoadingStatus>
  );
}

/**
 * A Panel-shaped placeholder: header block, hairline, then `rows` field rows.
 * Silent on its own — stacks announce once, via `PanelStackSkeleton`.
 */
function PanelSkeleton({ rows }: { readonly rows: number }): React.JSX.Element {
  return (
    <section className="border-border bg-bg-elevated border">
      <div className="space-y-2 px-4 py-3">
        <Skeleton className="h-4 w-40 max-w-full" />
        <Skeleton className="h-3 w-64 max-w-full" />
      </div>
      <div className="border-border border-t p-4">
        <FieldRows rows={rows} />
      </div>
    </section>
  );
}

/**
 * A list surface: the same bordered box the loaded tables draw, with a header
 * band and `rows` row bars on hairlines. Row height tracks the real table's, so
 * the box a page-worth of results will occupy is already reserved.
 */
export function TableSkeleton({ rows = 8 }: { readonly rows?: number }): React.JSX.Element {
  return (
    <LoadingStatus>
      <div className="border-border rounded-md border">
        <div className="border-border flex items-center gap-4 border-b px-3 py-2">
          <Skeleton className="h-3 w-20 shrink-0" />
          <Skeleton className="h-3 flex-1" />
          <Skeleton className="h-3 w-16 shrink-0" />
        </div>
        {Array.from({ length: rows }, (_, i) => (
          <div
            key={i}
            className="border-border flex items-center gap-4 border-b px-3 py-3 last:border-b-0"
          >
            <Skeleton className="h-3 w-24 shrink-0" />
            <Skeleton className="h-3 flex-1" />
            <Skeleton className="h-3 w-12 shrink-0" />
          </div>
        ))}
      </div>
    </LoadingStatus>
  );
}

// Uneven row counts on purpose: equal blocks read as a rendering glitch, a
// varied stack reads as content. Four panels clear a 667px phone viewport, so
// the scroller has somewhere to go while the operator waits.
const DEFAULT_SHAPE = [3, 4, 2, 3];

/**
 * The panel stack a page body renders once loaded. `shape` is one entry per
 * real panel, its value that panel's field count — describe the surface being
 * stood in for rather than accepting the generic default, or the placeholder
 * lands the operator's eye somewhere the content will not be.
 */
export function PanelStackSkeleton({
  shape = DEFAULT_SHAPE,
}: {
  readonly shape?: readonly number[];
}): React.JSX.Element {
  return (
    <LoadingStatus>
      <div className="space-y-6">
        {shape.map((rows, i) => (
          <PanelSkeleton key={i} rows={rows} />
        ))}
      </div>
    </LoadingStatus>
  );
}

/**
 * Whole-page placeholder: PageHeader-sized title block plus a panel stack.
 * Used where the route is not yet known (the router's pending screen), so it
 * takes no shape — a generic page is the most that can be said there.
 */
export function PageSkeleton(): React.JSX.Element {
  return (
    <div className="space-y-6">
      <header className="space-y-2">
        <Skeleton className="h-6 w-52 max-w-full" />
        <Skeleton className="h-3 w-72 max-w-full" />
      </header>
      <PanelStackSkeleton />
    </div>
  );
}
