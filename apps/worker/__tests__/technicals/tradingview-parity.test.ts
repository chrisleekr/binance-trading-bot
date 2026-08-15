import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { Decimal } from '@app/money';
import { computeTechnicalsRating, type Vote } from '@app/indicators/rating';
import type { Candle } from '@app/strategy-core';

import { bucketize } from '../../src/technicals/rating-to-signal.js';
import { prepareTechnicalsRatingWindow } from '../../src/technicals/rating-window.js';

type RawKline = readonly [
  number,
  string,
  string,
  string,
  string,
  string,
  number,
  string,
  number,
  string,
  string,
  string,
];

type DirectVoteName = 'stochRsi' | 'wr' | 'bbPower' | 'uo' | 'ichimokuBLine' | 'vwma20' | 'hullMa9';

interface FixtureCase {
  readonly exchange: 'BINANCE';
  readonly symbol: string;
  readonly scannerSymbol: `BINANCE:${string}`;
  readonly interval: string;
  readonly capturedAt: string;
  readonly scannerFields: readonly string[];
  readonly binanceKlinesUrl: string;
  readonly rawScannerData: readonly unknown[];
  readonly rawKlines: readonly RawKline[];
  readonly expected: {
    readonly barOpenTimeMs: number;
    readonly tradingViewClose: string;
    readonly recommendAll: number;
    readonly recommendMa: number;
    readonly recommendOther: number;
    readonly recommendation: ReturnType<typeof bucketize>;
    readonly directVotes: Readonly<Record<DirectVoteName, Vote>>;
  };
}

interface Fixture {
  readonly provenance: {
    readonly capturedAt: string;
    readonly tradingViewScannerUrl: string;
    readonly scannerFields: readonly string[];
    readonly technicalRatingVersion: '3.0';
    readonly technicalRatingSourceUrl: string;
    readonly technicalRatingSourceSha256: string;
    readonly binanceKlineFields: readonly string[];
  };
  readonly cases: readonly FixtureCase[];
}

const fixture = JSON.parse(
  readFileSync(
    new URL('../fixtures/technicals/tradingview-closed-bars.json', import.meta.url),
    'utf8',
  ),
) as Fixture;

const toCandle = (row: RawKline): Candle => ({
  openTimeMs: row[0],
  open: row[1],
  high: row[2],
  low: row[3],
  close: row[4],
  volume: row[5],
  closeTimeMs: row[6],
  isClosed: true,
});

const exposedDirectVotes: readonly DirectVoteName[] = [
  'stochRsi',
  'wr',
  'bbPower',
  'uo',
  'ichimokuBLine',
  'vwma20',
  'hullMa9',
];

const scannerSuffixByFixtureInterval = {
  '1m': '1',
  '5m': '5',
} as const;

