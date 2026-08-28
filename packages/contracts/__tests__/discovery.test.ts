import { describe, expect, it } from 'vitest';
import {
  DiscoveryConfigSchema,
  DiscoveryDashboardResponse,
  DiscoveryHolding,
  DiscoveryScoreboardResponse,
} from '../src/discovery.js';

describe('DiscoveryConfigSchema', () => {
  it('parses an empty object to the locked balanced seed defaults, disabled', () => {
    const cfg = DiscoveryConfigSchema.parse({});
    expect(cfg).toEqual({
      enabled: false,
      refreshPeriodMs: 900_000,
      blacklist: [],
      min24hPairVolumeUsd: '500000',
      min24hAssetVolumeUsd: '50000000',
      maxSpreadRatio: '0.003',
      changeMinPercent: '0',
      rankTopPercent: 30,
      rankExcludeTopPercent: 5,
      minAgeDays: 30,
      maxAutoSymbols: 5,
      minHoldMinutes: 120,
      marketBreadthMinPercent: '0',
      enterOnAdd: false,
      entryGuard: {
        maxDistanceFrom24hHighPercent: '0',
        knifeCandles: 0,
        knifeDropPercent: '0',
      },
      trendConfirm: {
        adxPeriod: 14,
        adxMin: '25',
        emaPeriod: 20,
        volSmaPeriod: 20,
        volMultiple: '1.5',
      },
      correlation: {
        maxPairwise: '0',
        lookbackCandles: 30,
      },
    });
  });

  it('correlation parses to off-by-default (maxPairwise 0) and round-trips an armed override', () => {
    expect(DiscoveryConfigSchema.parse({}).correlation).toEqual({
      maxPairwise: '0',
      lookbackCandles: 30,
    });
    const armed = DiscoveryConfigSchema.parse({
      correlation: { maxPairwise: '0.6', lookbackCandles: 50 },
    }).correlation;
    expect(armed).toEqual({ maxPairwise: '0.6', lookbackCandles: 50 });
  });

  it('rejects a correlation maxPairwise outside [0, 1] and a too-short lookback', () => {
    expect(() => DiscoveryConfigSchema.parse({ correlation: { maxPairwise: '1.5' } })).toThrow();
    expect(() => DiscoveryConfigSchema.parse({ correlation: { lookbackCandles: 2 } })).toThrow();
  });

  it('entryGuard parses to all-off from an empty object (#473)', () => {
    const eg = DiscoveryConfigSchema.parse({}).entryGuard;
    expect(eg).toEqual({
      maxDistanceFrom24hHighPercent: '0',
      knifeCandles: 0,
      knifeDropPercent: '0',
    });
    // An armed override round-trips losslessly.
    const armed = DiscoveryConfigSchema.parse({
      entryGuard: { maxDistanceFrom24hHighPercent: '3', knifeCandles: 3, knifeDropPercent: '5' },
    }).entryGuard;
    expect(armed).toEqual({
      maxDistanceFrom24hHighPercent: '3',
      knifeCandles: 3,
      knifeDropPercent: '5',
    });
  });

  it('honours partial overrides and fills the rest from defaults', () => {
    const cfg = DiscoveryConfigSchema.parse({ enabled: true, maxAutoSymbols: 8 });
    expect(cfg.enabled).toBe(true);
    expect(cfg.maxAutoSymbols).toBe(8);
    expect(cfg.refreshPeriodMs).toBe(900_000);
    expect(cfg.trendConfirm.adxMin).toBe('25');
  });

  it('enterOnAdd defaults off and accepts an explicit opt-in', () => {
    expect(DiscoveryConfigSchema.parse({}).enterOnAdd).toBe(false);
    expect(DiscoveryConfigSchema.parse({ enterOnAdd: true }).enterOnAdd).toBe(true);
  });

  it('marketBreadthMinPercent defaults to 0 (off), accepts a floor, rejects negatives (issue #439)', () => {
    expect(DiscoveryConfigSchema.parse({}).marketBreadthMinPercent).toBe('0');
    expect(
      DiscoveryConfigSchema.parse({ marketBreadthMinPercent: '50' }).marketBreadthMinPercent,
    ).toBe('50');
    expect(DiscoveryConfigSchema.safeParse({ marketBreadthMinPercent: '-1' }).success).toBe(false);
  });

  it('rejects a non-positive slot cap', () => {
    expect(DiscoveryConfigSchema.safeParse({ maxAutoSymbols: 0 }).success).toBe(false);
  });

  it('rejects a non-positive liquidity floor', () => {
    expect(DiscoveryConfigSchema.safeParse({ min24hPairVolumeUsd: '0' }).success).toBe(false);
    expect(DiscoveryConfigSchema.safeParse({ min24hAssetVolumeUsd: '0' }).success).toBe(false);
  });

  it('rejects a rank band that excludes more than it admits', () => {
    expect(
      DiscoveryConfigSchema.safeParse({ rankTopPercent: 10, rankExcludeTopPercent: 10 }).success,
    ).toBe(false);
    expect(
      DiscoveryConfigSchema.safeParse({ rankTopPercent: 10, rankExcludeTopPercent: 20 }).success,
    ).toBe(false);
    expect(
      DiscoveryConfigSchema.safeParse({ rankTopPercent: 30, rankExcludeTopPercent: 5 }).success,
    ).toBe(true);
  });

  it('rejects a malformed decimal threshold', () => {
    expect(DiscoveryConfigSchema.safeParse({ maxSpreadRatio: 'wide' }).success).toBe(false);
  });

  it('rejects a refresh period below the 1-minute floor', () => {
    expect(DiscoveryConfigSchema.safeParse({ refreshPeriodMs: 1000 }).success).toBe(false);
  });

  it('rejects a refresh period above the 24-hour ceiling', () => {
    expect(DiscoveryConfigSchema.safeParse({ refreshPeriodMs: 86_400_001 }).success).toBe(false);
  });

  it('rejects a minAgeDays above the 40-day kline-window reach', () => {
    expect(DiscoveryConfigSchema.safeParse({ minAgeDays: 90 }).success).toBe(false);
  });

  it('rejects a malformed nested trend-confirm threshold', () => {
    expect(DiscoveryConfigSchema.safeParse({ trendConfirm: { volMultiple: '-1' } }).success).toBe(
      false,
    );
  });

  it('accepts a negative change-band lower bound (a decimal with no positivity constraint)', () => {
    const cfg = DiscoveryConfigSchema.parse({ changeMinPercent: '-2' });
    expect(cfg.changeMinPercent).toBe('-2');
  });
});

