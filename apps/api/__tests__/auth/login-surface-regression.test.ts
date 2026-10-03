import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import { HAS_INFRA, setupApp, type ApiFixture } from '../_helpers.js';

const describeIfInfra = HAS_INFRA ? describe : describe.skip;

const OPERATOR = { email: 'operator@example.test', password: 'operator-password-123' };

// Regression suite for the pre-hardening login surface: each case failed against the catch-all router, where every Better Auth endpoint was reachable over HTTP.
describeIfInfra('login surface regressions', () => {
  let fx: ApiFixture;
  let cookie: string;

  const post = async (
    path: string,
    body: unknown,
    headers: Record<string, string> = {},
  ): Promise<Response> =>
    fx.app.request(`/api/auth${path}`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', ...headers },
      body: JSON.stringify(body),
    });

  beforeAll(async () => {
    fx = await setupApp({ seed: false });
    const signUp = await post('/sign-up', OPERATOR);
    expect(signUp.status).toBe(200);
    cookie = signUp.headers
      .getSetCookie()
      .map((entry) => entry.split(';')[0])
      .join('; ');
  });

  afterAll(async () => {
    await fx.cleanup();
  });

  it("refuses a second operator through Better Auth's native sign-up path", async () => {
    const res = await post('/sign-up/email', {
      email: 'intruder@example.test',
      password: 'intruder-password-123',
      name: 'Intruder',
    });
    expect(res.status).toBeGreaterThanOrEqual(400);
    const users = await fx.di.pool.query<{ n: string }>('select count(*)::text as n from "user"');
    expect(users.rows[0]?.n).toBe('1');
  });

  it.each([
    ['POST', '/verify-password'],
    ['POST', '/change-email'],
    ['GET', '/list-sessions'],
    ['POST', '/update-user'],
    ['POST', '/unlink-account'],
    ['GET', '/list-accounts'],
    ['POST', '/get-access-token'],
    ['POST', '/request-password-reset'],
    ['GET', '/get-session'],
  ])('does not expose Better Auth %s %s over HTTP', async (method, path) => {
    const res = await fx.app.request(`/api/auth${path}`, {
      method,
      headers: { 'content-type': 'application/json', cookie },
      ...(method === 'POST' ? { body: JSON.stringify({ password: OPERATOR.password }) } : {}),
    });
    expect(res.status).toBe(404);
  });

  it('keeps the session token out of the sign-in response body', async () => {
    const res = await post('/sign-in/email', OPERATOR);
    expect(res.status).toBe(200);
    const body = (await res.json()) as Record<string, unknown>;
    expect(body).not.toHaveProperty('token');
    expect(res.headers.getSetCookie().some((c) => c.includes('session_token'))).toBe(true);
  });
});
