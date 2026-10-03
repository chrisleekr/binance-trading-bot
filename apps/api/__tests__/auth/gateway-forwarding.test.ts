// What the auth gateway does with a request it lets through: which limit it counts against, what a refusal looks like, and which agent-authorization events it records. The topology test proves WHICH paths are reachable; these cases prove what happens on them.

import { Hono } from 'hono';
import { afterEach, describe, expect, it, vi } from 'vitest';

import type { DI } from '../../src/di.js';
import { authGateway, callbackReason, knownDeviceCookieFor } from '../../src/auth/gateway.js';
import { isKnownDevice, issueKnownDevice } from '../../src/auth/known-device.js';
import type { Env } from '../../src/types.js';

interface Options {
  readonly mcp?: boolean;
  readonly refuse?: number | null;
  readonly status?: number;
}

const setUp = (o: Options = {}) => {
  const record = vi.fn(async () => undefined);
  const checkAddressLimit = vi.fn(async () =>
    o.refuse == null ? null : { retryAfterMs: o.refuse },
  );
  const seenBodies: string[] = [];
  const handler = vi.fn(async (request: Request) => {
    seenBodies.push(await request.text());
    return new Response('{}', {
      status: o.status ?? 200,
      headers: { 'content-type': 'application/json' },
    });
  });
  const di = {
    env: {
      MCP_ENABLED: o.mcp ?? true,
      MCP_RESOURCE_URL: o.mcp === false ? undefined : 'https://bot.example.test/api/mcp',
    },
    security: {
      singleSignOn: null,
      singleSignOnAvailable: false,
      events: { record },
      protection: { checkAddressLimit },
    },
    auth: { handler },
  } as unknown as DI;
  const app = new Hono<Env>();
  app.all('/api/auth/*', authGateway(di));
  return { app, record, checkAddressLimit, handler, seenBodies };
};

const eventsOf = (record: ReturnType<typeof vi.fn>): unknown[] =>
  record.mock.calls.map((c) => (c[0] as { event: string }).event);

const form = (body: Record<string, string>): RequestInit => ({
  method: 'POST',
  headers: {
    'content-type': 'application/x-www-form-urlencoded',
    'x-forwarded-for': '198.51.100.7, 203.0.113.4',
  },
  body: new URLSearchParams(body).toString(),
});

const json = (body: unknown): RequestInit => ({
  method: 'POST',
  headers: { 'content-type': 'application/json' },
  body: JSON.stringify(body),
});

describe('authGateway forwarding', () => {
  afterEach(() => vi.clearAllMocks());

  it('answers 404 and records the probe for a path it does not expose', async () => {
    const { app, record, handler } = setUp();
    const res = await app.request('/api/auth/verify-password', json({ password: 'x' }));
    expect(res.status).toBe(404);
    expect(handler).not.toHaveBeenCalled();
    expect(record).toHaveBeenCalledWith(
      expect.objectContaining({
        event: 'auth-endpoint-denied',
        detail: { path: '/verify-password', method: 'POST' },
      }),
    );
  });

  it('hides the agent endpoints entirely while the control plane is off', async () => {
    const { app, handler } = setUp({ mcp: false });
    expect((await app.request('/api/auth/jwks')).status).toBe(404);
    expect((await app.request('/api/auth/oauth2/token', form({ client_id: 'c' }))).status).toBe(
      404,
    );
    expect(handler).not.toHaveBeenCalled();
  });

  it('counts the token endpoint per agent as well as per address, and still forwards the untouched body', async () => {
    const { app, checkAddressLimit, seenBodies } = setUp();
    const res = await app.request(
      '/api/auth/oauth2/token',
      form({ grant_type: 'refresh_token', client_id: 'https://agent.example.test/meta' }),
    );
    expect(res.status).toBe(200);
    expect(checkAddressLimit).toHaveBeenCalledWith(
      'agent_token',
      expect.objectContaining({ ipAddress: '203.0.113.4' }),
      'https://agent.example.test/meta',
    );
    expect(seenBodies[0]).toContain('client_id=');
  });

  it('counts a token request with no client id against the address alone', async () => {
    const { app, checkAddressLimit } = setUp();
    await app.request('/api/auth/oauth2/token', form({ grant_type: 'refresh_token' }));
    expect(checkAddressLimit).toHaveBeenCalledWith('agent_token', expect.anything(), undefined);
  });

  it('refuses an agent over its limit with a 429 and a Retry-After, without reaching Better Auth', async () => {
    const { app, handler, record } = setUp({ refuse: 2500 });
    const res = await app.request('/api/auth/oauth2/token', form({ client_id: 'c' }));
    expect(res.status).toBe(429);
    expect(res.headers.get('retry-after')).toBe('3');
    expect(handler).not.toHaveBeenCalled();
    expect(eventsOf(record)).not.toContain('agent-token-issued');
  });

  it('sends a refused browser navigation back to the sign-in page instead of showing raw JSON', async () => {
    const { app, handler } = setUp({ refuse: 1000 });
    const res = await app.request('/api/auth/oauth2/authorize?client_id=c');
    expect(res.status).toBe(302);
    expect(res.headers.get('location')).toBe('/login?error=rate_limited');
    expect(handler).not.toHaveBeenCalled();
  });

  it('never limits the key endpoint the resource server verifies against', async () => {
    const { app, checkAddressLimit, handler } = setUp({ refuse: 1000 });
    expect((await app.request('/api/auth/jwks')).status).toBe(200);
    expect(checkAddressLimit).not.toHaveBeenCalled();
    expect(handler).toHaveBeenCalledOnce();
  });

  it.each([
    [true, 'agent-consent-granted'],
    [false, 'agent-consent-denied'],
  ])('records the operator’s consent choice accept=%s', async (accept, event) => {
    const { app, record, seenBodies } = setUp();
    await app.request('/api/auth/oauth2/consent', json({ accept }));
    expect(eventsOf(record)).toEqual([event]);
    expect(JSON.parse(seenBodies[0] ?? '{}')).toEqual({ accept });
  });

  it('records no consent when the body carries no choice', async () => {
    const { app, record } = setUp();
    await app.request('/api/auth/oauth2/consent', json({ scope: 'mcp:read' }));
    expect(record).not.toHaveBeenCalled();
  });

  it('records nothing for a consent or token request Better Auth rejected', async () => {
    const { app, record } = setUp({ status: 400 });
    await app.request('/api/auth/oauth2/consent', json({ accept: true }));
    await app.request('/api/auth/oauth2/token', form({ client_id: 'c' }));
    expect(record).not.toHaveBeenCalled();
  });

  it('records each issued agent token', async () => {
    const { app, record } = setUp();
    await app.request('/api/auth/oauth2/token', form({ client_id: 'c' }));
    expect(record).toHaveBeenCalledWith(
      expect.objectContaining({ event: 'agent-token-issued', ipAddress: '203.0.113.4' }),
    );
  });
});

