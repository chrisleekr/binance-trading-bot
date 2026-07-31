// DELETE /accounts/:accountId — the most destructive route in the app. It
// cascades away every profile under the account, and with them the local record
// of orders that are still resting on Binance. It must therefore carry the same
// guarantees the profile delete already has: refuse while real money is committed —
// with no force escape hatch, because the cascade cannot cancel anything on Binance —
// wipe each cascaded profile's Redis, and tell the worker to tear down its streams.

import { describe, expect, it, vi } from 'vitest';
import { profilePrefix } from '@app/db';
import { asAccountId, asProfileId } from '@app/contracts';
import type { OpenAPIHono } from '@hono/zod-openapi';
import { HAS_INFRA, setupApp, type ApiFixture } from '../_helpers.js';

const describeIfInfra = HAS_INFRA ? describe : describe.skip;

const headers = (userId: string): Record<string, string> => ({
  'x-test-user-id': userId,
  'content-type': 'application/json',
});

// A second profile under the same account, so the cascade fan-out is tested on
// more than one row (a loop that only ever handles the first profile passes a
// single-profile fixture).
const SECOND_PROFILE = asProfileId('00000000-0000-4000-8000-00000000a102');

const seedSecondProfile = async (fx: ApiFixture): Promise<void> => {
  await fx.di.pool.query(
    `insert into profiles (id, account_id, name, strategy_name, strategy_version, config, state)
     values ($1, $2, 'second', 'trailing-trade',
             (select strategy_version from profiles where id = $3), '{}', '{}')`,
    [SECOND_PROFILE, fx.alice.accountId, fx.alice.profileId],
  );
};

describeIfInfra('accounts router — delete guard', () => {
  it('returns 409 with open order and position counts when deleting an account without force', async () => {
    const fx = await setupApp();
    try {
      await seedSecondProfile(fx);
      // Exposure sits on the SECOND profile: an account-wide count must see it,
      // a count that only looks at one profile would not.
      await fx.di.pool.query(
        `insert into orders
           (account_id, profile_id, symbol, side, intent, binance_order_id, client_order_id, status, raw)
         values ($1, $2, 'BTCUSDT', 'BUY', 'manual', 9100001, 'acct-del-guard-b', 'NEW', '{}')`,
        [fx.alice.accountId, SECOND_PROFILE],
      );
      await fx.di.pool.query(
        `insert into avg_entry_prices (profile_id, symbol, avg_entry_price, quantity, updated_at)
         values ($1, 'ETHUSDT', '100', '1', now())`,
        [fx.alice.profileId],
      );

      const res = await fx.app.request(`/api/accounts/${fx.alice.accountId}`, {
        method: 'DELETE',
        headers: headers(fx.alice.userId),
      });
      expect(res.status).toBe(409);
      const body = (await res.json()) as {
        error: { details: { openOrderCount: number; openPositionCount: number } };
      };
      expect(body.error.details).toEqual({ openOrderCount: 1, openPositionCount: 1 });

      // The account survives the rejected delete.
      const get = await fx.app.request(`/api/accounts/${fx.alice.accountId}`, {
        headers: headers(fx.alice.userId),
      });
      expect(get.status).toBe(200);
    } finally {
      await fx.cleanup();
    }
    // Explicit timeout: each case stands up its own fixture (truncate + seed
    // against real Postgres/Redis), which outruns vitest's 5s default under load.
  }, 30_000);

  it('declares the 409 response in the OpenAPI document', async () => {
    const fx = await setupApp();
    try {
      const doc = (fx.app as unknown as OpenAPIHono).getOpenAPIDocument({
        openapi: '3.0.0',
        info: { title: 'app', version: '1.0.0' },
      }) as unknown as {
        paths?: Record<string, Record<string, { responses?: Record<string, unknown> }>>;
      };
      const del = doc.paths?.['/api/accounts/{accountId}']?.['delete'];
      expect(del).toBeDefined();
      // An undeclared 409 is invisible to every generated client, so the UI
      // cannot know the conflict envelope exists.
      expect(Object.keys(del?.responses ?? {})).toContain('409');
    } finally {
      await fx.cleanup();
    }
    // Explicit timeout: each case stands up its own fixture (truncate + seed
    // against real Postgres/Redis), which outruns vitest's 5s default under load.
  }, 30_000);

  it('wipes Redis and enqueues unsubscribe-profile for every cascaded profile', async () => {
    const fx = await setupApp();
    const redis = fx.di.redis.raw();
    try {
      await seedSecondProfile(fx);
      const accountId = asAccountId(fx.alice.accountId);
      const keyA = `${profilePrefix({ accountId, profileId: asProfileId(fx.alice.profileId) })}state:BTCUSDT`;
      const keyB = `${profilePrefix({ accountId, profileId: SECOND_PROFILE })}state:BTCUSDT`;
      await redis.set(keyA, '1');
      await redis.set(keyB, '1');

      const addSpy = vi.spyOn(fx.di.queue, 'add');
      const res = await fx.app.request(`/api/accounts/${fx.alice.accountId}`, {
        method: 'DELETE',
        headers: headers(fx.alice.userId),
      });
      expect(res.status).toBe(204);

      // Stale per-profile Redis state outlives the DB rows unless it is wiped;
      // a re-created profile would then boot on another profile's cached state.
      expect(await redis.exists(keyA, keyB)).toBe(0);

      for (const profileId of [fx.alice.profileId, SECOND_PROFILE]) {
        expect(addSpy).toHaveBeenCalledWith(
          'unsubscribe-profile',
          { userId: fx.alice.userId, accountId: fx.alice.accountId, profileId },
          expect.objectContaining({ jobId: `unsubscribe:${profileId}` }),
        );
      }
      addSpy.mockRestore();
    } finally {
      await redis.quit();
      await fx.cleanup();
    }
  }, 30_000);

  // INTENTIONAL BEHAVIOUR CHANGE, and the cascade half of the same bug: `force`
  // used to cascade every child profile away while their orders stayed live on
  // Binance. The account delete no longer has an escape hatch — dispose of each
  // profile first (which cancels or hands off its orders against the exchange).
  it('force=true no longer abandons child-profile exposure: still 409, account survives', async () => {
    const fx = await setupApp();
    try {
      await fx.di.pool.query(
        `insert into orders
           (account_id, profile_id, symbol, side, intent, binance_order_id, client_order_id, status, raw)
         values ($1, $2, 'BTCUSDT', 'BUY', 'manual', 9100002, 'acct-del-force-b', 'NEW', '{}')`,
        [fx.alice.accountId, fx.alice.profileId],
      );

      const res = await fx.app.request(`/api/accounts/${fx.alice.accountId}?force=true`, {
        method: 'DELETE',
        headers: headers(fx.alice.userId),
      });
      expect(res.status).toBe(409);

      const get = await fx.app.request(`/api/accounts/${fx.alice.accountId}`, {
        headers: headers(fx.alice.userId),
      });
      expect(get.status).toBe(200);
    } finally {
      await fx.cleanup();
    }
    // Explicit timeout: each case stands up its own fixture (truncate + seed
    // against real Postgres/Redis), which outruns vitest's 5s default under load.
  }, 30_000);
});
