// The cheap guards in front of the sign-in system: the cross-site request guard, the pre-session flood limit, the password hashing gate, the known-device mark, the notification sanitiser and the address keys. Most run before any database work, which is the point of them, so several cases here prove ordering as well as verdicts.

import { createMetricsRegistry } from '@app/observability';
import { Hono } from 'hono';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';

import { addressLimitKey, clientIpFromHeaders } from '../../src/auth/client-address.js';
import {
  isKnownDevice,
  issueKnownDevice,
  knownDeviceSetCookie,
} from '../../src/auth/known-device.js';
import {
  createPasswordCheckGate,
  PASSWORD_CHECK_QUEUE_LIMIT,
  PasswordCheckOverloadedError,
} from '../../src/auth/password-check-gate.js';
import { sanitizeUntrusted } from '../../src/auth/security-events.js';
import type { DI } from '../../src/di.js';
import { hasSignedSessionCookie } from '../../src/middleware/api-flood-limit.js';
import { crossSiteRequestGuard } from '../../src/middleware/cross-site-request-guard.js';
import type { Env } from '../../src/types.js';

import { HAS_INFRA, setupApp, type ApiFixture } from '../_helpers.js';

// `hono/bun`, which `createApp` reaches through the WebSocket router, reads the `Bun` global at import; vitest runs under Node. Stubbed, as body-limit.test.ts does, so the real middleware chain can be built.
vi.stubGlobal('Bun', { write: async () => undefined });
const { createApp } = await import('../../src/app.js');

describe('address keys', () => {
  it('keys IPv4 by address, groups IPv6 by /64 with a /48 wider tier, and folds IPv4-mapped IPv6 onto IPv4', () => {
    expect(addressLimitKey('198.51.100.7')).toEqual({ key: 'v4:198.51.100.7', wideKey: null });
    const v6 = addressLimitKey('2001:db8:1:2:aaaa::1');
    expect(v6.key).toBe(addressLimitKey('2001:db8:1:2:ffff::9').key);
    expect(v6.key).not.toBe(addressLimitKey('2001:db8:1:3::1').key);
    expect(v6.wideKey).toBe(addressLimitKey('2001:db8:1:3::1').wideKey);
    expect(addressLimitKey('::ffff:198.51.100.7').key).toBe('v4:198.51.100.7');
  });

  it('puts anything that is not an address into one shared bucket rather than a key per string', () => {
    expect(addressLimitKey('unknown').key).toBe(addressLimitKey('not an ip').key);
  });

  it('trusts only the rightmost forwarded hop', () => {
    expect(clientIpFromHeaders(new Headers({ 'x-forwarded-for': '6.6.6.6, 203.0.113.9' }))).toBe(
      '203.0.113.9',
    );
  });
});

describe('password check gate', () => {
  it('never runs more hashes at once than the capacity, and refuses at once past the wait queue', async () => {
    let peak = 0;
    let live = 0;
    const gate = createPasswordCheckGate(async () => 2);
    const releases: Array<() => void> = [];
    const hash = (): Promise<void> =>
      gate.run(async () => {
        live += 1;
        peak = Math.max(peak, live);
        await new Promise<void>((resolve) => releases.push(resolve));
        live -= 1;
      });
    const admitted = Array.from({ length: 2 + PASSWORD_CHECK_QUEUE_LIMIT }, hash);
    await new Promise((resolve) => setTimeout(resolve, 10));
    await expect(hash()).rejects.toBeInstanceOf(PasswordCheckOverloadedError);
    // Drain: each release lets exactly one waiter in.
    while (releases.length > 0 || live > 0) {
      releases.shift()?.();
      await new Promise((resolve) => setTimeout(resolve, 1));
    }
    await Promise.all(admitted);
    expect(peak).toBe(2);
    expect(gate.inFlight()).toBe(0);
  });

  it('frees its slot when the check throws', async () => {
    const gate = createPasswordCheckGate(async () => 1);
    await expect(gate.run(async () => Promise.reject(new Error('boom')))).rejects.toThrow('boom');
    expect(gate.inFlight()).toBe(0);
    await expect(gate.run(async () => 'ok')).resolves.toBe('ok');
  });
});

