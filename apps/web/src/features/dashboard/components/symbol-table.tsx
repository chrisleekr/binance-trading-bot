// Account-wide flat symbol grid — the terminal's centerpiece. The
// cross-profile aggregate only carries held positions, so the full symbol set
// lives in each profile's dashboard; this fans out one query per profile (a
// handful, single-account) and flattens the symbols into one dense grid where
// every row is a single click into that symbol's detail surface and one click
// into its config.
//
// One DOM per row, two layouts switched on a CONTAINER query, not the
// viewport: a narrow table box keeps the stacked two-line list that fits 375px
// (invariant #3); once the box itself clears the grid's ~750px minimum the
// `@3xl:contents` wrappers dissolve and the same nodes flow into an aligned
// data grid with column headers. Keying on the box, not the window, is what
// stops the dense grid from overflowing when the table sits inside the sidebar
// inset (where a viewport `md:` engaged the grid ~240px before it could fit).

import { Link } from '@tanstack/react-router';
import { useMemo, useState } from 'react';

import { useSymbolRows, type SymbolRow } from '@/features/dashboard/lib/use-symbol-rows';
import { useActiveAccountId } from '@/shared/lib/account-scope';
import { isHeldPosition, unrealisedPnlOf } from '@/features/profile/lib/unrealised-pnl';
import { deriveQuote } from '@/shared/lib/symbol-quote';
import { formatAmount, formatPrice } from '@/shared/lib/format';
import {
  blockerPositionGuarded,
  glossProtectiveStopBlocker,
} from '@/shared/lib/gloss-protective-stop-blocker';
import { glossEntryBlocker } from '@/shared/lib/gloss-entry-blocker';
import { PnlValue } from '@/shared/components/pnl-value';
import { LoadingRows } from '@/shared/components/page-skeleton';
import { Badge } from '@/shared/components/ui/badge';
import { Button } from '@/shared/components/ui/button';
import { Input } from '@/shared/components/ui/input';
import { cn } from '@/shared/lib/cn';
import { t } from '@/shared/lib/i18n';

import type { DashboardAggregateRow, ProfileDashboardSymbol } from '@app/contracts';

/** Unrealised P/L for a symbol as a decimal-string, or null when flat / no price. */
function pnlString(sym: ProfileDashboardSymbol): string | null {
  const pnl = unrealisedPnlOf(sym);
  return pnl == null ? null : String(pnl);
}

/** Shared column template: dot · symbol · status · profile · position · orders · price · P/L · config. */
const GRID_COLS =
  '@3xl:grid @3xl:grid-cols-[10px_minmax(0,1.2fr)_6rem_minmax(0,1fr)_minmax(0,1fr)_4.5rem_7rem_9rem_4.5rem] @3xl:items-center @3xl:gap-x-3';

/**
 * Flat, filterable, one-click-per-row symbol grid across every profile. Fans
 * out per-profile dashboards (each Redis-cached, so cheap) and merges. A single
 * profile failing flags a partial load rather than vanishing (no silent
 * failures).
 */
