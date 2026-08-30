import { readFileSync } from 'node:fs';

import type { ScopedRedis } from '@app/db';
import { OpenAPIHono } from '@hono/zod-openapi';
import type { Context } from 'hono';
import { Redis } from 'ioredis';
import { pino } from 'pino';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import { clientIp } from '../src/middleware/client-ip.js';
import { errorEnvelope } from '../src/middleware/error.js';
import { loginRateLimit } from '../src/middleware/login-rate-limit.js';
import type { Env } from '../src/types.js';

import { HAS_INFRA, setupApp, type ApiFixture } from './_helpers.js';

// Minimal Context stub exposing only `req.header`, the sole surface clientIp reads.
const ctx = (headers: Record<string, string>): Context =>
  ({
    req: { header: (name: string): string | undefined => headers[name.toLowerCase()] },
  }) as unknown as Context;

/**
 * Issue #688 — the API must derive the client IP from the RIGHTMOST X-Forwarded-For
 * hop (one trusted proxy), not the client-controlled leftmost hop.
 *
 * These are start-state (RED) tests against the current leftmost-hop code:
 *   - the login throttle buckets on the wrong IP, so a rotating leftmost prefix
 *     never trips the per-IP cap (C1/C2);
 *   - the audit middleware stores the whole raw header string instead of the
 *     single trusted hop (C3).
 * C4 locks the no-header fallback so a fix cannot regress it into a 500.
 *
 * Redis + Postgres come from the shared testcontainers stack via setupApp, so the
 * suite runs hermetically under TESTCONTAINERS=1 (unlike login-throttle.test.ts,
 * which only runs when REDIS_TEST_URL is set).
 */
const describeIfInfra = HAS_INFRA ? describe : describe.skip;

// Same ScopedRedis shim login-throttle.test.ts uses: the middleware only ever
// calls `.raw()`, so the other members throw to catch accidental use.
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

// Minimal app fronting the REAL loginRateLimit middleware, mirroring
// login-throttle.test.ts. The handler always answers 200 so nothing but the
// per-IP layer can produce a 429.
const buildRateLimitApp = (redis: ScopedRedis): OpenAPIHono<Env> => {
  const app = new OpenAPIHono<Env>();
  app.use('*', errorEnvelope(pino({ level: 'silent' })));
  app.use('/api/auth/sign-in', loginRateLimit(redis));
  app.post('/api/auth/sign-in', (c) => c.text('ok', 200));
  return app;
};

describeIfInfra('client IP derivation (#688)', () => {
  let fx: ApiFixture;

  beforeAll(async () => {
    fx = await setupApp();
  });
  afterAll(async () => {
    await fx.cleanup();
  });

  it('C1/C2: per-IP throttle buckets on the rightmost hop — 6th request 429s despite a rotating leftmost', async () => {
    const r = new Redis(fx.redisUrl);
    await r.flushdb();
    const app = buildRateLimitApp(wrapRedis(r));

    // Rightmost (trusted proxy) is constant; leftmost (client-controlled) rotates
    // every request. Bucketing on the rightmost hop means all 6 share one counter.
    const fire = async (leftmost: string): Promise<Response> =>
      app.fetch(
        new Request('http://test.local/api/auth/sign-in', {
          method: 'POST',
          headers: {
            'x-forwarded-for': `${leftmost}, 203.0.113.9`,
            'content-type': 'application/json',
          },
          body: JSON.stringify({ email: 'c1@b.c', password: 'x' }),
        }),
      );

    for (let i = 1; i <= 5; i += 1) {
      const res = await fire(`${i}.${i}.${i}.${i}`);
      expect(res.status).toBe(200);
    }
    // RED now: current code keys on the rotating leftmost hop, so each request
    // hits a distinct `auth:rl:ip:<leftmost>` bucket and this stays 200.
    const blocked = await fire('6.6.6.6');
    expect(blocked.status).toBe(429);
    expect(blocked.headers.get('Retry-After')).toBeTruthy();

    await r.quit();
  });

  it('C3: audit row records the rightmost hop, not the raw X-Forwarded-For string', async () => {
    const res = await fx.app.request(
      `/api/accounts/${fx.alice.accountId}/profiles/${fx.alice.profileId}/disable-all`,
      {
        method: 'POST',
        headers: {
          'x-test-user-id': fx.alice.userId,
          'content-type': 'application/json',
          'x-forwarded-for': '9.9.9.9, 203.0.113.9',
        },
      },
    );
    expect(res.status).toBe(204);

    const { rows } = await fx.di.pool.query<{ ip: string | null }>(
      `select ip from audit_logs where event = 'kill-switch-on' order by created_at desc limit 1`,
    );
    // RED now: audit.ts writes the raw header, so ip is '9.9.9.9, 203.0.113.9'.
    expect(rows[0]?.ip).toBe('203.0.113.9');
  });

  it('C4: sign-in with no X-Forwarded-For and no X-Real-IP does not 500 (fallback holds)', async () => {
    const r = new Redis(fx.redisUrl);
    await r.flushdb();
    const app = buildRateLimitApp(wrapRedis(r));

    const res = await app.fetch(
      new Request('http://test.local/api/auth/sign-in', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ email: 'c4@b.c', password: 'x' }),
      }),
    );
    // Fallback to the 'unknown' bucket must keep the throttle functioning.
    expect(res.status).not.toBe(500);
    expect(res.status).toBe(200);

    await r.quit();
  });
});

