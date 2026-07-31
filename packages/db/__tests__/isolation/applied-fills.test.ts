import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { profileRepo, type ProfileRepo } from '../../src/repo/index.js';
import { setupFixture, TEST_DB_URL, type IsolationFixture } from './_helpers.js';

/**
 * Account-scoped happy-path matrix for `packages/db/src/repo/applied-fills.ts`.
 * Both functions take a `ProfileScope`, so wrong-owner is unrepresentable —
 * ownership is proven once by `scopeProfile`. Cross-account rejection lives
 * in `cross-account.test.ts`.
 *
 * Skipped when `DATABASE_TEST_URL` is not set so `bun run test` works on
 * workstations without a Postgres available.
 */
const describeIfDb = TEST_DB_URL ? describe : describe.skip;

describeIfDb('applied-fills account-scoped reads and writes', () => {
  let fx: IsolationFixture;
  let ap: ProfileRepo;
  let bp: ProfileRepo;

  beforeAll(async () => {
    fx = await setupFixture();
    ap = await profileRepo(fx.db, fx.alice.userId, fx.alice.accountId, fx.alice.profileId);
    bp = await profileRepo(fx.db, fx.bob.userId, fx.bob.accountId, fx.bob.profileId);
  });

  afterAll(async () => {
    if (fx) await fx.cleanup();
  });

  it('tryRecord returns true on first apply and false on duplicate (same profile)', async () => {
    const first = await ap.appliedFills.tryRecord({
      symbol: 'BTCUSDT',
      orderId: 1001,
      tradeId: 2001,
      side: 'BUY',
    });
    expect(first).toBe(true);

    const replay = await ap.appliedFills.tryRecord({
      symbol: 'BTCUSDT',
      orderId: 1001,
      tradeId: 2001,
      side: 'BUY',
    });
    expect(replay).toBe(false);
  });

  it('tryRecord scopes by profile — same (symbol, orderId, tradeId) lands once per account', async () => {
    // Bob applies the same (symbol, orderId, tradeId) tuple. The dedupe
    // is per-profile, so this is a first-apply, not a replay.
    const bobFirst = await bp.appliedFills.tryRecord({
      symbol: 'BTCUSDT',
      orderId: 1001,
      tradeId: 2001,
      side: 'BUY',
    });
    expect(bobFirst).toBe(true);

    // And Bob replaying the same tuple still dedupes (false), even
    // though Alice's row exists at the table level.
    const bobReplay = await bp.appliedFills.tryRecord({
      symbol: 'BTCUSDT',
      orderId: 1001,
      tradeId: 2001,
      side: 'BUY',
    });
    expect(bobReplay).toBe(false);
  });

  it('maxTradeId returns null for a symbol with no adopted fills', async () => {
    expect(await ap.appliedFills.maxTradeId('NONEUSDT')).toBeNull();
  });

  it('maxTradeId returns the highest adopted trade id, scoped per profile and symbol', async () => {
    // Alice already recorded (BTCUSDT, order 1001, trade 2001) above. Add a
    // higher trade and a different symbol to prove the max is per-symbol.
    await ap.appliedFills.tryRecord({
      symbol: 'BTCUSDT',
      orderId: 1002,
      tradeId: 2050,
      side: 'SELL',
    });
    await ap.appliedFills.tryRecord({
      symbol: 'ETHUSDT',
      orderId: 1003,
      tradeId: 9999,
      side: 'BUY',
    });
    expect(await ap.appliedFills.maxTradeId('BTCUSDT')).toBe(2050);
    // Bob only recorded trade 2001 on BTCUSDT — his max is unaffected by
    // Alice's 2050 (per-profile scope).
    expect(await bp.appliedFills.maxTradeId('BTCUSDT')).toBe(2001);
  });
});
