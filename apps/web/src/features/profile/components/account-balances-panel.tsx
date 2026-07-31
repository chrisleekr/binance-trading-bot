// Account balances panel — the full wallet readout for a profile.
//
// Follows Binance's wallet
// pattern: a testnet account holds hundreds of assets, so an unfiltered list
// blows the page to thousands of pixels. The operator needs to find an asset,
// not scroll past 440 rows. Search + hide-zero + a height-capped scroll keep
// the card a fixed size regardless of how many assets the account holds.
//
// Each row shows a coin icon + full asset name, the held quantity, and an
// estimated value in the profile's quote asset from the asset's own `usdPrice`
// (the market-trend price map, attached by the projection); the header sums
// those into the account's estimated value. For an asset the profile actively
// trades and currently holds, the row also shows the bot's average entry price
// and unrealized P/L. Presentational — the route owns the dashboard query.
// Display-only Number formatting is safe here (apps/web is barred from decimal.js).

import { useVirtualizer } from '@tanstack/react-virtual';
import { useMemo, useRef, useState } from 'react';

import { CoinIcon } from '@/features/profile/components/coin-icon';
import { isHeldPosition, toFinite, unrealisedPnlOf } from '@/features/profile/lib/unrealised-pnl';
import { balanceUsdValue, totalUsdValue } from '@/features/profile/lib/balance-value';
import { PnlValue, PNL_TONE } from '@/shared/components/pnl-value';
import { Input } from '@/shared/components/ui/input';
import { Label } from '@/shared/components/ui/label';
import { Switch } from '@/shared/components/ui/switch';
import { assetName } from '@/shared/lib/asset-names';
import { cn } from '@/shared/lib/cn';
import { formatBalanceAmount, formatPercent, formatPrice, signOf } from '@/shared/lib/format';
import { deriveBase } from '@/shared/lib/symbol-quote';

import type { ProfileDashboardResponse } from '@app/contracts';

type AssetBalance = ProfileDashboardResponse['balances'][number];
type DashboardSymbol = ProfileDashboardResponse['symbols'][number];

type SortKey = 'value' | 'asset';

/**
 * Switch to virtualised rendering when the visible row count crosses this
 * threshold. A testnet wallet carries hundreds of assets; rendering every
 * row makes the panel the page's render hot spot. The cutoff is well above
 * a realistic mainnet wallet (~30-50 priced assets) so the common case
 * keeps the simpler direct-render path and only large/unfiltered lists pay
 * the virtualizer's setup cost.
 */
const VIRTUALIZE_THRESHOLD = 50;

/** Percent return of a held position, or null when either leg is unusable. */
function positionPercent(sym: DashboardSymbol): number | null {
  const avg = toFinite(sym.avgEntryPrice);
  const cur = toFinite(sym.currentPrice);
  if (avg == null || avg === 0 || cur == null) return null;
  return (cur / avg - 1) * 100;
}

/** Shared row component — same DOM for direct and virtualised paths. */
function BalanceRow({
  balance,
  quoteAsset,
  position,
  style,
  measureRef,
  dataIndex,
}: {
  readonly balance: AssetBalance;
  readonly quoteAsset: string;
  /** The traded symbol this asset holds a position in, or undefined when the
   * profile is not holding it — drives the avg-entry + P/L lines. */
  readonly position?: DashboardSymbol | undefined;
  readonly style?: React.CSSProperties;
  readonly measureRef?: (node: HTMLLIElement | null) => void;
  /** `@tanstack/react-virtual` reads `data-index` from the measured node to
   * map the ResizeObserver callback back to the row; without it dynamic
   * row measurement silently falls back to the estimate. */
  readonly dataIndex?: number;
}): React.JSX.Element {
  const value = balanceUsdValue(balance);
  const pnl = position ? unrealisedPnlOf(position) : null;
  const pct = position ? positionPercent(position) : null;
  return (
    <li
      ref={measureRef}
      style={style}
      data-index={dataIndex}
      className="flex items-start justify-between gap-2 px-4 py-2.5 text-sm"
      data-testid={`balance-row-${balance.asset}`}
    >
      <div className="flex min-w-0 items-center gap-2">
        <CoinIcon asset={balance.asset} />
        <div className="flex min-w-0 flex-col">
          <span className="font-medium" title={balance.asset}>
            {balance.asset}
          </span>
          <span className="text-muted-fg truncate text-xs" title={balance.asset}>
            {assetName(balance.asset)}
          </span>
        </div>
      </div>
      <span className="flex shrink-0 flex-col items-end font-mono tabular-nums">
        <span>
          {formatBalanceAmount(balance.free)} <span className="text-muted-fg">free</span>
        </span>
        <span className="text-muted-fg text-xs">{formatBalanceAmount(balance.locked)} locked</span>
        {value != null ? (
          <span className="text-muted-fg text-xs" data-testid={`balance-value-${balance.asset}`}>
            ≈ {formatUsd(value)} {quoteAsset}
          </span>
        ) : null}
        {position ? (
          <>
            <span className="text-muted-fg text-xs">
              Avg {formatPrice(position.avgEntryPrice ?? '0')} {quoteAsset}
            </span>
            <span className="text-xs" data-testid={`balance-pnl-${balance.asset}`}>
              <PnlValue
                value={pnl == null ? null : String(pnl)}
                unit={quoteAsset}
                className="text-xs"
              />
              {pct != null ? (
                <span className={cn('ml-1', PNL_TONE[signOf(String(pct))])}>
                  {formatPercent(pct, { sign: true })}
                </span>
              ) : null}
            </span>
          </>
        ) : null}
      </span>
    </li>
  );
}

