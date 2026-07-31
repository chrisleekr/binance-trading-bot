import { describe, expect, it } from 'vitest';
import type { Candle } from '@app/strategy-core';
import {
  marketBreadthOk,
  resolveDiscovery,
  runDiscovery,
  shortlistByTicker,
} from '../src/index.js';
import type { CurrentAutoSymbol, DiscoverySkipReason } from '../src/index.js';
// Imported from the module (not the package index) — a test-only helper that
// stays out of the public surface.
import { maxPeerCorrelation, tickerStageCounts } from '../src/run.js';
import type { TickerStageCounts } from '../src/run.js';
import { cfg, DAY_MS, ticker, uptrend } from './_helpers.js';

const NOW = 1_700_000_000_000;
const MIN_MS = 60_000;
// An eligible window: old enough (oldest 40 days back) AND trend-confirmed.
const good: readonly Candle[] = uptrend(40, NOW - 40 * DAY_MS);

const klinesFor = (symbols: readonly string[]): Record<string, readonly Candle[]> =>
  Object.fromEntries(symbols.map((s) => [s, good]));

describe('shortlistByTicker', () => {
  it('keeps only ticker-stage survivors and ranks by 24h gain, ties by symbol', () => {
    const tickers = [
      ticker({ symbol: 'CCCUSDT', priceChangePercent: '10' }),
      ticker({ symbol: 'BBBUSDT', priceChangePercent: '20' }),
      ticker({ symbol: 'AAAUSDT', priceChangePercent: '20' }), // ties BBB on gain
      ticker({ symbol: 'QUOTEBTC', quoteAsset: 'BTC' }), // fails quote-match
      ticker({ symbol: 'BLACKUSDT' }), // fails blacklist
      ticker({ symbol: 'THINUSDT', pairVolumeUsd: '1' }), // fails liquidity
      ticker({ symbol: 'DEADUSDT', assetVolumeUsd: '100' }), // fails activity
      ticker({ symbol: 'WIDEUSDT', bidPrice: '100', askPrice: '105' }), // fails spread
      ticker({ symbol: 'FLATUSDT', priceChangePercent: '1' }), // fails change band
    ];
    const out = shortlistByTicker(tickers, cfg({ blacklist: ['BLACKUSDT'] }));
    // gain desc; AAA before BBB on the tie; CCC last.
    expect(out).toEqual(['AAAUSDT', 'BBBUSDT', 'CCCUSDT']);
  });
});

describe('resolveDiscovery', () => {
  it('adds top eligible up to the slot cap, skipping cooldown symbols', () => {
    const shortlist = ['G1', 'G2', 'G3', 'G4'];
    const diff = resolveDiscovery(
      shortlist,
      klinesFor(shortlist),
      [],
      { G2: NOW - 10 * MIN_MS }, // G2 on cooldown (10 < 120 min)
      cfg({ maxAutoSymbols: 2 }),
      NOW,
    );
    expect(diff.add).toEqual(['G1', 'G3']); // G2 skipped, G4 past the cap
    expect(diff.remove).toEqual([]);
    expect(diff.desired).toEqual(['G1', 'G3']);
  });

  it('a shortlisted symbol with no klines is not eligible', () => {
    const diff = resolveDiscovery(
      ['G1', 'NOKLINES'],
      { G1: good }, // NOKLINES absent → treated as []
      [],
      {},
      cfg({ maxAutoSymbols: 5 }),
      NOW,
    );
    expect(diff.add).toEqual(['G1']);
  });

  it('keeps still-eligible current, reaps a faded symbol past hold, protects one within hold', () => {
    const shortlist = ['K1', 'N1']; // K1 current+eligible, N1 new eligible
    const current: CurrentAutoSymbol[] = [
      { symbol: 'K1', addedAtMs: NOW - 300 * MIN_MS },
      { symbol: 'F1', addedAtMs: NOW - 300 * MIN_MS }, // faded, past hold → reap
      { symbol: 'F2', addedAtMs: NOW - 10 * MIN_MS }, // faded, within hold → keep
    ];
    const diff = resolveDiscovery(
      shortlist,
      klinesFor(shortlist), // F1/F2 absent → not eligible
      current,
      {},
      cfg({ maxAutoSymbols: 3 }),
      NOW,
    );
    expect(diff.add).toEqual(['N1']); // one slot free: 3 - 1 kept - 1 protected
    expect(diff.remove).toEqual(['F1']);
    expect(diff.desired).toEqual(['K1', 'N1']);
  });

  it('never force-evicts still-eligible current symbols even over a lowered cap', () => {
    const shortlist = ['K1', 'K2', 'N1'];
    const current: CurrentAutoSymbol[] = [
      { symbol: 'K1', addedAtMs: NOW - 300 * MIN_MS },
      { symbol: 'K2', addedAtMs: NOW - 300 * MIN_MS },
    ];
    const diff = resolveDiscovery(
      shortlist,
      klinesFor(shortlist),
      current,
      {},
      cfg({ maxAutoSymbols: 1 }), // below the 2 still-eligible holds
      NOW,
    );
    expect(diff.add).toEqual([]); // no slots: max(0, 1 - 2) = 0
    expect(diff.remove).toEqual([]);
    expect(diff.desired).toEqual(['K1', 'K2']); // kept, intentionally over cap
  });
});

