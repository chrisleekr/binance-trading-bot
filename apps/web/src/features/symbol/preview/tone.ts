// The ONE place PreviewTone maps to a colour, so scripts/ci/no-arbitrary-color-token.sh
// polices a single map. Two consumers:
//   - the preview panel text tone (semantic Tailwind token), and
//   - the candle-chart line tone (ChartLineTone), which has no `trail`/`neutral`.
//
// The two must AGREE for a shared tone: a `trail` row drawn on the chart uses
// the `stop` line (the --warning orange), and its panel label uses text-warning
// (the same --warning). A `stop` row is text-danger in the panel (a hard exit
// reads red) while its chart line stays the --warning stop colour; only `trail`
// is required to match across both surfaces, and it does.

import type { PreviewTone } from '@app/strategy-core';

import type { ChartLineTone } from '@/features/symbol/components/symbol-candle-chart';

/**
 * Semantic text token per {@link PreviewTone}. Semantic utilities only (never an
 * arbitrary `text-[var(--x)]`), so the colour gate has one map to check.
 */
export const PREVIEW_TONE_TOKEN: Record<PreviewTone, string> = {
  entry: 'text-accent',
  buy: 'text-up',
  sell: 'text-down',
  trail: 'text-warning',
  stop: 'text-danger',
  neutral: 'text-muted-fg',
};

/**
 * Project a {@link PreviewTone} onto the chart's {@link ChartLineTone} (which has
 * no `trail`/`neutral`). `trail` maps to `stop` so the trailing line paints the
 * --warning orange that agrees with the panel's text-warning; `neutral` never
 * carries a chart line (a neutral row is never `chartLine`), so it also falls to
 * `stop` as an inert default the line filter never reaches.
 */
const PREVIEW_TONE_CHART: Record<PreviewTone, ChartLineTone> = {
  entry: 'entry',
  buy: 'buy',
  sell: 'sell',
  trail: 'stop',
  stop: 'stop',
  neutral: 'stop',
};

export const previewToneToChartTone = (tone: PreviewTone): ChartLineTone =>
  PREVIEW_TONE_CHART[tone];
