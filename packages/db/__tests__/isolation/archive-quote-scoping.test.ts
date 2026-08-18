import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import { profileRepo, type ProfileRepo } from '../../src/repo/index.js';
import { getClosedTradesForPeriod } from '../../src/repo/projections/closed-trades.js';
import { setupFixture, TEST_DB_URL, type IsolationFixture } from './_helpers.js';

/**
 * A profile's `quote_asset` can be changed after it has closed cycles, so its archive holds rows denominated in more than one currency. Every realised-P/L aggregate must therefore count in ONE named quote: an unfiltered sum returns a figure in no currency at all, and the equity snapshot went on to add that figure to position legs marked in the new quote.
 *
 * The magnitudes here are deliberately far apart (10 USDT vs 0.5 BTC) so a regression that drops the filter cannot coincidentally satisfy an assertion.
 *
 * Skipped when `DATABASE_TEST_URL` is unset so `bun run test` works without PG.
 */
const describeIfDb = TEST_DB_URL ? describe : describe.skip;

// A window unique to this file so the totals never overlap rows the sibling archive suites seed — the suite stays order-independent.
const FROM = new Date('2029-03-01T00:00:00Z');
const TO = new Date('2029-03-02T00:00:00Z');
const AT = new Date('2029-03-01T00:30:00Z');

describeIfDb('trade-archive aggregates are scoped to one quote asset', () => {
  let fx: IsolationFixture;
  let ap: ProfileRepo;

  beforeAll(async () => {
    fx = await setupFixture();
    ap = await profileRepo(fx.db, fx.alice.userId, fx.alice.accountId, fx.alice.profileId);
    // One cycle per quote, both `auto` so the by-source aggregates see a single group and any leakage shows up as a changed magnitude, not an extra row.
    await ap.tradeArchive.insert({
      symbol: 'ETHUSDT',
      baseAsset: 'ETH',
      quoteAsset: 'USDT',
      totalBuyQuote: '100',
      totalSellQuote: '110',
      breakdown: {},
      profit: '10',
      profitPercent: '10',
      orders: [{ side: 'BUY' as const }, { side: 'SELL' as const }],
      feesQuote: '1',
      source: 'auto',
      archivedAt: AT,
    });
    await ap.tradeArchive.insert({
      symbol: 'ETHBTC',
      baseAsset: 'ETH',
      quoteAsset: 'BTC',
      totalBuyQuote: '5',
      totalSellQuote: '5.5',
      breakdown: {},
      profit: '0.5',
      profitPercent: '10',
      orders: [{ side: 'BUY' as const }, { side: 'SELL' as const }],
      feesQuote: '0.01',
      source: 'auto',
      archivedAt: AT,
    });
  });

  afterAll(async () => {
    if (fx) await fx.cleanup();
  });

  it('sumProfitInRange counts only the requested quote and tags the result with it', async () => {
    const usdt = await ap.tradeArchive.sumProfitInRange('USDT', FROM, TO);
    expect(usdt.quoteAsset).toBe('USDT');
    expect(usdt.tradeCount).toBe(1);
    expect(Number(usdt.totalProfit)).toBe(10);
    expect(Number(usdt.totalFees)).toBe(1);
    expect(Number(usdt.netProfit)).toBe(9);

    const btc = await ap.tradeArchive.sumProfitInRange('BTC', FROM, TO);
    expect(btc.quoteAsset).toBe('BTC');
    expect(btc.tradeCount).toBe(1);
    expect(Number(btc.totalProfit)).toBe(0.5);
    expect(Number(btc.totalFees)).toBe(0.01);
    expect(Number(btc.netProfit)).toBe(0.49);
  });

  it('a quote the profile never traded sums to zero rather than to the other quote', async () => {
    const out = await ap.tradeArchive.sumProfitInRange('EUR', FROM, TO);
    expect(out.quoteAsset).toBe('EUR');
    expect(out.tradeCount).toBe(0);
    expect(out.totalProfit).toBe('0');
    expect(out.totalProfitPercent).toBe('0');
  });

  it('matches a lower/mixed-case stored quote against the archive’s exchangeInfo casing', async () => {
    // `profiles.quote_asset` is allowed to be stored lower or mixed case (the base-asset exclusivity suite pins that on purpose), while the archive column always carries Binance's upper casing. A raw compare would match nothing and report a clean zero — and on the daily-loss breaker a silent zero is a risk control failing open, not a cosmetic bug.
    // All three aggregates in the one loop: they hold the fold through three separate `canonicalQuote` calls, and a future edit that drops it from one leaves the other two green.
    for (const stored of ['usdt', 'Usdt', 'USDT']) {
      const out = await ap.tradeArchive.sumProfitInRange(stored, FROM, TO);
      expect(out.tradeCount).toBe(1);
      expect(Number(out.totalProfit)).toBe(10);
      // The echo is canonical, so a consumer bucketing by it cannot end up with two keys for one currency.
      expect(out.quoteAsset).toBe('USDT');

      const forSource = await ap.tradeArchive.sumProfitInRangeForSource(stored, FROM, TO, 'auto');
      expect(forSource.tradeCount).toBe(1);
      expect(Number(forSource.totalProfit)).toBe(10);
      expect(forSource.quoteAsset).toBe('USDT');

      const bySource = await ap.tradeArchive.sumProfitInRangeBySource(stored, FROM, TO);
      expect(bySource.map((r) => r.source)).toEqual(['auto']);
      expect(bySource[0]?.quoteAsset).toBe('USDT');
      expect(Number(bySource[0]?.totalProfit)).toBe(10);
    }
  });

  it('sumProfitInRangeForSource narrows by quote as well as by source', async () => {
    const usdt = await ap.tradeArchive.sumProfitInRangeForSource('USDT', FROM, TO, 'auto');
    expect(usdt.quoteAsset).toBe('USDT');
    expect(usdt.tradeCount).toBe(1);
    expect(Number(usdt.totalProfit)).toBe(10);
    expect(usdt.wins).toBe(1);

    const btc = await ap.tradeArchive.sumProfitInRangeForSource('BTC', FROM, TO, 'auto');
    expect(btc.quoteAsset).toBe('BTC');
    expect(btc.tradeCount).toBe(1);
    expect(Number(btc.totalProfit)).toBe(0.5);
  });

  it('sumProfitInRangeBySource groups by source within the one requested quote', async () => {
    const usdt = await ap.tradeArchive.sumProfitInRangeBySource('USDT', FROM, TO);
    expect(usdt.map((r) => r.source)).toEqual(['auto']);
    expect(usdt[0]?.quoteAsset).toBe('USDT');
    expect(usdt[0]?.tradeCount).toBe(1);
    expect(Number(usdt[0]?.totalProfit)).toBe(10);

    const btc = await ap.tradeArchive.sumProfitInRangeBySource('BTC', FROM, TO);
    expect(btc.map((r) => r.source)).toEqual(['auto']);
    expect(btc[0]?.quoteAsset).toBe('BTC');
    expect(Number(btc[0]?.totalProfit)).toBe(0.5);
  });

  it('the closed-trades projection counts in the quote it is asked for', async () => {
    const btc = await getClosedTradesForPeriod(ap.scope, {
      period: 'd',
      tz: 'UTC',
      from: FROM,
      to: TO,
      quoteAsset: 'BTC',
    });
    expect(btc.tradeCount).toBe(1);
    expect(Number(btc.totalProfit)).toBe(0.5);
    // Percent stays intra-quote: 0.5 profit over a 5 BTC cost basis.
    expect(Number(btc.totalProfitPercent)).toBeCloseTo(10, 5);
  });
});
