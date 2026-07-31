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
});