export function SymbolTable({
  rows,
  focusedProfileId,
}: {
  rows: readonly DashboardAggregateRow[];
  focusedProfileId: string | null;
}) {
  const [filter, setFilter] = useState('');
  // Add-symbol targets one profile; the grid is cross-profile, so the opener
  // only appears when a single profile is focused.
  const accountId = useActiveAccountId() ?? '';
  const merged = useSymbolRows(rows);

  const visible = useMemo(() => {
    const needle = filter.trim().toUpperCase();
    if (!needle) return merged.items;
    return merged.items.filter(
      (r) =>
        r.sym.symbol.toUpperCase().includes(needle) || r.profileName.toUpperCase().includes(needle),
    );
  }, [merged.items, filter]);

  return (
    <section aria-labelledby="symbols-heading" data-testid="symbol-table" className="space-y-2">
      <div className="flex flex-wrap items-center justify-between gap-2">
        <h2
          id="symbols-heading"
          className="text-[11px] font-semibold tracking-wider text-muted-fg uppercase"
        >
          {t('home.symbols.title')}
        </h2>
        <div className="flex w-full items-center gap-2 sm:w-auto">
          {merged.items.length > 0 ? (
            <Input
              type="search"
              value={filter}
              onChange={(e) => setFilter(e.target.value)}
              placeholder={t('home.symbols.filter')}
              aria-label={t('home.symbols.filter')}
              data-testid="symbol-table-filter"
              className="h-9 w-full sm:w-56"
            />
          ) : null}
          {focusedProfileId !== null ? (
            <Button asChild variant="outline" size="sm" className="shrink-0">
              <Link
                to="/accounts/$accountId/profiles/$profileId/symbols/new"
                params={{ accountId, profileId: focusedProfileId }}
                data-testid="symbol-table-add-symbol"
              >
                {t('home.symbols.add')}
              </Link>
            </Button>
          ) : null}
        </div>
      </div>

      <div className="@container border border-border bg-bg-elevated">
        {merged.isError ? (
          <p className="px-4 py-6 text-sm text-muted-fg">{t('home.symbols.error')}</p>
        ) : merged.isLoading ? (
          // The enclosing div already draws the table's box, so this fills it
          // with rows rather than nesting a second bordered frame.
          <div className="p-4">
            <LoadingRows rows={8} />
          </div>
        ) : merged.items.length === 0 ? (
          <p className="px-4 py-6 text-sm text-muted-fg">{t('home.symbols.empty')}</p>
        ) : visible.length === 0 ? (
          <p className="px-4 py-6 text-sm text-muted-fg">{t('home.symbols.no_match')}</p>
        ) : (
          <>
            {merged.isPartial ? (
              <p
                data-testid="symbol-table-partial"
                className="border-b border-border px-4 py-2 text-xs text-warning"
              >
                ⚠ {t('home.symbols.partial')}
              </p>
            ) : null}
            <GridHeader />
            <ul className="divide-y divide-border">
              {visible.map((r) => (
                <SymbolListRow key={`${r.profileId}:${r.sym.symbol}`} row={r} />
              ))}
            </ul>
          </>
        )}
      </div>
    </section>
  );
}

/** Desktop-only column header strip (uppercase, letter-spaced, muted — the v2 table treatment). */
function GridHeader() {
  const th = 'text-[11px] font-semibold uppercase tracking-[0.14em] text-muted-fg';
  return (
    <div aria-hidden="true" className={cn('hidden border-b border-border px-3 py-1.5', GRID_COLS)}>
      <span />
      <span className={th}>{t('home.symbols.col.symbol')}</span>
      <span className={th}>{t('home.symbols.col.status')}</span>
      <span className={th}>{t('home.symbols.col.profile')}</span>
      <span className={th}>{t('home.symbols.col.position')}</span>
      <span className={cn(th, 'text-right')}>{t('home.symbols.col.orders')}</span>
      <span className={cn(th, 'text-right')}>{t('home.symbols.col.price')}</span>
      <span className={cn(th, 'text-right')}>{t('home.symbols.col.pnl')}</span>
      <span />
    </div>
  );
}

/** The trading status of a symbol, in priority order: unprotected / stop-stale > held > paused > blocked > watching. */
type SymbolStatusKind =
  'unprotected' | 'stop-stale' | 'holding' | 'paused' | 'blocked' | 'watching';

export interface SymbolStatus {
  readonly kind: SymbolStatusKind;
  /** Short chip label. */
  readonly label: string;
  /** Full hover/aria text — the blocker gloss for `blocked`, the label otherwise. */
  readonly title: string;
  /**
   * Shared `Badge` variant for the desktop chip. HOLDING maps to `up` (the same
   * `--up`/`#00e070` token as the success dot; `Badge` has no `success`
   * variant), BLOCKED to `warning` (amber tint matching the trade-archive
   * panel's status badges), PAUSED to `secondary`, WATCHING to `outline`, and
   * UNPROTECTED to `danger` — it is the only status that says money is at risk.
   * A stop resting at a stale level reads `warning`, not `danger`: protection
   * exists, it is just behind the trail.
   */
  readonly variant: 'up' | 'secondary' | 'warning' | 'outline' | 'danger';
}

