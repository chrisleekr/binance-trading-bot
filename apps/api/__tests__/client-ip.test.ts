import { readFileSync } from 'node:fs';

import type { Context } from 'hono';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import { clientIp } from '../src/middleware/client-ip.js';

import { HAS_INFRA, setupApp, type ApiFixture } from './_helpers.js';

// Minimal Context stub exposing only `req.raw.headers`, the sole surface clientIp reads.
const ctx = (headers: Record<string, string>): Context =>
  ({ req: { raw: { headers: new Headers(headers) } } }) as unknown as Context;

/**
 * The API derives the client IP from the RIGHTMOST X-Forwarded-For hop (one trusted proxy), never the client-controlled leftmost hop. A leftmost-hop key would let an attacker mint a fresh sign-in allowance per request by rotating the prefix (C1/C2), and would put attacker text in the audit row (C3). C4 locks the no-header fallback so it cannot regress into a 500.
 *
 * Runs against the real sign-in route with the production Redis limiter, so the per-IP allowance under test is the one the operator configures (default 3 attempts per 5 minutes).
 */
const describeIfInfra = HAS_INFRA ? describe : describe.skip;

const signIn = (
  fx: ApiFixture,
  headers: Record<string, string>,
  email: string,
): Promise<Response> =>
  Promise.resolve(
    fx.app.request('/api/auth/sign-in/email', {
      method: 'POST',
      headers: { 'content-type': 'application/json', ...headers },
      body: JSON.stringify({ email, password: 'not-the-password' }),
    }),
  );

describeIfInfra('client IP derivation (#688)', () => {
  let fx: ApiFixture;

  beforeAll(async () => {
    fx = await setupApp({ realLimiter: true });
  });
  afterAll(async () => {
    await fx.cleanup();
  });

  it('C1/C2: the per-IP allowance keys on the rightmost hop, so a rotating leftmost prefix is still refused after 3 attempts', async () => {
    // Distinct emails keep the per-email allowance (5) out of the way, so only the per-IP one can refuse.
    for (let i = 1; i <= 3; i += 1) {
      const res = await signIn(
        fx,
        { 'x-forwarded-for': `${i}.${i}.${i}.${i}, 203.0.113.9` },
        `c1-${i}@example.test`,
      );
      expect(res.status).toBe(401);
    }
    const blocked = await signIn(
      fx,
      { 'x-forwarded-for': '6.6.6.6, 203.0.113.9' },
      'c1-4@example.test',
    );
    expect(blocked.status).toBe(429);
    expect(Number(blocked.headers.get('Retry-After'))).toBeGreaterThan(0);
    // A different trusted hop has its own allowance, which proves the refusal above is per address rather than global.
    const other = await signIn(
      fx,
      { 'x-forwarded-for': '6.6.6.6, 203.0.113.10' },
      'c1-5@example.test',
    );
    expect(other.status).toBe(401);
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
    const res = await signIn(fx, {}, 'c4@example.test');
    // The shared 'unknown' bucket keeps the limiter working; a wrong password is an ordinary 401.
    expect(res.status).toBe(401);
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

  it('C6 structural: no leftmost-hop derivation remains; the address helper and the audit middleware both take the rightmost hop', () => {
    const address = readFileSync(new URL('../src/auth/client-address.ts', import.meta.url), 'utf8');
    const au = readFileSync(new URL('../src/middleware/audit.ts', import.meta.url), 'utf8');
    const routes = readFileSync(new URL('../src/routes/auth.ts', import.meta.url), 'utf8');
    // The original bug was `split(',')[0]` (leftmost) in the limiter and a raw x-forwarded-for read in audit. Neither may reappear.
    expect(address).not.toMatch(/split\(\s*','\s*\)\s*\[\s*0\s*\]/);
    expect(address).toMatch(/export const clientIpFromHeaders/);
    expect(routes).toMatch(/clientIpFromHeaders\(/);
    expect(routes).not.toMatch(/'x-forwarded-for'/);
    expect(au).not.toMatch(/header\(\s*'x-forwarded-for'\s*\)/);
    expect(au).toMatch(/clientIp\(/);
  });
});
