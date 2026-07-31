// One-off generator for the hermetic backtest golden-fixture candle series.
// Run once with `bun scripts/gen-golden-candles.mjs`; the emitted JSONL is
// committed and read by the golden gate. NOT part of the build or CI — the
// fixture is the source of truth, this only regenerates it on intent.
import { writeFileSync } from 'node:fs';
import { resolve } from 'node:path';

const HOUR = 3_600_000;
const START = 1_700_000_000_000;

// Close-price path: a flat warm-up, a first-buy window, a +6% climb that arms
// the trailing sell, then a pullback through the trailing stop, then drift.
const closes = [
  100,
  100,
  100, // warm-up
  100, // first-buy fires here (post warm-up)
  101,
  103,
  106,
  108, // climb past +5% trigger; high = 108
  104,
  102, // pullback through trailing stop (0.98 * 108 = 105.84)
  101,
  103,
  100, // first-buy can re-arm after lbp clears
  98,
  96,
  99,
  102,
  105,
  103, // second cycle
];

/** OHLC around a close: a symmetric ±0.8% range so resting LIMITs can cross. */
function candle(i, close, prevClose) {
  const open = prevClose ?? close;
  const hi = Math.max(open, close) * 1.008;
  const lo = Math.min(open, close) * 0.992;
  const openTimeMs = START + i * HOUR;
  return {
    openTimeMs,
    closeTimeMs: openTimeMs + HOUR - 1,
    open: open.toFixed(2),
    high: hi.toFixed(2),
    low: lo.toFixed(2),
    close: close.toFixed(2),
    volume: '10',
    isClosed: true,
  };
}

const lines = closes.map((c, i) => JSON.stringify(candle(i, c, closes[i - 1])));
const out = resolve('packages/strategy/backtest/__tests__/fixtures/golden/tt-btc-1h.jsonl');
writeFileSync(out, lines.join('\n') + '\n');
console.log(`wrote ${lines.length} candles → ${out}`);
