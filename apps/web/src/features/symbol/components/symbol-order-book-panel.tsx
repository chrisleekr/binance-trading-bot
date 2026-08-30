// Symbol order-book panel — the Binance-style depth ladder for the pair.
//
// Self-contained widget: owns its `/symbols/{sym}/depth` query and polls.
// Asks (red) render above bids (green) framing a centre row that carries the
// last-traded price and the spread, mirroring Binance's spot order book. Each
// row shows Price / Amount / Total — Total being the running cumulative volume
// from the best price outward — and carries a cumulative-depth bar of the same
// proportion behind it, so relative liquidity is scannable at a glance.
//
// Display-only — apps/web is barred from decimal.js; these values never feed
// an order, so a Number round-trip for formatting is safe.

import { useQuery } from '@tanstack/react-query';
import { useMemo, useState } from 'react';

import { fetchSymbolOrderBook, symbolOrderBookQueryKey } from '@/features/symbol/api/symbol';
import { groupingSteps, groupLevels } from '@/features/symbol/lib/order-book-group';
import { TableSkeleton } from '@/shared/components/page-skeleton';
import { formatAmount, formatPrice } from '@/shared/lib/format';
import { Select } from '@/shared/components/ui/select';

import type { OrderBook, OrderBookLevel } from '@app/contracts';

/** Depth shifts continuously; an 8s poll keeps the ladder live without hammering Binance. */
const DEPTH_REFETCH_MS = 8_000;
/** Levels rendered per side — a readable ladder, sliced from the deeper payload. */
const DISPLAY_LEVELS = 12;

/** A price level paired with the running volume from the best price down to it. */
interface CumulativeLevel {
  readonly level: OrderBookLevel;
  readonly cumulative: number;
}

/**
 * Accumulate `qty` from the best price outward. Input is best-first; the
 * returned array keeps that order and carries each level's running total.
 */
function accumulate(levels: readonly OrderBookLevel[]): CumulativeLevel[] {
  let running = 0;
  return levels.map((level) => {
    running += Number(level.qty);
    return { level, cumulative: running };
  });
}

function LevelRow({
  entry,
  side,
  maxCumulative,
}: {
  readonly entry: CumulativeLevel;
  readonly side: 'ask' | 'bid';
  readonly maxCumulative: number;
}): React.JSX.Element {
  // Bar width tracks cumulative depth relative to the deeper side's total, so
  // asks and bids stay visually comparable. Anchored right, Binance-style.
  // Rounded to 2dp — sub-pixel precision is invisible and churns the DOM attr.
  const depthPct = maxCumulative > 0 ? ((entry.cumulative / maxCumulative) * 100).toFixed(2) : '0';
  return (
    <li className="relative grid grid-cols-3 gap-2 px-3 py-0.5 text-xs tabular-nums">
      <span
        aria-hidden
        data-testid="depth-bar"
        className="absolute inset-y-0 right-0"
        style={{
          width: `${depthPct}%`,
          backgroundColor: `color-mix(in srgb, ${side === 'ask' ? 'var(--down)' : 'var(--up)'} 16%, transparent)`,
        }}
      />
      <span
        aria-label={`${side === 'ask' ? 'Ask' : 'Bid'} ${formatPrice(entry.level.price)}`}
        className={`relative font-mono ${side === 'ask' ? 'text-down' : 'text-up'}`}
      >
        {formatPrice(entry.level.price)}
      </span>
      <span className="relative text-right font-mono text-muted-fg">
        {formatAmount(entry.level.qty)}
      </span>
      <span data-testid="depth-total" className="relative text-right font-mono text-muted-fg">
        {formatAmount(entry.cumulative)}
      </span>
    </li>
  );
}

/**
 * Best-ask-minus-best-bid of the *raw* book, formatted. Computed from the
 * ungrouped levels so the spread reflects the true market, not the artefact
 * of whatever grouping step the operator picked.
 */
function rawSpread(book: OrderBook): string {
  const bestAsk = Number(book.asks[0]?.price ?? NaN);
  const bestBid = Number(book.bids[0]?.price ?? NaN);
  return Number.isFinite(bestAsk) && Number.isFinite(bestBid)
    ? formatAmount(bestAsk - bestBid)
    : '—';
}

