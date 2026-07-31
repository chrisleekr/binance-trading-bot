// Split-effect contract for SymbolCandleChart: an overlay-only change must
// mutate price lines / markers on the existing series WITHOUT rebuilding the
// chart canvas (no extra createChart), while a candle change rebuilds it.

import { render, waitFor } from '@testing-library/react';
import { beforeEach, describe, expect, it, vi } from 'vitest';

import {
  SymbolCandleChart,
  type ChartModule,
  type ChartOverlays,
} from '@/features/symbol/components/symbol-candle-chart';

import type { CandleList } from '@app/contracts';

const setData = vi.fn();
const applyOptions = vi.fn();
let priceLineSeq = 0;
const createPriceLine = vi.fn(() => ({ id: priceLineSeq++ }));
const removePriceLine = vi.fn();
const subscribeCrosshairMove = vi.fn();
const remove = vi.fn();
const setMarkers = vi.fn();
const addSeries = vi.fn(() => ({ setData, applyOptions, createPriceLine, removePriceLine }));
const createChart = vi.fn(() => ({ addSeries, subscribeCrosshairMove, remove }));
const createSeriesMarkers = vi.fn(() => ({ setMarkers }));
const chartModuleStub: ChartModule = {
  createChart: createChart as unknown as ChartModule['createChart'],
  CandlestickSeries: { id: 'candlestick' },
  createSeriesMarkers: createSeriesMarkers as unknown as ChartModule['createSeriesMarkers'],
};
const loadStub = vi.fn(() => Promise.resolve(chartModuleStub));

const candle = (time: string, close: string): CandleList[number] => ({
  time,
  open: close,
  high: close,
  low: close,
  close,
  volume: '1',
});

const candlesA: CandleList = [
  candle('2026-05-10T05:00:00.000Z', '50000.00'),
  candle('2026-05-10T05:01:00.000Z', '50100.00'),
];
const candlesB: CandleList = [...candlesA, candle('2026-05-10T05:02:00.000Z', '50200.00')];

// Clear in beforeEach, not afterEach: @testing-library's auto-cleanup
// unmounts the component in its own afterEach, which calls the chart's
// `remove` mock. Vitest runs afterEach hooks LIFO, so a mockClear in afterEach
// runs BEFORE that unmount and the leaked `remove` call bleeds into the next
// test's count. Clearing in beforeEach runs after the prior test's cleanup.
beforeEach(() => {
  loadStub.mockClear();
  createChart.mockClear();
  addSeries.mockClear();
  setData.mockClear();
  applyOptions.mockClear();
  createPriceLine.mockClear();
  removePriceLine.mockClear();
  subscribeCrosshairMove.mockClear();
  createSeriesMarkers.mockClear();
  setMarkers.mockClear();
  remove.mockClear();
  priceLineSeq = 0;
});

describe('SymbolCandleChart overlay/candle effect split', () => {
  it('an overlay-only change repaints lines/markers without rebuilding the chart', async () => {
    const overlays1: ChartOverlays = {
      priceLines: [{ price: '49000.00', label: 'ENTRY', tone: 'entry' }],
    };
    const { rerender } = render(
      <SymbolCandleChart candles={candlesA} overlays={overlays1} loadModule={loadStub} />,
    );

    await waitFor(() => expect(createChart).toHaveBeenCalledTimes(1));
    // Initial paint drew the ENTRY line; nothing removed yet.
    await waitFor(() =>
      expect(createPriceLine).toHaveBeenCalledWith(
        expect.objectContaining({ price: 49000, title: 'ENTRY' }),
      ),
    );
    expect(removePriceLine).not.toHaveBeenCalled();
    expect(setMarkers).toHaveBeenCalledTimes(1);

    createPriceLine.mockClear();
    setMarkers.mockClear();

    // Overlay-only change: same candles, new overlay object reference (the
    // route hands a fresh deriveOverlays result on every /state refetch).
    const overlays2: ChartOverlays = {
      priceLines: [
        { price: '49500.00', label: 'ENTRY', tone: 'entry' },
        { price: '51000.00', label: 'SELL ARM', tone: 'sell' },
      ],
    };
    rerender(<SymbolCandleChart candles={candlesA} overlays={overlays2} loadModule={loadStub} />);

    // The expensive canvas is NOT rebuilt …
    await waitFor(() => expect(createPriceLine).toHaveBeenCalled());
    expect(createChart).toHaveBeenCalledTimes(1);
    expect(remove).not.toHaveBeenCalled();
    // … but the prior line was cleared and the new ones drawn, markers reset.
    expect(removePriceLine).toHaveBeenCalled();
    expect(createPriceLine).toHaveBeenCalledWith(
      expect.objectContaining({ price: 49500, title: 'ENTRY' }),
    );
    expect(createPriceLine).toHaveBeenCalledWith(
      expect.objectContaining({ price: 51000, title: 'SELL ARM' }),
    );
    expect(setMarkers).toHaveBeenCalledTimes(1);
  });

  it('a candle change updates the series in place without rebuilding the chart', async () => {
    const overlays: ChartOverlays = {
      priceLines: [{ price: '49000.00', label: 'ENTRY', tone: 'entry' }],
    };
    const { rerender } = render(
      <SymbolCandleChart candles={candlesA} overlays={overlays} loadModule={loadStub} />,
    );
    await waitFor(() => expect(createChart).toHaveBeenCalledTimes(1));
    // First window painted on create.
    expect(setData).toHaveBeenCalledTimes(1);

    // A fresh candle window (every interval boundary in production) arrives.
    rerender(<SymbolCandleChart candles={candlesB} overlays={overlays} loadModule={loadStub} />);

    // The new window is pushed onto the existing series …
    await waitFor(() => expect(setData).toHaveBeenCalledTimes(2));
    // … and the canvas is NOT torn down or rebuilt (the flicker fix).
    expect(createChart).toHaveBeenCalledTimes(1);
    expect(remove).not.toHaveBeenCalled();
  });

  it('a precision change repoints the axis in place without rebuilding the chart', async () => {
    const overlays: ChartOverlays = {
      priceLines: [{ price: '49000.00', label: 'ENTRY', tone: 'entry' }],
    };
    // filterTickSize null → precision derived from the candle window.
    const { rerender } = render(
      <SymbolCandleChart candles={candlesA} overlays={overlays} loadModule={loadStub} />,
    );
    await waitFor(() => expect(createChart).toHaveBeenCalledTimes(1));
    applyOptions.mockClear();

    // exchangeInfo resolves: authoritative tickSize lifts precision to 8.
    rerender(
      <SymbolCandleChart
        candles={candlesA}
        overlays={overlays}
        filterTickSize="0.00000001"
        loadModule={loadStub}
      />,
    );

    await waitFor(() =>
      expect(applyOptions).toHaveBeenCalledWith(
        expect.objectContaining({
          priceFormat: expect.objectContaining({ precision: 8, minMove: 0.00000001 }),
        }),
      ),
    );
    expect(createChart).toHaveBeenCalledTimes(1);
    expect(remove).not.toHaveBeenCalled();
  });
});