/**
 * Derive a symbol's at-a-glance status. An open position whose protective stop
 * could not be placed outranks everything — it is unguarded right now, unless an
 * earlier stop of ours still covers it, which downgrades it to stale. Otherwise
 * held positions read HOLDING regardless of enabled state (the operator's money
 * is in it); a paused symbol that holds nothing reads PAUSED; a flat enabled
 * symbol with a blocker shows the blocker (amber), otherwise it is WATCHING.
 */
export function deriveStatus(sym: ProfileDashboardSymbol): SymbolStatus {
  if (sym.protectiveStopBlocker) {
    const stale = blockerPositionGuarded(sym.protectiveStopBlocker);
    return {
      kind: stale ? 'stop-stale' : 'unprotected',
      label: stale ? t('grid.status.stopStale') : t('grid.status.unprotected'),
      title: glossProtectiveStopBlocker(sym.protectiveStopBlocker),
      variant: stale ? 'warning' : 'danger',
    };
  }
  if (isHeldPosition(sym)) {
    return {
      kind: 'holding',
      label: t('grid.status.holding'),
      title: t('grid.status.holding'),
      variant: 'up',
    };
  }
  if (!sym.enabled) {
    return {
      kind: 'paused',
      label: t('grid.status.paused'),
      title: t('grid.status.paused'),
      variant: 'secondary',
    };
  }
  if (sym.entryBlocker) {
    return {
      kind: 'blocked',
      label: t('grid.status.blocked'),
      title: glossEntryBlocker(sym.entryBlocker),
      variant: 'warning',
    };
  }
  return {
    kind: 'watching',
    label: t('grid.status.watching'),
    title: t('grid.status.watching'),
    variant: 'outline',
  };
}

/**
 * One symbol row. The symbol name is the navigation link, stretched across the
 * whole row (`after:inset-0`) so the row stays one click; clicking opens the
 * symbol's workspace beside the overview via `?sym=<id>:<SYMBOL>` (an SPA push
 * that also supports middle-click). The CONFIG action sits above the stretch
 * (`z-10`) as a second, direct entry into the symbol's strategy editor.
 */