function isZero(balance: AssetBalance): boolean {
  return Number(balance.free) === 0 && Number(balance.locked) === 0;
}

/** Format a USD value at 2dp with thousands separators. */
function formatUsd(value: number): string {
  return value.toLocaleString(undefined, {
    minimumFractionDigits: 2,
    maximumFractionDigits: 2,
  });
}

/**
 * Full-wallet balances card for the profile-detail page. Search filters by
 * asset symbol; the hide-zero toggle (default on) drops assets with no free
 * and no locked amount; the sort select orders by estimated USD value or by
 * asset name; the list scrolls inside a fixed-height box so the card never
 * dominates the page.
 */
export function AccountBalancesPanel({
  balances,
  symbols,
  quoteAsset,
}: {
  readonly balances: readonly AssetBalance[];
  readonly symbols: readonly DashboardSymbol[];
  readonly quoteAsset: string;
}): React.JSX.Element {
  const [search, setSearch] = useState('');
  const [hideZero, setHideZero] = useState(true);
  const [sort, setSort] = useState<SortKey>('value');

  // Held positions keyed by base asset: an asset the profile trades (its
  // `<base><quoteAsset>` pair) and currently holds (avg-entry + quantity). The
  // row uses this to show the bot's cost basis and unrealized P/L.
  const positionByAsset = useMemo(() => {
    const m = new Map<string, DashboardSymbol>();
    if (!quoteAsset) return m;
    for (const s of symbols) {
      const base = deriveBase(s.symbol, quoteAsset);
      if (base != null && isHeldPosition(s)) m.set(base, s);
    }
    return m;
  }, [symbols, quoteAsset]);

  const estimatedValue = useMemo(() => totalUsdValue(balances), [balances]);
  // Operator-facing honesty: the estimate silently drops every asset with no
  // price. Counting them here lets the panel disclose how many non-zero
  // balances aren't reflected in the total.
  const unpricedNonZero = useMemo(
    () => balances.filter((b) => !isZero(b) && balanceUsdValue(b) === null).length,
    [balances],
  );

  const visible = useMemo(() => {
    const query = search.trim().toUpperCase();
    const rows = balances
      .filter((b) => !hideZero || !isZero(b))
      .filter((b) => query === '' || b.asset.toUpperCase().includes(query));
    return rows.slice().sort((a, b) => {
      if (sort === 'asset') return a.asset.localeCompare(b.asset);
      // Value sort: priced rows first, descending by value; unpriced rows fall
      // to the bottom, ordered by asset name.
      const av = balanceUsdValue(a);
      const bv = balanceUsdValue(b);
      if (av == null && bv == null) return a.asset.localeCompare(b.asset);
      if (av == null) return 1;
      if (bv == null) return -1;
      return bv - av || a.asset.localeCompare(b.asset);
    });
  }, [balances, search, hideZero, sort]);

  return (
    <section
      aria-labelledby="balances-heading"
      className="space-y-3"
      data-testid="account-balances-panel"
    >
      <div className="flex flex-wrap items-baseline justify-between gap-2">
        <h2 id="balances-heading" className="text-fg text-sm font-semibold">
          Balances
        </h2>
        <p className="text-muted-fg text-sm">
          Est. value{' '}
          <span className="font-mono" data-testid="balance-est-value">
            ≈ {formatUsd(estimatedValue)} {quoteAsset}
          </span>
          {unpricedNonZero > 0 ? (
            <>
              {' '}
              <span data-testid="balance-unpriced-count" className="text-xs">
                ({unpricedNonZero} unpriced)
              </span>
            </>
          ) : null}
        </p>
      </div>

      <div className="flex flex-wrap items-center gap-3">
        <Input
          type="search"
          value={search}
          onChange={(e) => setSearch(e.target.value)}
          placeholder="Search asset"
          aria-label="Search asset"
          data-testid="balance-search"
          className="h-9 max-w-48"
        />
        <select
          aria-label="Sort balances"
          data-testid="balance-sort"
          className="rounded-xs border-border bg-surface-alt h-9 border px-2 text-sm"
          value={sort}
          onChange={(e) => setSort(e.target.value as SortKey)}
        >
          <option value="value">Value high → low</option>
          <option value="asset">Asset A → Z</option>
        </select>
        <div className="flex items-center gap-2">
          <Switch id="hide-zero" checked={hideZero} onCheckedChange={setHideZero} />
          <Label htmlFor="hide-zero" className="text-muted-fg text-sm">
            Hide zero balances
          </Label>
        </div>
      </div>

      {balances.length === 0 ? (
        <p className="text-muted-fg text-sm">No balances — the account snapshot is empty.</p>
      ) : visible.length === 0 ? (
        <p className="text-muted-fg text-sm">No assets match.</p>
      ) : (
        <>
          {visible.length <= VIRTUALIZE_THRESHOLD ? (
            <ul
              className="divide-border max-h-80 divide-y overflow-y-auto rounded-md border"
              data-testid="balances-list"
            >
              {visible.map((b) => (
                <BalanceRow
                  key={b.asset}
                  balance={b}
                  quoteAsset={quoteAsset}
                  position={positionByAsset.get(b.asset)}
                />
              ))}
            </ul>
          ) : (
            <VirtualisedBalanceList
              visible={visible}
              quoteAsset={quoteAsset}
              positionByAsset={positionByAsset}
            />
          )}
          <p className="text-muted-fg text-xs" data-testid="balance-count">
            Showing {visible.length} of {balances.length} asset{balances.length === 1 ? '' : 's'}
            {hideZero && balances.length - visible.length > 0 ? (
              <>
                {' '}
                <span data-testid="balance-hidden-count">
                  ({balances.length - visible.length} zero hidden)
                </span>
              </>
            ) : null}
            .
          </p>
        </>
      )}
    </section>
  );
}

