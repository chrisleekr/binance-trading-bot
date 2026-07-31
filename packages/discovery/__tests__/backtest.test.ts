import { describe, expect, it } from 'vitest';
import { backtestDiscovery } from '../src/index.js';
import type { DiscoveryBacktestStep } from '../src/index.js';
import { cfg, DAY_MS, ticker, uptrend } from './_helpers.js';

const NOW = 1_700_000_000_000;
const MIN = 60_000;
// Eligible window confirms under the permissive thresholds below; a 2-candle
// window nulls ADX, so a symbol with it fades and is removed.
const elig = uptrend(6, NOW - 10 * DAY_MS);
const notElig = uptrend(2, NOW - 10 * DAY_MS);

const pcfg = cfg({
  minAgeDays: 1,
  minHoldMinutes: 10,
  maxAutoSymbols: 5,
  min24hPairVolumeUsd: '1',
  min24hAssetVolumeUsd: '1',
  maxSpreadRatio: '1',
  changeMinPercent: '0',
  rankTopPercent: 100,
  rankExcludeTopPercent: 0,
  trendConfirm: { adxPeriod: 2, adxMin: '0', emaPeriod: 2, volSmaPeriod: 2, volMultiple: '0.0001' },
});

const tk = (symbol: string, lastPrice: string, bidPrice: string, askPrice: string, over = {}) =>
  ticker({ symbol, lastPrice, bidPrice, askPrice, ...over });

describe('backtestDiscovery', () => {
  it('a rotation whose price move clears round-trip costs is net-positive', () => {
    const steps: DiscoveryBacktestStep[] = [
      {
        nowMs: NOW,
        tickers: [
          tk('AAAUSDT', '100', '99.95', '100.05'),
          tk('BBBUSDT', '50', '49.97', '50.03'),
          tk('NOLIQUSDT', '100', '99.9', '100.1', { pairVolumeUsd: '0' }), // fails liquidity -> not added
        ],
        klinesBySymbol: { AAAUSDT: elig, BBBUSDT: elig },
      },
      {
        nowMs: NOW + 20 * MIN, // past the 10-min min-hold
        tickers: [tk('AAAUSDT', '110', '109.9', '110.1'), tk('BBBUSDT', '50', '49.97', '50.03')],
        // AAA's window stops confirming -> faded -> removed (priced at 110);
        // BBB still confirms -> kept (still open at window end, uncounted).
        klinesBySymbol: { AAAUSDT: notElig, BBBUSDT: elig },
      },
    ];
    const r = backtestDiscovery(steps, pcfg, { feeRate: '0.001' });
    expect(r.trades).toBe(1);
    expect(r.netPositive).toBe(true);
    expect(Number(r.netReturn)).toBeCloseTo(0.0952, 3);
    // One rotation, so meanEdge equals netReturn.
    expect(Number(r.meanEdge)).toBeCloseTo(0.0952, 3);
  });

  it('fee + spread bleed dominates a flat rotation (gross ~0, net negative)', () => {
    const steps: DiscoveryBacktestStep[] = [
      {
        nowMs: NOW,
        tickers: [tk('AAAUSDT', '100', '99.9', '100.1')],
        klinesBySymbol: { AAAUSDT: elig },
      },
      {
        nowMs: NOW + 20 * MIN,
        tickers: [tk('AAAUSDT', '100', '99.9', '100.1')], // no price move
        klinesBySymbol: { AAAUSDT: notElig },
      },
    ];
    const r = backtestDiscovery(steps, pcfg, { feeRate: '0.02' }); // heavy fee
    expect(r.trades).toBe(1);
    expect(Number(r.grossReturn)).toBe(0);
    expect(r.netPositive).toBe(false);
    expect(Number(r.netReturn)).toBeLessThan(0);
  });

  it('an empty universe produces no rotations', () => {
    const r = backtestDiscovery([{ nowMs: NOW, tickers: [], klinesBySymbol: {} }], pcfg, {
      feeRate: '0.001',
    });
    expect(r).toMatchObject({ trades: 0, grossReturn: '0', netReturn: '0', netPositive: false });
  });

  it('a position still open at the end of the window is not counted', () => {
    const r = backtestDiscovery(
      [
        {
          nowMs: NOW,
          tickers: [tk('AAAUSDT', '100', '99.95', '100.05')],
          klinesBySymbol: { AAAUSDT: elig },
        },
      ],
      pcfg,
      { feeRate: '0.001' },
    );
    expect(r.trades).toBe(0); // added but never closed
    expect(r.netReturn).toBe('0');
  });

  it('a symbol removed after it vanished from the universe has no exit price, so is uncounted', () => {
    const steps: DiscoveryBacktestStep[] = [
      {
        nowMs: NOW,
        tickers: [tk('AAAUSDT', '100', '99.95', '100.05')],
        klinesBySymbol: { AAAUSDT: elig },
      },
      { nowMs: NOW + 20 * MIN, tickers: [], klinesBySymbol: {} }, // AAA gone -> removed unpriced
    ];
    const r = backtestDiscovery(steps, pcfg, { feeRate: '0.001' });
    expect(r.trades).toBe(0);
  });

  it('handles degenerate exit books (non-positive / crossed) as zero spread', () => {
    const steps: DiscoveryBacktestStep[] = [
      {
        nowMs: NOW,
        tickers: [
          tk('AAAUSDT', '100', '99.95', '100.05'),
          tk('BBBUSDT', '100', '99.95', '100.05'),
          tk('CCCUSDT', '100', '99.95', '100.05'),
        ],
        klinesBySymbol: { AAAUSDT: elig, BBBUSDT: elig, CCCUSDT: elig },
      },
      {
        nowMs: NOW + 20 * MIN,
        tickers: [
          tk('AAAUSDT', '110', '0', '110'), // bid <= 0 -> spread 0
          tk('BBBUSDT', '110', '110', '0'), // ask <= 0 -> spread 0
          tk('CCCUSDT', '110', '111', '109'), // crossed (ask < bid) -> spread 0
        ],
        klinesBySymbol: { AAAUSDT: notElig, BBBUSDT: notElig, CCCUSDT: notElig },
      },
    ];
    const r = backtestDiscovery(steps, pcfg, { feeRate: '0.001' });
    expect(r.trades).toBe(3);
    // gross = 3 x 0.1; cost = 3 x (2*fee + entrySpread + 0 exitSpread)
    expect(r.netPositive).toBe(true);
  });
});
