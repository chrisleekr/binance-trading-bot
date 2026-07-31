import { asProfileId, type ProfileId } from '@app/contracts';
import { profileRepo } from '@app/db';
import { Redis } from 'ioredis';
import { afterAll, afterEach, beforeAll, describe, expect, it } from 'vitest';
import { HAS_INFRA, setupApp, type ApiFixture } from '../_helpers.js';

/**
 * Verifies the symbol-override read/cancel endpoints against the three-state
 * override-action lifecycle (`pending` / `processing` / `consumed`):
 * - GET surfaces `processingAt` so the SPA can tell a queued override from one
 *   a worker is mid-side-effect on.
 * - DELETE removes only `pending` rows and evicts the Redis override cache; a
 *   `processing` row belongs to a tick that may already have an order on the wire,
 *   so it (and its cache key) survives and the operator is told 409 rather than
 *   being told the action was cancelled.
 *
 * Uses a locally-seeded profile with a real v4 UUID: the shared fixture's
 * profile ids are sentinel values that fail the route's `z.uuid()` param.
 */
const describeIfInfra = HAS_INFRA ? describe : describe.skip;

describeIfInfra('override route', () => {
  let fx: ApiFixture;
  let redis: Redis;
  const PROFILE_ID: ProfileId = asProfileId('11111111-1111-4111-8111-111111111111');
  const SYMBOL = 'BTCUSDT';

  beforeAll(async () => {
    fx = await setupApp();
    // The app's DI Redis, not a hardcoded default: under TESTCONTAINERS the app
    // talks to a provisioned container, and a client on the default port would
    // never see the DELETE handler's cache eviction.
    redis = new Redis(fx.redisUrl);
    await fx.di.pool.query(
      `insert into profiles (id, account_id, name, strategy_name, strategy_version, config, state)
       values ($1, $2, 'override-test', 'trailing-trade', '1.0.0', '{}', '{}')`,
      [PROFILE_ID, fx.alice.accountId],
    );
  });

  afterAll(async () => {
    await redis.quit();
    await fx.cleanup();
  });

  afterEach(async () => {
    await fx.di.pool.query('delete from override_actions');
    await redis.flushdb();
  });

  const path = (): string =>
    `/api/accounts/${fx.alice.accountId}/profiles/${PROFILE_ID}/symbols/${SYMBOL}/override`;
  const headers = (): Record<string, string> => ({ 'x-test-user-id': fx.alice.userId });
  const cacheKey = (): string =>
    `tenant:${fx.alice.accountId}:profile:${PROFILE_ID}:override:${SYMBOL}`;
  const repo = (): ReturnType<typeof profileRepo> =>
    profileRepo(fx.di.db, fx.alice.userId, fx.alice.accountId, PROFILE_ID);

  const seedPending = async (): Promise<string> => {
    const p = await repo();
    const row = await p.overrideActions.record({
      symbol: SYMBOL,
      action: 'buy',
      actionAt: new Date(),
      payload: { tag: 'seed' },
      triggeredBy: 'test',
    });
    return row.id;
  };

  it('GET returns null when no override exists for the symbol', async () => {
    const res = await fx.app.request(path(), { headers: headers() });
    expect(res.status).toBe(200);
    expect(await res.json()).toBeNull();
  });

  it('GET returns a pending override with processingAt null', async () => {
    const id = await seedPending();
    const res = await fx.app.request(path(), { headers: headers() });
    expect(res.status).toBe(200);
    const body = (await res.json()) as { id: string; processingAt: string | null };
    expect(body.id).toBe(id);
    expect(body.processingAt).toBeNull();
  });

  it('GET surfaces processingAt once a worker has claimed the override', async () => {
    const id = await seedPending();
    const p = await repo();
    expect(await p.overrideActions.claimAction(id, new Date())).toBe(true);

    const res = await fx.app.request(path(), { headers: headers() });
    const body = (await res.json()) as { id: string; processingAt: string | null };
    expect(body.id).toBe(id);
    expect(body.processingAt).not.toBeNull();
  });

  it('GET returns the settled outcome of an override that has already run', async () => {
    // The optimistic 202 said "scheduled". The operator now needs to know it was
    // REFUSED. A read that hides consumed rows can never tell them that.
    const id = await seedPending();
    const p = await repo();
    await p.overrideActions.settle(id, {
      status: 'rejected',
      reason: 'binance logic -2010: insufficient balance',
    });

    const res = await fx.app.request(path(), { headers: headers() });
    expect(res.status).toBe(200);
    const body = (await res.json()) as {
      id: string;
      consumedAt: string | null;
      outcome: { status: string; reason?: string } | null;
    };
    expect(body.id).toBe(id);
    expect(body.consumedAt).not.toBeNull();
    expect(body.outcome?.status).toBe('rejected');
    expect(body.outcome?.reason).toContain('-2010');
  });

  it('GET never leaks the pick-up breadcrumb, even on a row that carries one', async () => {
    // The breadcrumb is worker-internal bookkeeping with exactly one reader: the
    // expiry sweep. Serving it would invite the SPA to render "a tick took this"
    // as progress, which is the opposite of what it means — it is only ever read
    // to explain a row NO tick came back from. Pinned as an exact key set, so a
    // future field cannot ride along unnoticed.
    const id = await seedPending();
    const p = await repo();
    expect(await p.overrideActions.markPickedUp(id)).toBe(true);

    const res = await fx.app.request(path(), { headers: headers() });
    const body = (await res.json()) as Record<string, unknown>;
    expect(body['id']).toBe(id);
    expect(Object.keys(body).sort()).toEqual([
      'action',
      'actionAt',
      'consumedAt',
      'createdAt',
      'id',
      'outcome',
      'payload',
      'processingAt',
      'symbol',
      'triggeredBy',
    ]);
  });

  it("GET never serves the dust flow's `result` payload as an outcome", async () => {
    // `result` is the side-effect payload column and `outcome` is the outcome
    // column. A row carrying a convertDust response and no outcome is still
    // "no outcome" — the two must never be conflated.
    const id = await seedPending();
    await fx.di.pool.query(
      `update override_actions set consumed_at = now(), result = $2 where id = $1`,
      [id, JSON.stringify({ totalTransfered: '0.5' })],
    );

    const res = await fx.app.request(path(), { headers: headers() });
    const body = (await res.json()) as { id: string; outcome: unknown };
    expect(body.id).toBe(id);
    expect(body.outcome).toBeNull();
  });

  it('DELETE removes a pending override and evicts the Redis cache key', async () => {
    await seedPending();
    await redis.set(cacheKey(), '{}');

    const res = await fx.app.request(path(), { method: 'DELETE', headers: headers() });
    expect(res.status).toBe(204);

    const p = await repo();
    expect(await p.overrideActions.findActiveForSymbol(SYMBOL)).toBeNull();
    expect(await redis.exists(cacheKey())).toBe(0);
  });

  it('DELETE answers 409 for a claimed override and leaves it and its cache key intact', async () => {
    // A tick owns this row and may already have an order on the wire. 204 would tell
    // the operator it was cancelled while the trade goes through, and that is the one
    // answer they cannot recover from, because they act on it: they stop watching.
    const id = await seedPending();
    const p = await repo();
    expect(await p.overrideActions.claimAction(id, new Date())).toBe(true);
    await redis.set(cacheKey(), '{}');

    const res = await fx.app.request(path(), { method: 'DELETE', headers: headers() });
    expect(res.status).toBe(409);
    const body = (await res.json()) as { error?: { code?: string; message?: string } };
    expect(body.error?.code).toBe('CONFLICT');
    // Names the action as in flight, so the operator knows to wait for an outcome
    // rather than re-pressing and risking a second order.
    expect(body.error?.message).toMatch(/already acting/i);

    // The worker is mid-side-effect on the claimed row: the DB row and the
    // cache key it still reads must both survive the operator cancel.
    const survivor = await (await repo()).overrideActions.findActiveForSymbol(SYMBOL);
    expect(survivor?.id).toBe(id);
    expect(survivor?.processingAt).not.toBeNull();
    expect(await redis.exists(cacheKey())).toBe(1);
  });

  it('DELETE says what it did when it cancelled a queued override but not an in-flight one', async () => {
    // Two rows for one symbol: an earlier one a tick is acting on, and a queued one the
    // operator pushed after it. The delete removes the queued row and cannot touch the
    // claimed one, so a bare "already acting on this override" would be a half-truth
    // about which of the two was cancelled.
    const claimedId = await seedPending();
    const p = await repo();
    expect(await p.overrideActions.claimAction(claimedId, new Date())).toBe(true);
    const queuedId = await seedPending();

    const res = await fx.app.request(path(), { method: 'DELETE', headers: headers() });
    expect(res.status).toBe(409);
    const body = (await res.json()) as { error?: { code?: string; message?: string } };
    expect(body.error?.code).toBe('CONFLICT');
    expect(body.error?.message).toMatch(/cancelled the queued override/i);

    // The queued row really is gone and the claimed one really did survive.
    const rows = await fx.di.pool.query<{ id: string }>(
      `select id from override_actions where symbol = $1 and consumed_at is null`,
      [SYMBOL],
    );
    expect(rows.rows.map((r) => r.id)).toEqual([claimedId]);
    expect(queuedId).not.toBe(claimedId);
  });

  it('DELETE keeps deferring to a claim inside the stale-claim horizon', async () => {
    // Six minutes is past the override's own 300s Redis TTL but well inside the horizon
    // the stale-claim reaper uses, and a dispatch can genuinely run that long (the weight
    // governor's admission wait is unbounded). Answering 204 here would tell the operator
    // it was cancelled with an order on the wire, which is the bug the 409 exists to close.
    const id = await seedPending();
    await fx.di.pool.query(
      `update override_actions set processing_at = now() - interval '6 minutes' where id = $1`,
      [id],
    );
    await redis.set(cacheKey(), '{}');

    const res = await fx.app.request(path(), { method: 'DELETE', headers: headers() });
    expect(res.status).toBe(409);
    // The worker may still be mid-side-effect, so its key survives too.
    expect(await redis.exists(cacheKey())).toBe(1);
    const survivor = await (await repo()).overrideActions.findActiveForSymbol(SYMBOL);
    expect(survivor?.id).toBe(id);
  });

  it('DELETE stops deferring to a claim past the stale-claim horizon', async () => {
    // A worker that died holding the claim leaves a row no cancel can delete. Eleven
    // minutes is past `OVERRIDE_CLAIM_STALE_MS`, the same horizon the reaper uses, so the
    // API never calls a claim dead before the reaper has had its chance. Left as a
    // conflict the operator's cancel would be inert for as long as the row sat there.
    const id = await seedPending();
    await fx.di.pool.query(
      `update override_actions set processing_at = now() - interval '11 minutes' where id = $1`,
      [id],
    );
    await redis.set(cacheKey(), '{}');

    const res = await fx.app.request(path(), { method: 'DELETE', headers: headers() });
    expect(res.status).toBe(204);
    // The key is evicted so no tick can act on it. The ROW is left alone deliberately:
    // clearing another consumer's claim from the API is the unfenced write the worker
    // side is careful never to make, and the stale-claim reaper owns that job.
    expect(await redis.exists(cacheKey())).toBe(0);
    const survivor = await (await repo()).overrideActions.findActiveForSymbol(SYMBOL);
    expect(survivor?.id).toBe(id);
  });

  it('DELETE evicts an orphaned cache key and answers 204 when no override row exists', async () => {
    // Idempotent cancel, and the orphan-cleanup path: a key whose row is already
    // settled must still be evicted, or the bundle-builder would hand a consumed
    // override to the next tick.
    await redis.set(cacheKey(), '{}');

    const res = await fx.app.request(path(), { method: 'DELETE', headers: headers() });
    expect(res.status).toBe(204);
    expect(await redis.exists(cacheKey())).toBe(0);
  });

  it('declares 409 on the DELETE route so the published contract stays honest', () => {
    // A route that can answer 409 while its OpenAPI map says 204/404 makes every
    // generated client treat the conflict as an unexpected failure, which is how a
    // "the bot is already acting on this" answer becomes a generic error toast.
    const app = fx.app as unknown as {
      getOpenAPI31Document: (cfg: unknown) => {
        paths?: Record<string, { delete?: { responses?: Record<string, unknown> } }>;
      };
    };
    const doc = app.getOpenAPI31Document({
      openapi: '3.1.0',
      info: { title: 'test', version: '0' },
    });
    const entry = Object.entries(doc.paths ?? {}).find(([p]) => p.endsWith('/override'));
    expect(entry).toBeDefined();
    const responses = entry?.[1].delete?.responses ?? {};
    expect(Object.keys(responses).sort()).toEqual(['204', '404', '409']);
    // The repo's one error shape, not a bespoke body for this route. Pinned by
    // comparing against the 404 on the SAME route, which is `ErrorEnvelope` by
    // construction: a placeholder matcher here would pass for any schema at all, which
    // is precisely the drift this assertion exists to catch.
    const schemaOf = (code: string): unknown =>
      (responses[code] as { content?: Record<string, { schema?: unknown }> } | undefined)
        ?.content?.['application/json']?.schema;
    expect(schemaOf('409')).toBeDefined();
    expect(schemaOf('409')).toEqual(schemaOf('404'));
  });
});
