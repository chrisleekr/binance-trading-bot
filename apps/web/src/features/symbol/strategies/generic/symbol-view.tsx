// Generic StrategyView — the fallback for any strategy without a bespoke view module. No grid, rung, or ladder concepts, so a non-grid strategy (e.g. momentum) reads honestly instead of showing a grid-shaped panel full of zeros. What the bot is waiting for comes from the strategy's own preview rows (the same ones the chart draws), turned into sentences by row tone, so a new strategy gets this readout with no web code. Open orders, balances, technicals, and the chart are shared chrome rendered by the route, not here.

import { formatPrice } from '@/shared/lib/format';
import { distanceFromNow } from '@/features/symbol/lib/order-raw';

import type { PreviewRow } from '@app/strategy-core';
import type { StrategyView, StrategyViewProps } from '@/features/symbol/strategies/types';

/** Plain names for the candle intervals the web serves; anything else is shown as-is. */
const CANDLE_WORD: Record<string, string> = {
  '1m': '1-minute',
  '5m': '5-minute',
  '15m': '15-minute',
  '1h': 'hourly',
  '4h': '4-hour',
  '1d': 'daily',
};

/**
 * One preview row as a sentence about what the bot will do, or null for a row with nothing to say.
 *
 * Keyed on the generic row fields only (tone, triggerWhen, label, price, limitPrice, note), never on a strategy's row codes. A row's `skip` is deliberately ignored: this page builds the preview without the account, so every entry row would read as unfundable; the live entry blocker above the chart is the real answer to "why is it not buying".
 *
 * @param row - The strategy's preview row.
 * @param held - Whether a position is open; flat, a stop row describes where a stop would start after a buy.
 * @param currentPrice - Latest price for the distance phrase, or null before it loads.
 * @returns The sentence, or null when the row carries neither a price nor a note.
 */
function rowSentence(row: PreviewRow, held: boolean, currentPrice: string | null): string | null {
  const label = row.label ?? row.code;
  if (row.price == null) return row.note != null ? `${label}: ${row.note}` : null;
  const price = formatPrice(row.price);
  const dist = distanceFromNow(row.price, currentPrice);
  const at = dist === null ? price : `${price} (${dist})`;
  const isExit = row.tone === 'stop' || row.tone === 'trail' || row.tone === 'sell';
  if (isExit) {
    if (!held) return `If it buys, the ${label.toLowerCase()} would start near ${price}.`;
    const above = row.triggerWhen === 'above';
    // Past the level the sell is due, not pending; "falls to 99" under a price of 97 reads as still waiting.
    const now = currentPrice === null ? NaN : Number(currentPrice);
    const passed = above ? now >= Number(row.price) : now <= Number(row.price);
    if (!passed) return `Sells if price ${above ? 'rises' : 'falls'} to ${at}. (${label})`;
    // A row with a limit price is a stop-limit resting on Binance, so past its trigger it has already fired rather than waiting for the bot's next check.
    return row.limitPrice != null
      ? `Price is already past ${price}. If the exchange stop is resting it has fired, and its sell near ${formatPrice(row.limitPrice)} may not fill if price keeps falling; if not, the bot sells on its next check. (${label})`
      : `Price is already past ${price}; this exit is due on the next check. (${label})`;
  }
  if (row.tone === 'entry' || row.tone === 'buy') {
    return held ? null : `Next buy level: ${at}. (${label})`;
  }
  return `${label}: ${at}.`;
}

/**
 * The Signal panel for a strategy with no bespoke view: whether it holds, and what it is waiting for, from its own preview rows.
 *
 * @param props.state - The symbol's state read; a non-null `avgEntryPrice` means a position is open.
 * @param props.currentPrice - Latest price for the distance phrases, or null before it loads.
 * @param props.previewModel - The strategy's preview rows; absent until the preview builds, which reads as "no levels yet".
 * @returns The panel section.
 */
function GenericSignalPanel({
  state,
  currentPrice,
  previewModel,
}: StrategyViewProps): React.JSX.Element {
  const lbp = state.avgEntryPrice?.avgEntryPrice ?? null;
  const isHolding = lbp !== null;
  const rows = (previewModel?.sections ?? []).flatMap((s) => s.rows);
  // The stop that fires first is the highest one, so it leads.
  const ordered = isHolding
    ? [...rows].sort((a, b) => Number(b.price ?? 0) - Number(a.price ?? 0))
    : rows;
  const sentences = ordered
    .map((r) => rowSentence(r, isHolding, currentPrice))
    .filter((s): s is string => s !== null);
  // `config` is opaque on the wire; `candleInterval` is the one field every candle-reading strategy shares.
  const interval = (state.strategy.config as { candleInterval?: unknown } | null | undefined)
    ?.candleInterval;
  const candleNote =
    typeof interval === 'string'
      ? `It checks once each ${CANDLE_WORD[interval] ?? interval} candle closes.`
      : null;

  return (
    <section className="space-y-2" data-testid="symbol-signal-panel">
      <h2 className="text-sm font-semibold text-fg">Signal</h2>
      {isHolding ? (
        <div className="space-y-1 text-xs" data-testid="symbol-signal-generic-holding">
          <p className="font-medium text-fg">
            Holding since entry <span className="font-mono">{formatPrice(lbp)}</span>.
          </p>
          <SentenceList sentences={sentences} />
        </div>
      ) : (
        <div className="space-y-1 text-xs" data-testid="symbol-signal-generic-flat">
          <p className="font-medium text-fg">Not holding — waiting to buy.</p>
          {sentences.length > 0 ? (
            <>
              <SentenceList sentences={sentences} />
              {candleNote !== null ? <p className="text-muted-fg">{candleNote}</p> : null}
            </>
          ) : (
            <p className="text-muted-fg">
              The buy level appears here once enough price history has loaded.
            </p>
          )}
        </div>
      )}
    </section>
  );
}

/**
 * The panel's sentences as a list, one fact per line so a phone reader scans them top to bottom.
 *
 * @param sentences - Already-worded lines, first-firing level first.
 * @returns The list, or nothing when empty.
 */
function SentenceList({
  sentences,
}: {
  readonly sentences: readonly string[];
}): React.JSX.Element | null {
  if (sentences.length === 0) return null;
  return (
    <ul className="space-y-1 text-muted-fg" data-testid="symbol-signal-sentences">
      {sentences.map((s) => (
        <li key={s}>{s}</li>
      ))}
    </ul>
  );
}

export const genericView: StrategyView = {
  strategyName: '__generic__',
  SignalPanel: GenericSignalPanel,
};