describe('callbackReason', () => {
  it.each([
    ['state_mismatch', 'state_mismatch'],
    ['state_not_found', 'state_mismatch'],
    ['invalid_callback_request', 'state_mismatch'],
    ['access_denied', 'access_denied'],
    ['invalid_code', 'invalid_code'],
    ['no_code', 'invalid_code'],
    ['account not linked', 'account_not_linked'],
    ['account_not_linked', 'account_not_linked'],
    ['signup disabled', 'sign_up_refused'],
    ['signup_disabled', 'sign_up_refused'],
    ['unable_to_create_user', 'sign_up_refused'],
    ['issuer_mismatch', 'issuer_mismatch'],
    ['email_not_verified', 'email_not_verified'],
    ['unable_to_create_session', 'session_refused'],
    ['<script>', 'other'],
    [null, 'other'],
  ])(
    'maps %s to %s, so an attacker-chosen error never reaches a log or notification verbatim',
    (code, reason) => {
      expect(callbackReason(code)).toBe(reason);
    },
  );
});

describe('knownDeviceCookieFor', () => {
  const SECRET = 'x'.repeat(32);
  const DAY_MS = 86_400_000;
  const di = {
    env: { AUTH_SECRET: SECRET, NODE_ENV: 'test' },
    security: {
      settings: {
        get: async () => ({ securityEpoch: 3, settings: { knownDeviceLifetimeDays: 30 } }),
      },
    },
  } as unknown as DI;

  it('re-issues a still-valid mark on every sign-in, so a browser that keeps signing in stays recognised past its first mark’s expiry', async () => {
    const now = Date.now();
    // Issued 20 days ago with a 30-day lifetime: valid today, expired 10 days from now.
    const existing = issueKnownDevice(SECRET, 'user-1', 3, 30 * DAY_MS, now - 20 * DAY_MS);
    expect(isKnownDevice(SECRET, existing, 'user-1', 3, now)).toBe(true);

    // The browser presents a still-valid mark; the sign-in must hand back a fresh one rather than keep the old expiry.
    const header = await knownDeviceCookieFor(di, 'user-1');
    const refreshed = /^app\.known_device=([^;]+);.*Max-Age=2592000/.exec(header)?.[1];
    expect(refreshed).toBeDefined();
    expect(refreshed).not.toBe(existing);
    const later = now + 25 * DAY_MS;
    expect(isKnownDevice(SECRET, existing, 'user-1', 3, later)).toBe(false);
    expect(isKnownDevice(SECRET, refreshed, 'user-1', 3, later)).toBe(true);
  });
});
