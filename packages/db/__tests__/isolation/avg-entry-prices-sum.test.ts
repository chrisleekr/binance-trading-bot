import { randomUUID } from 'node:crypto';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { asAccountId, asProfileId } from '@app/contracts';
import { profileRepo } from '../../src/repo/index.js';
import { sumDeployedQuoteForAccount } from '../../src/repo/avg-entry-prices.js';
import * as schema from '../../src/schema/index.js';
import { setupFixture, TEST_DB_URL, type IsolationFixture } from './_helpers.js';

/**
 * `sumDeployedQuoteForAccount` is the one cross-profile read percent-of-account
 * entry sizing (#497) and the account-wide exposure cap (#392) need:
 * Σ(avg_entry_price × quantity) over one account's profiles that share a quote
 * asset. An account is one Binance environment, so `account_id` already fixes
 * the environment (no mode filter). This suite proves it (a) aggregates across
 * profiles of the same account + quote asset, (b) excludes other accounts via
 * the `profiles` join, (c) excludes a different account owned by the same
 * operator (a live account's positions must not count toward a test account's
 * sum), (d) excludes a different `quote_asset` (a USDT sum must not fold in a
 * BTC-quoted cost basis), and (e) returns '0' when nothing matches.
 *
 * Skipped when `TEST_DB_URL` is unset so `bun run test` works without a
 * Postgres available.
 */
const describeIfDb = TEST_DB_URL ? describe : describe.skip;

describeIfDb('sumDeployedQuoteForAccount (deployed total, scoped by account + quote)', () => {
  let fx: IsolationFixture;
  // A second USDT profile under Alice's (test) account so the sum must aggregate
  // across profiles of the same account.
  const aliceProfile2 = randomUUID();
  // A second account under Alice, in the live environment, holding a USDT
  // profile — positions here must NOT bleed into her test account's sum.
  const aliceLiveAccount = randomUUID();
  const aliceLive = randomUUID();
  // A BTC-quoted profile under Alice's (test) account — same account, different
  // quote unit: its BTC cost basis must NOT be summed into the USDT total.
  const aliceBtc = randomUUID();

  beforeAll(async () => {
    fx = await setupFixture();
    // Alice's second (live) account, owned by the same operator.
    await fx.db.insert(schema.accounts).values({
      id: aliceLiveAccount,
      ownerId: fx.alice.userId as unknown as string,
      name: 'demo-live',
      binanceMode: 'live',
    });
    // setupFixture seeds Alice's profile 1 as USDT under her test account
    // (quote_asset defaults to USDT). The extra profiles below pin quote
    // explicitly and hang off the right account.
    await fx.db.insert(schema.profiles).values([
      {
        id: aliceProfile2,
        accountId: fx.alice.accountId as unknown as string,
        name: 'demo-2',
        strategyName: 'trailing-trade',
        strategyVersion: '2.0.0',
        config: {},
        state: {},
        quoteAsset: 'USDT',
      },
      {
        id: aliceLive,
        accountId: aliceLiveAccount,
        name: 'demo-live',
        strategyName: 'trailing-trade',
        strategyVersion: '2.0.0',
        config: {},
        state: {},
        quoteAsset: 'USDT',
      },
      {
        id: aliceBtc,
        accountId: fx.alice.accountId as unknown as string,
        name: 'demo-btc',
        strategyName: 'trailing-trade',
        strategyVersion: '2.0.0',
        config: {},
        state: {},
        quoteAsset: 'BTC',
      },
    ]);

    const aliceP1 = await profileRepo(
      fx.db,
      fx.alice.userId,
      fx.alice.accountId,
      fx.alice.profileId,
    );
    const aliceP2 = await profileRepo(
      fx.db,
      fx.alice.userId,
      fx.alice.accountId,
      asProfileId(aliceProfile2),
    );
    const aliceLiveP = await profileRepo(
      fx.db,
      fx.alice.userId,
      asAccountId(aliceLiveAccount),
      asProfileId(aliceLive),
    );
    const aliceBtcP = await profileRepo(
      fx.db,
      fx.alice.userId,
      fx.alice.accountId,
      asProfileId(aliceBtc),
    );
    const bobP1 = await profileRepo(fx.db, fx.bob.userId, fx.bob.accountId, fx.bob.profileId);

    // Alice test/USDT: profile 1 = 60000 × 0.001 = 60; profile 2 = 3000 × 0.5
    // = 1500 → 1560.
    await aliceP1.avgEntryPrices.upsert('BTCUSDT', { avgEntryPrice: '60000', quantity: '0.001' });
    await aliceP2.avgEntryPrices.upsert('ETHUSDT', { avgEntryPrice: '3000', quantity: '0.5' });
    // Alice live/USDT: 100 × 1 = 100 — must NOT count toward the test account sum.
    await aliceLiveP.avgEntryPrices.upsert('SOLUSDT', { avgEntryPrice: '100', quantity: '1' });
    // Alice test/BTC: 0.05 × 2 = 0.1 (BTC unit) — must NOT count toward USDT.
    await aliceBtcP.avgEntryPrices.upsert('ETHBTC', { avgEntryPrice: '0.05', quantity: '2' });
    // Bob test/USDT: 61000 × 0.002 = 122 — must NOT bleed into Alice's total.
    await bobP1.avgEntryPrices.upsert('BTCUSDT', { avgEntryPrice: '61000', quantity: '0.002' });
  });

  afterAll(async () => {
    if (fx) await fx.cleanup();
  });

  it('sums avg×qty across same-account profiles of the same quote', async () => {
    const total = await sumDeployedQuoteForAccount(fx.db, fx.alice.accountId, 'USDT');
    // numeric(38,18) products keep full scale; compare numerically.
    expect(Number(total)).toBe(1560);
  });

  it('excludes a different account owned by the same operator (live not counted in the test sum)', async () => {
    const live = await sumDeployedQuoteForAccount(fx.db, asAccountId(aliceLiveAccount), 'USDT');
    // Only the live account's USDT profile (100); the test account is excluded.
    expect(Number(live)).toBe(100);
  });

  it('excludes a different quote_asset (BTC cost basis not folded into USDT)', async () => {
    const btc = await sumDeployedQuoteForAccount(fx.db, fx.alice.accountId, 'BTC');
    // Only the test/BTC profile (0.1 BTC); the USDT positions are excluded.
    expect(Number(btc)).toBe(0.1);
  });

  it('excludes other accounts via the profiles join', async () => {
    const total = await sumDeployedQuoteForAccount(fx.db, fx.bob.accountId, 'USDT');
    expect(Number(total)).toBe(122);
  });

  it("returns '0' for an account that holds no matching positions", async () => {
    const stranger = asAccountId(randomUUID());
    const total = await sumDeployedQuoteForAccount(fx.db, stranger, 'USDT');
    expect(total).toBe('0');
  });
});
