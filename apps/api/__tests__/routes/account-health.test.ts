import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { profileKey } from '@app/db';
import type { AccountHealthResponse } from '@app/contracts';
import { HAS_INFRA, setupApp, type ApiFixture } from '../_helpers.js';

const describeIfInfra = HAS_INFRA ? describe : describe.skip;

const headers = (userId: string): Record<string, string> => ({ 'x-test-user-id': userId });

describeIfInfra('account-health router', () => {
  let fx: ApiFixture;

  beforeAll(async () => {
    fx = await setupApp();
  });
  afterAll(async () => {
    await fx.cleanup();
  });

  const get = async (): Promise<AccountHealthResponse> => {
    const res = await fx.app.request(`/api/accounts/${fx.alice.accountId}/account/health`, {
      headers: headers(fx.alice.userId),
    });
    expect(res.status).toBe(200);
    return (await res.json()) as AccountHealthResponse;
  };

  it('reports the worker down when no heartbeat is present, and no halts initially', async () => {
    const body = await get();
    // No worker process runs in the api test, so the heartbeat key is absent.
    expect(body.worker.status).toBe('down');
    expect(body.halts).toEqual([]);
    // Today's realized is summed per (quote, mode); the array exists even at zero.
    expect(Array.isArray(body.todayRealized)).toBe(true);
  });

  it('aggregates the per-profile daily-loss halt Redis flag', async () => {
    const raw = fx.di.redis.raw();
    try {
      await raw.set(
        profileKey(
          { accountId: fx.alice.accountId, profileId: fx.alice.profileId },
          'entryHaltDaily',
        ),
        JSON.stringify({ reason: 'daily-loss-limit' }),
      );
    } finally {
      await raw.quit();
    }

    const body = await get();
    const kinds = body.halts
      .filter((h) => h.profileId === fx.alice.profileId)
      .map((h) => h.kind)
      .sort();
    expect(kinds).toEqual(['daily-loss']);
  });
});
