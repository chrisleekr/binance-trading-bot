import type { ScopedRedis } from '@app/db';
import type { Context, MiddlewareHandler } from 'hono';
import { clientIp } from 'middleware/client-ip.js';
import type { Env } from 'types.js';

// Three concurrent layers protect /api/auth/sign-in:
//   Layer 1: Better Auth's per-route 60s/5 limit (config in createAuth).
//   Layer 2: Redis sliding-window — 5/min/IP and 10/min/email.
//   Layer 3: Per-email lockout — 10 failures within 1h sets a 15-min
//            lockout marker; the next request is rejected before the
//            handler runs.
const WINDOW_SEC = 60;
const IP_MAX = 5;
const EMAIL_MAX = 10;
const LOCKOUT_WINDOW_SEC = 3600;
const LOCKOUT_THRESHOLD = 10;
const LOCKOUT_DURATION_SEC = 900;

type RawRedis = ReturnType<ScopedRedis['raw']>;

/**
 * Sliding-window counter primitive: ZADD this attempt, evict entries
 * older than the window, then ZCARD. Returning the post-add count
 * lets the caller check `count > limit` — the new attempt is counted.
 */
const slidingCount = async (
  r: RawRedis,
  key: string,
  windowSec: number,
  nowMs: number,
): Promise<number> => {
  const cutoff = nowMs - windowSec * 1000;
  const member = `${nowMs}:${Math.random().toString(36).slice(2, 10)}`;
  await r.zadd(key, nowMs, member);
  await r.zremrangebyscore(key, '-inf', cutoff);
  await r.expire(key, windowSec * 2);
  return r.zcard(key);
};

/**
 * 429 envelope. `retryAfter` is the seconds the client should wait —
 * the sliding-window layers report the window length; the lockout
 * layer reports the remaining lockout TTL so the client retries
 * once the marker actually expires.
 */
const tooMany = (c: Context<Env>, scope: string, retryAfter: number): Response => {
  c.header('Retry-After', String(retryAfter));
  return c.json(
    { error: { code: 'RATE_LIMITED', message: `login rate exceeded for ${scope}` } },
    429,
  );
};

/**
 * Login rate-limit middleware. Sits in front of /api/auth/sign-in
 * (only). Reads the email out of the request body so the email
 * throttle and lockout layers can key on it; failures to parse
 * the body fall back to the IP-only path.
 */
export const loginRateLimit =
  (redis: ScopedRedis): MiddlewareHandler<Env> =>
  async (c, next) => {
    const r = redis.raw();
    // Bucket on the trusted rightmost x-forwarded-for hop. Our proxy appends the
    // real client to the right, so the leftmost entries are client-supplied and
    // a rotating prefix could otherwise mint a fresh bucket per request.
    const ip = clientIp(c);
    let email = '';
    try {
      const cloned = c.req.raw.clone();
      const body = (await cloned.json().catch(() => ({}))) as { email?: unknown };
      if (typeof body.email === 'string') email = body.email.toLowerCase();
    } catch {
      // body unparseable; only IP throttle applies.
    }
    const now = Date.now();

    // Layer 3: lockout marker — short-circuit before any handler runs.
    if (email.length > 0) {
      const ttl = await r.ttl(`auth:lockout:active:${email}`);
      if (ttl > 0) return tooMany(c, 'lockout', ttl);
    }

    // Layer 2a: per-IP sliding window.
    const ipCount = await slidingCount(r, `auth:rl:ip:${ip}`, WINDOW_SEC, now);
    if (ipCount > IP_MAX) return tooMany(c, 'ip', WINDOW_SEC);

    // Layer 2b: per-email sliding window.
    if (email.length > 0) {
      const emailCount = await slidingCount(r, `auth:rl:email:${email}`, WINDOW_SEC, now);
      if (emailCount > EMAIL_MAX) return tooMany(c, 'email', WINDOW_SEC);
    }

    await next();

    // Layer 3 maintenance: count failures and arm the lockout. We
    // observe the response status because Better Auth's sign-in
    // handler maps a wrong-credentials attempt to 401; any 4xx
    // is treated as a failure for lockout purposes (a 422 from
    // body validation is also "this client doesn't know what it's
    // doing"). 429 is excluded so a throttled request doesn't
    // count toward the lockout it's already being throttled by.
    if (email.length > 0 && c.res.status >= 400 && c.res.status !== 429) {
      const failCount = await slidingCount(
        r,
        `auth:lockout:fail:${email}`,
        LOCKOUT_WINDOW_SEC,
        now,
      );
      if (failCount >= LOCKOUT_THRESHOLD) {
        await r.set(`auth:lockout:active:${email}`, '1', 'EX', LOCKOUT_DURATION_SEC);
      }
    }
  };