function SymbolListRow({ row }: { row: SymbolRow }) {
  const { sym, profileName, profileId, binanceMode } = row;
  const accountId = useActiveAccountId() ?? '';
  const held = isHeldPosition(sym);
  const quote = deriveQuote(sym.symbol) ?? sym.symbol;
  const positionLabel = held
    ? t('home.symbols.held', { qty: formatAmount(sym.quantity ?? '0') })
    : t('home.symbols.flat');
  // Only surface the open-order count when there is one — "· 0 orders" on every
  // flat row is noise. Singular/plural picked explicitly since the i18n shim
  // does no plural selection.
  const ordersLabel =
    sym.openOrderCount > 0
      ? t(sym.openOrderCount === 1 ? 'home.symbols.order' : 'home.symbols.orders', {
          count: sym.openOrderCount,
        })
      : null;
  // Dot meaning, hover-titled so the colour is never a guess. Paused symbols get
  // a hollow ring, not red — "off by choice" is not an error.
  const dot = !sym.enabled
    ? { cls: 'border border-muted-fg', title: t('home.symbols.dot.disabled') }
    : held
      ? { cls: 'bg-success', title: t('home.symbols.dot.held') }
      : { cls: 'bg-muted-fg', title: t('home.symbols.dot.flat') };
  const status = deriveStatus(sym);

  return (
    <li
      data-testid={`symbol-row-${profileId}-${sym.symbol}`}
      className={cn(
        'relative flex items-center gap-3 px-3 py-2 even:bg-[color-mix(in_srgb,var(--surface-alt)_45%,transparent)] hover:bg-surface-alt',
        GRID_COLS,
      )}
    >
      <span
        className={cn('h-2 w-2 shrink-0 rounded-full', dot.cls)}
        title={dot.title}
        aria-hidden
      />
      <div className="min-w-0 flex-1 @3xl:contents">
        <div className="flex min-w-0 flex-wrap items-center gap-2">
          <Link
            to="/accounts/$accountId/profiles/$profileId/symbols/$symbol"
            params={{ accountId, profileId, symbol: sym.symbol }}
            data-testid={`symbol-link-${profileId}-${sym.symbol}`}
            className="truncate font-mono text-sm font-medium text-fg after:absolute after:inset-0 focus-visible:outline-none focus-visible:after:ring-2 focus-visible:after:ring-focus focus-visible:after:ring-inset"
          >
            {sym.symbol}
          </Link>
          {binanceMode === 'test' ? (
            <Badge variant="outline" className="text-xs">
              {t('home.card.testnet')}
            </Badge>
          ) : null}
          {!sym.enabled ? (
            <Badge variant="outline" className="text-xs">
              {t('home.symbols.disabled')}
            </Badge>
          ) : null}
        </div>
        {/* STATUS cell — desktop column only; mobile shows the same status on
            the meta line below. The shared Badge gives the tinted fill the
            hand-rolled chip lacked, so BLOCKED reads as the same object as the
            TESTNET Badge two columns over. The full blocker gloss rides as the
            hover/aria title so an amber BLOCKED is never a guess. */}
        <Badge
          variant={status.variant}
          title={status.title}
          data-testid={`symbol-status-${profileId}-${sym.symbol}`}
          data-status={status.kind}
          className="hidden @3xl:inline-flex"
        >
          {status.label}
        </Badge>
        {/* Mobile meta line; at md+ the wrapper dissolves and each fact takes
            its own aligned column. The interpunct separators are mobile-only. */}
        <p className="mt-0.5 truncate text-xs text-muted-fg @3xl:contents">
          <span className="truncate @3xl:mt-0 @3xl:text-xs @3xl:text-muted-fg">{profileName}</span>
          <span aria-hidden="true" className="@3xl:hidden">
            {' · '}
          </span>
          <span
            className={cn(
              '@3xl:font-mono @3xl:text-xs @3xl:tabular-nums',
              held ? '@3xl:text-fg' : '@3xl:text-muted-fg',
            )}
          >
            {positionLabel}
          </span>
          {ordersLabel ? (
            <>
              <span aria-hidden="true" className="@3xl:hidden">
                {' · '}
              </span>
              <span className="@3xl:text-right @3xl:font-mono @3xl:text-xs @3xl:text-fg @3xl:tabular-nums">
                {ordersLabel}
              </span>
            </>
          ) : (
            <span className="hidden @3xl:block @3xl:text-right @3xl:text-xs @3xl:text-muted-fg">
              —
            </span>
          )}
          {/* Mobile: fold the status (and, when blocked, the full gloss) onto
              the meta line — the desktop STATUS column has no mobile twin. */}
          <span aria-hidden="true" className="@3xl:hidden">
            {' · '}
          </span>
          <span
            className="@3xl:hidden"
            data-testid={`symbol-status-meta-${profileId}-${sym.symbol}`}
          >
            {status.kind === 'blocked' ? status.title : status.label}
          </span>
        </p>
      </div>
      <div className="shrink-0 text-right @3xl:contents">
        <div className="font-mono text-sm text-fg tabular-nums @3xl:text-right">
          {sym.currentPrice != null ? formatPrice(sym.currentPrice) : '—'}
        </div>
        <PnlValue
          value={pnlString(sym)}
          {...(held ? { unit: quote } : {})}
          className="text-xs @3xl:text-right"
        />
      </div>
      {/* CONFIG opens the symbol-config drawer beside the workspace by setting
          both `sym` (the drawer's required context) and `edit`. `Button asChild`
          wraps the Link so it gets the canonical outline-button treatment while
          a Link (not a handler) keeps middle-click + the row's `z-10`-above-
          stretch pattern. Desktop column only (`@3xl:`). */}
      <Button
        asChild
        variant="outline"
        size="sm"
        className="relative z-10 hidden @3xl:inline-flex @3xl:justify-self-end"
      >
        <Link
          to="/accounts/$accountId/profiles/$profileId/symbols/$symbol/config"
          params={{ accountId, profileId, symbol: sym.symbol }}
          aria-label={t('home.symbols.configure.aria', {
            symbol: sym.symbol,
            profile: profileName,
          })}
          data-testid={`symbol-configure-${profileId}-${sym.symbol}`}
        >
          {t('home.symbols.configure')}
        </Link>
      </Button>
    </li>
  );
}
