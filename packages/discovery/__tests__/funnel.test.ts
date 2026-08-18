import { describe, expect, it } from 'vitest';
import { projectFunnel } from '../src/funnel.js';
import type { TickerStageCounts } from '../src/run.js';
import type {
  CandidateExplain,
  DiscoveryDisposition,
  DiscoveryFilterName,
} from '../src/explain.js';
import type { DiscoveryDiff } from '../src/types.js';

const STAGES: readonly DiscoveryFilterName[] = [
  'quote',
  'assetPolicy',
  'blacklist',
  'liquidity',
  'activity',
  'spread',
  'changeBand',
  'age',
  'trend',
];

/** A candidate that passed every stage up to (but not including) `failedAt`. */
const candidate = (
  symbol: string,
  failedAt: DiscoveryFilterName | null,
  disposition: DiscoveryDisposition,
): CandidateExplain => {
  const cut = failedAt === null ? STAGES.length : STAGES.indexOf(failedAt);
  return { symbol, gainerScore: '1', passed: STAGES.slice(0, cut), failedAt, disposition };
};

const emptyDiff: DiscoveryDiff = { add: [], remove: [], desired: [] };

// The ticker segment is now supplied to projectFunnel as its own count vector,
// computed over the FULL quote-matched ticker set (issue #636). The candidate
// segment (age/trend/eligible) is still derived from the candidate array.
const zeroTicker: TickerStageCounts = {
  universe: 0,
  quote: 0,
  assetPolicy: 0,
  blacklist: 0,
  liquidity: 0,
  activity: 0,
  spread: 0,
  changeBand: 0,
};

