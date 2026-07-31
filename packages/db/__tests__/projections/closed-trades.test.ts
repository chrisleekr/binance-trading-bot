import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import type { ProfileScope } from '../../src/repo/_scoped.js';
import { profileRepo } from '../../src/repo/index.js';
import { getClosedTradesForPeriod } from '../../src/repo/projections/closed-trades.js';
import { setupFixture, TEST_DB_URL, type IsolationFixture } from '../isolation/_helpers.js';

const describeIfDb = TEST_DB_URL ? describe : describe.skip;

describeIfDb('getClosedTradesForPeriod', () => {
  let fx: IsolationFixture;
  let scope: ProfileScope;

  beforeAll(async () => {
    fx = await setupFixture();
    const ap = await profileRepo(fx.db, fx.alice.userId, fx.alice.accountId, fx.alice.profileId);
    scope = ap.scope;
    await ap.tradeArchive.insert({
      symbol: 'BTCUSDT',
      baseAsset: 'BTC',
      quoteAsset: 'USDT',
      totalBuyQuote: '60000',
      totalSellQuote: '62000',
      breakdown: { 'grid-buy:BUY': '60000', 'grid-sell:SELL': '62000' },
      profit: '2000',
      profitPercent: '3.33',
      orders: [{ side: 'BUY' as const }, { side: 'SELL' as const }],
      archivedAt: new Date('2026-05-11T00:00:00Z'),
    });
  });

  afterAll(async () => {
    if (fx) await fx.cleanup();
  });

  it('sums archive profit inside the window and echoes the period back', async () => {
    const out = await getClosedTradesForPeriod(scope, {
      period: 'm',
      tz: 'UTC',
      from: new Date('2026-05-01T00:00:00Z'),
      to: new Date('2026-05-31T00:00:00Z'),
    });
    expect(out.period).toBe('m');
    expect(out.tz).toBe('UTC');
    expect(Number(out.totalProfit)).toBe(2000);
    expect(out.tradeCount).toBe(1);
  });

  it('excludes trades archived outside the window', async () => {
    const out = await getClosedTradesForPeriod(scope, {
      period: 'd',
      tz: 'UTC',
      from: new Date('2026-05-17T00:00:00Z'),
      to: new Date('2026-05-18T00:00:00Z'),
    });
    expect(out.tradeCount).toBe(0);
    expect(out.totalProfit).toBe('0');
  });

  it('computes totalProfitPercent as profit over the buy-quote cost basis', async () => {
    const out = await getClosedTradesForPeriod(scope, {
      period: 'm',
      tz: 'UTC',
      from: new Date('2026-05-01T00:00:00Z'),
      to: new Date('2026-05-31T00:00:00Z'),
    });
    // profit 2000 / totalBuyQuote 60000 * 100
    expect(Number(out.totalProfitPercent)).toBeCloseTo(3.3333, 3);
  });

  it('guards a zero cost basis — an empty window yields 0 percent, not NaN', async () => {
    const out = await getClosedTradesForPeriod(scope, {
      period: 'd',
      tz: 'UTC',
      from: new Date('2026-05-17T00:00:00Z'),
      to: new Date('2026-05-18T00:00:00Z'),
    });
    expect(out.totalProfitPercent).toBe('0');
  });
});