/**
 * Virtualised row list. A testnet wallet carries hundreds of assets — rendering
 * every row as a DOM node turns the panel into the page's hot spot on every
 * re-render. `useVirtualizer` keeps only the visible window (+ overscan) in
 * the tree; the search/sort/hide-zero parent owns the layout state.
 */
function VirtualisedBalanceList({
  visible,
  quoteAsset,
  positionByAsset,
}: {
  readonly visible: readonly AssetBalance[];
  readonly quoteAsset: string;
  readonly positionByAsset: ReadonlyMap<string, DashboardSymbol>;
}): React.JSX.Element {
  const parentRef = useRef<HTMLDivElement | null>(null);
  // Row height varies (some carry value / avg-entry / P/L lines, some don't).
  // 84px is the median for the taller stacked row; the virtualizer measures
  // each row on mount and reconciles, so the estimate only affects the initial
  // layout — not the steady-state scroll.
  const virtualizer = useVirtualizer({
    count: visible.length,
    getScrollElement: () => parentRef.current,
    estimateSize: () => 84,
    overscan: 8,
    // Key by asset symbol so search/sort reorderings reuse the right DOM
    // node per asset — not the wrong one keyed by its previous index.
    getItemKey: (i) => visible[i]?.asset ?? i,
  });
  return (
    <div
      ref={parentRef}
      role="region"
      aria-label="Asset balances"
      className="border-border max-h-80 overflow-y-auto rounded-md border"
      data-testid="balances-list-scroll"
    >
      <ul
        className="relative w-full"
        style={{ height: `${virtualizer.getTotalSize()}px` }}
        data-testid="balances-list"
      >
        {virtualizer.getVirtualItems().map((vi) => {
          const b = visible[vi.index];
          if (!b) return null;
          return (
            <BalanceRow
              key={b.asset}
              balance={b}
              quoteAsset={quoteAsset}
              position={positionByAsset.get(b.asset)}
              measureRef={virtualizer.measureElement}
              dataIndex={vi.index}
              style={{
                position: 'absolute',
                left: 0,
                top: 0,
                width: '100%',
                transform: `translateY(${vi.start}px)`,
              }}
            />
          );
        })}
      </ul>
    </div>
  );
}
