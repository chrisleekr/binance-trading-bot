// Trailing-trade grid ladder — the strategy-specific side panel. Reads
// `config.buy.gridLevels` and the live `state.currentGridTradeIndex`, both
// trailing-trade concepts, so this module is the only place those grid
// string-keys are read on the web. The symbol route resolves it through the
// StrategyView registry; a non-grid strategy never mounts it. The chart's
// ladder lines are now generic (from the strategy's PreviewModel), not here.
// Display-only `Number` math (apps/web is decimal-barred); the worker re-derives
// every threshold in Decimal at decision time.

import type { SymbolStateResponse } from '@app/contracts';

import { formatAmount } from '@/shared/lib/format';

import { asRecord } from './lib.js';

interface GridLevel {
  // Optional fields are present-but-`undefined` when the opaque level
  // record omits them or carries a wrong type; the row renders a dash.
  readonly triggerPercentage?: string | number | undefined;
  // Max purchase amount: the quote-asset budget for this rung — shown so
  // the operator reads the full ladder here, not just the trigger fraction.
  readonly maxPurchaseAmount?: string | number | undefined;
  // True once the strategy has reached this rung. NOT a fill confirmation:
  // `currentGridTradeIndex` advances optimistically when a buy is emitted,
  // before Binance confirms the fill, so the current rung may still have a
  // resting order.
  readonly reached?: boolean;
}

/**
 * Derive the buy-side grid ladder from the profile's strategy config + state.
 * The ladder is `config.buy.gridLevels`; each rung's `reached` flag comes
 * from the live `state.currentGridTradeIndex` — rungs at or below that index
 * have been reached. The index advances optimistically at buy-emit (before
 * the fill confirms), so `reached` means "the strategy has committed to this
 * rung", not "the order has filled". The API passes `config`/`state` through
 * opaquely because the contract is strategy-agnostic, so they are duck-typed
 * here — apps/web is permitted strategy coupling, and this mirrors the file's
 * other `unknown`-shape guards. Returns null when no grid is configured.
 */
export function buyLadderFromStrategy(
  strategy: SymbolStateResponse['strategy'],
): readonly GridLevel[] | null {
  const levels = asRecord(asRecord(strategy.config)?.['buy'])?.['gridLevels'];
  if (!Array.isArray(levels) || levels.length === 0) return null;
  const idxRaw = asRecord(strategy.state)?.['currentGridTradeIndex'];
  // null index = flat profile (no rung reached). A pre-grid profile that
  // holds a position but has not been re-normalised by a tick yet also
  // reads null here for one tick; the lag is cosmetic and self-heals.
  const currentIndex = typeof idxRaw === 'number' && idxRaw >= 0 ? idxRaw : null;
  // Keep only string/number scalars off the opaque level record; a missing
  // or wrong-typed field reads as `undefined` and the row renders a dash.
  const scalar = (v: unknown): string | number | undefined =>
    typeof v === 'string' || typeof v === 'number' ? v : undefined;
  return levels.map((level, i): GridLevel => {
    const rec = asRecord(level);
    return {
      triggerPercentage: scalar(rec?.['triggerPercentage']),
      maxPurchaseAmount: scalar(rec?.['maxPurchaseAmount']),
      reached: currentIndex !== null && i <= currentIndex,
    };
  });
}

const currentIndexFromGrid = (grid: readonly GridLevel[]): number => {
  // The active rung is the first not-yet-reached level; once every rung is
  // reached the last one stays highlighted.
  const idx = grid.findIndex((row) => row.reached !== true);
  return idx === -1 ? grid.length - 1 : Math.max(0, idx);
};

/** Trailing-trade's strategy-specific side panel: the configured buy ladder and a flat-state what-if projection. */
export function GridLadderPanel({
  state,
  currentPrice,
}: {
  readonly state: SymbolStateResponse;
  readonly currentPrice: string | null;
}): React.JSX.Element {
  const buyGrid = buyLadderFromStrategy(state.strategy);
  // The projection is a flat-state planning tool — "if a position opens here
  // and every rung fills, what does it build". Once a position is open the
  // remaining rungs trigger off the real `avgEntryPrice`, not today's price,
  // so showing it then would contradict the chart's next-trigger overlay;
  // suppress it. Flatness reads the structured contract field
  // `SymbolStateResponse.avgEntryPrice` (null when flat) — the same source the
  // chart overlay uses, so the two never disagree.
  const isFlat = state.avgEntryPrice == null;
  const price = Number(currentPrice);
  const projection =
    buyGrid && isFlat && Number.isFinite(price) && price > 0
      ? projectGridLadder(buyGrid, price)
      : [];
  return (
    <section className="space-y-3" data-testid="grid-ladder-panel">
      <h2 className="text-sm font-semibold">Grid trade</h2>
      {buyGrid ? (
        <>
          <GridTable label="Buy ladder" rows={buyGrid} />
          {projection.length > 0 ? <GridProjection rows={projection} entryPrice={price} /> : null}
        </>
      ) : (
        <p className="text-muted-fg text-sm">
          No grid configured yet. Open Config above to set up a buy ladder.
        </p>
      )}
    </section>
  );
}

/** One projected grid rung — see {@link projectGridLadder}. */
interface GridProjectionRow {
  readonly rung: number;
  readonly fillPrice: number;
  readonly quoteSpent: number;
  readonly baseQty: number;
  readonly cumQuote: number;
  readonly cumBase: number;
  readonly avgCost: number;
}

