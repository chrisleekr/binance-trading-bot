import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import { profileRepo, type ProfileRepo } from '../../src/repo/index.js';
import { setupFixture, TEST_DB_URL, type IsolationFixture } from './_helpers.js';

/**
 * Net-of-fee aggregation for the trade-archive sum functions. `fees_quote` is
 * the cycle's commissions valued in the quote asset; the sums must (a) expose
 * `totalFees`/`netProfit` and (b) classify wins/losses on NET profit, so a row
 * that cleared a gross profit but not its fees counts as a loss.
 *
 * Skipped when `DATABASE_TEST_URL` is unset so `bun run test` works without PG.
 */
const describeIfDb = TEST_DB_URL ? describe : describe.skip;

const FROM = new Date('2026-05-01T00:00:00Z');
const TO = new Date('2026-06-01T00:00:00Z');
const AT = new Date('2026-05-15T00:00:00Z');

describeIfDb('trade-archive net-of-fee aggregation', () => {
  let fx: IsolationFixture;
  let ap: ProfileRepo;

  beforeAll(async () => {
    fx = await setupFixture();
    ap = await profileRepo(fx.db, fx.alice.userId, fx.alice.accountId, fx.alice.profileId);
    const row = (o: {
      symbol: string;
      source: 'auto' | 'manual';
      profit: string;
      feesQuote: string;
    }) => ({
      symbol: o.symbol,
      baseAsset: o.symbol.replace('USDT', ''),
      quoteAsset: 'USDT',
      totalBuyQuote: '100',
      totalSellQuote: '110',
      breakdown: {},
      profit: o.profit,
      profitPercent: '0',
      orders: [{ side: 'BUY' as const }, { side: 'SELL' as const }],
      feesQuote: o.feesQuote,
      source: o.source,
      archivedAt: AT,
    });
    // auto A: gross +10, fees 2 → net +8 (win)
    await ap.tradeArchive.insert(
      row({ symbol: 'AAAUSDT', source: 'auto', profit: '10', feesQuote: '2' }),
    );
    // auto B: gross +1, fees 3 → net −2 (a gross win that is a NET loss)
    await ap.tradeArchive.insert(
      row({ symbol: 'BBBUSDT', source: 'auto', profit: '1', feesQuote: '3' }),
    );
    // manual: gross −5, fees 1 → net −6 (loss)
    await ap.tradeArchive.insert(
      row({ symbol: 'CCCUSDT', source: 'manual', profit: '-5', feesQuote: '1' }),
    );
  });

  afterAll(async () => {
    if (fx) await fx.cleanup();
  });

  it('splits per source with net-classified wins/losses and fee totals', async () => {
    const rows = await ap.tradeArchive.sumProfitInRangeBySource(FROM, TO);
    const auto = rows.find((r) => r.source === 'auto');
    const manual = rows.find((r) => r.source === 'manual');

    // auto: gross 11, fees 5, net 6; the +1/−3 row flips to a loss on net.
    expect(Number(auto?.totalProfit)).toBe(11);
    expect(Number(auto?.totalFees)).toBe(5);
    expect(Number(auto?.netProfit)).toBe(6);
    expect(auto?.wins).toBe(1);
    expect(auto?.losses).toBe(1);
    expect(Number(auto?.grossProfit)).toBe(8);
    expect(Number(auto?.grossLoss)).toBe(2);

    // manual: a single net loss.
    expect(Number(manual?.netProfit)).toBe(-6);
    expect(manual?.wins).toBe(0);
    expect(manual?.losses).toBe(1);
  });

  it('exposes net totals on the whole-period sum', async () => {
    const out = await ap.tradeArchive.sumProfitInRange(FROM, TO);
    expect(Number(out.totalProfit)).toBe(6); // 10 + 1 − 5
    expect(Number(out.totalFees)).toBe(6); // 2 + 3 + 1
    expect(Number(out.netProfit)).toBe(0); // 6 − 6
    expect(out.tradeCount).toBe(3);
  });

  it('counts a net win for the auto source on the for-source sum', async () => {
    const out = await ap.tradeArchive.sumProfitInRangeForSource(FROM, TO, 'auto');
    expect(out.wins).toBe(1); // only the +10/−2-fee row is a net win
    expect(Number(out.netProfit)).toBe(6);
    expect(Number(out.totalFees)).toBe(5);
  });
});
