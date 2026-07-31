// Market-trend card. A global read of the broad tape — BTC/ETH daily regime
// plus USDT universe breadth — polled from /market-trend. It is CONTEXT, not
// the per-symbol gate any strategy evaluates, so the copy says "market" and
// the footnote spells that out. Shown on every dashboard view (both 'all' and
// single-profile scope) because the tape is the same regardless of which
// profile the operator is looking at.

import { useQuery } from '@tanstack/react-query';
import { useEffect, useState } from 'react';
import type React from 'react';

import { fetchMarketTrend, marketTrendQueryKey } from '@/features/dashboard/api/market-trend';
import type { MarketRegime, MarketTrendSymbol } from '@app/contracts';

/**
 * Web poll cadence. The /market-trend route only reads one Redis key (no
 * Binance call), so polling fast is cheap; 5s picks up a freshly-written
 * snapshot within a few seconds of the cron writing it.
 */
const POLL_MS = 5_000;

/**
 * Worker cron cadence — mirrors the market-trend cron's `selfReschedulePeriodMs`.
 * Drives the "next update in ~Xs" countdown so the operator knows when the next
 * reading lands rather than watching a stale age creep up.
 */
const CRON_PERIOD_MS = 60_000;

/**
 * Snapshot age past which the read is treated as not updating. The cron writes
 * every ~60s, so >5 min means several missed cycles — the worker is likely down
 * and the operator should be told to restart it.
 */
const STALE_AFTER_MS = 5 * 60_000;

/**
 * Footer freshness label, framed by what the operator should do. Normal case
 * counts down to the next scheduled write; the brief gap right after it shows
 * "Checking…". Once the reading is genuinely old (several missed cycles, worker
 * likely down) it says so plainly and names the fix — no "stale", no
 * contradictory "updating" on a reading that is clearly not moving.
 */
function freshnessLabel(computedAtMs: number, nowMs: number): { text: string; warn: boolean } {
  const secsLeft = Math.ceil((computedAtMs + CRON_PERIOD_MS - nowMs) / 1000);
  if (secsLeft > 0) {
    // Clamp to the cron period: if the worker clock runs ahead of the browser,
    // raw secsLeft can exceed the period and show a confusing ">60s".
    const shown = Math.min(secsLeft, Math.ceil(CRON_PERIOD_MS / 1000));
    return { text: `Next update in ~${shown}s`, warn: false };
  }
  if (nowMs - computedAtMs > STALE_AFTER_MS) {
    return { text: 'Updates stopped. Restart the worker.', warn: true };
  }
  return { text: 'Checking…', warn: false };
}

// Regime labels match the trade wording the rest of the app uses internally;
// the arrow glyph and colour carry the plain-language read alongside.
const REGIME_META: Readonly<Record<MarketRegime, { tone: string; glyph: string; label: string }>> =
  {
    bull: { tone: 'text-success', glyph: '▲', label: 'Bull' },
    bear: { tone: 'text-danger', glyph: '▼', label: 'Bear' },
    neutral: { tone: 'text-muted-fg', glyph: '◆', label: 'Neutral' },
  };

/** Compact price with a $ sign: 4 dp under $10 (alt prices), grouped above. */
function formatPrice(value: string): string {
  const n = Number(value);
  if (!Number.isFinite(n)) return '—';
  return n < 10
    ? `$${n.toLocaleString(undefined, { maximumFractionDigits: 4 })}`
    : `$${n.toLocaleString(undefined, { maximumFractionDigits: 0 })}`;
}

/**
 * Plain-language gap to the 50-day average price — the line the regime reads.
 * "10.6% below 50-day avg" instead of the "% vs SMA50" jargon; above the
 * average is roughly healthy, below it is weak.
 */
function pctVsSma50(sym: MarketTrendSymbol): string {
  const last = Number(sym.price);
  const ma = Number(sym.sma50);
  if (!Number.isFinite(last) || !Number.isFinite(ma) || ma === 0) return '—';
  const ratio = (last / ma - 1) * 100;
  const direction = ratio >= 0 ? 'above' : 'below';
  return `${Math.abs(ratio).toFixed(1)}% ${direction} 50-day avg`;
}

/**
 * One short, plain-language read of the tape. The strong calls require BOTH
 * Bitcoin and Ethereum to agree (all down / all up) so the copy never says
 * "both falling" when one is up; a split pair with most coins down reads as
 * cautious, and everything else is an explicit "no clear direction".
 */
function verdict(symbols: readonly MarketTrendSymbol[], percentUp: number): string {
  const n = symbols.length;
  const bears = symbols.filter((s) => s.regime === 'bear').length;
  const bulls = symbols.filter((s) => s.regime === 'bull').length;
  const mostDown = percentUp < 50;
  if (n > 0 && bears === n && mostDown)
    return 'Weak market — Bitcoin and Ethereum are both falling and most coins are down today.';
  if (n > 0 && bulls === n && !mostDown)
    return 'Strong market — Bitcoin and Ethereum are both rising and most coins are up today.';
  if (mostDown) return 'Mixed and cautious — most coins are down today.';
  return 'Mixed — no clear direction right now.';
}

