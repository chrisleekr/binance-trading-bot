import { asAccountId, asProfileId, asUserId } from '@app/contracts';
import { eventsChannelKey, eventsStreamKey, ProfileNotOwnedError, scopeProfile } from '@app/db';
import { createBunWebSocket } from 'hono/bun';
import type { ServerWebSocket } from 'bun';
import type { DI } from 'di.js';
import { replayMissed } from 'ws/replay.js';
import { isAllowedOrigin } from 'middleware/cors.js';
import { createApiHono, type ApiHono } from 'types.js';

interface BunWsHandle {
  upgradeWebSocket: ReturnType<typeof createBunWebSocket<ServerWebSocket>>['upgradeWebSocket'];
  websocket: ReturnType<typeof createBunWebSocket<ServerWebSocket>>['websocket'];
}

export interface WsRouterHandle {
  router: ApiHono;
  websocket: BunWsHandle['websocket'];
}

// /api/profiles/:profileId/ws upgrade. Validation chain:
//   1. session cookie → userId   (else 401)
//   2. Origin in the WEB_ORIGIN allowlist  (else 403)
//   3. profileId owned by userId (else 404)
// Then subscribe ws.raw to `events:<userId>:<profileId>` and replay missed
// events from the Redis stream of the same name + ":stream" if ?since= given.
export const createWsRouter = (di: DI): WsRouterHandle => {
  const { upgradeWebSocket, websocket } = createBunWebSocket<ServerWebSocket>();
  const app = createApiHono();

  app.get('/profiles/:profileId/ws', async (c, next) => {
    const userIdRaw = c.get('userId');
    if (!userIdRaw) return c.text('unauthenticated', 401);
    const origin = c.req.header('Origin');
    if (!isAllowedOrigin(origin, di.env.WEB_ORIGIN)) return c.text('forbidden', 403);
    const profileIdRaw = c.req.param('profileId');
    if (!profileIdRaw) return c.text('not_found', 404);
    const accountIdRaw = c.req.param('accountId');
    if (!accountIdRaw) return c.text('not_found', 404);
    const operatorId = asUserId(userIdRaw);
    const accountId = asAccountId(accountIdRaw);
    const profileId = asProfileId(profileIdRaw);
    // `scopeProfile` runs the single ownership check; an unowned or missing
    // profile rejects with `ProfileNotOwnedError`, which we fold into the
    // same plain-text 404 the other pre-upgrade guards return.
    try {
      await scopeProfile(di.db, operatorId, accountId, profileId);
    } catch (err) {
      if (err instanceof ProfileNotOwnedError) return c.text('not_found', 404);
      throw err;
    }
    const since = Number(c.req.query('since') ?? 0);
    const topic = eventsChannelKey(accountId, profileId);
    const streamKey = eventsStreamKey(accountId, profileId);

    const handler = upgradeWebSocket(() => ({
      async onOpen(_e, ws) {
        const raw = ws.raw;
        if (raw && typeof raw.subscribe === 'function') {
          raw.subscribe(topic);
        }
        if (since > 0) {
          const replayed = await replayMissed(di.redis, streamKey, since, di.logger);
          if (replayed.resyncRequired) {
            ws.send(
              JSON.stringify({
                seq: 0,
                topic: 'resync-required',
                ts: new Date().toISOString(),
                payload: null,
              }),
            );
          } else {
            for (const env of replayed.envelopes) ws.send(env);
          }
        }
      },
      onMessage() {
        // read-only channel in v1.0.
      },
      onClose(_e, ws) {
        const raw = ws.raw;
        if (raw && typeof raw.unsubscribe === 'function') raw.unsubscribe(topic);
      },
    }));
    return handler(c, next);
  });

  return { router: app, websocket };
};
