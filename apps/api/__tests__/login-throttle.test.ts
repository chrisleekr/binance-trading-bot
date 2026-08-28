import type { ScopedRedis } from '@app/db';
import { OpenAPIHono } from '@hono/zod-openapi';
import { Redis } from 'ioredis';
import { pino } from 'pino';
import { describe, expect, it } from 'vitest';

import { errorEnvelope } from '../src/middleware/error.js';
import { loginRateLimit } from '../src/middleware/login-rate-limit.js';
import type { Env } from '../src/types.js';

const REDIS_URL = process.env['REDIS_TEST_URL'] ?? 'redis://127.0.0.1:6390/15';
const HAS_REDIS = Boolean(process.env['REDIS_TEST_URL']);
const describeIfRedis = HAS_REDIS ? describe : describe.skip;

const wrapRedis = (r: Redis): ScopedRedis =>
  ({
    raw: () => r,
    forProfile: () => {
      throw new Error('not used');
    },
    forGlobal: () => {
      throw new Error('not used');
    },
    quit: async () => 'OK' as const,
  }) as unknown as ScopedRedis;

const buildApp = (
  redis: ScopedRedis,
  handler: (status: number) => number = () => 200,
): OpenAPIHono<Env> => {
  const logger = pino({ level: 'silent' });
  const app = new OpenAPIHono<Env>();
  app.use('*', errorEnvelope(logger));
  app.use('/api/auth/sign-in', loginRateLimit(redis));
  app.post('/api/auth/sign-in', (c) => {
    // Simulated Better Auth handler: 401 for "wrong password", 200 otherwise.
    const code = handler(401);
    return c.text(code === 200 ? 'ok' : 'bad', code as 200 | 401);
  });
  return app;
};

describeIfRedis('login rate limit — sliding window', () => {
  it('returns 429 with Retry-After on the 6th request within 1 minute from the same IP', async () => {
    const r = new Redis(REDIS_URL);
    await r.flushdb();
    const app = buildApp(wrapRedis(r), () => 200);

    const fire = async (): Promise<Response> =>
      app.fetch(
        new Request('http://test.local/api/auth/sign-in', {
          method: 'POST',
          headers: { 'x-forwarded-for': '203.0.113.1', 'content-type': 'application/json' },
          body: JSON.stringify({ email: 'a@b.c', password: 'x' }),
        }),
      );

    for (let i = 0; i < 5; i += 1) {
      const r1 = await fire();
      expect(r1.status).toBe(200);
    }
    const blocked = await fire();
    expect(blocked.status).toBe(429);
    expect(blocked.headers.get('Retry-After')).toBeTruthy();
    await r.quit();
  });
});

describeIfRedis('login lockout — 15-min after 10 failures within 1h', () => {
  it('arms the lockout marker after the 10th failed attempt and rejects the 11th request before the handler runs', async () => {
    const r = new Redis(REDIS_URL);
    await r.flushdb();
    // Handler always returns 401 — every attempt is a failure.
    const app = buildApp(wrapRedis(r), () => 401);

    // Spread attempts across 10 different IPs to avoid the per-IP layer
    // (5/min/IP) firing before the lockout layer arms.
    const attempt = async (n: number): Promise<Response> =>
      app.fetch(
        new Request('http://test.local/api/auth/sign-in', {
          method: 'POST',
          headers: {
            'x-forwarded-for': `203.0.113.${n}`,
            'content-type': 'application/json',
          },
          body: JSON.stringify({ email: 'lock@b.c', password: 'wrong' }),
        }),
      );

    for (let i = 1; i <= 10; i += 1) {
      const res = await attempt(i);
      expect(res.status).toBe(401);
    }

    // 11th attempt — the lockout marker is now armed. New IP so the
    // sliding window doesn't claim the rejection first.
    const blocked = await attempt(11);
    expect(blocked.status).toBe(429);
    const retry = blocked.headers.get('Retry-After');
    expect(retry).toBeTruthy();
    expect(Number(retry)).toBeGreaterThan(0);
    expect(Number(retry)).toBeLessThanOrEqual(900);

    // Marker is the source of truth — confirm via Redis directly.
    const ttl = await r.ttl('auth:lockout:active:lock@b.c');
    expect(ttl).toBeGreaterThan(0);
    expect(ttl).toBeLessThanOrEqual(900);

    await r.quit();
  });

  it('does not arm the lockout when failures stay below the threshold', async () => {
    const r = new Redis(REDIS_URL);
    await r.flushdb();
    const app = buildApp(wrapRedis(r), () => 401);

    for (let i = 1; i <= 9; i += 1) {
      await app.fetch(
        new Request('http://test.local/api/auth/sign-in', {
          method: 'POST',
          headers: {
            'x-forwarded-for': `203.0.113.${i}`,
            'content-type': 'application/json',
          },
          body: JSON.stringify({ email: 'safe@b.c', password: 'wrong' }),
        }),
      );
    }
    const ttl = await r.ttl('auth:lockout:active:safe@b.c');
    // -2 = key does not exist; -1 = no TTL. Either is acceptable; both mean "not armed".
    expect(ttl).toBeLessThanOrEqual(0);
    await r.quit();
  });
});

