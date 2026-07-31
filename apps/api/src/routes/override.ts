import {
  asProfileId,
  ErrorEnvelope,
  OverrideAction,
  OVERRIDE_CLAIM_STALE_MS,
  OVERRIDE_OUTCOME_WINDOW_MS,
} from '@app/contracts';
import { createRoute, z } from '@hono/zod-openapi';
import type { DI } from 'di.js';
import { HttpError } from 'middleware/error.js';
import { requireUser } from 'middleware/require-user.js';
import { scopeOf } from 'route-helpers.js';
import { createApiHono, type ApiHono } from 'types.js';

const Param = z.object({
  profileId: z.uuid(),
  symbol: z.string().min(1).max(32),
});

const getRoute = createRoute({
  method: 'get',
  path: '/profiles/{profileId}/symbols/{symbol}/override',
  tags: ['override'],
  request: { params: Param },
  responses: {
    200: {
      description: 'the most recent override in the outcome window, settled or not; null if none',
      content: { 'application/json': { schema: OverrideAction.nullable() } },
    },
    404: { description: 'NOT_FOUND', content: { 'application/json': { schema: ErrorEnvelope } } },
  },
});

const deleteRoute = createRoute({
  method: 'delete',
  path: '/profiles/{profileId}/symbols/{symbol}/override',
  tags: ['override'],
  request: { params: Param },
  responses: {
    204: { description: 'cancelled' },
    404: { description: 'NOT_FOUND', content: { 'application/json': { schema: ErrorEnvelope } } },
    409: {
      description: 'CONFLICT: a tick has claimed this override and may already have acted on it',
      content: { 'application/json': { schema: ErrorEnvelope } },
    },
  },
});

export const overrideRouter = (di: DI): ApiHono => {
  const app = createApiHono();
  app.use('/profiles/*', requireUser());

  app.openapi(getRoute, async (c) => {
    const { profileId: profileIdRaw, symbol } = c.req.valid('param');
    const profileId = asProfileId(profileIdRaw);
    // `scopeOf` runs the single ownership check; an unowned profile
    // rejects with `ProfileNotOwnedError`, mapped to 404 by `app.onError`.
    const p = await scopeOf(c, di, profileId);
    // Settled rows included: the operator submitted an override seconds ago and
    // is waiting to learn how it ENDED, and only the settled row knows. The
    // window bounds that to overrides from the current session — an override
    // from yesterday must not surface as if it were the pending one.
    const row = await p.overrideActions.findLatestForSymbol(
      symbol,
      new Date(Date.now() - OVERRIDE_OUTCOME_WINDOW_MS),
    );
    if (!row) return c.json(null, 200);
    return c.json(
      {
        id: row.id,
        symbol: row.symbol,
        action: row.action,
        actionAt: row.actionAt.toISOString(),
        payload: row.payload,
        triggeredBy: row.triggeredBy,
        processingAt: row.processingAt ? row.processingAt.toISOString() : null,
        consumedAt: row.consumedAt ? row.consumedAt.toISOString() : null,
        // `outcome` is the outcome column and nothing else — no shape-sniffing
        // needed to tell it apart from the dust flow's `result` payload.
        outcome: row.outcome ?? null,
        createdAt: row.createdAt.toISOString(),
      },
      200,
    );
  });

  app.openapi(deleteRoute, async (c) => {
    const { profileId: profileIdRaw, symbol } = c.req.valid('param');
    const profileId = asProfileId(profileIdRaw);
    const p = await scopeOf(c, di, profileId);
    const { accountId } = p.scope;
    // Read the target BEFORE the delete, because the delete's own outcome is the only
    // reliable evidence. `processing_at` is a lease the worker itself nulls: it
    // releases the claim just before re-arming the Redis key, so reading the column
    // after the delete can see null for a row that WAS claimed when the delete ran and
    // whose key has just been restored. Answering 204 there is the original bug
    // inverted: the operator is told it was cancelled while the next tick executes it.
    // Identity survives that race; the column does not.
    const target = await p.overrideActions.findActiveForSymbol(symbol);
    const deleted = await p.overrideActions.deletePendingForSymbol(symbol);
    // Evict the cached override unless an active row survives: the repo guard leaves
    // a worker-claimed row in place, and the worker still reads the override
    // mid-side-effect, so dropping its Redis key would desync the cache from the DB.
    // With no active row, evict (orphan cleanup too).
    const stillActive = await p.overrideActions.findActiveForSymbol(symbol);
    const evict = (): Promise<number> =>
      di.redis.raw().del(`tenant:${accountId}:profile:${profileId}:override:${symbol}`);
    if (!stillActive) {
      await evict();
      return new Response(null, { status: 204 });
    }
    // Did the guarded delete skip the very row the operator asked about? Then it was
    // claimed at that moment, whatever the column reads now, and a tick may already
    // have an order on the wire. `processing_at` is still consulted because a row that
    // arrived after the read can be claimed too.
    const survivedTheDelete = target !== null && stillActive.id === target.id;
    const claimed = survivedTheDelete || stillActive.processingAt !== null;
    // A `processing_at` the worker released mid-race reads as age 0, i.e. fresh, which
    // is the safe direction: `survivedTheDelete` already proved it was claimed.
    const claimAgeMs =
      stillActive.processingAt === null ? 0 : Date.now() - stillActive.processingAt.getTime();
    if (claimed) {
      if (claimAgeMs <= OVERRIDE_CLAIM_STALE_MS) {
        // 204 here would tell the operator it was cancelled while the trade is going
        // through, and that is the one answer they cannot recover from, because they act
        // on it: they stop watching. 409 sends them to the outcome instead. The wording
        // has to own the half-measure too, since a queued override may well have been
        // deleted while an earlier claimed one survived.
        throw new HttpError(
          'CONFLICT',
          deleted > 0
            ? 'cancelled the queued override, but the bot is already acting on an earlier one for this symbol; wait for its outcome before re-issuing'
            : 'the bot is already acting on this override; wait for its outcome before re-issuing it',
        );
      }
      // Past the horizon the stale-claim reaper itself uses, so the API can never call a
      // claim dead before the reaper has had its chance: this row belongs to a worker
      // that died holding it. It is also the NEWEST active row, so no fresher override
      // waits behind it and any key still present is an orphan of a window that has
      // drained.
      // Evict it, or the operator's cancel would be inert for as long as the row sits
      // there. The ROW is left alone: clearing another consumer's claim from the API is
      // exactly the unfenced write the worker side is careful never to make, and the
      // stale-claim reaper plus the stranded-row sweep already own it.
      await evict();
      return new Response(null, { status: 204 });
    }
    // Unclaimed and still here: a NEWER override landed after the delete. Its key is
    // that new intent, not the one being cancelled, so the key is left alone.
    return new Response(null, { status: 204 });
  });

  return app;
};