/**
 * Project a configured grid ladder from a hypothetical entry price — the
 * grid-trade calculator. A what-if for a flat profile: rung 0 fills at
 * `entryPrice`, and the projection chains each later rung's fill at
 * `projectedFill[N-1] * triggerPercentage[N]`. This is the *projection's*
 * model, an approximation of the executor — `tick.ts` evaluateGridBuy fires
 * rung N off the real `avgEntryPrice` and a MARKET buy fills at-or-below the
 * trigger, so a real ladder's average cost runs at or under the projection.
 * Per rung the quote spent is the level's `maxPurchaseAmount`; base acquired
 * is `quote / fillPrice`; `avgCost` is cumQuote / cumBase. Display-only
 * `Number` math (apps/web is decimal-barred). Returns `[]` for a non-positive
 * entry price or any level whose fields are absent / non-positive.
 */
export function projectGridLadder(
  levels: readonly GridLevel[],
  entryPrice: number,
): readonly GridProjectionRow[] {
  if (!Number.isFinite(entryPrice) || entryPrice <= 0) return [];
  const rows: GridProjectionRow[] = [];
  let prevFill = entryPrice;
  let cumQuote = 0;
  let cumBase = 0;
  for (let i = 0; i < levels.length; i += 1) {
    const lvl = levels[i];
    if (lvl === undefined) return [];
    const quoteSpent = Number(lvl.maxPurchaseAmount);
    if (!Number.isFinite(quoteSpent) || quoteSpent <= 0) return [];
    let fillPrice: number;
    if (i === 0) {
      fillPrice = entryPrice;
    } else {
      // Rung 0's triggerPercentage is informational (no prior fill); a
      // promotion rung needs a positive trigger fraction.
      const trig = Number(lvl.triggerPercentage);
      if (!Number.isFinite(trig) || trig <= 0) return [];
      fillPrice = prevFill * trig;
    }
    const baseQty = quoteSpent / fillPrice;
    cumQuote += quoteSpent;
    cumBase += baseQty;
    rows.push({
      rung: i,
      fillPrice,
      quoteSpent,
      baseQty,
      cumQuote,
      cumBase,
      avgCost: cumBase > 0 ? cumQuote / cumBase : 0,
    });
    prevFill = fillPrice;
  }
  return rows;
}

/** Renders the {@link projectGridLadder} preview below the configured ladder. */
function GridProjection({
  rows,
  entryPrice,
}: {
  readonly rows: readonly GridProjectionRow[];
  readonly entryPrice: number;
}): React.JSX.Element {
  const last = rows[rows.length - 1];
  return (
    <div className="space-y-1" data-testid="grid-projection">
      <div className="text-muted-fg text-xs">
        Projection — if a position opens at {formatAmount(entryPrice)} and every buy level fills
      </div>
      <ul className="divide-border divide-y rounded-none border">
        {rows.map((r) => (
          <li
            key={r.rung}
            className="flex items-baseline justify-between gap-2 px-3 py-1.5 text-xs"
          >
            <span className="font-semibold">#{r.rung + 1}</span>
            <span className="text-muted-fg font-mono">
              fill {formatAmount(r.fillPrice)} · spend {formatAmount(r.quoteSpent)}
            </span>
          </li>
        ))}
      </ul>
      {last ? (
        <p className="text-muted-fg text-xs">
          All {rows.length} buy level{rows.length > 1 ? 's' : ''} filled → spent{' '}
          {formatAmount(last.cumQuote)}, average cost {formatAmount(last.avgCost)}
        </p>
      ) : null}
    </div>
  );
}

/**
 * Resolved quote a grid rung spends: the level's `maxPurchaseAmount`, the
 * budget `tick.ts` evaluateGridBuy passes to the order sizer. Display-only
 * `Number` math (apps/web is decimal-barred). Returns `'—'` unless it is a
 * strictly-positive number — the panel renders opaque persisted config that
 * has not been through the schema's positive-decimal refine, so an empty /
 * zero / negative value (which `Number()` would coerce to a confident-but-
 * wrong `0`) must read as "no value", matching how the executor's filter
 * logic would skip such a rung.
 */
export function levelBudget(row: GridLevel): string {
  const max = Number(row.maxPurchaseAmount);
  if (!Number.isFinite(max) || max <= 0) return '—';
  return formatAmount(max);
}

function GridTable({
  label,
  rows,
}: {
  readonly label: string;
  readonly rows: readonly GridLevel[];
}): React.JSX.Element {
  const currentIdx = currentIndexFromGrid(rows);
  return (
    <div className="space-y-1">
      <div className="text-muted-fg text-xs">{label}</div>
      <ul
        className="divide-border divide-y rounded-none border"
        data-testid={`grid-${label.toLowerCase().replace(/\s+/g, '-')}`}
      >
        {rows.map((row, i) => {
          const active = i === currentIdx;
          return (
            <li
              key={i}
              className={'space-y-0.5 px-3 py-2 text-xs ' + (active ? 'bg-accent/15' : '')}
              data-testid={`grid-row-${i}`}
              aria-current={active ? 'true' : undefined}
            >
              <div className="flex items-center justify-between">
                <span className="font-semibold">#{i + 1}</span>
                <span className={row.reached ? 'font-medium' : 'text-muted-fg'}>
                  {row.reached ? 'reached' : 'pending'}
                </span>
              </div>
              <div className="text-muted-fg flex flex-wrap gap-x-3 gap-y-0.5">
                {/* Rung 0 is the entry buy — its triggerPercentage has no
                    prior fill to compare against, so it is not shown. */}
                <span>{i === 0 ? 'entry' : `trigger ${String(row.triggerPercentage ?? '—')}`}</span>
                {/* Spend is the level's max purchase amount budget. */}
                <span>spend {levelBudget(row)}</span>
              </div>
            </li>
          );
        })}
      </ul>
    </div>
  );
}