describe('reviewed TradingView closed-bar parity', () => {
  it('records the published source and exact scanner field contract', () => {
    expect(fixture.provenance).toMatchObject({
      technicalRatingVersion: '3.0',
      technicalRatingSourceUrl:
        'https://pine-facade.tradingview.com/pine-facade/get/PUB%3Ba76380106c7f4d519db87128797c3a1c/last',
      technicalRatingSourceSha256:
        '93c8274c1e2e6e4f594b694611243c5399aca48863aab2a4300789b0d707d08b',
      tradingViewScannerUrl: 'https://scanner.tradingview.com/crypto/scan',
    });
    expect(fixture.provenance.scannerFields).toEqual([
      'name',
      'close|1',
      'close[1]|1',
      'time|1',
      'time[1]|1',
      'Recommend.All[1]|1',
      'Recommend.MA[1]|1',
      'Recommend.Other[1]|1',
      'Rec.Stoch.RSI[1]|1',
      'Rec.WR[1]|1',
      'Rec.BBPower[1]|1',
      'Rec.UO[1]|1',
      'Rec.Ichimoku[1]|1',
      'Rec.VWMA[1]|1',
      'Rec.HullMA9[1]|1',
    ]);
  });

  it.each(fixture.cases)(
    '$scannerSymbol $interval proves identity before ratings',
    ({
      exchange,
      symbol,
      scannerSymbol,
      interval,
      capturedAt,
      scannerFields,
      binanceKlinesUrl,
      rawScannerData,
      rawKlines,
      expected,
    }) => {
      expect(scannerSymbol).toBe(`${exchange}:${symbol}`);
      expect(Number.isNaN(Date.parse(capturedAt))).toBe(false);
      const scannerSuffix = scannerFields[1]?.split('|')[1];
      expect(scannerSuffix).toBe(
        scannerSuffixByFixtureInterval[interval as keyof typeof scannerSuffixByFixtureInterval],
      );
      expect(scannerSuffix).toMatch(/^\d+$/);
      expect(scannerFields).toEqual([
        'name',
        `close|${scannerSuffix}`,
        `close[1]|${scannerSuffix}`,
        `time|${scannerSuffix}`,
        `time[1]|${scannerSuffix}`,
        `Recommend.All[1]|${scannerSuffix}`,
        `Recommend.MA[1]|${scannerSuffix}`,
        `Recommend.Other[1]|${scannerSuffix}`,
        `Rec.Stoch.RSI[1]|${scannerSuffix}`,
        `Rec.WR[1]|${scannerSuffix}`,
        `Rec.BBPower[1]|${scannerSuffix}`,
        `Rec.UO[1]|${scannerSuffix}`,
        `Rec.Ichimoku[1]|${scannerSuffix}`,
        `Rec.VWMA[1]|${scannerSuffix}`,
        `Rec.HullMA9[1]|${scannerSuffix}`,
      ]);
      expect(rawScannerData).toHaveLength(scannerFields.length);
      expect(rawScannerData[0]).toBe(symbol);
      expect(Number(rawScannerData[4]) * 1_000).toBe(expected.barOpenTimeMs);
      expect(new Decimal(String(rawScannerData[2])).equals(expected.tradingViewClose)).toBe(true);
      expect(rawScannerData.slice(5, 8)).toEqual([
        expected.recommendAll,
        expected.recommendMa,
        expected.recommendOther,
      ]);
      expect(rawScannerData.slice(8)).toEqual(Object.values(expected.directVotes));

      const klineUrl = new URL(binanceKlinesUrl);
      expect(klineUrl.hostname).toBe('api.binance.com');
      expect(klineUrl.searchParams.get('symbol')).toBe(symbol);
      expect(klineUrl.searchParams.get('interval')).toBe(interval);
      expect(Number(klineUrl.searchParams.get('limit'))).toBe(rawKlines.length);
      expect(Number(klineUrl.searchParams.get('endTime'))).toBe(rawKlines.at(-1)?.[6]);

      const source = rawKlines.map(toCandle);
      const window = prepareTechnicalsRatingWindow(source);
      const last = window.at(-1);
      if (last === undefined) throw new Error('fixture yielded no traded bars');
      expect(last.openTimeMs).toBe(expected.barOpenTimeMs);
      expect(new Decimal(last.close).equals(expected.tradingViewClose)).toBe(true);

      const rating = computeTechnicalsRating(window);
      expect(rating.recommendAll.toNumber()).toBeCloseTo(expected.recommendAll, 12);
      expect(rating.recommendMa.toNumber()).toBeCloseTo(expected.recommendMa, 12);
      expect(rating.recommendOther.toNumber()).toBeCloseTo(expected.recommendOther, 12);
      expect(bucketize(rating.recommendAll.toNumber())).toBe(expected.recommendation);

      expect(Object.keys(expected.directVotes)).toEqual(exposedDirectVotes);
      for (const [name, vote] of Object.entries(expected.directVotes)) {
        expect(rating.perIndicatorVotes[name]).toBe(vote);
      }
    },
  );

  it('retains contiguous sparse Binance evidence while rating 250 traded MIRA bars', () => {
    const mira = fixture.cases.find((entry) => entry.symbol === 'MIRAUSDT');
    if (mira === undefined) throw new Error('MIRAUSDT fixture is missing');
    expect(mira.rawKlines.some((row) => new Decimal(row[5]).isZero())).toBe(true);
    expect(prepareTechnicalsRatingWindow(mira.rawKlines.map(toCandle))).toHaveLength(250);
  });
});
