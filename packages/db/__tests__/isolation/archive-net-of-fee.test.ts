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
      orders: [{ side: 'BUY' as const }, { side: 'SELL' as const }],
      feesQuote: o.feesQuote,
      feeBasis: 'exact' as const,
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
    const rows = await ap.tradeArchive.sumProfitInRangeBySource('USDT', FROM, TO);
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
    expect(auto?.feeBasis).toBe('exact');

    // manual: a single net loss.
    expect(Number(manual?.netProfit)).toBe(-6);
    expect(manual?.wins).toBe(0);
    expect(manual?.losses).toBe(1);
  });

  it('exposes net totals on the whole-period sum', async () => {
    const out = await ap.tradeArchive.sumProfitInRange('USDT', FROM, TO);
    expect(Number(out.totalProfit)).toBe(6); // 10 + 1 − 5
    expect(Number(out.totalFees)).toBe(6); // 2 + 3 + 1
    expect(Number(out.netProfit)).toBe(0); // 6 − 6
    expect(out.tradeCount).toBe(3);
    expect(out.feeBasis).toBe('exact');
  });

  it('counts a net win for the auto source on the for-source sum', async () => {
    const out = await ap.tradeArchive.sumProfitInRangeForSource('USDT', FROM, TO, 'auto');
    expect(out.wins).toBe(1); // only the +10/−2-fee row is a net win
    expect(Number(out.netProfit)).toBe(6);
    expect(Number(out.totalFees)).toBe(5);
    expect(out.feeBasis).toBe('exact');
  });

  it('marks a numeric subtotal incomplete when any row is incomplete', async () => {
    const from = new Date('2029-01-01T00:00:00Z');
    const to = new Date('2029-01-02T00:00:00Z');
    await ap.tradeArchive.insert({
      symbol: 'LEGACYUSDT',
      baseAsset: 'LEGACY',
      quoteAsset: 'USDT',
      totalBuyQuote: '10',
      totalSellQuote: '11',
      breakdown: {},
      profit: '1',
      orders: [],
      fees: { BNB: '0.01' },
      feesQuote: '0',
      archivedAt: new Date('2029-01-01T12:00:00Z'),
    });
    const out = await ap.tradeArchive.sumProfitInRange('USDT', from, to);
    expect(Number(out.netProfit)).toBe(1);
    expect(out.feeBasis).toBe('unknown');
  });

  it('reports the weakest fee tier present across a mixed window', async () => {
    // The SQL fold, the counterpart of the TS one in @app/contracts. A window is only as trustworthy as its worst row, and a rank MAXIMUM reads a window holding one estimated cycle as fully proven — which is the reading that puts an unmarked profit factor in front of the operator.
    const from = new Date('2031-01-01T00:00:00Z');
    const to = new Date('2031-01-02T00:00:00Z');
    const at = new Date('2031-01-01T12:00:00Z');
    const mixed = (symbol: string, feeBasis: string) => ({
      symbol,
      baseAsset: symbol.replace('USDT', ''),
      quoteAsset: 'USDT',
      totalBuyQuote: '100',
      totalSellQuote: '110',
      breakdown: {},
      profit: '10',
      orders: [{ side: 'BUY' as const }, { side: 'SELL' as const }],
      feesQuote: '1',
      feeBasis,
      archivedAt: at,
    });
    await ap.tradeArchive.insert(
      mixed('MIXAUSDT', 'exact') as Parameters<typeof ap.tradeArchive.insert>[0],
    );
    await ap.tradeArchive.insert(
      mixed('MIXBUSDT', 'estimated') as Parameters<typeof ap.tradeArchive.insert>[0],
    );

    const out = await ap.tradeArchive.sumProfitInRange('USDT', from, to);
    expect(out.tradeCount).toBe(2);
    expect(out.feeBasis).toBe('estimated');

    // The same mixed rows through the other two aggregates. All three share one `weakestFeeBasisAgg` constant today, which is a real defence but not a pinned one: the sites are only asserted against all-`exact` fixtures otherwise, and those pass under a rank-MAXIMUM fold exactly as readily as a rank-minimum one. Inlining the shared expression at one site during a later refactor is how the three come to disagree.
    const forSource = await ap.tradeArchive.sumProfitInRangeForSource('USDT', from, to, 'manual');
    expect(forSource.tradeCount).toBe(2);
    expect(forSource.feeBasis).toBe('estimated');

    const bySource = await ap.tradeArchive.sumProfitInRangeBySource('USDT', from, to);
    const manual = bySource.find((r) => r.source === 'manual');
    expect(manual?.tradeCount).toBe(2);
    expect(manual?.feeBasis).toBe('estimated');
  });

  it("reports 'exact' for a window holding no trades at all", async () => {
    // The empty-set arm. There is nothing to distrust, and this is the reading today's `coalesce(bool_and(...), true)` already has — a rank-minimum fold silently changes it to `unknown` and blanks the statistics on every quiet period.
    const out = await ap.tradeArchive.sumProfitInRange(
      'USDT',
      new Date('2032-01-01T00:00:00Z'),
      new Date('2032-01-02T00:00:00Z'),
    );
    expect(out.tradeCount).toBe(0);
    expect(out.feeBasis).toBe('exact');
  });

  it('keeps incompleteness scoped to the requested risk window', async () => {
    await ap.tradeArchive.insert({
      symbol: 'OLDUSDT',
      baseAsset: 'OLD',
      quoteAsset: 'USDT',
      totalBuyQuote: '10',
      totalSellQuote: '11',
      breakdown: {},
      profit: '1',
      orders: [],
      fees: { BNB: '0.01' },
      feesQuote: '0',
      archivedAt: new Date('2028-01-01T12:00:00Z'),
    });
    expect((await ap.tradeArchive.listWithUnvaluedFees(10)).length).toBeGreaterThan(0);

    const currentWindow = await ap.tradeArchive.sumProfitInRange(
      'USDT',
      new Date('2030-01-01T00:00:00Z'),
      new Date('2030-01-02T00:00:00Z'),
    );
    expect(currentWindow.tradeCount).toBe(0);
    expect(currentWindow.feeBasis).toBe('exact');
  });
});