describe('clientIp helper (#688)', () => {
  it('C4 precision: falls back to x-real-ip, then to unknown, and never throws', () => {
    expect(clientIp(ctx({ 'x-real-ip': '7.7.7.7' }))).toBe('7.7.7.7');
    expect(clientIp(ctx({}))).toBe('unknown');
    // A whitespace-only / empty XFF must not surface as the client IP; it falls
    // through to x-real-ip.
    expect(clientIp(ctx({ 'x-forwarded-for': '  ', 'x-real-ip': '7.7.7.7' }))).toBe('7.7.7.7');
  });

  it('C5: a single-entry XFF with no comma is returned unchanged', () => {
    expect(clientIp(ctx({ 'x-forwarded-for': '203.0.113.5' }))).toBe('203.0.113.5');
  });

  it('takes the rightmost hop from a multi-entry chain', () => {
    expect(clientIp(ctx({ 'x-forwarded-for': '9.9.9.9, 203.0.113.9' }))).toBe('203.0.113.9');
    expect(clientIp(ctx({ 'x-forwarded-for': '1.1.1.1, 2.2.2.2, 203.0.113.9' }))).toBe(
      '203.0.113.9',
    );
  });

  it('drops a trailing-comma empty hop and keeps IPv6 addresses intact', () => {
    // A trailing comma leaves an empty final field; it must be filtered so the
    // real rightmost hop wins, not an empty bucket key.
    expect(clientIp(ctx({ 'x-forwarded-for': '9.9.9.9, 203.0.113.9,' }))).toBe('203.0.113.9');
    // IPv6 has colons but no commas, so splitting on ',' keeps each address whole.
    expect(clientIp(ctx({ 'x-forwarded-for': '2001:db8::1, ::1' }))).toBe('::1');
  });

  it('ignores a blank x-real-ip and falls through to unknown', () => {
    // The fallback is trimmed and empty-checked like the XFF hops, so a blank
    // x-real-ip cannot become the literal bucket key.
    expect(clientIp(ctx({ 'x-real-ip': '   ' }))).toBe('unknown');
  });

  it('C6 structural: no leftmost-hop derivation remains; both middlewares route through clientIp', () => {
    const rl = readFileSync(
      new URL('../src/middleware/login-rate-limit.ts', import.meta.url),
      'utf8',
    );
    const au = readFileSync(new URL('../src/middleware/audit.ts', import.meta.url), 'utf8');
    // The bug was `split(',')[0]` (leftmost) in login-rate-limit and a raw
    // x-forwarded-for read in audit. Neither may reappear.
    expect(rl).not.toMatch(/split\(\s*','\s*\)\s*\[\s*0\s*\]/);
    expect(rl).toMatch(/clientIp\(/);
    expect(au).not.toMatch(/header\(\s*'x-forwarded-for'\s*\)/);
    expect(au).toMatch(/clientIp\(/);
  });
});
