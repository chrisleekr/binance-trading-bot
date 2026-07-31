// ChartIntervalSelector — renders the Binance-style interval tabs, marks the
// active one via aria-pressed, and reports clicks. Also covers the candle
// window math that the selector drives.

import { render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { describe, expect, it, vi } from 'vitest';

import { ChartIntervalSelector } from '../src/features/symbol/components/chart-interval-selector.js';
import {
  CANDLE_INTERVALS,
  fetchSymbolCandles,
  symbolCandleBucketMs,
} from '../src/features/symbol/api/symbol.js';

describe('ChartIntervalSelector', () => {
  it('renders every interval and marks the active one', () => {
    render(<ChartIntervalSelector value="1h" onChange={vi.fn()} />);
    for (const interval of CANDLE_INTERVALS) {
      expect(screen.getByRole('button', { name: interval })).toBeInTheDocument();
    }
    expect(screen.getByRole('button', { name: '1h' })).toHaveAttribute('aria-pressed', 'true');
    expect(screen.getByRole('button', { name: '1m' })).toHaveAttribute('aria-pressed', 'false');
  });

  it('reports the clicked interval', async () => {
    const onChange = vi.fn();
    render(<ChartIntervalSelector value="1m" onChange={onChange} />);
    await userEvent.click(screen.getByRole('button', { name: '4h' }));
    expect(onChange).toHaveBeenCalledWith('4h');
  });
});

describe('candle window math', () => {
  it('buckets `now` to the interval boundary', () => {
    const now = new Date('2026-05-17T13:37:42.000Z');
    // Each interval floors `now` to its epoch-anchored UTC boundary: 1m drops
    // sub-minute, 1h drops sub-hour, 4h to the 00/04/08/12/16/20 grid (13:37 →
    // 12:00), 1d to 00:00.
    expect(symbolCandleBucketMs('1m', now)).toBe(new Date('2026-05-17T13:37:00Z').getTime());
    expect(symbolCandleBucketMs('1h', now)).toBe(new Date('2026-05-17T13:00:00Z').getTime());
    expect(symbolCandleBucketMs('4h', now)).toBe(new Date('2026-05-17T12:00:00Z').getTime());
    expect(symbolCandleBucketMs('1d', now)).toBe(new Date('2026-05-17T00:00:00Z').getTime());
  });

  it('sizes the request window by the interval span, not always one minute', async () => {
    let requestedUrl = '';
    const fetchMock = vi.fn(async (input: RequestInfo | URL) => {
      requestedUrl =
        typeof input === 'string' ? input : input instanceof URL ? input.toString() : input.url;
      return new Response('[]', { status: 200, headers: { 'content-type': 'application/json' } });
    });
    vi.stubGlobal('fetch', fetchMock);
    try {
      const now = new Date('2026-05-17T12:00:00.000Z');
      await fetchSymbolCandles('p1', 'BTCUSDT', { interval: '1h', frames: 10, now });
      const params = new URLSearchParams(requestedUrl.slice(requestedUrl.indexOf('?')));
      expect(params.get('interval')).toBe('1h');
      // 10 frames × 1h back from 12:00 → 02:00.
      expect(params.get('from')).toBe('2026-05-17T02:00:00.000Z');
      expect(params.get('to')).toBe('2026-05-17T12:00:00.000Z');
    } finally {
      // Restore the global even if an assertion throws, so the stub cannot
      // leak into later tests in this file.
      vi.unstubAllGlobals();
    }
  });
});