function Ladder({
  book,
  lastPrice,
  spread,
}: {
  readonly book: OrderBook;
  readonly lastPrice: string | null;
  /** Pre-computed raw-book spread — see {@link rawSpread}. */
  readonly spread: string;
}): React.JSX.Element {
  // Asks ascend best-first; accumulate then render reversed so the best ask
  // sits just above the spread row, Binance-style. Bids already descend
  // best-first. Both sides scale to the deeper side's cumulative total.
  const asks = accumulate(book.asks.slice(0, DISPLAY_LEVELS));
  const bids = accumulate(book.bids.slice(0, DISPLAY_LEVELS));
  const askTotal = asks.at(-1)?.cumulative ?? 0;
  const bidTotal = bids.at(-1)?.cumulative ?? 0;
  const maxCumulative = Math.max(askTotal, bidTotal);
  // Bid share of the top-12 displayed depth — Binance's order-book buy/sell
  // ratio. A book heavy on bids reads as buy pressure. Defaults to a balanced
  // 50 when both sides are empty so the bar renders without a divide-by-zero.
  // Rounded once here so the two labels always sum to 100.
  const bidPct = bidTotal + askTotal > 0 ? (bidTotal / (bidTotal + askTotal)) * 100 : 50;
  const bidLabel = Math.round(bidPct);

  return (
    <div className="rounded-md border border-border" data-testid="order-book-ladder">
      <div className="grid grid-cols-3 gap-2 px-3 py-1 text-xs text-muted-fg">
        <span>Price</span>
        <span className="text-right">Amount</span>
        <span className="text-right">Total</span>
      </div>
      {/* Side label, not colour alone, so a colour-blind operator can tell sells
          from buys; doubles as an inline gloss for ask/bid. */}
      <div
        className="px-3 py-0.5 text-xs font-medium text-down/80"
        data-testid="order-book-asks-label"
      >
        Asks · sell orders
      </div>
      <ul>
        {/* accumulate returns a fresh array owned here — reverse it in place. */}
        {asks.reverse().map((entry, i) => (
          <LevelRow key={`a${i}`} entry={entry} side="ask" maxCumulative={maxCumulative} />
        ))}
      </ul>
      {/* Binance centres the last-traded price between asks and bids — it is
          the number an operator scans the book for. Spread stays as secondary
          context. Falls back to a spread-only row when no price is known. */}
      <div
        className="flex items-baseline justify-between gap-2 border-y border-border px-3 py-1.5"
        data-testid="order-book-spread"
      >
        {lastPrice !== null ? (
          <span className="font-mono text-base font-semibold tabular-nums">
            {formatPrice(lastPrice)}
          </span>
        ) : null}
        <span className="ml-auto text-xs text-muted-fg">
          <abbr
            title="Spread — the gap between the lowest sell price and the highest buy price. A smaller spread means a more liquid, cheaper-to-trade market."
            className="no-underline"
          >
            Spread
          </abbr>{' '}
          {spread}
        </span>
      </div>
      <div
        className="px-3 py-0.5 text-xs font-medium text-up/80"
        data-testid="order-book-bids-label"
      >
        Bids · buy orders
      </div>
      <ul>
        {bids.map((entry, i) => (
          <LevelRow key={`b${i}`} entry={entry} side="bid" maxCumulative={maxCumulative} />
        ))}
      </ul>
      {/* Binance's buy/sell ratio: the bid share of the displayed depth as a
          split bar, so the operator reads the book's lean at a glance. */}
      <div
        className="flex items-center gap-2 border-t border-border px-3 py-1.5 text-xs tabular-nums"
        data-testid="order-book-ratio"
      >
        <span className="font-mono font-medium text-up">B {bidLabel}%</span>
        <div
          aria-hidden
          className="flex h-1.5 flex-1 overflow-hidden rounded-none"
          style={{ backgroundColor: 'color-mix(in srgb, var(--down) 30%, transparent)' }}
        >
          <div
            style={{
              width: `${bidPct.toFixed(1)}%`,
              backgroundColor: 'color-mix(in srgb, var(--up) 70%, transparent)',
            }}
          />
        </div>
        <span className="font-mono font-medium text-down">{100 - bidLabel}% S</span>
      </div>
    </div>
  );
}

/**
 * Order-book panel for the symbol-detail screen. Self-contained: owns its
 * query and poll. Loading / empty / error degrade to a thin notice.
 */
export function SymbolOrderBookPanel({
  profileId,
  symbol,
  lastPrice,
}: {
  readonly profileId: string;
  readonly symbol: string;
  /** Last-traded price, centred Binance-style in the spread row. */
  readonly lastPrice: string | null;
}): React.JSX.Element {
  const book = useQuery({
    queryKey: symbolOrderBookQueryKey(profileId, symbol),
    queryFn: () => fetchSymbolOrderBook(profileId, symbol),
    refetchInterval: DEPTH_REFETCH_MS,
    staleTime: DEPTH_REFETCH_MS,
  });

  const hasDepth = book.isSuccess && (book.data.bids.length > 0 || book.data.asks.length > 0);

  // Grouping: `null` means "follow the finest step" so the control tracks the
  // book's natural tick until the operator picks a coarser bucket.
  const [step, setStep] = useState<number | null>(null);
  const steps = useMemo(
    () => (book.isSuccess ? groupingSteps(book.data) : []),
    [book.isSuccess, book.data],
  );
  const effectiveStep = step ?? steps[0] ?? 0;
  const grouped = useMemo<OrderBook | null>(
    () =>
      book.isSuccess
        ? {
            asks: groupLevels(book.data.asks, 'ask', effectiveStep),
            bids: groupLevels(book.data.bids, 'bid', effectiveStep),
          }
        : null,
    [book.isSuccess, book.data, effectiveStep],
  );

  return (
    <section className="space-y-2" data-testid="symbol-order-book-panel">
      <div className="flex items-center justify-between gap-2">
        <h2 className="text-sm font-semibold text-fg">Order book</h2>
        {hasDepth && steps.length > 0 ? (
          <label className="flex items-center gap-1 text-xs text-muted-fg">
            Group
            <Select
              variant="sm"
              data-testid="order-book-group"
              value={String(effectiveStep)}
              onChange={(e) => setStep(Number(e.target.value))}
            >
              {steps.map((s) => (
                <option key={s} value={s}>
                  {s}
                </option>
              ))}
            </Select>
          </label>
        ) : null}
      </div>
      {hasDepth && grouped && book.isSuccess ? (
        <Ladder book={grouped} lastPrice={lastPrice} spread={rawSpread(book.data)} />
      ) : book.isLoading ? (
        // The ladder is DISPLAY_LEVELS a side plus the spread row; half that in
        // taller placeholder rows reserves roughly the box it will occupy.
        <TableSkeleton rows={DISPLAY_LEVELS} />
      ) : (
        <p className="text-sm text-muted-fg">
          {book.isError ? 'Order book unavailable.' : 'No depth.'}
        </p>
      )}
    </section>
  );
}
