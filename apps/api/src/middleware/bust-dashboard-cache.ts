import type { MiddlewareHandler } from 'hono';
import { asAccountId, asProfileId } from '@app/contracts';
import { projections, type ScopedRedis } from '@app/db';
import type { Env } from 'types.js';

/**
 * After any successful state-changing request, drop the dashboard read-through
 * caches so the SPA's immediate refetch returns fresh data instead of a blob
 * cached up to the TTL (the "action is slow to refresh" lag). Post-response and
 * best-effort: a thrown handler rejects `next()` so a failed write never busts,
 * and a Redis error is swallowed so it never turns a 2xx into a 5xx.
 */
export const bustDashboardCache =
  (redis: ScopedRedis): MiddlewareHandler<Env> =>
  async (c, next) => {
    await next();
    if (c.req.method === 'GET') return;
    if (!c.get('userId')) return;
    // Only a 2xx write changed state worth refreshing (covers 200/201/204).
    // A 3xx is not a state change to surface, so this stays stricter than the
    // audit middleware's `>= 400` guard.
    if (c.res.status < 200 || c.res.status >= 300) return;
    // The dashboard caches are keyed by account. Only account-scoped routes carry
    // `:accountId`; an operator-global write has no dashboard cache to bust.
    const accountId = c.req.param('accountId');
    if (!accountId) return;
    const profileId = c.req.param('profileId');
    await projections.invalidateDashboardCaches(
      redis.raw(),
      asAccountId(accountId),
      profileId ? asProfileId(profileId) : undefined,
    );
  };