describe('runDiscovery', () => {
  it('composes the ticker and kline stages into one deterministic diff', () => {
    const diff = runDiscovery({
      tickers: [
        ticker({ symbol: 'G1USDT', priceChangePercent: '20' }),
        ticker({ symbol: 'G2USDT', priceChangePercent: '10' }),
        ticker({ symbol: 'LOWUSDT', priceChangePercent: '1' }), // fails change band
      ],
      klinesBySymbol: { G1USDT: good, G2USDT: good },
      currentAuto: [],
      lastFlattenAtMsBySymbol: {},
      config: cfg({ maxAutoSymbols: 5 }),
      nowMs: NOW,
    });
    expect(diff.add).toEqual(['G1USDT', 'G2USDT']);
    expect(diff.remove).toEqual([]);
    expect(diff.desired).toEqual(['G1USDT', 'G2USDT']);
  });

  it('never re-adopts a manually-pinned symbol even when it still qualifies (issue #435)', () => {
    const diff = runDiscovery({
      tickers: [
        ticker({ symbol: 'AUTOUSDT', priceChangePercent: '20' }),
        ticker({ symbol: 'PINUSDT', priceChangePercent: '15' }), // pinned, still qualifies
      ],
      klinesBySymbol: { AUTOUSDT: good, PINUSDT: good },
      currentAuto: [],
      lastFlattenAtMsBySymbol: {},
      manualMembers: ['PINUSDT'],
      config: cfg({ maxAutoSymbols: 5 }),
      nowMs: NOW,
    });
    // PINUSDT is eligible by the chain but excluded from add (operator pinned it
    // to manual); only the genuine auto candidate is rotated in.
    expect(diff.add).toEqual(['AUTOUSDT']);
    expect(diff.desired).toEqual(['AUTOUSDT']);
  });
});

describe('marketBreadthOk (issue #439)', () => {
  // 4 positive, 1 negative → 80% breadth.
  const universe = [
    ticker({ symbol: 'AUSDT', priceChangePercent: '5' }),
    ticker({ symbol: 'BUSDT', priceChangePercent: '5' }),
    ticker({ symbol: 'CUSDT', priceChangePercent: '5' }),
    ticker({ symbol: 'DUSDT', priceChangePercent: '5' }),
    ticker({ symbol: 'EUSDT', priceChangePercent: '-5' }),
  ];

  it('floor 0 disables the guard (always true)', () => {
    expect(marketBreadthOk(universe, cfg({ marketBreadthMinPercent: '0' }))).toBe(true);
  });

  it('empty universe is not blocked', () => {
    expect(marketBreadthOk([], cfg({ marketBreadthMinPercent: '50' }))).toBe(true);
  });

  it('exactly at the floor passes (gte)', () => {
    expect(marketBreadthOk(universe, cfg({ marketBreadthMinPercent: '80' }))).toBe(true);
  });

  it('just below the floor fails', () => {
    expect(marketBreadthOk(universe, cfg({ marketBreadthMinPercent: '80.01' }))).toBe(false);
  });

  it('excludes non-quote tickers from the universe', () => {
    // Add a positive BTC-quoted ticker: it must NOT lift USDT breadth.
    const mixed = [
      ...universe,
      ticker({ symbol: 'XBTC', quoteAsset: 'BTC', priceChangePercent: '5' }),
    ];
    // Still 4/5 = 80% on the USDT universe; the BTC ticker is ignored.
    expect(marketBreadthOk(mixed, cfg({ marketBreadthMinPercent: '80' }))).toBe(true);
    expect(marketBreadthOk(mixed, cfg({ marketBreadthMinPercent: '80.01' }))).toBe(false);
  });
});