describe('known-device mark', () => {
  const SECRET = 's'.repeat(32);
  const LIFETIME = 30 * 86_400_000;

  it('is valid only for the same operator, epoch, secret and before expiry', () => {
    const now = 1_000_000;
    const mark = issueKnownDevice(SECRET, 'user-1', 3, LIFETIME, now);
    expect(isKnownDevice(SECRET, mark, 'user-1', 3, now + 1)).toBe(true);
    expect(isKnownDevice(SECRET, mark, 'user-2', 3, now + 1)).toBe(false);
    // Sign-out-everywhere raises the epoch, which forgets every device.
    expect(isKnownDevice(SECRET, mark, 'user-1', 4, now + 1)).toBe(false);
    expect(isKnownDevice('t'.repeat(32), mark, 'user-1', 3, now + 1)).toBe(false);
    expect(isKnownDevice(SECRET, mark, 'user-1', 3, now + LIFETIME + 1)).toBe(false);
  });

  it('refuses a tampered payload and junk values without throwing', () => {
    const mark = issueKnownDevice(SECRET, 'user-1', 0, LIFETIME);
    const [body, mac] = mark.split('.');
    const forged = Buffer.from(
      JSON.stringify({ u: 'user-1', e: 0, x: Date.now() + LIFETIME * 10, n: 'x' }),
    ).toString('base64url');
    expect(isKnownDevice(SECRET, `${forged}.${mac}`, 'user-1', 0)).toBe(false);
    expect(isKnownDevice(SECRET, `${body}.`, 'user-1', 0)).toBe(false);
    for (const junk of ['', '.', 'abc', '..', `${body}`])
      expect(isKnownDevice(SECRET, junk, 'user-1', 0)).toBe(false);
  });

  it('is an HttpOnly, strict, secure-when-asked cookie', () => {
    const cookie = knownDeviceSetCookie('v', LIFETIME, true);
    expect(cookie).toContain('HttpOnly');
    expect(cookie).toContain('SameSite=Strict');
    expect(cookie).toContain('Secure');
    expect(knownDeviceSetCookie('v', LIFETIME, false)).not.toContain('Secure');
  });
});

describe('notification sanitiser', () => {
  it('renders a hostile user agent inert: no extra lines, no links, capped', () => {
    const hostile =
      'Mozilla\n*Method*: password\u2028<!channel> <http://evil.example|click> https://evil.example/x';
    const out = sanitizeUntrusted(hostile);
    expect(out).not.toMatch(new RegExp('[\n\r\u2028\u2029]'));
    expect(out).not.toContain('://');
    expect(out).not.toContain('evil.example');
    expect(sanitizeUntrusted('a'.repeat(1000))).toHaveLength(256);
  });
});

describe('cross-site request guard', () => {
  const guarded = () => {
    const record = vi.fn(async () => undefined);
    const di = {
      env: { WEB_ORIGIN: ['https://bot.example.test'], PUBLIC_BASE_URL: undefined },
      security: { events: { record } },
    } as unknown as DI;
    const app = new Hono<Env>();
    app.use('/api/*', crossSiteRequestGuard(di));
    app.all('/api/*', (c) => c.text('reached'));
    return { app, record };
  };

  it.each([
    ['a foreign Origin', { origin: 'https://evil.example' }],
    ['an opaque null Origin', { origin: 'null' }],
    ['a browser reporting a cross-site request', { 'sec-fetch-site': 'cross-site' }],
  ])('refuses a state-changing request with %s and records it', async (_label, headers) => {
    const { app, record } = guarded();
    const res = await app.request('/api/accounts', { method: 'POST', headers });
    expect(res.status).toBe(403);
    expect(record).toHaveBeenCalledWith(
      expect.objectContaining({ event: 'cross-site-request-blocked' }),
    );
  });

  it.each([
    [
      'the app origin',
      'POST',
      '/api/accounts',
      { origin: 'https://bot.example.test', 'sec-fetch-site': 'same-origin' },
    ],
    ['a non-browser client that sends neither header', 'POST', '/api/accounts', {}],
    ['a safe method from anywhere', 'GET', '/api/accounts', { origin: 'https://evil.example' }],
    [
      'the agent token endpoint, which agents call cross-site by design',
      'POST',
      '/api/auth/oauth2/token',
      { origin: 'https://agent.example' },
    ],
    ['the agent endpoint', 'POST', '/api/mcp', { origin: 'https://agent.example' }],
  ])('lets through %s', async (_label, method, path, headers) => {
    const { app } = guarded();
    expect((await app.request(path, { method, headers })).status).toBe(200);
  });
});