describe('DiscoveryHolding', () => {
  it('parses a cost-basis row', () => {
    const h = DiscoveryHolding.parse({
      symbol: 'CHZUSDT',
      quantity: '100',
      avgEntryPrice: '0.028',
      quoteCostBasis: '2.8',
    });
    expect(h.symbol).toBe('CHZUSDT');
    expect(h.quoteCostBasis).toBe('2.8');
  });

  it('rejects a non-decimal money field', () => {
    expect(
      DiscoveryHolding.safeParse({
        symbol: 'CHZUSDT',
        quantity: 'lots',
        avgEntryPrice: '0.028',
        quoteCostBasis: '2.8',
      }).success,
    ).toBe(false);
  });
});

describe('DiscoveryDashboardResponse', () => {
  it('defaults holdings to an empty array when absent (a never-traded profile)', () => {
    const res = DiscoveryDashboardResponse.parse({
      config: {},
      quoteAsset: 'USDT',
      scoreboard: {
        realizedProfit: '0',
        realizedProfitPercent: '0',
        tradeCount: 0,
        winRate: 0,
        realizedProfit7d: '0',
        tradeCount7d: 0,
      },
      gauge: { deployedQuote: '0', maxAccountExposureQuote: null, autoSymbolCount: 0 },
    });
    expect(res.holdings).toEqual([]);
    expect(res.autoSymbols).toEqual([]);
    // Absent flag defaults to "config is valid".
    expect(res.configInvalid).toBe(false);
    expect(res.scoreboard.feeBasis).toBe('unknown');
    expect(res.scoreboard.feeBasis7d).toBe('unknown');
  });

  it("defaults both fee tiers to 'unknown' when the producer omits them", () => {
    // Silence is not evidence. A default of `exact` would let a payload that never computed fee provenance light up profit factor, payoff and expectancy on a scorecard the operator reads as proven.
    const res = DiscoveryDashboardResponse.parse({
      config: {},
      quoteAsset: 'USDT',
      scoreboard: {
        realizedProfit: '0',
        realizedProfitPercent: '0',
        tradeCount: 0,
        winRate: 0,
        realizedProfit7d: '0',
        tradeCount7d: 0,
      },
      gauge: { deployedQuote: '0', maxAccountExposureQuote: null, autoSymbolCount: 0 },
    });
    expect(res.scoreboard.feeBasis).toBe('unknown');
    expect(res.scoreboard.feeBasis7d).toBe('unknown');
  });
});

describe('DiscoveryScoreboardResponse', () => {
  const valid = {
    period: 'w' as const,
    tz: 'UTC',
    from: '2026-06-01T00:00:00.000Z',
    to: '2026-06-08T00:00:00.000Z',
    realizedProfit: '12.5',
    realizedProfitPercent: '4.2',
    tradeCount: 9,
    winRate: 0.5,
  };

  it('parses a period-ranged scoreboard', () => {
    const res = DiscoveryScoreboardResponse.parse(valid);
    expect(res.tradeCount).toBe(9);
    expect(res.winRate).toBe(0.5);
    expect(res.feeBasis).toBe('unknown');
  });

  it("defaults the ranged scoreboard's fee tier to 'unknown'", () => {
    expect(DiscoveryScoreboardResponse.parse(valid).feeBasis).toBe('unknown');
  });

  it('defaults bySource to an empty array when absent', () => {
    expect(DiscoveryScoreboardResponse.parse(valid).bySource).toEqual([]);
  });

  it('parses a populated bySource breakdown', () => {
    const res = DiscoveryScoreboardResponse.parse({
      ...valid,
      bySource: [
        {
          source: 'auto',
          realizedProfit: '12.5',
          tradeCount: 9,
          wins: 5,
          losses: 4,
          grossProfit: '30',
          grossLoss: '17.5',
        },
      ],
    });
    expect(res.bySource).toHaveLength(1);
    expect(res.bySource[0]?.grossProfit).toBe('30');
  });

  it('rejects a malformed money field in a bySource slice', () => {
    expect(
      DiscoveryScoreboardResponse.safeParse({
        ...valid,
        bySource: [
          {
            source: 'auto',
            realizedProfit: 'lots',
            tradeCount: 1,
            wins: 1,
            losses: 0,
            grossProfit: '1',
            grossLoss: '0',
          },
        ],
      }).success,
    ).toBe(false);
  });

  it('rejects a win rate outside the 0..1 range', () => {
    expect(DiscoveryScoreboardResponse.safeParse({ ...valid, winRate: 1.5 }).success).toBe(false);
  });

  it('rejects a malformed money field', () => {
    expect(
      DiscoveryScoreboardResponse.safeParse({ ...valid, realizedProfit: 'lots' }).success,
    ).toBe(false);
  });
});