describe('runDiscovery — market-breadth gate (issue #439)', () => {
  // A universe whose breadth is 1 positive of 3 quote symbols = 33.3%. Only the
  // one positive symbol is shortlist-eligible (the others fail the change band),
  // but all three count toward breadth.
  const tickers = [
    ticker({ symbol: 'G1USDT', priceChangePercent: '20' }), // eligible add candidate
    ticker({ symbol: 'D1USDT', priceChangePercent: '-10' }),
    ticker({ symbol: 'D2USDT', priceChangePercent: '-10' }),
  ];
  const klines = { G1USDT: good };

  it('gate OFF (default 0): adds proceed regardless of breadth', () => {
    const diff = runDiscovery({
      tickers,
      klinesBySymbol: klines,
      currentAuto: [],
      lastFlattenAtMsBySymbol: {},
      config: cfg({ maxAutoSymbols: 5 }), // marketBreadthMinPercent defaults to '0'
      nowMs: NOW,
    });
    expect(diff.add).toEqual(['G1USDT']);
  });

  it('gate ON, breadth BELOW floor: no adds, reap/desired unchanged vs gate-off', () => {
    const current: CurrentAutoSymbol[] = [
      { symbol: 'K1USDT', addedAtMs: NOW - 300 * MIN_MS }, // kept survivor
      { symbol: 'F1USDT', addedAtMs: NOW - 300 * MIN_MS }, // faded → reap
    ];
    const tickersWithKept = [...tickers, ticker({ symbol: 'K1USDT', priceChangePercent: '20' })];
    const klinesWithKept = { ...klines, K1USDT: good };
    const blocked = runDiscovery({
      tickers: tickersWithKept,
      klinesBySymbol: klinesWithKept,
      currentAuto: current,
      lastFlattenAtMsBySymbol: {},
      // Universe: G1(+) D1(-) D2(-) K1(+) = 2/4 = 50%, below a 60% floor.
      config: cfg({ maxAutoSymbols: 5, marketBreadthMinPercent: '60' }),
      nowMs: NOW,
    });
    expect(blocked.add).toEqual([]); // G1USDT suppressed by risk-off breadth
    expect(blocked.remove).toEqual(['F1USDT']); // reap unchanged
    expect(blocked.desired).toEqual(['K1USDT']); // kept survivor unchanged
  });

  it('gate ON, breadth ABOVE floor: adds proceed normally', () => {
    const diff = runDiscovery({
      tickers,
      klinesBySymbol: klines,
      currentAuto: [],
      lastFlattenAtMsBySymbol: {},
      // 1/3 = 33.3% breadth clears a 30% floor.
      config: cfg({ maxAutoSymbols: 5, marketBreadthMinPercent: '30' }),
      nowMs: NOW,
    });
    expect(diff.add).toEqual(['G1USDT']);
  });
});

