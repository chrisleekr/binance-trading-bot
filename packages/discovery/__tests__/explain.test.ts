import { describe, expect, it } from 'vitest';
import { explainDiscovery, runDiscovery } from '../src/index.js';
import type { CandidateExplain, DiscoveryDisposition } from '../src/index.js';
import type { DiscoveryInput } from '../src/index.js';
import { cfg, DAY_MS, ticker, uptrend } from './_helpers.js';

const NOW = 1_700_000_000_000;
const MIN = 60_000;
const eligibleKlines = uptrend(40, NOW - 40 * DAY_MS);
// Old enough (oldest candle is 40 days back) but only 2 candles, so ADX is null
// and trend-confirm fails: a symbol that passes the age gate but not the trend.
const shortKlines = uptrend(2, NOW - 40 * DAY_MS);
// Recent window: oldest candle inside minAgeDays, so the age gate fails.
const youngKlines = uptrend(40, NOW - 5 * DAY_MS);

const bySymbol = (candidates: readonly CandidateExplain[]): Record<string, CandidateExplain> =>
  Object.fromEntries(candidates.map((c) => [c.symbol, c]));

describe('explainDiscovery', () => {
  it('classifies every disposition in one cycle, matching the cron add-loop precedence', () => {
    // 2 free slots (cap 5 − 2 kept − 1 protected). The add loop fills them with
    // WIN then ADD2 in rank order: COOL is skipped on cooldown WHILE a slot is
    // still free (so 'cooldown'); CAP comes after the slots fill (so
    // 'slot-capped', even though it is not on cooldown). KEEP2 is a held symbol
    // ranked after the slots fill — still 'kept', never slot-capped.
    const input: DiscoveryInput = {
      tickers: [
        ticker({ symbol: 'WINUSDT', priceChangePercent: '22', quoteVolume: '80000000' }),
        ticker({ symbol: 'COOLUSDT', priceChangePercent: '20', quoteVolume: '60000000' }),
        ticker({ symbol: 'KEEPUSDT', priceChangePercent: '18', quoteVolume: '50000000' }),
        ticker({ symbol: 'ADD2USDT', priceChangePercent: '16', quoteVolume: '45000000' }),
        ticker({ symbol: 'KEEP2USDT', priceChangePercent: '15', quoteVolume: '44000000' }),
        ticker({ symbol: 'CAPUSDT', priceChangePercent: '14', quoteVolume: '43000000' }),
      ],
      klinesBySymbol: {
        WINUSDT: eligibleKlines,
        COOLUSDT: eligibleKlines,
        KEEPUSDT: eligibleKlines,
        ADD2USDT: eligibleKlines,
        KEEP2USDT: eligibleKlines,
        CAPUSDT: eligibleKlines,
      },
      currentAuto: [
        { symbol: 'KEEPUSDT', addedAtMs: NOW - 600 * MIN }, // eligible + held -> kept
        { symbol: 'KEEP2USDT', addedAtMs: NOW - 600 * MIN }, // held, ranked after slots fill -> kept
        { symbol: 'FADEDUSDT', addedAtMs: NOW - 600 * MIN }, // vanished, past hold -> reaped
        { symbol: 'HOLDUSDT', addedAtMs: NOW - 10 * MIN }, // vanished, within hold -> held
      ],
      lastFlattenAtMsBySymbol: { COOLUSDT: NOW - 10 * MIN }, // on cooldown
      config: cfg({ maxAutoSymbols: 5 }),
      nowMs: NOW,
    };
    const { diff, candidates } = explainDiscovery(input);
    // Diff is taken verbatim from runDiscovery.
    expect(diff).toEqual(runDiscovery(input));

    const map = bySymbol(candidates);
    const dispositions: Record<string, DiscoveryDisposition> = {
      WINUSDT: 'added',
      COOLUSDT: 'cooldown', // skipped on cooldown while a slot was still free
      KEEPUSDT: 'kept',
      ADD2USDT: 'added',
      KEEP2USDT: 'kept', // held, after the slots filled — never slot-capped
      CAPUSDT: 'slot-capped', // eligible, but reached after the slots filled
      FADEDUSDT: 'faded-removed',
      HOLDUSDT: 'faded-held',
    };
    for (const [symbol, disposition] of Object.entries(dispositions)) {
      expect(map[symbol]?.disposition).toBe(disposition);
    }
    // Ranked by gain desc, null scores (vanished) last by symbol.
    expect(candidates.map((c) => c.symbol)).toEqual([
      'WINUSDT',
      'COOLUSDT',
      'KEEPUSDT',
      'ADD2USDT',
      'KEEP2USDT',
      'CAPUSDT',
      'FADEDUSDT',
      'HOLDUSDT',
    ]);
    // A vanished held symbol has no score and no filter trail.
    expect(map['FADEDUSDT']).toMatchObject({ gainerScore: null, passed: [], failedAt: null });
    // An eligible symbol passed all nine filters.
    expect(map['WINUSDT']?.passed).toEqual([
      'quote',
      'assetPolicy',
      'blacklist',
      'liquidity',
      'activity',
      'spread',
      'changeBand',
      'age',
      'trend',
    ]);
    expect(map['WINUSDT']?.failedAt).toBeNull();
  });

  it('subtracts sibling-conflicted symbols from add/desired and labels them, leaving remove and clean adds intact', () => {
    // AAA + BBB + CCC all qualify to be added; GONE is a vanished held symbol
    // past its hold, so it reaps (a `remove`). The overlay marks AAA owned by a
    // sibling and BBB colliding with a sibling's quote; CCC is unconflicted.
    const input: DiscoveryInput = {
      tickers: [
        ticker({ symbol: 'AAAUSDT', priceChangePercent: '22', quoteVolume: '80000000' }),
        ticker({ symbol: 'BBBUSDT', priceChangePercent: '20', quoteVolume: '70000000' }),
        ticker({ symbol: 'CCCUSDT', priceChangePercent: '18', quoteVolume: '60000000' }),
      ],
      klinesBySymbol: {
        AAAUSDT: eligibleKlines,
        BBBUSDT: eligibleKlines,
        CCCUSDT: eligibleKlines,
      },
      currentAuto: [
        { symbol: 'GONEUSDT', addedAtMs: NOW - 600 * MIN }, // vanished, past hold -> reaped
      ],
      lastFlattenAtMsBySymbol: {},
      config: cfg({ maxAutoSymbols: 5 }),
      nowMs: NOW,
    };

    const pure = explainDiscovery(input);
    expect(pure.diff.add).toEqual(expect.arrayContaining(['AAAUSDT', 'BBBUSDT', 'CCCUSDT']));
    expect(pure.diff.remove).toContain('GONEUSDT');

    const overlay = new Map<string, DiscoveryDisposition>([
      ['AAAUSDT', 'sibling-owns-base'],
      ['BBBUSDT', 'sibling-quotes-base'],
    ]);
    const { diff, candidates } = explainDiscovery(
      input,
      overlay as ReadonlyMap<string, 'sibling-owns-base' | 'sibling-quotes-base'>,
    );

    // Conflicted symbols leave the add + desired sets; the unconflicted add stays.
    expect(diff.add).not.toContain('AAAUSDT');
    expect(diff.add).not.toContain('BBBUSDT');
    expect(diff.add).toContain('CCCUSDT');
    expect(diff.desired).not.toContain('AAAUSDT');
    expect(diff.desired).not.toContain('BBBUSDT');
    // A conflict blocks an add only — the reap is untouched.
    expect(diff.remove).toEqual(pure.diff.remove);

    const map = bySymbol(candidates);
    expect(map['AAAUSDT']?.disposition).toBe('sibling-owns-base');
    expect(map['BBBUSDT']?.disposition).toBe('sibling-quotes-base');
    expect(map['CCCUSDT']?.disposition).toBe('added');
  });

  it('slot-caps a fresh candidate when held symbols already exceed a lowered cap', () => {
    // cap 1 but two eligible held symbols → 1 − 2 = −1 free slots, clamped to 0.
    // Held symbols keep their slots (never evicted); the fresh one is slot-capped.
    const input: DiscoveryInput = {
      tickers: [
        ticker({ symbol: 'NEWUSDT', priceChangePercent: '22', quoteVolume: '80000000' }),
        ticker({ symbol: 'KEEPAUSDT', priceChangePercent: '18', quoteVolume: '50000000' }),
        ticker({ symbol: 'KEEPBUSDT', priceChangePercent: '16', quoteVolume: '45000000' }),
      ],
      klinesBySymbol: {
        NEWUSDT: eligibleKlines,
        KEEPAUSDT: eligibleKlines,
        KEEPBUSDT: eligibleKlines,
      },
      currentAuto: [
        { symbol: 'KEEPAUSDT', addedAtMs: NOW - 600 * MIN },
        { symbol: 'KEEPBUSDT', addedAtMs: NOW - 600 * MIN },
      ],
      lastFlattenAtMsBySymbol: {},
      config: cfg({ maxAutoSymbols: 1 }),
      nowMs: NOW,
    };
    const map = bySymbol(explainDiscovery(input).candidates);
    expect(map['NEWUSDT']?.disposition).toBe('slot-capped');
    expect(map['KEEPAUSDT']?.disposition).toBe('kept');
    expect(map['KEEPBUSDT']?.disposition).toBe('kept');
  });

  it('reports the first failing ticker filter for a faded held symbol', () => {
    const held = (symbol: string) => ({ symbol, addedAtMs: NOW - 10 * MIN }); // within hold -> faded-held
    const input: DiscoveryInput = {
      tickers: [
        ticker({ symbol: 'QUOTEUSDT', quoteAsset: 'BTC' }), // fails quote
        ticker({ symbol: 'PEGUSDT', baseAsset: 'PEG', isStablecoinOrFiat: true }), // fails assetPolicy
        ticker({ symbol: 'BLKUSDT' }), // fails blacklist
        ticker({ symbol: 'ILLIQUSDT', pairVolumeUsd: '1000' }), // fails liquidity
        ticker({ symbol: 'SPRDUSDT', bidPrice: '110', askPrice: '100' }), // crossed -> fails spread
        ticker({ symbol: 'BANDUSDT', priceChangePercent: '1' }), // under the changeMinPercent hurdle
      ],
      klinesBySymbol: {
        QUOTEUSDT: eligibleKlines,
        PEGUSDT: eligibleKlines,
        BLKUSDT: eligibleKlines,
        ILLIQUSDT: eligibleKlines,
        SPRDUSDT: eligibleKlines,
        BANDUSDT: eligibleKlines,
      },
      currentAuto: [
        held('QUOTEUSDT'),
        held('PEGUSDT'),
        held('BLKUSDT'),
        held('ILLIQUSDT'),
        held('SPRDUSDT'),
        held('BANDUSDT'),
      ],
      lastFlattenAtMsBySymbol: {},
      config: cfg({ blacklist: ['BLKUSDT'] }),
      nowMs: NOW,
    };
    const map = bySymbol(explainDiscovery(input).candidates);
    expect(map['QUOTEUSDT']).toMatchObject({
      failedAt: 'quote',
      passed: [],
      disposition: 'faded-held',
    });
    expect(map['PEGUSDT']).toMatchObject({ failedAt: 'assetPolicy', passed: ['quote'] });
    expect(map['BLKUSDT']).toMatchObject({
      failedAt: 'blacklist',
      passed: ['quote', 'assetPolicy'],
    });
    expect(map['ILLIQUSDT']).toMatchObject({
      failedAt: 'liquidity',
      passed: ['quote', 'assetPolicy', 'blacklist'],
    });
    expect(map['SPRDUSDT']?.failedAt).toBe('spread');
    expect(map['BANDUSDT']?.failedAt).toBe('changeBand');
  });

  it('rejects a non-held shortlist symbol that fails the age or trend gate', () => {
    const input: DiscoveryInput = {
      tickers: [
        ticker({ symbol: 'AGEUSDT', priceChangePercent: '20' }),
        ticker({ symbol: 'TRENDUSDT', priceChangePercent: '18' }),
      ],
      klinesBySymbol: { AGEUSDT: youngKlines, TRENDUSDT: shortKlines },
      currentAuto: [],
      lastFlattenAtMsBySymbol: {},
      config: cfg(),
      nowMs: NOW,
    };
    const map = bySymbol(explainDiscovery(input).candidates);
    expect(map['AGEUSDT']).toMatchObject({ failedAt: 'age', disposition: 'rejected' });
    expect(map['TRENDUSDT']).toMatchObject({ failedAt: 'trend', disposition: 'rejected' });
    expect(map['TRENDUSDT']?.passed).toContain('age');
  });

  it('treats a shortlist symbol with no kline window as failing the age gate', () => {
    const input: DiscoveryInput = {
      tickers: [ticker({ symbol: 'MISSUSDT', priceChangePercent: '20' })],
      klinesBySymbol: {}, // no window fetched
      currentAuto: [],
      lastFlattenAtMsBySymbol: {},
      config: cfg(),
      nowMs: NOW,
    };
    const map = bySymbol(explainDiscovery(input).candidates);
    expect(map['MISSUSDT']).toMatchObject({
      failedAt: 'age',
      passed: [
        'quote',
        'assetPolicy',
        'blacklist',
        'liquidity',
        'activity',
        'spread',
        'changeBand',
      ],
      disposition: 'rejected',
    });
  });

  it('omits a manually-pinned symbol from the universe and keeps slot labels consistent (issue #435)', () => {
    // MAN is pinned; it qualifies by the chain but must not appear as a discovery
    // candidate, and it must not consume a slot — so with cap 1 the genuine auto
    // candidate WIN is still 'added' (not pushed to 'slot-capped' by MAN).
    const input: DiscoveryInput = {
      tickers: [
        ticker({ symbol: 'MANUSDT', priceChangePercent: '22', quoteVolume: '80000000' }),
        ticker({ symbol: 'WINUSDT', priceChangePercent: '20', quoteVolume: '60000000' }),
      ],
      klinesBySymbol: { MANUSDT: eligibleKlines, WINUSDT: eligibleKlines },
      currentAuto: [],
      lastFlattenAtMsBySymbol: {},
      pinnedMembers: ['MANUSDT'],
      config: cfg({ maxAutoSymbols: 1 }),
      nowMs: NOW,
    };
    const { diff, candidates } = explainDiscovery(input);
    expect(diff.add).toEqual(['WINUSDT']);
    const map = bySymbol(candidates);
    expect(map['MANUSDT']).toBeUndefined(); // pinned -> not a discovery candidate
    expect(map['WINUSDT']?.disposition).toBe('added'); // slot not consumed by MAN
  });

  it('labels an eligible candidate slot-capped when market breadth blocks adds (issue #439)', () => {
    // Breadth = 1 positive of 3 quote tickers = 33.3%, below a 50% floor, so the
    // diff has no adds; the otherwise-addable WIN reads slot-capped, consistent
    // with the empty diff (no false 'added' or free-slot label).
    const input: DiscoveryInput = {
      tickers: [
        ticker({ symbol: 'WINUSDT', priceChangePercent: '20', quoteVolume: '60000000' }),
        ticker({ symbol: 'DN1USDT', priceChangePercent: '-10' }),
        ticker({ symbol: 'DN2USDT', priceChangePercent: '-10' }),
      ],
      klinesBySymbol: { WINUSDT: eligibleKlines },
      currentAuto: [],
      lastFlattenAtMsBySymbol: {},
      config: cfg({ maxAutoSymbols: 5, marketBreadthMinPercent: '50' }),
      nowMs: NOW,
    };
    const { diff, candidates } = explainDiscovery(input);
    expect(diff.add).toEqual([]);
    expect(bySymbol(candidates)['WINUSDT']?.disposition).toBe('slot-capped');
  });

  it('ranks equal scores by symbol and orders scoreless symbols last', () => {
    const input: DiscoveryInput = {
      tickers: [
        ticker({ symbol: 'BBBUSDT', priceChangePercent: '20', quoteVolume: '60000000' }),
        ticker({ symbol: 'AAAUSDT', priceChangePercent: '20', quoteVolume: '60000000' }),
      ],
      klinesBySymbol: { AAAUSDT: eligibleKlines, BBBUSDT: eligibleKlines },
      currentAuto: [
        { symbol: 'ZZZUSDT', addedAtMs: NOW - 600 * MIN }, // vanished, scoreless
        { symbol: 'YYYUSDT', addedAtMs: NOW - 600 * MIN }, // vanished, scoreless
      ],
      lastFlattenAtMsBySymbol: {},
      config: cfg({ maxAutoSymbols: 5 }),
      nowMs: NOW,
    };
    expect(explainDiscovery(input).candidates.map((c) => c.symbol)).toEqual([
      'AAAUSDT', // tie on score -> symbol asc
      'BBBUSDT',
      'YYYUSDT', // scoreless -> last, symbol asc
      'ZZZUSDT',
    ]);
  });
});
