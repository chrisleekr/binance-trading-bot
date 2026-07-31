import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { profileRepo, type ProfileRepo } from '../../src/repo/index.js';
import type { LedgerEntry } from '../../src/repo/result-ledger.js';
import { setupFixture, TEST_DB_URL, type IsolationFixture } from './_helpers.js';

const describeIfDb = TEST_DB_URL ? describe : describe.skip;

const WINDOW = { fromMs: 0, toMs: 1_000, interval: '1h' };

const entry = (over: Partial<LedgerEntry> = {}): LedgerEntry => ({
  backtestSignature: 'sig-aaaa',
  configFingerprint: 'cfg-aaaa',
  strategyId: 'trailing-trade',
  symbols: ['BTCUSDT'],
  window: WINDOW,
  params: { buy: { amount: '20' } },
  outcome: { totalReturnPct: -11.89, totalTrades: 4, gatePassed: false },
  ...over,
});

const RUN_PARAMS = {
  symbols: ['BTCUSDT'],
  fromMs: 0,
  toMs: 1_000,
  strategyInterval: '1h',
  detailInterval: '5m',
  initialQuoteBalance: '1000',
  fees: { makerBps: 10, takerBps: 10 },
  slippageBps: 5,
};

describeIfDb('backtest_result_ledger account-scoped durable memory', () => {
  let fx: IsolationFixture;
  let alice: ProfileRepo;
  let bob: ProfileRepo;

  beforeAll(async () => {
    fx = await setupFixture();
    alice = await profileRepo(fx.db, fx.alice.userId, fx.alice.accountId, fx.alice.profileId);
    bob = await profileRepo(fx.db, fx.bob.userId, fx.bob.accountId, fx.bob.profileId);
  });

  afterAll(async () => {
    await fx.cleanup();
  });

  it('upsert then listForMarket reads the outcome back', async () => {
    await alice.resultLedger.upsert(entry({ backtestSignature: 'sig-get' }));
    const rows = await alice.resultLedger.listForMarket({
      symbols: ['BTCUSDT'],
      window: WINDOW,
      strategyId: 'trailing-trade',
    });
    const got = rows.find((r) => r.backtestSignature === 'sig-get');
    expect(got?.outcome).toEqual({ totalReturnPct: -11.89, totalTrades: 4, gatePassed: false });
  });

  it('upsert on the same signature refreshes the outcome instead of duplicating', async () => {
    await alice.resultLedger.upsert(entry({ backtestSignature: 'sig-up', outcome: { v: 1 } }));
    await alice.resultLedger.upsert(entry({ backtestSignature: 'sig-up', outcome: { v: 2 } }));
    const market = await alice.resultLedger.listForMarket({
      symbols: ['BTCUSDT'],
      window: WINDOW,
      strategyId: 'trailing-trade',
    });
    const sigUp = market.filter((r) => r.backtestSignature === 'sig-up');
    expect(sigUp).toHaveLength(1);
    expect(sigUp[0]?.outcome).toEqual({ v: 2 });
  });

  it('listForMarket matches symbols order-independently and is window-exact', async () => {
    await alice.resultLedger.upsert(
      entry({ backtestSignature: 'sig-mkt', symbols: ['ETHUSDT', 'BTCUSDT'] }),
    );
    const hit = await alice.resultLedger.listForMarket({
      symbols: ['BTCUSDT', 'ETHUSDT'],
      window: WINDOW,
      strategyId: 'trailing-trade',
    });
    expect(hit.some((r) => r.backtestSignature === 'sig-mkt')).toBe(true);
    // A different window must not match.
    const miss = await alice.resultLedger.listForMarket({
      symbols: ['BTCUSDT', 'ETHUSDT'],
      window: { fromMs: 0, toMs: 2_000, interval: '1h' },
      strategyId: 'trailing-trade',
    });
    expect(miss.some((r) => r.backtestSignature === 'sig-mkt')).toBe(false);
  });

  it("alice's ledger entry is invisible to bob's scope", async () => {
    await alice.resultLedger.upsert(entry({ backtestSignature: 'sig-iso' }));
    const bobRows = await bob.resultLedger.listForMarket({
      symbols: ['BTCUSDT'],
      window: WINDOW,
      strategyId: 'trailing-trade',
    });
    expect(bobRows.some((r) => r.backtestSignature === 'sig-iso')).toBe(false);
  });

  // The core requirement: clearing run history must not erase learned outcomes.
  // Deleting the run it came from must leave the ledger row standing so a re-run
  // still avoids the proven loser (no FK to runs).
  it('survives deletion of the run it came from', async () => {
    const run = await alice.backtestRuns.create({ symbols: ['BTCUSDT'], params: RUN_PARAMS });
    await alice.backtestRuns.markRunning(run.id);
    await alice.backtestRuns.complete(run.id, { metrics: {} });
    await alice.resultLedger.upsert(entry({ backtestSignature: 'sig-survive' }));

    expect(await alice.backtestRuns.deleteById(run.id)).toBe(true);
    // The run is gone...
    expect(await alice.backtestRuns.get(run.id)).toBeNull();
    // ...but the ledger memory persists (no FK to runs).
    const survivors = await alice.resultLedger.listForMarket({
      symbols: ['BTCUSDT'],
      window: WINDOW,
      strategyId: 'trailing-trade',
    });
    expect(survivors.some((r) => r.backtestSignature === 'sig-survive')).toBe(true);
  });
});