describeIfRedis('login throttle — body-parse fallback', () => {
  it('falls back to the IP-only layer when the request body is not parseable as JSON', async () => {
    const r = new Redis(REDIS_URL);
    await r.flushdb();
    const app = buildApp(wrapRedis(r), () => 401);

    const fire = async (): Promise<Response> =>
      app.fetch(
        new Request('http://test.local/api/auth/sign-in', {
          method: 'POST',
          headers: { 'x-forwarded-for': '198.51.100.1', 'content-type': 'application/json' },
          // Deliberately malformed — the middleware must swallow the parse
          // error and fall through to the IP-only path rather than 500.
          body: '{ not valid json',
        }),
      );

    // First 5 attempts reach the handler (401). 6th hits the per-IP cap.
    for (let i = 0; i < 5; i += 1) {
      const res = await fire();
      expect(res.status).toBe(401);
    }
    const blocked = await fire();
    expect(blocked.status).toBe(429);
    expect(blocked.headers.get('Retry-After')).toBeTruthy();

    // No email was extractable, so the lockout layer cannot have armed
    // against any email key. Sample the wildcard space to catch a
    // hypothetical regression where an empty-email lockout key gets
    // armed under `auth:lockout:active:`.
    const lockoutKeys = await r.keys('auth:lockout:active:*');
    expect(lockoutKeys).toEqual([]);
    await r.quit();
  });

  it('counts only non-429 responses toward the lockout: per-IP rejections do not consume the failure budget', async () => {
    // A same-IP run hits the per-IP cap on the 6th attempt (429), but the
    // throttle deliberately skips 429 responses when incrementing the
    // failure-count window. The lockout therefore arms only once the
    // attacker actually accumulates LOCKOUT_THRESHOLD (10) genuine 4xx
    // responses — pivoting to fresh IPs is required after the per-IP
    // layer rejects them. This test pins that interaction so a future
    // refactor cannot collapse the two layers into one and let 429s
    // inflate the failure counter.
    const r = new Redis(REDIS_URL);
    await r.flushdb();
    const app = buildApp(wrapRedis(r), () => 401);

    const fire = async (ip: string): Promise<Response> =>
      app.fetch(
        new Request('http://test.local/api/auth/sign-in', {
          method: 'POST',
          headers: { 'x-forwarded-for': ip, 'content-type': 'application/json' },
          body: JSON.stringify({ email: 'target@b.c', password: 'wrong' }),
        }),
      );

    // Phase 1: hammer one IP. First 5 are 401s and count toward lockout.
    for (let i = 0; i < 5; i += 1) {
      const res = await fire('192.0.2.1');
      expect(res.status).toBe(401);
    }
    // 6th from the same IP hits the per-IP cap → 429, NOT a failure.
    const perIp = await fire('192.0.2.1');
    expect(perIp.status).toBe(429);

    // Pre-condition: only the 5 genuine 401s have been counted; the
    // lockout marker must not yet exist.
    expect(await r.ttl('auth:lockout:active:target@b.c')).toBeLessThanOrEqual(0);

    // Phase 2: continue from fresh IPs. The 6th–10th 401 push the failure
    // counter to 10 and arm the lockout. The 429 from the per-IP layer
    // did not inflate the counter, so still need exactly 5 more 401s.
    for (let i = 2; i <= 6; i += 1) {
      const res = await fire(`192.0.2.${i}`);
      expect(res.status).toBe(401);
    }
    const lockoutTtl = await r.ttl('auth:lockout:active:target@b.c');
    expect(lockoutTtl).toBeGreaterThan(0);
    expect(lockoutTtl).toBeLessThanOrEqual(900);
    await r.quit();
  });
});