describe('resolveDiscovery — manual exclusion (issue #435)', () => {
  it('excludes a qualifying manual symbol from add without consuming a slot', () => {
    const shortlist = ['M1', 'A1', 'A2']; // M1 manual (pinned), A1/A2 auto candidates
    const diff = resolveDiscovery(
      shortlist,
      klinesFor(shortlist),
      [],
      {},
      cfg({ maxAutoSymbols: 2 }),
      NOW,
      ['M1'],
    );
    // M1 is skipped and does NOT occupy a slot, so both auto candidates still fit.
    expect(diff.add).toEqual(['A1', 'A2']);
  });

  it('defaults to no manual members when the argument is omitted (back-compat)', () => {
    const shortlist = ['A1', 'A2'];
    const diff = resolveDiscovery(shortlist, klinesFor(shortlist), [], {}, cfg(), NOW);
    expect(diff.add).toEqual(['A1', 'A2']);
  });

  // Correlation cap (default-off). All test symbols share the `good` window, so
  // their returns are perfectly correlated (+1); the cap then admits the first
  // and skips the rest as 'correlation-high'.
  const corrCfg = (maxPairwise: string) =>
    cfg({ correlation: { maxPairwise, lookbackCandles: 30 } });

  it('skips a candidate too correlated with one already added this cycle', () => {
    const shortlist = ['C1', 'C2', 'C3'];
    const skip = new Map<string, DiscoverySkipReason>();
    const diff = resolveDiscovery(
      shortlist,
      klinesFor(shortlist), // identical windows → +1 correlation
      [],
      {},
      corrCfg('0.8'),
      NOW,
      [],
      true,
      skip,
    );
    expect(diff.add).toEqual(['C1']); // C1 has no peer yet; C2/C3 correlate +1 with C1
    expect(skip.get('C2')).toBe('correlation-high');
    expect(skip.get('C3')).toBe('correlation-high');
  });

  it('is inert when the cap is absent (back-compat: all eligible add)', () => {
    const shortlist = ['C1', 'C2', 'C3'];
    const diff = resolveDiscovery(shortlist, klinesFor(shortlist), [], {}, cfg(), NOW);
    expect(diff.add).toEqual(['C1', 'C2', 'C3']);
  });

  it('skips a candidate too correlated with a KEPT survivor', () => {
    const shortlist = ['K1', 'N1']; // K1 held+eligible (kept), N1 new
    const current: CurrentAutoSymbol[] = [{ symbol: 'K1', addedAtMs: NOW - 300 * MIN_MS }];
    const diff = resolveDiscovery(
      shortlist,
      klinesFor(shortlist),
      current,
      {},
      corrCfg('0.8'),
      NOW,
    );
    expect(diff.add).toEqual([]); // N1 correlates +1 with kept K1 → vetoed
    expect(diff.desired).toEqual(['K1']);
  });

  it('does not veto when correlation is below the threshold (gte gate)', () => {
    const shortlist = ['C1', 'C2', 'C3'];
    // +1 correlation never reaches a 1.5 threshold → every candidate still adds.
    const diff = resolveDiscovery(shortlist, klinesFor(shortlist), [], {}, corrCfg('1.5'), NOW);
    expect(diff.add).toEqual(['C1', 'C2', 'C3']);
  });

  // issue #439 — breadth risk-off blocks NEW adds but never touches reap/desired.
  it('allowAdds=false proposes no adds yet still reaps a faded past-hold symbol and keeps survivors', () => {
    const shortlist = ['K1', 'N1']; // K1 current+eligible (kept), N1 new eligible
    const current: CurrentAutoSymbol[] = [
      { symbol: 'K1', addedAtMs: NOW - 300 * MIN_MS },
      { symbol: 'F1', addedAtMs: NOW - 300 * MIN_MS }, // faded, past hold → reap
    ];
    const diff = resolveDiscovery(
      shortlist,
      klinesFor(shortlist), // F1 absent → not eligible
      current,
      {},
      cfg({ maxAutoSymbols: 5 }),
      NOW,
      [], // no manual members
      false, // breadth risk-off
    );
    expect(diff.add).toEqual([]); // N1 not added — adds suppressed
    expect(diff.remove).toEqual(['F1']); // reap unaffected by breadth
    expect(diff.desired).toEqual(['K1']); // kept survivor unaffected
  });
});

describe('maxPeerCorrelation', () => {
  // Index-aligned constant-close windows give controllable correlation.
  const win = (closes: readonly number[]): Candle[] =>
    closes.map((c, i) => ({
      openTimeMs: i * 60_000,
      closeTimeMs: (i + 1) * 60_000,
      open: String(c),
      high: String(c),
      low: String(c),
      close: String(c),
      volume: '1',
      isClosed: true,
    }));

  it('returns the highest positive correlation across peers', () => {
    const k = { CAND: win([1, 2, 3, 4]), UP: win([2, 4, 6, 8]), DOWN: win([8, 6, 4, 2]) };
    const corr = maxPeerCorrelation('CAND', ['UP', 'DOWN'], k, 10);
    expect(corr?.toFixed(4)).toBe('1.0000'); // UP is +1; DOWN (-1) never wins the max
  });

  it('returns null when the candidate window is too thin (fail-open)', () => {
    expect(maxPeerCorrelation('CAND', ['P'], { CAND: win([1]), P: win([1, 2, 3]) }, 10)).toBeNull();
  });

  it('skips a peer whose return series length differs (fail-open)', () => {
    // P has only 2 candles (1 return) vs CAND's 3 returns → length gap → skipped.
    const k = { CAND: win([1, 2, 3, 4]), P: win([5, 6]) };
    expect(maxPeerCorrelation('CAND', ['P'], k, 10)).toBeNull();
  });

  it('skips a flat (zero-variance) peer whose correlation is undefined', () => {
    const k = { CAND: win([1, 2, 3, 4]), FLAT: win([7, 7, 7, 7]) };
    expect(maxPeerCorrelation('CAND', ['FLAT'], k, 10)).toBeNull();
  });

  it('treats a candidate absent from the kline map as too-thin (fail-open)', () => {
    // klinesBySymbol['MISSING'] is undefined → `?? []` → no returns → null.
    expect(maxPeerCorrelation('MISSING', ['P'], { P: win([1, 2, 3]) }, 10)).toBeNull();
  });

  it('skips a peer absent from the kline map (length gap, fail-open)', () => {
    expect(maxPeerCorrelation('CAND', ['MISSING'], { CAND: win([1, 2, 3, 4]) }, 10)).toBeNull();
  });

  it('skips a peer whose candles do not line up in time (fail-open, no misaligned correlation)', () => {
    // Same length, but the peer's candle close-times are shifted, so index i is
    // NOT the same period in both — the gate must skip rather than correlate
    // mismatched candles.
    const shifted = win([2, 4, 6, 8]).map((c) => ({
      ...c,
      closeTimeMs: c.closeTimeMs + 1,
    }));
    expect(
      maxPeerCorrelation('CAND', ['SHIFTED'], { CAND: win([1, 2, 3, 4]), SHIFTED: shifted }, 10),
    ).toBeNull();
  });

  it('returns null when fewer than two aligned returns remain', () => {
    // Two-candle windows yield a single return each — not enough to correlate.
    expect(maxPeerCorrelation('CAND', ['P'], { CAND: win([1, 2]), P: win([3, 4]) }, 10)).toBeNull();
  });

  it('drops a zero-prior-close step from BOTH series, keeping the rest aligned', () => {
    // CAND and PEER are identical and start with a 0 close. The 0→10 step has a
    // zero prior, so it is dropped from both; the remaining aligned steps are
    // identical → +1 correlation (proves the drop did not desync the series).
    const series = [0, 10, 11, 13, 16];
    const corr = maxPeerCorrelation('CAND', ['PEER'], { CAND: win(series), PEER: win(series) }, 10);
    expect(corr?.toFixed(4)).toBe('1.0000');
  });
});