function SymbolRow({ sym }: { sym: MarketTrendSymbol }) {
  const meta = REGIME_META[sym.regime];
  const base = sym.symbol.replace(/USDT$/, '');
  return (
    <div
      className="bg-bg-elevated flex items-center justify-between gap-2 p-3"
      data-testid={`market-trend-${sym.symbol}`}
    >
      <div className="flex items-center gap-2">
        <span className="text-fg font-medium">{base}</span>
        <span
          className={`text-xs font-semibold ${meta.tone}`}
          data-testid={`market-trend-${sym.symbol}-regime`}
        >
          {meta.glyph} {meta.label}
        </span>
      </div>
      <div className="text-right">
        <div className="text-fg font-mono text-sm tabular-nums">{formatPrice(sym.price)}</div>
        <div className="text-muted-fg text-[11px] tabular-nums">{pctVsSma50(sym)}</div>
      </div>
    </div>
  );
}

function BreadthRow({
  percentUp,
  upCount,
  total,
}: {
  percentUp: number;
  upCount: number;
  total: number;
}) {
  const mostDown = percentUp < 50;
  const tone = mostDown ? 'text-warning' : 'text-success';
  const barTone = mostDown ? 'bg-warning' : 'bg-success';
  return (
    <div className="bg-bg-elevated flex flex-col gap-1 p-3" data-testid="market-trend-breadth">
      <div className="flex items-center justify-between text-xs">
        <span className="text-muted-fg">Coins rising (24h)</span>
        <span className={`font-semibold tabular-nums ${tone}`}>
          {percentUp.toFixed(0)}% rising · {mostDown ? 'Cautious' : 'Upbeat'}
        </span>
      </div>
      <div
        className="bg-border h-1.5 w-full overflow-hidden rounded-full"
        role="meter"
        aria-valuenow={Math.round(percentUp)}
        aria-valuemin={0}
        aria-valuemax={100}
        aria-label={`Market breadth: ${upCount} of ${total} pairs up over 24 hours`}
      >
        <div className={`h-full ${barTone}`} style={{ width: `${percentUp}%` }} />
      </div>
    </div>
  );
}

/**
 * Render the market-trend card. Loading and warming (no snapshot yet) collapse
 * to a single muted line so the dashboard never flashes a zeroed band.
 */
export function MarketTrendCard(): React.JSX.Element | null {
  const q = useQuery({
    queryKey: marketTrendQueryKey(),
    queryFn: fetchMarketTrend,
    refetchInterval: POLL_MS,
    staleTime: POLL_MS,
  });

  // Tick once a second so the "next update" countdown actually counts down
  // between polls instead of freezing until the next refetch forces a render.
  const [nowMs, setNowMs] = useState(() => Date.now());
  useEffect(() => {
    const id = setInterval(() => setNowMs(Date.now()), 1000);
    return () => clearInterval(id);
  }, []);

  const Shell = ({ children }: { children: React.ReactNode }) => (
    <section
      className="@container space-y-2"
      aria-label="Market trend"
      data-testid="market-trend-card"
    >
      <h2 className="text-muted-fg text-[11px] font-semibold uppercase tracking-wider">
        Market trend
      </h2>
      {children}
    </section>
  );

  if (q.isLoading) {
    return (
      <Shell>
        <p className="text-muted-fg text-xs">Loading market trend…</p>
      </Shell>
    );
  }
  const trend = q.data?.trend ?? null;
  if (q.error || trend === null) {
    return (
      <Shell>
        <p
          className="text-muted-fg text-xs"
          data-testid={q.error ? 'market-trend-error' : 'market-trend-warming'}
        >
          {q.error ? 'Market trend unavailable.' : 'Getting the latest market data…'}
        </p>
      </Shell>
    );
  }

  const freshness = freshnessLabel(trend.computedAtMs, nowMs);

  return (
    <Shell>
      <div className="@md:grid-cols-2 border-border bg-border grid grid-cols-1 gap-px border">
        {trend.symbols.map((sym) => (
          <SymbolRow key={sym.symbol} sym={sym} />
        ))}
        <BreadthRow
          percentUp={trend.breadth.percentUp}
          upCount={trend.breadth.upCount}
          total={trend.breadth.total}
        />
        <div
          className="bg-bg-elevated text-fg flex items-center p-3 text-xs"
          data-testid="market-trend-verdict"
        >
          {verdict(trend.symbols, trend.breadth.percentUp)}
        </div>
      </div>
      {freshness.warn ? (
        <p
          className="text-warning text-[11px] font-medium"
          data-testid="market-trend-age"
          role="status"
        >
          {freshness.text}
        </p>
      ) : (
        <div className="flex items-center justify-between gap-2 text-[11px]">
          <p className="text-muted-fg">
            The overall market mood. It&apos;s context, not a buy or sell signal — your bot still
            decides each coin on its own.
          </p>
          <span className="text-muted-fg shrink-0 tabular-nums" data-testid="market-trend-age">
            {freshness.text}
          </span>
        </div>
      )}
    </Shell>
  );
}