describe('projectFunnel', () => {
  it('returns all-zero counts and false breadth on an empty cycle without throwing', () => {
    expect(projectFunnel([], emptyDiff, false, zeroTicker, 0)).toEqual({
      universe: 0,
      quote: 0,
      assetPolicy: 0,
      blacklist: 0,
      liquidity: 0,
      activity: 0,
      spread: 0,
      changeBand: 0,
      probed: 0,
      age: 0,
      trend: 0,
      eligible: 0,
      added: 0,
      kept: 0,
      removed: 0,
      breadthOk: false,
    });
  });

  it('reads universe + quote…changeBand from the ticker counts, age/trend/eligible from the candidate array', () => {
    // Ticker counts are deliberately distinct from what the single fully-passing
    // candidate would produce, proving the ticker segment reads the counts, not
    // the candidate rows.
    const ticker: TickerStageCounts = {
      universe: 9,
      quote: 8,
      assetPolicy: 8,
      blacklist: 7,
      liquidity: 6,
      activity: 5,
      spread: 4,
      changeBand: 3,
    };
    const f = projectFunnel([candidate('AAAUSDT', null, 'added')], emptyDiff, true, ticker, 1);
    // Ticker segment: from the counts.
    expect(f.universe).toBe(9);
    expect(f.quote).toBe(8);
    expect(f.assetPolicy).toBe(8);
    expect(f.blacklist).toBe(7);
    expect(f.liquidity).toBe(6);
    expect(f.activity).toBe(5);
    expect(f.spread).toBe(4);
    expect(f.changeBand).toBe(3);
    // Candidate segment: from the (fully-passing) candidate.
    expect(f.age).toBe(1);
    expect(f.trend).toBe(1);
    expect(f.eligible).toBe(1);
    expect(f.breadthOk).toBe(true);
  });

  it('a ticker dying at spread zeroes spread + changeBand in the counts', () => {
    const ticker: TickerStageCounts = {
      universe: 5,
      quote: 4,
      assetPolicy: 4,
      blacklist: 3,
      liquidity: 2,
      activity: 1,
      spread: 0,
      changeBand: 0,
    };
    const f = projectFunnel([], emptyDiff, true, ticker, 0);
    expect(f.quote).toBe(4);
    expect(f.assetPolicy).toBe(4);
    expect(f.blacklist).toBe(3);
    expect(f.liquidity).toBe(2);
    expect(f.activity).toBe(1);
    expect(f.spread).toBe(0);
    expect(f.changeBand).toBe(0);
    // No candidate cleared the ticker segment, so the candidate segment is empty.
    expect(f.age).toBe(0);
    expect(f.trend).toBe(0);
    expect(f.eligible).toBe(0);
  });

  it('the candidate segment age→trend→eligible is monotone non-increasing, independent of the ticker segment', () => {
    const candidates = [
      candidate('DIESATAGE', 'age', 'rejected'), // survives changeBand, dies at age
      candidate('DIESATTREND', 'trend', 'rejected'), // survives age, dies at trend
      candidate('FULLPASS', null, 'added'), // survives every stage
    ];
    // changeBand is deliberately BELOW `age` here: the two segments are separate,
    // so the funnel makes no cross-boundary monotonicity claim (changeBand ≥ age
    // is NOT asserted).
    const ticker: TickerStageCounts = {
      universe: 3,
      quote: 3,
      assetPolicy: 3,
      blacklist: 3,
      liquidity: 3,
      activity: 3,
      spread: 3,
      changeBand: 1,
    };
    const f = projectFunnel(candidates, emptyDiff, true, ticker, candidates.length);
    // The segment's own denominator: every candidate whose klines were fetched,
    // including the one that died at the first kline filter. Without it `age` is
    // the first entry and nothing can score a collapse AT the age filter.
    expect(f.probed).toBe(3);
    expect(f.age).toBe(2);
    expect(f.trend).toBe(1);
    expect(f.eligible).toBe(1);
    expect(f.probed).toBeGreaterThanOrEqual(f.age);
    expect(f.age).toBeGreaterThanOrEqual(f.trend);
    expect(f.trend).toBeGreaterThanOrEqual(f.eligible);
    // The boundary is intentionally non-monotone: changeBand(1) < age(2).
    expect(f.changeBand).toBe(1);
  });

  it('universe comes from the ticker count; a vanished held candidate contributes 0 to the candidate segment', () => {
    // A held auto symbol that dropped out of the ticker feed: no ticker to filter,
    // so passed=[] and failedAt=null. It counts toward NOTHING in the candidate
    // segment, and universe now reflects the full ticker set, not this one row.
    const vanished: CandidateExplain = {
      symbol: 'GONEUSDT',
      gainerScore: null,
      passed: [],
      failedAt: null,
      disposition: 'faded-held',
    };
    const ticker: TickerStageCounts = {
      universe: 250,
      quote: 200,
      assetPolicy: 200,
      blacklist: 195,
      liquidity: 120,
      activity: 90,
      spread: 60,
      changeBand: 12,
    };
    const f = projectFunnel([vanished], emptyDiff, true, ticker, 1);
    expect(f.universe).toBe(250); // from the counts, not the candidate array length
    expect(f.age).toBe(0);
    expect(f.trend).toBe(0);
    expect(f.eligible).toBe(0);
  });

  it('reads added/removed/kept from the diff, kept = desired minus new adds', () => {
    const diff: DiscoveryDiff = {
      add: ['NEWUSDT'],
      remove: ['OLDUSDT', 'OLD2USDT'],
      desired: ['KEPTUSDT', 'NEWUSDT'], // one retained survivor + one new add
    };
    const f = projectFunnel([], diff, true, zeroTicker, 0);
    expect(f.added).toBe(1);
    expect(f.removed).toBe(2);
    expect(f.kept).toBe(1);
  });

  it('takes probed from the caller, so a failed kline fetch does not read as an age cut', () => {
    // Three candidates reached the kline stage; only one window arrived. The two
    // without data score as failing `age`, which is exactly what a partial probe
    // must not report as the age filter doing its job.
    const candidates = [
      candidate('AAAUSDT', null, 'added'),
      candidate('BBBUSDT', 'age', 'rejected'),
      candidate('CCCUSDT', 'age', 'rejected'),
    ];
    const ticker: TickerStageCounts = {
      universe: 9,
      quote: 8,
      assetPolicy: 8,
      blacklist: 7,
      liquidity: 6,
      activity: 5,
      spread: 4,
      changeBand: 3,
    };

    expect(projectFunnel(candidates, emptyDiff, true, ticker, 1).probed).toBe(1);
    // Left to derive itself, the ladder would claim two of three died at the age
    // filter when neither was ever measured.
    expect(projectFunnel(candidates, emptyDiff, true, ticker, candidates.length).probed).toBe(3);
  });
});