describe('tickerStageCounts (issue #636)', () => {
  it('all fields are 0 on an empty ticker set', () => {
    const counts: TickerStageCounts = tickerStageCounts([], cfg());
    expect(counts).toEqual({
      universe: 0,
      quote: 0,
      blacklist: 0,
      liquidity: 0,
      activity: 0,
      spread: 0,
      changeBand: 0,
    });
  });

  it('counts survivors after each ticker stage over the FULL set, monotone non-increasing', () => {
    // One distinct ticker dies at each successive stage; the rest all pass. The
    // stages are counted over the whole ticker set, not the ~few candidates.
    const tickers = [
      ticker({ symbol: 'PASSUSDT', priceChangePercent: '12' }), // passes every stage
      ticker({ symbol: 'QUOTEBTC', quoteAsset: 'BTC' }), // dies at quote
      ticker({ symbol: 'BLACKUSDT' }), // dies at blacklist
      ticker({ symbol: 'THINUSDT', pairVolumeUsd: '1' }), // dies at liquidity
      ticker({ symbol: 'DEADUSDT', assetVolumeUsd: '100' }), // dies at activity
      ticker({ symbol: 'WIDEUSDT', bidPrice: '100', askPrice: '105' }), // dies at spread
      ticker({ symbol: 'FLATUSDT', priceChangePercent: '1' }), // dies at change band
    ];
    const counts = tickerStageCounts(tickers, cfg({ blacklist: ['BLACKUSDT'] }));
    expect(counts).toEqual({
      universe: 7,
      quote: 6,
      blacklist: 5,
      liquidity: 4,
      activity: 3,
      spread: 2,
      changeBand: 1,
    });
    // Monotone non-increasing within the ticker segment.
    const seq = [
      counts.universe,
      counts.quote,
      counts.blacklist,
      counts.liquidity,
      counts.activity,
      counts.spread,
      counts.changeBand,
    ];
    for (let i = 1; i < seq.length; i++) {
      expect(seq[i]).toBeLessThanOrEqual(seq[i - 1] as number);
    }
  });

  it('universe === tickers.length', () => {
    const tickers = [ticker({ symbol: 'AUSDT' }), ticker({ symbol: 'QBTC', quoteAsset: 'BTC' })];
    expect(tickerStageCounts(tickers, cfg()).universe).toBe(tickers.length);
  });

  it('the final changeBand count equals shortlistByTicker(...).length (consistency)', () => {
    const tickers = [
      ticker({ symbol: 'PASSUSDT', priceChangePercent: '12' }),
      ticker({ symbol: 'BLACKUSDT' }), // dies at blacklist
      ticker({ symbol: 'THINUSDT', pairVolumeUsd: '1' }), // dies at liquidity
      ticker({ symbol: 'FLATUSDT', priceChangePercent: '1' }), // dies at change band
    ];
    const c = cfg({ blacklist: ['BLACKUSDT'] });
    expect(tickerStageCounts(tickers, c).changeBand).toBe(shortlistByTicker(tickers, c).length);
  });
});