describe('pre-session guards run before the session lookup', () => {
  const stubDi = (refuseFlood: boolean, mcpEnabled = false) => {
    const getSession = vi.fn(async () => null);
    const checkApiFlood = vi.fn(async () =>
      refuseFlood ? { limit: 'anonymous_api', reason: 'anonymous_api', retryAfterMs: 1500 } : null,
    );
    const di = {
      env: {
        WEB_ORIGIN: ['http://local.test'],
        WEB_DIST_DIR: null,
        LIVE_DEMO: false,
        AUTH_SECRET: 'x'.repeat(32),
        MCP_ENABLED: mcpEnabled,
        MCP_RESOURCE_URL: 'http://localhost/api/mcp',
      },
      logger: {
        info: () => undefined,
        warn: () => undefined,
        error: () => undefined,
        debug: () => undefined,
        child() {
          return this;
        },
      },
      metrics: createMetricsRegistry({ service: 'api-test' }),
      redis: {},
      db: {},
      auth: { handler: async () => new Response(null, { status: 404 }), api: { getSession } },
      security: {
        settings: {},
        events: { record: async () => undefined },
        protection: { checkApiFlood },
      },
      demoOperatorId: null,
    } as unknown as DI;
    return { app: createApp(di).app, getSession, checkApiFlood };
  };

  it('answers a flood with 429 and a retry time without looking the session up', async () => {
    const { app, getSession } = stubDi(true);
    const res = await app.request('/api/accounts', {
      headers: { cookie: 'app.session_token=forged.sig' },
    });
    expect(res.status).toBe(429);
    expect(res.headers.get('retry-after')).toBe('2');
    expect(getSession).not.toHaveBeenCalled();
  });

  it('leaves the MCP route to meter its own callers, and only that route', async () => {
    // An agent carries a bearer token, never a session cookie, so this limit would put every verified agent on the anonymous budget. The route charges unproven callers itself.
    // A caller without a token is charged exactly once, by the route. Charged here as well, it would pay twice and a verified agent would be on this budget too.
    const { app, checkApiFlood } = stubDi(false, true);
    await app.request('/api/mcp', { method: 'POST' });
    expect(checkApiFlood).toHaveBeenCalledTimes(1);
    const refusing = stubDi(true, true).app;
    for (const path of ['/api/mcp/', '/api/mcpx', '/api/mcp/tools']) {
      const res = await refusing.request(path, { method: 'POST' });
      expect(res.status, path).toBe(429);
    }
  });

  it('meters the MCP path like any other while MCP is switched off', async () => {
    // Nothing is mounted there, so the path is an ordinary 404 and must not be the one unmetered address.
    const { app } = stubDi(true, false);
    const res = await app.request('/api/mcp', { method: 'POST' });
    expect(res.status).toBe(429);
  });

  it('refuses a cross-site write without looking the session up', async () => {
    const { app, getSession } = stubDi(false);
    const res = await app.request('/api/accounts', {
      method: 'POST',
      headers: { origin: 'https://evil.example' },
    });
    expect(res.status).toBe(403);
    expect(getSession).not.toHaveBeenCalled();
  });
});

const describeIfInfra = HAS_INFRA ? describe : describe.skip;

describeIfInfra('signed session cookie check', () => {
  let fx: ApiFixture;
  let cookie: string;

  beforeAll(async () => {
    fx = await setupApp({ seed: false });
    const res = await fx.app.request('/api/auth/sign-up', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        email: 'cookie@example.test',
        password: 'cookie-operator-password',
        name: 'Operator',
      }),
    });
    expect(res.status).toBe(200);
    cookie = res.headers
      .getSetCookie()
      .map((c) => c.split(';')[0])
      .join('; ');
  });
  afterAll(async () => {
    await fx.cleanup();
  });

  it('accepts the cookie Better Auth really issues, and refuses a forged or unsigned one, with no database read', () => {
    // Against a real cookie, so a change in Better Auth's signing format fails here instead of silently putting every signed-in operator on the anonymous budget.
    expect(cookie).toMatch(/app\.session_token=/);
    expect(hasSignedSessionCookie(new Headers({ cookie }), fx.di.env.AUTH_SECRET)).toBe(true);
    expect(hasSignedSessionCookie(new Headers({ cookie }), 'y'.repeat(32))).toBe(false);
    expect(
      hasSignedSessionCookie(
        new Headers({ cookie: 'app.session_token=abc.ZmFrZQ%3D%3D' }),
        fx.di.env.AUTH_SECRET,
      ),
    ).toBe(false);
    expect(
      hasSignedSessionCookie(
        new Headers({ cookie: 'app.session_token=abc' }),
        fx.di.env.AUTH_SECRET,
      ),
    ).toBe(false);
    expect(hasSignedSessionCookie(new Headers({}), fx.di.env.AUTH_SECRET)).toBe(false);
  });
});
