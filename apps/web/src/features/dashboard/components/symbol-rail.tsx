// Compact symbol switch rail for the workspace overlay. While a symbol is open
// full-width, this thin left column keeps every other symbol one click away —
// the master-detail hop without giving the squeezed overview back its column.
// Held-first, same source as the overview table (useSymbolRows). The workspace
// route scopes it to the open profile, so the rail lists that profile's symbols;
// clicking a row re-points the route in place so the workspace remounts on the
// new symbol without a close/reopen. Hidden below md (the workspace is full-bleed
// on a phone; the header switcher covers hopping there).

import { useMemo, useState } from 'react';
import { useNavigate } from '@tanstack/react-router';

import { deriveStatus } from '@/features/dashboard/components/symbol-table';
import { useSymbolRows, type SymbolRow } from '@/features/dashboard/lib/use-symbol-rows';
import { useActiveAccountId } from '@/shared/lib/account-scope';
import { isHeldPosition } from '@/features/profile/lib/unrealised-pnl';
import { deriveQuote } from '@/shared/lib/symbol-quote';
import { formatPrice } from '@/shared/lib/format';
import { Badge } from '@/shared/components/ui/badge';
import { Input } from '@/shared/components/ui/input';
import { cn } from '@/shared/lib/cn';
import { t } from '@/shared/lib/i18n';

import type { DashboardAggregateRow } from '@app/contracts';

/**
 * The switch rail. `selected` is the active `?sym` value (`<profileId>:<SYMBOL>`)
 * so the open symbol's row reads as current. A filter narrows long lists in
 * place — the rail is the only symbol list visible while the workspace is open.
 */
export function SymbolRail({
  rows,
  selected,
}: {
  rows: readonly DashboardAggregateRow[];
  selected: string;
}): React.JSX.Element {
  const navigate = useNavigate();
  const accountId = useActiveAccountId() ?? '';
  const [filter, setFilter] = useState('');
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
    <aside
      data-testid="symbol-rail"
      aria-label={t('home.symbols.title')}
      className="border-border bg-bg-elevated hidden w-64 shrink-0 flex-col border-r md:flex"
    >
      <div className="border-border shrink-0 space-y-2 border-b p-3">
        <h2 className="text-muted-fg text-[11px] font-semibold uppercase tracking-wider">
          {t('home.symbols.title')}
        </h2>
        {merged.items.length > 0 ? (
          <Input
            type="search"
            value={filter}
            onChange={(e) => setFilter(e.target.value)}
            placeholder={t('home.symbols.filter')}
            aria-label={t('home.symbols.filter')}
            data-testid="symbol-rail-filter"
            className="h-8"
          />
        ) : null}
      </div>

      <div className="min-h-0 flex-1 overflow-y-auto">
        {merged.isError ? (
          <p className="text-muted-fg px-3 py-4 text-xs">{t('home.symbols.error')}</p>
        ) : merged.isLoading ? (
          <p className="text-muted-fg px-3 py-4 text-xs">{t('home.symbols.loading')}</p>
        ) : visible.length === 0 ? (
          <p className="text-muted-fg px-3 py-4 text-xs">
            {merged.items.length === 0 ? t('home.symbols.empty') : t('home.symbols.no_match')}
          </p>
        ) : (
          <ul className="divide-border divide-y">
            {merged.isPartial ? (
              <li data-testid="symbol-rail-partial" className="text-warning px-3 py-2 text-xs">
                ⚠ {t('home.symbols.partial')}
              </li>
            ) : null}
            {visible.map((r) => (
              <RailRow
                key={`${r.profileId}:${r.sym.symbol}`}
                row={r}
                selected={selected === `${r.profileId}:${r.sym.symbol}`}
                onSelect={() =>
                  void navigate({
                    to: '/accounts/$accountId/profiles/$profileId/symbols/$symbol',
                    params: { accountId, profileId: r.profileId, symbol: r.sym.symbol },
                    // Keep the active ?tab when hopping to another symbol.
                    search: (prev) => prev,
                  })
                }
              />
            ))}
          </ul>
        )}
      </div>
    </aside>
  );
}

/** One rail row: dot · symbol · status chip, with the current price below. */
function RailRow({
  row,
  selected,
  onSelect,
}: {
  row: SymbolRow;
  selected: boolean;
  onSelect: () => void;
}): React.JSX.Element {
  const { sym } = row;
  const held = isHeldPosition(sym);
  const status = deriveStatus(sym);
  const dot = !sym.enabled ? 'border border-muted-fg' : held ? 'bg-success' : 'bg-muted-fg';
  const quote = deriveQuote(sym.symbol) ?? sym.symbol;

  return (
    <li>
      <button
        type="button"
        onClick={onSelect}
        aria-current={selected ? 'true' : undefined}
        data-testid={`symbol-rail-row-${row.profileId}-${sym.symbol}`}
        title={status.kind === 'blocked' ? status.title : undefined}
        className={cn(
          'hover:bg-surface-alt focus-visible:ring-focus flex w-full flex-col gap-1 px-3 py-2 text-left focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-inset',
          selected && 'border-accent bg-surface-alt border-l-2',
        )}
      >
        <div className="flex items-center gap-2">
          <span className={cn('h-2 w-2 shrink-0 rounded-full', dot)} aria-hidden />
          <span className="text-fg truncate font-mono text-sm font-medium">{sym.symbol}</span>
          <Badge variant={status.variant} data-status={status.kind} className="ml-auto shrink-0">
            {status.label}
          </Badge>
        </div>
        <div className="text-muted-fg flex items-center justify-between pl-4 text-xs">
          <span className="truncate">{row.profileName}</span>
          <span className="shrink-0 font-mono tabular-nums">
            {sym.currentPrice != null ? `${formatPrice(sym.currentPrice)} ${quote}` : '—'}
          </span>
        </div>
      </button>
    </li>
  );
}
