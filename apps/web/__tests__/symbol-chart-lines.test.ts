// Generic chart-line derivation — the PreviewModel-driven replacement for the
// per-strategy trailingTradeChartLines. Asserts only `chartLine` priced rows
// become lines, the tone maps to a ChartLineTone, and the trailing line's chart
// colour AGREES with the panel's text token (issue #593 done-when #4).

import { describe, expect, it } from 'vitest';

import type { PreviewModel } from '@app/strategy-core';

import {
  deriveChartLines,
  humanizeCode,
} from '../src/features/symbol/preview/preview-chart-lines.js';
import { PREVIEW_TONE_TOKEN, previewToneToChartTone } from '../src/features/symbol/preview/tone.js';

const model = (): PreviewModel => ({
  sections: [
    {
      title: 'Grid ladder',
      rows: [
        { code: 'grid-buy', tone: 'buy', price: '95', quantity: '1', chartLine: true },
        // avg-cost carries a price but is NOT a chart line.
        { code: 'avg-cost', tone: 'neutral', price: '96' },
      ],
    },
    {
      title: 'Sell targets',
      rows: [
        { code: 'technicals-force-sell', tone: 'sell', price: '110', chartLine: true },
        { code: 'grid-stop-loss', tone: 'stop', price: '80', chartLine: true },
        { code: 'grid-sell', tone: 'trail', price: '104', chartLine: true },
        // A priceless row is never a line even if it opts in.
        { code: 'no-price', tone: 'buy', chartLine: true },
      ],
    },
  ],
});

describe('deriveChartLines', () => {
  it('draws a line only for priced rows that opted in, humanising the code', () => {
    expect(deriveChartLines(model())).toEqual([
      { price: '95', label: 'GRID BUY', tone: 'buy' },
      { price: '110', label: 'TECHNICALS FORCE SELL', tone: 'sell' },
      { price: '80', label: 'GRID STOP LOSS', tone: 'stop' },
      { price: '104', label: 'GRID SELL', tone: 'stop' },
    ]);
  });

  it('drops the avg-cost neutral row and the priceless row', () => {
    const labels = deriveChartLines(model()).map((l) => l.label);
    expect(labels).not.toContain('AVG COST');
    expect(labels).not.toContain('NO PRICE');
  });

  it('prefers an explicit row label over the humanised code', () => {
    const lines = deriveChartLines({
      sections: [
        {
          title: 's',
          rows: [{ code: 'x', label: 'Sell arm', tone: 'sell', price: '9', chartLine: true }],
        },
      ],
    });
    expect(lines[0]?.label).toBe('Sell arm');
  });
});

describe('humanizeCode', () => {
  it('uppercases and de-hyphenates', () => {
    expect(humanizeCode('grid-stop-loss')).toBe('GRID STOP LOSS');
  });
});

describe('trail colour agreement (done-when #4)', () => {
  it('maps the trailing tone to the chart stop line, which shares the panel warning colour', () => {
    // chart: trail -> 'stop' (the --warning orange line); panel: trail -> text-warning.
    expect(previewToneToChartTone('trail')).toBe('stop');
    expect(PREVIEW_TONE_TOKEN.trail).toBe('text-warning');
  });

  it('maps every tone to a valid chart tone', () => {
    expect(previewToneToChartTone('entry')).toBe('entry');
    expect(previewToneToChartTone('buy')).toBe('buy');
    expect(previewToneToChartTone('sell')).toBe('sell');
    expect(previewToneToChartTone('stop')).toBe('stop');
    expect(previewToneToChartTone('neutral')).toBe('stop');
  });
});
