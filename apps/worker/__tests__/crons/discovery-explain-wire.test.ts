// Wire-contract guard for the discovery worker→api boundary. The cron persists
// `explainDiscovery`'s candidates as JSON under `discovery:explain:{pid}`; the
// api parses it with `@app/contracts`'s `DiscoveryUniverse` zod schema (whose
// enums "mirror" `@app/discovery`'s `DiscoveryDisposition`/`DiscoveryFilterName`).
// There is no compile-time bridge between the two — the contracts side uses a
// branded `DecimalString` while the discovery side emits plain strings — so this
// test is the drift guard: a new disposition, a renamed filter stage, or a
// shape change in the explain payload fails `DiscoveryUniverse.parse` here
// instead of silently null-ing the dashboard universe in production.

import { describe, expect, it } from 'vitest';
import { explainDiscovery, type DiscoveryConfig, type DiscoveryInput } from '@app/discovery';
import { DiscoveryUniverse } from '@app/contracts';
import type { Candle } from '@app/strategy-core';

const NOW = 1_700_000_000_000;
const DAY = 86_400_000;
const HOUR = 3_600_000;

/** A rising, old-enough kline window that clears the permissive age + trend gates. */
const uptrend = (): Candle[] =>
  Array.from({ length: 8 }, (_, i) => ({
    openTimeMs: NOW - 5 * DAY + i * HOUR,
    closeTimeMs: NOW - 5 * DAY + (i + 1) * HOUR,
    open: String(100 + i * 4 - 2),
    high: String(100 + i * 4 + 1),
    low: String(100 + i * 4 - 3),
    close: String(100 + i * 4),
    volume: '10',
    isClosed: true,
  }));

const config: DiscoveryConfig = {
  quoteAsset: 'USDT',
  blacklist: [],
  min24hPairVolumeUsd: '1',
  min24hAssetVolumeUsd: '1',
  maxSpreadRatio: '1',
  changeMinPercent: '0',
  rankTopPercent: 100,
  rankExcludeTopPercent: 0,
  minAgeDays: 1,
  maxAutoSymbols: 1, // one slot → forces an 'added' + a 'slot-capped'
  minHoldMinutes: 60,
  marketBreadthMinPercent: '0',
  trendConfirm: { adxPeriod: 2, adxMin: '0', emaPeriod: 2, volSmaPeriod: 2, volMultiple: '0.0001' },
};

const ticker = (symbol: string, gain: string) => ({
  symbol,
  quoteAsset: 'USDT',
  priceChangePercent: gain,
  quoteVolume: '5000000',
  pairVolumeUsd: '5000000',
  assetVolumeUsd: '5000000',
  lastPrice: '1',
  bidPrice: '1',
  askPrice: '1',
});

describe('discovery explain payload ↔ DiscoveryUniverse wire schema', () => {
  it('the serialised explain payload parses under the api wire schema', () => {
    const input: DiscoveryInput = {
      tickers: [
        ticker('AAAUSDT', '20'), // top rank, eligible → added
        ticker('BBBUSDT', '15'), // eligible, after the single slot fills → slot-capped
        ticker('CCCUSDT', '12'), // passes ticker filters but has no klines → fails age → rejected
      ],
      // CCCUSDT intentionally absent → klines default to [] → age gate fails.
      klinesBySymbol: { AAAUSDT: uptrend(), BBBUSDT: uptrend() },
      currentAuto: [{ symbol: 'OLDUSDT', addedAtMs: NOW - 600 * 60_000 }], // vanished, past hold → reaped
      lastFlattenAtMsBySymbol: {},
      config,
      nowMs: NOW,
    };
    const { candidates } = explainDiscovery(input);

    // Exactly what the cron writes to Redis.
    const persisted = JSON.stringify({ computedAtMs: NOW, candidates });
    const parsed = DiscoveryUniverse.parse(JSON.parse(persisted));

    expect(parsed.candidates).toHaveLength(candidates.length);
    // The varied dispositions all round-trip through the wire enum.
    const dispositions = new Set(parsed.candidates.map((c) => c.disposition));
    expect(dispositions).toContain('added');
    expect(dispositions).toContain('slot-capped');
    expect(dispositions).toContain('rejected');
  });
});
