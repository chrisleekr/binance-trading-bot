import { describe, expect, it } from 'vitest';
import { runDiscovery } from '../src/index.js';
import type { DiscoveryDiff, DiscoveryInput } from '../src/index.js';
import { cfg, DAY_MS, ticker, uptrend } from './_helpers.js';

// Golden replay: a fixed ticker + kline snapshot must always resolve to the
// same add/remove diff. A drift here is a behaviour change in the pure chain
// and must be reviewed deliberately, not absorbed silently. The snapshot
// deliberately exercises every resolve-stage branch: a fresh add, a cooldown
// skip, a kept survivor, a protected-faded hold, and a reap.
const NOW = 1_700_000_000_000;
const MIN_MS = 60_000;
const eligibleKlines = uptrend(40, NOW - 40 * DAY_MS);

const SNAPSHOT: DiscoveryInput = {
  tickers: [
    ticker({ symbol: 'WINUSDT', priceChangePercent: '22', quoteVolume: '80000000' }), // fresh add
    ticker({ symbol: 'COOLUSDT', priceChangePercent: '18', quoteVolume: '60000000' }), // on cooldown
    ticker({ symbol: 'KEEPUSDT', priceChangePercent: '16', quoteVolume: '50000000' }), // kept survivor
    ticker({ symbol: 'RUNUSDT', priceChangePercent: '14', quoteVolume: '40000000' }), // fresh add
    ticker({ symbol: 'WEAKUSDT', priceChangePercent: '2' }), // under the gain hurdle
    ticker({ symbol: 'DUSTUSDT', pairVolumeUsd: '500000' }), // pair too thin to fill
    ticker({ symbol: 'DEADUSDT', assetVolumeUsd: null }), // no USD market: dead coin
    ticker({ symbol: 'PEGBTC', quoteAsset: 'BTC' }), // wrong quote asset
  ],
  klinesBySymbol: {
    WINUSDT: eligibleKlines,
    COOLUSDT: eligibleKlines,
    KEEPUSDT: eligibleKlines,
    RUNUSDT: eligibleKlines,
  },
  currentAuto: [
    { symbol: 'KEEPUSDT', addedAtMs: NOW - 600 * MIN_MS }, // still eligible -> kept
    { symbol: 'FADEDUSDT', addedAtMs: NOW - 600 * MIN_MS }, // gone, past hold -> reap
    { symbol: 'HOLDUSDT', addedAtMs: NOW - 10 * MIN_MS }, // gone, within hold -> protected
  ],
  lastFlattenAtMsBySymbol: { COOLUSDT: NOW - 10 * MIN_MS }, // COOL on cooldown
  config: cfg({ maxAutoSymbols: 4, blacklist: [] }),
  nowMs: NOW,
};

// Slots: 4 cap - 1 kept (KEEP) - 1 protected (HOLD) = 2. WIN + RUN fill them;
// COOL is skipped on cooldown. FADED reaped; HOLD left untouched (not in desired).
const EXPECTED: DiscoveryDiff = {
  add: ['WINUSDT', 'RUNUSDT'],
  remove: ['FADEDUSDT'],
  desired: ['WINUSDT', 'KEEPUSDT', 'RUNUSDT'],
};

describe('discovery golden replay', () => {
  it('resolves the fixed snapshot to the deterministic diff', () => {
    expect(runDiscovery(SNAPSHOT)).toEqual(EXPECTED);
  });

  it('is referentially stable across repeated runs (purity)', () => {
    expect(runDiscovery(SNAPSHOT)).toEqual(runDiscovery(SNAPSHOT));
  });
});
