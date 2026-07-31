// Derive the chart's horizontal price lines from a PreviewModel — the generic
// replacement for the per-strategy `trailingTradeChartLines`. A row is drawn
// when it opted in (`chartLine`) and carries a price; its tone maps to the
// chart's line tone through the single tone map, so the panel and the chart
// agree on colour (notably the trailing line).

import type { PreviewModel } from '@app/strategy-core';

import type { ChartPriceLine } from '@/features/symbol/components/symbol-candle-chart';

import { previewToneToChartTone } from './tone';

/** A strategy code (`grid-stop-loss`) as an axis label (`GRID STOP LOSS`). */
export const humanizeCode = (code: string): string => code.replace(/-/g, ' ').toUpperCase();

export const deriveChartLines = (model: PreviewModel): ChartPriceLine[] =>
  model.sections
    .flatMap((s) => s.rows)
    .filter((r) => r.chartLine === true && r.price != null)
    .map((r) => ({
      price: r.price as string,
      label: r.label ?? humanizeCode(r.code),
      tone: previewToneToChartTone(r.tone),
    }));
