// Symbol stats strip — the Binance-style 24h ticker that anchors the
// symbol-detail header.
//
// Ports the market-data row Binance shows above the chart: last price, the
// 24h absolute and percentage change, the 24h high/low, and the 24h base /
// quote volume. The query is the shared `symbolTickerQuery`, so the last price
// shown here is the same cache entry the workspace marks unrealised P/L
// against — one poll, and the two numbers cannot disagree.
//
// Display-only — apps/web is barred from decimal.js, and none of these
// values feed an order, so a Number round-trip for formatting is safe here.
// Prices render through the shared `formatPrice` so the header precision
// matches every other screen; `toNum` stays local for the volume + change math.

import { useQuery } from '@tanstack/react-query';

import { symbolTickerQuery } from '@/features/symbol/api/symbol';
import { LoadingStatus } from '@/shared/components/page-skeleton';
import { Skeleton } from '@/shared/components/ui/skeleton';
import { formatPrice } from '@/shared/lib/format';
import { useFlashOnChange, type FlashTone } from '@/shared/lib/use-flash-on-change';

import type { Ticker24hr } from '@app/contracts';

/**
 * Inline background tint for a value that just changed — green up, red down,
 * fading back out via the caller's `transition-colors`. `color-mix` keeps the
 * tint translucent so it reads as a flash, not a solid fill.
 */
function flashStyle(tone: FlashTone): React.CSSProperties | undefined {
  if (tone == null) return undefined;
  const base = tone === 'up' ? 'var(--up)' : 'var(--down)';
  return { backgroundColor: `color-mix(in srgb, ${base} 22%, transparent)` };
}

function toNum(value: string): number {
  const n = Number(value);
  return Number.isFinite(n) ? n : NaN;
}

/** Compact volume formatting — 1_234_567 → "1.23M". Keeps the strip readable on a 375px viewport. */
function formatVolume(value: string): string {
  const n = toNum(value);
  if (Number.isNaN(n)) return value;
  return n.toLocaleString(undefined, { notation: 'compact', maximumFractionDigits: 2 });
}

function StatCell({
  label,
  children,
}: {
  readonly label: string;
  readonly children: React.ReactNode;
}): React.JSX.Element {
  return (
    <div className="flex flex-col gap-0.5">
      <span className="text-muted-fg text-xs">{label}</span>
      <span className="font-mono text-sm font-medium tabular-nums">{children}</span>
    </div>
  );
}

// Shared by the loaded row and its placeholder. The strip wraps, so the two
// must carry the identical container: same gaps, same padding, same wrap rule.
const STATS_ROW_CLASS =
  'border-border bg-bg-elevated flex flex-wrap items-center gap-x-6 gap-y-3 rounded-md border px-4 py-3';

/** One placeholder stat cell: an `text-xs` label bar over a value bar. */
function StatCellSkeleton({
  width,
  tall = false,
}: {
  readonly width: string;
  readonly tall?: boolean;
}): React.JSX.Element {
  return (
    <div className="flex flex-col gap-0.5">
      <Skeleton className={`h-4 ${width}`} />
      {/* h-7 / h-5 are the `text-xl` and `text-sm` line boxes the real cells
          occupy, so the placeholder row is the same height as the loaded one. */}
      <Skeleton className={tall ? `h-7 ${width}` : `h-5 ${width}`} />
    </div>
  );
}

function StatsRow({ ticker }: { readonly ticker: Ticker24hr }): React.JSX.Element {
  const flash = useFlashOnChange(ticker.lastPrice);
  const changePct = toNum(ticker.priceChangePercent);
  const up = !Number.isNaN(changePct) && changePct >= 0;
  const changeColor = Number.isNaN(changePct) ? '' : up ? 'text-up' : 'text-down';
  const signedPct = Number.isNaN(changePct)
    ? ticker.priceChangePercent
    : `${up ? '+' : ''}${changePct.toFixed(2)}%`;
  const signedChange = (() => {
    const n = toNum(ticker.priceChange);
    if (Number.isNaN(n)) return ticker.priceChange;
    return `${n >= 0 ? '+' : ''}${formatPrice(ticker.priceChange)}`;
  })();

  return (
    <div className={STATS_ROW_CLASS} data-testid="symbol-stats-strip">
      <div className="flex flex-col gap-0.5">
        <span className="text-muted-fg text-xs">Last price</span>
        <span
          // duration-700 is the fade-out for the useFlashOnChange tint, kept
          // longer than FLASH_MS so the colour eases out after the tone clears.
          className={
            '-mx-1 rounded px-1 font-mono text-xl font-semibold tabular-nums transition-colors duration-700 ' +
            changeColor
          }
          style={flashStyle(flash)}
          data-testid="symbol-last-price"
          data-flash={flash ?? undefined}
        >
          {formatPrice(ticker.lastPrice)}
        </span>
      </div>
      <StatCell label="24h change">
        <span className={changeColor} data-testid="symbol-24h-change">
          {signedChange} ({signedPct})
        </span>
      </StatCell>
      <StatCell label="24h high">{formatPrice(ticker.highPrice)}</StatCell>
      <StatCell label="24h low">{formatPrice(ticker.lowPrice)}</StatCell>
      <StatCell label="24h volume">{formatVolume(ticker.volume)}</StatCell>
      <StatCell label="24h quote volume">{formatVolume(ticker.quoteVolume)}</StatCell>
    </div>
  );
}

/**
 * 24h market-stats strip for the symbol-detail header. Loading and error states
 * degrade to a thin inline notice rather than collapsing the header height.
 */
export function SymbolStatsStrip({
  profileId,
  symbol,
}: {
  readonly profileId: string;
  readonly symbol: string;
}): React.JSX.Element {
  const ticker = useQuery(symbolTickerQuery(profileId, symbol));

  if (ticker.isSuccess) return <StatsRow ticker={ticker.data} />;

  if (ticker.isLoading || ticker.isPaused) {
    // Mirrors the loaded row rather than reserving a fixed height: the strip
    // wraps, so six cells sit on one line on a desktop and on three at 375px,
    // and any single height would be wrong at most widths. Same container and
    // roughly the same cell widths means it wraps at the same viewport widths
    // the loaded strip does, so the header holds still when the ticker lands.
    return (
      <LoadingStatus>
        <div className={STATS_ROW_CLASS}>
          <StatCellSkeleton width="w-24" tall />
          <StatCellSkeleton width="w-32" />
          <StatCellSkeleton width="w-20" />
          <StatCellSkeleton width="w-20" />
          <StatCellSkeleton width="w-24" />
          <StatCellSkeleton width="w-32" />
        </div>
      </LoadingStatus>
    );
  }

  return (
    <div
      className="border-border bg-bg-elevated text-muted-fg flex items-center rounded-md border px-4 py-3 text-sm"
      data-testid="symbol-stats-strip"
    >
      24h stats unavailable.
    </div>
  );
}
