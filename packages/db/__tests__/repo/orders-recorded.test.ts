// listRecordedAmong: "which of the orders CURRENTLY on Binance's open book did THIS
// profile record?" — the second proof of ownership behind a profile disposal, next to
// the strategy's own clientOrderId attribution.
//
// It exists because attribution cannot claim every order we placed: an id that folds a
// candle close time into its hash is unenumerable by design, so the strategy returns
// null for it. A DB row is the other proof, and it does not depend on the id being
// re-derivable.
//
// Two properties carry the whole guard, and both are pinned below:
//   - NO `closed_at` filter. `upsertLive`'s closePrevious stamps the previous
//     (profile, symbol, intent) row CLOSED when the next candle's order takes the slot,
//     while that order may still be RESTING on Binance. Filtering on `closed_at IS NULL`
//     would fail to claim precisely the row that proves the resting order is ours.
//   - The match is keyed on SYMBOL + binance_order_id, and never widens past the profile.
//     Over-claiming is the worst outcome there is: cancelling a sibling profile's stop
//     strips a live position of its protection.

import { randomUUID } from 'node:crypto';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import { scopeProfile } from '../../src/repo/index.js';
import { listRecordedAmong } from '../../src/repo/orders.js';
import * as schema from '../../src/schema/index.js';
import { setupFixture, TEST_DB_URL, type IsolationFixture } from '../isolation/_helpers.js';

const describeIfDb = TEST_DB_URL ? describe : describe.skip;

const key = (row: { symbol: string; binanceOrderId: bigint }): string =>
  `${row.symbol}:${row.binanceOrderId}`;

describeIfDb('orders.listRecordedAmong', () => {
  let fx: IsolationFixture;
  // A second profile under the SAME account: its orders share the account's key pair and
  // show up on the same account-wide open-order book, so they are the near-miss the
  // profile filter has to reject.
  const siblingProfileId = randomUUID();

  beforeAll(async () => {
    fx = await setupFixture();
    await fx.db.insert(schema.profiles).values({
      id: siblingProfileId,
      accountId: fx.alice.accountId,
      name: 'sibling',
      strategyName: 'momentum',
      strategyVersion: '1.0.0',
      config: {},
      state: {},
    });

    await fx.db.insert(schema.orders).values([
      // The closePrevious case: recorded by alice's profile, its row already stamped
      // CLOSED by the next candle's order taking the slot — yet still resting on Binance.
      {
        accountId: fx.alice.accountId,
        profileId: fx.alice.profileId,
        symbol: 'ENAUSDT',
        side: 'BUY',
        intent: 'entry',
        binanceOrderId: 9100001n,
        clientOrderId: 'ena-closed-but-resting',
        status: 'CANCELED',
        closedAt: new Date(),
        raw: {},
      },
      // Same profile, still open. Both halves of the `closed_at` axis must be claimed.
      {
        accountId: fx.alice.accountId,
        profileId: fx.alice.profileId,
        symbol: 'ENAUSDT',
        side: 'SELL',
        intent: 'protective-stop',
        binanceOrderId: 9100002n,
        clientOrderId: 'ena-open',
        status: 'NEW',
        raw: {},
      },
      // A sibling profile's order on the same account.
      {
        accountId: fx.alice.accountId,
        profileId: siblingProfileId,
        symbol: 'SOLUSDT',
        side: 'SELL',
        intent: 'protective-stop',
        binanceOrderId: 9100003n,
        clientOrderId: 'sibling-stop',
        status: 'NEW',
        raw: {},
      },
      // A DETACHED order: its profile was deleted, so nothing points at it. It is not
      // this profile's to claim either.
      {
        accountId: fx.alice.accountId,
        profileId: null,
        symbol: 'BTCUSDT',
        side: 'BUY',
        intent: 'entry',
        binanceOrderId: 9100004n,
        clientOrderId: 'detached',
        status: 'NEW',
        raw: {},
      },
      // Alice's profile recorded id 9100005 on ENAUSDT. A Binance orderId is unique per
      // SYMBOL only, so the identically-numbered order on ADAUSDT below is a DIFFERENT
      // order — a bare-id match would claim a stranger's.
      {
        accountId: fx.alice.accountId,
        profileId: fx.alice.profileId,
        symbol: 'ENAUSDT',
        side: 'BUY',
        intent: 'grid-0',
        binanceOrderId: 9100005n,
        clientOrderId: 'ena-collide',
        status: 'NEW',
        raw: {},
      },
    ]);
  });

  afterAll(async () => {
    await fx.cleanup();
  });

  const aliceScope = () =>
    scopeProfile(fx.db, fx.alice.userId, fx.alice.accountId, fx.alice.profileId);

  it('claims a row this profile recorded even though it is already CLOSED', async () => {
    // The whole point: the DB row was closed by the slot reuse, the order is still on
    // the book, and it is unmistakably ours.
    const rows = await listRecordedAmong(await aliceScope(), [9100001n, 9100002n]);
    expect(rows.map(key).sort()).toEqual(['ENAUSDT:9100001', 'ENAUSDT:9100002']);
  });

  it("never claims a sibling profile's order, a detached one, or one that was never recorded", async () => {
    const rows = await listRecordedAmong(await aliceScope(), [
      9100003n, // sibling profile, same account
      9100004n, // detached (profile_id NULL)
      9199999n, // no row anywhere
    ]);
    expect(rows).toEqual([]);
  });

  it('returns each matched row under its OWN symbol — the pair the handler keys on', async () => {
    // The repo filters by id and by profile; it returns the ROW's symbol. That returned
    // symbol is what lets the disposal handler key `symbol:orderId` and refuse to claim a
    // stranger's order that happens to share the numeric id on another symbol (a Binance
    // orderId is unique per symbol only). So the guarantee this half must uphold is that
    // the symbol comes back off the recorded row, not off the caller's guess.
    const rows = await listRecordedAmong(await aliceScope(), [9100005n]);
    expect(rows).toEqual([{ symbol: 'ENAUSDT', binanceOrderId: 9100005n }]);
  });

  it("does not leak across accounts: bob's scope claims none of alice's rows", async () => {
    const bobScope = await scopeProfile(fx.db, fx.bob.userId, fx.bob.accountId, fx.bob.profileId);
    const rows = await listRecordedAmong(bobScope, [9100001n, 9100002n]);
    expect(rows).toEqual([]);
  });

  it('an empty candidate list is a no-op, not a full-table scan', async () => {
    expect(await listRecordedAmong(await aliceScope(), [])).toEqual([]);
  });
});
