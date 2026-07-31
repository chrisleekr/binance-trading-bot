import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import { HAS_INFRA, setupApp, type ApiFixture } from '../_helpers.js';

/**
 * Integration coverage for the account-settings router: a fresh account reads
 * the 'UTC' default, a PATCH persists a valid IANA zone that a later GET
 * reflects, an invalid zone is rejected (422), and the read requires a session.
 */
const describeIfInfra = HAS_INFRA ? describe : describe.skip;

const headers = (userId: string): Record<string, string> => ({
  'x-test-user-id': userId,
  'content-type': 'application/json',
});

describeIfInfra('account-settings router', () => {
  let fx: ApiFixture;

  beforeAll(async () => {
    fx = await setupApp();
  });
  afterAll(async () => {
    await fx.cleanup();
  });

  it('GET returns the UTC default for a fresh account', async () => {
    const res = await fx.app.request('/api/account/settings', {
      headers: headers(fx.alice.userId),
    });
    expect(res.status).toBe(200);
    const body = (await res.json()) as { timezone: string };
    expect(body.timezone).toBe('UTC');
  });

  it('PATCH persists a valid zone and a subsequent GET reflects it', async () => {
    const patch = await fx.app.request('/api/account/settings', {
      method: 'PATCH',
      headers: headers(fx.alice.userId),
      body: JSON.stringify({ timezone: 'Australia/Sydney' }),
    });
    expect(patch.status).toBe(200);
    expect(((await patch.json()) as { timezone: string }).timezone).toBe('Australia/Sydney');

    const after = await fx.app.request('/api/account/settings', {
      headers: headers(fx.alice.userId),
    });
    expect(((await after.json()) as { timezone: string }).timezone).toBe('Australia/Sydney');
  });

  it('PATCH rejects an invalid IANA zone with 422', async () => {
    const res = await fx.app.request('/api/account/settings', {
      method: 'PATCH',
      headers: headers(fx.bob.userId),
      body: JSON.stringify({ timezone: 'Mars/Olympus_Mons' }),
    });
    expect(res.status).toBe(422);
  });

  it('PATCH rejects an empty zone with 422', async () => {
    const res = await fx.app.request('/api/account/settings', {
      method: 'PATCH',
      headers: headers(fx.bob.userId),
      body: JSON.stringify({ timezone: '' }),
    });
    expect(res.status).toBe(422);
  });

  it('is account-scoped: each user reads their own setting', async () => {
    await fx.app.request('/api/account/settings', {
      method: 'PATCH',
      headers: headers(fx.bob.userId),
      body: JSON.stringify({ timezone: 'Asia/Seoul' }),
    });
    const aliceRes = await fx.app.request('/api/account/settings', {
      headers: headers(fx.alice.userId),
    });
    const bobRes = await fx.app.request('/api/account/settings', {
      headers: headers(fx.bob.userId),
    });
    expect(((await aliceRes.json()) as { timezone: string }).timezone).toBe('Australia/Sydney');
    expect(((await bobRes.json()) as { timezone: string }).timezone).toBe('Asia/Seoul');
  });

  it('requires a session', async () => {
    const res = await fx.app.request('/api/account/settings');
    expect(res.status).toBe(401);
  });
});
