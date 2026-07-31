// Shared test helpers for the rating suite — loaders, mock builders, the
// canonical BTC fixture. Kept here (not under src/) because they're test-only.

import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

import type { Candle } from '@app/strategy-core';

const HERE = dirname(fileURLToPath(import.meta.url));
const FIXTURES = join(HERE, '..', 'fixtures');

export interface CanonicalFixture {
  readonly source: string;
  readonly fetchedAt: string;
  readonly symbol: string;
  readonly interval: string;
  readonly count: number;
  readonly candles: readonly Candle[];
}

export const loadCanonicalBtc1h = (): CanonicalFixture =>
  JSON.parse(readFileSync(join(FIXTURES, 'btc-1h-canonical.json'), 'utf8')) as CanonicalFixture;

export const mkCandle = (
  open: string,
  high: string,
  low: string,
  close: string,
  volume = '0',
  t = 0,
): Candle => ({
  openTimeMs: t,
  closeTimeMs: t + 60_000,
  open,
  high,
  low,
  close,
  volume,
  isClosed: true,
});

/** Build a window from a sequence of closes (high=low=open=close). */
export const mkCloseWindow = (closes: readonly string[]): readonly Candle[] =>
  closes.map((c, i) => mkCandle(c, c, c, c, '0', i * 60_000));

/** Build a window from full OHLCV tuples. */
export const mkOhlcvWindow = (
  bars: readonly { o: string; h: string; l: string; c: string; v?: string }[],
): readonly Candle[] => bars.map((b, i) => mkCandle(b.o, b.h, b.l, b.c, b.v ?? '0', i * 60_000));
