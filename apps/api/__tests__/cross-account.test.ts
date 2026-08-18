import { profileRepo } from '@app/db';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { HAS_INFRA, setupApp, type ApiFixture } from './_helpers.js';

const describeIfInfra = HAS_INFRA ? describe : describe.skip;

describeIfInfra('cross-account HTTP penetration tests', () => {
  let fx: ApiFixture;
  beforeAll(async () => {
    fx = await setupApp();
  });
  afterAll(async () => {
    await fx.cleanup();
  });

  // Account-scoped routes are mounted under `/accounts/:accountId`. Two ways to
  // breach isolation, both must 404 (never 200/401/403):
  //  1. Bob names Alice's accountId  -> scopeAccount fails (bob != owner).
  //  2. Bob names his OWN accountId but Alice's profileId -> scopeProfile's
  //     account+profile join fails (the profile does not live under bob's
  //     account). This is the 4-arg ownership gate.
  const underAlice = (rest: string): string => `/api/accounts/${fx.alice.accountId}${rest}`;
  const bobsAccountAliceProfile = (rest: string): string =>
    `/api/accounts/${fx.bob.accountId}${rest}`;

  const cases: { name: string; method: string; path: () => string; body?: unknown }[] = [
    {
      name: 'GET profile',
      method: 'GET',
      path: () => underAlice(`/profiles/${fx.alice.profileId}`),
    },
    {
      name: 'PATCH profile',
      method: 'PATCH',
      path: () => underAlice(`/profiles/${fx.alice.profileId}`),
      body: { name: 'evil' },
    },
    {
      name: 'DELETE profile',
      method: 'DELETE',
      path: () => underAlice(`/profiles/${fx.alice.profileId}`),
    },
    {
      name: 'POST start',
      method: 'POST',
      path: () => underAlice(`/profiles/${fx.alice.profileId}/start`),
    },
    // The account delete cascades away every profile, key, order, and ledger row
    // beneath it — the single most destructive route, so the isolation boundary
    // is tested on it explicitly.
    { name: 'DELETE account', method: 'DELETE', path: () => underAlice('') },
    {
      // The profile DISPOSAL: it cancels orders on Binance and deletes the row, so
      // the ownership boundary matters as much here as on the account delete.
      name: 'DELETE profile with a disposition',
      method: 'DELETE',
      path: () => `${underAlice(`/profiles/${fx.alice.profileId}`)}?disposition=cancel-orders`,
    },
    { name: 'GET api-key', method: 'GET', path: () => underAlice(`/api-key`) },
    {
      name: 'PUT api-key',
      method: 'PUT',
      path: () => underAlice(`/api-key`),
      body: { key: 'k', secret: 'sssss', label: 'l' },
    },
    {
      name: 'GET symbols',
      method: 'GET',
      path: () => underAlice(`/profiles/${fx.alice.profileId}/symbols`),
    },
    {
      name: 'POST symbol',
      method: 'POST',
      path: () => underAlice(`/profiles/${fx.alice.profileId}/symbols`),
      body: { symbol: 'BTCUSDT' },
    },
    {
      name: 'GET state',
      method: 'GET',
      path: () => underAlice(`/profiles/${fx.alice.profileId}/symbols/BTCUSDT/state`),
    },
    {
      name: 'GET orders',
      method: 'GET',
      path: () => underAlice(`/profiles/${fx.alice.profileId}/symbols/BTCUSDT/orders`),
    },
    {
      name: 'POST trigger-buy',
      method: 'POST',
      path: () => underAlice(`/profiles/${fx.alice.profileId}/symbols/BTCUSDT/trigger-buy`),
    },
    {
      name: 'GET dashboard',
      method: 'GET',
      path: () => underAlice(`/profiles/${fx.alice.profileId}/dashboard`),
    },
    {
      name: 'GET notify-providers',
      method: 'GET',
      path: () => underAlice(`/profiles/${fx.alice.profileId}/notify-providers`),
    },
    {
      name: 'POST disable-all',
      method: 'POST',
      path: () => underAlice(`/profiles/${fx.alice.profileId}/disable-all`),
    },
    {
      name: 'DELETE disable-all',
      method: 'DELETE',
      path: () => underAlice(`/profiles/${fx.alice.profileId}/disable-all`),
    },
    {
      name: 'GET dust-transfer',
      method: 'GET',
      path: () => underAlice(`/profiles/${fx.alice.profileId}/dust-transfer`),
    },
    {
      name: 'GET dust-transfer history',
      method: 'GET',
      path: () => underAlice(`/profiles/${fx.alice.profileId}/dust-transfer/history`),
    },
    // Hard-deletes rows, so an ownership regression here destroys another
    // operator's queued conversions rather than merely disclosing them.
    {
      name: 'DELETE dust-transfer',
      method: 'DELETE',
      path: () => underAlice(`/profiles/${fx.alice.profileId}/dust-transfer`),
    },
    // The other leg on the one route here that destroys data. A handler that
    // minted its scope from the URL's accountId alone and then took profileId raw
    // would still pass the case above and fail only this one.
    {
      name: 'DELETE dust-transfer via own account, foreign profileId',
      method: 'DELETE',
      path: () => bobsAccountAliceProfile(`/profiles/${fx.alice.profileId}/dust-transfer`),
    },
    // The 4-arg join: bob owns this account, but alice's profile is not in it.
    {
      name: 'GET profile via own account, foreign profileId',
      method: 'GET',
      path: () => bobsAccountAliceProfile(`/profiles/${fx.alice.profileId}`),
    },
    {
      name: 'GET symbols via own account, foreign profileId',
      method: 'GET',
      path: () => bobsAccountAliceProfile(`/profiles/${fx.alice.profileId}/symbols`),
    },
    // The archive reader mints its scope INSIDE a transaction, which is the one
    // place the ownership error has something to travel through: drizzle rolls
    // the transaction back and rethrows. Both legs, because a wrapped error
    // would land as a 500 and neither the account nor the profile leg would say
    // so on its own.
    {
      name: 'GET trade-archive',
      method: 'GET',
      path: () => underAlice(`/profiles/${fx.alice.profileId}/trade-archive`),
    },
    {
      name: 'GET trade-archive via own account, foreign profileId',
      method: 'GET',
      path: () => bobsAccountAliceProfile(`/profiles/${fx.alice.profileId}/trade-archive`),
    },
  ];

  for (const tc of cases) {
    it(`returns 404 for ${tc.name} when bob accesses alice`, async () => {
      const headers = new Headers({
        'x-test-user-id': fx.bob.userId,
        'content-type': 'application/json',
      });
      const init: RequestInit = { method: tc.method, headers };
      if (tc.body) init.body = JSON.stringify(tc.body);
      const res = await fx.app.fetch(new Request(`http://test.local${tc.path()}`, init));
      expect(res.status).toBe(404);
    });
  }

  it("leaves alice's queued conversion in place when bob issues the cancel", async () => {
    // A status code cannot say the rows survived. A handler that ran the delete
    // and proved ownership afterwards would answer 404 on both legs above and
    // have destroyed the conversions this route exists to let their owner
    // cancel — the row is the only witness to the difference.
    const p = await profileRepo(fx.di.db, fx.alice.userId, fx.alice.accountId, fx.alice.profileId);
    const armed = await p.overrideActions.record({
      symbol: null,
      action: 'dust-transfer',
      actionAt: new Date(),
      payload: { assets: ['TRX'] },
      triggeredBy: 'user',
    });
    const pending = async (): Promise<string[]> => {
      const { rows } = await fx.di.pool.query<{ id: string }>(
        `select id from override_actions
          where profile_id = $1 and action = 'dust-transfer' and consumed_at is null`,
        [fx.alice.profileId],
      );
      return rows.map((r) => r.id);
    };
    const cancelAs = async (userId: string, path: string): Promise<number> => {
      const res = await fx.app.fetch(
        new Request(`http://test.local${path}`, {
          method: 'DELETE',
          headers: new Headers({ 'x-test-user-id': userId }),
        }),
      );
      return res.status;
    };
    const alicesRow = `/profiles/${fx.alice.profileId}/dust-transfer`;

    expect(await cancelAs(fx.bob.userId, underAlice(alicesRow))).toBe(404);
    expect(await cancelAs(fx.bob.userId, bobsAccountAliceProfile(alicesRow))).toBe(404);
    expect(await pending()).toEqual([armed.id]);

    // The owner's own cancel, on the same path: without it a route that 404s for
    // everyone — or one mounted at a different path entirely — would satisfy
    // every assertion above, and the 404s would prove nothing about ownership.
    expect(await cancelAs(fx.alice.userId, underAlice(alicesRow))).toBe(204);
    expect(await pending()).toEqual([]);
  });
});
