// Single sign-on end to end against a mock OpenID Connect provider: a real HTTP server publishing discovery and signing keys, issuing codes and RS256 ID tokens, so Better Auth's own code exchange, signature, audience and nonce checks run unmodified. Each refusal case varies exactly one thing about an otherwise valid login.

import { randomUUID } from 'node:crypto';
import { createServer, type Server } from 'node:http';
import type { AddressInfo } from 'node:net';

import { OpenAPIHono } from '@hono/zod-openapi';
import { exportJWK, generateKeyPair, SignJWT, type CryptoKey, type JWK } from 'jose';
import { pino } from 'pino';
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';

import { repo } from '@app/db';

import { createAuth } from '../../src/auth.js';
import {
  checkDiscovery,
  discoveryUrlFor,
  type SingleSignOnConfig,
} from '../../src/auth/single-sign-on.js';
import type { DI } from '../../src/di.js';
import { sessionResolver } from '../../src/middleware/auth.js';
import { errorHandler } from '../../src/middleware/error.js';
import { authRouter } from '../../src/routes/auth.js';
import type { Env } from '../../src/types.js';

import { HAS_INFRA, setupApp, type ApiFixture } from '../_helpers.js';

const BASE = 'http://localhost:3000';
const CLIENT_ID = 'client-under-test';

interface Login {
  sub?: string;
  email?: string;
  authTime?: number;
  omitIdToken?: boolean;
  /** Replaces the nonce the app asked for. */
  nonce?: string;
  /** Replaces the `iss` claim. */
  issuer?: string;
  /** Signs with a key the provider never published. */
  foreignKey?: boolean;
}

interface MockProvider {
  readonly issuer: string;
  /** Records what the next code should yield and returns it. */
  issueCode(nonce: string | null, login: Login): string;
  close(): Promise<void>;
}

const listen = async (server: Server): Promise<number> => {
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', () => resolve()));
  return (server.address() as AddressInfo).port;
};

/** A minimal OpenID provider: discovery, JWKS, and a token endpoint that answers for codes the test issued. */
const startProvider = async (): Promise<MockProvider> => {
  const { privateKey, publicKey } = await generateKeyPair('RS256');
  const foreign = await generateKeyPair('RS256');
  const jwk: JWK = { ...(await exportJWK(publicKey)), kid: 'k1', alg: 'RS256', use: 'sig' };
  const codes = new Map<string, { nonce: string | null; login: Login }>();
  let issuer = '';
  const sign = async (claims: Record<string, unknown>, key: CryptoKey): Promise<string> =>
    new SignJWT(claims).setProtectedHeader({ alg: 'RS256', kid: 'k1' }).sign(key);

  const server = createServer((req, res) => {
    const url = new URL(req.url ?? '/', issuer);
    const json = (status: number, body: unknown): void => {
      res.writeHead(status, { 'content-type': 'application/json' });
      res.end(JSON.stringify(body));
    };
    if (url.pathname === '/.well-known/openid-configuration') {
      json(200, {
        issuer,
        authorization_endpoint: `${issuer}/authorize`,
        token_endpoint: `${issuer}/token`,
        jwks_uri: `${issuer}/jwks`,
        userinfo_endpoint: `${issuer}/userinfo`,
        response_types_supported: ['code'],
        subject_types_supported: ['public'],
        id_token_signing_alg_values_supported: ['RS256'],
      });
      return;
    }
    if (url.pathname === '/jwks') {
      json(200, { keys: [jwk] });
      return;
    }
    if (url.pathname === '/userinfo') {
      json(200, { sub: 'from-userinfo', email: 'userinfo@example.test' });
      return;
    }
    if (url.pathname === '/token' && req.method === 'POST') {
      let raw = '';
      req.on('data', (chunk: Buffer) => (raw += chunk.toString()));
      req.on('end', () => {
        void (async () => {
          const code = new URLSearchParams(raw).get('code') ?? '';
          const pending = codes.get(code);
          codes.delete(code);
          if (pending === undefined) {
            json(400, { error: 'invalid_grant' });
            return;
          }
          const { login, nonce } = pending;
          const now = Math.floor(Date.now() / 1000);
          const idToken = await sign(
            {
              iss: login.issuer ?? issuer,
              aud: CLIENT_ID,
              sub: login.sub ?? 'sub-1',
              email: login.email ?? 'operator@example.test',
              email_verified: true,
              name: 'Operator',
              auth_time: login.authTime ?? now,
              iat: now,
              exp: now + 300,
              ...(login.nonce !== undefined
                ? { nonce: login.nonce }
                : nonce !== null
                  ? { nonce }
                  : {}),
            },
            login.foreignKey ? foreign.privateKey : privateKey,
          );
          json(200, {
            access_token: 'provider-access-token',
            refresh_token: 'provider-refresh-token',
            token_type: 'Bearer',
            expires_in: 300,
            ...(login.omitIdToken ? {} : { id_token: idToken }),
          });
        })();
      });
      return;
    }
    json(404, {});
  });
  const port = await listen(server);
  issuer = `http://127.0.0.1:${port}`;
  return {
    issuer,
    issueCode(nonce, login) {
      const code = randomUUID();
      codes.set(code, { nonce, login });
      return code;
    },
    close: () => new Promise((resolve) => server.close(() => resolve())),
  };
};

describe('provider discovery check', () => {
  it('gives up on a provider that never answers within the bound, instead of hanging boot', async () => {
    const server = createServer(() => undefined);
    const port = await listen(server);
    const started = Date.now();
    const result = await checkDiscovery(`http://127.0.0.1:${port}`, fetch, 200);
    expect(result).toEqual({ ok: false, reason: 'unreachable' });
    expect(Date.now() - started).toBeLessThan(2000);
    server.closeAllConnections();
    server.close();
  });

  it('refuses a document whose issuer differs from the configured one by even a trailing slash', async () => {
    const provider = await startProvider();
    expect(await checkDiscovery(provider.issuer)).toMatchObject({ ok: true });
    // The same document is fetched either way; only the exact comparison tells them apart, and ID tokens are compared the same way.
    expect(await checkDiscovery(`${provider.issuer}/`)).toEqual({
      ok: false,
      reason: 'issuer_mismatch',
    });
    await provider.close();
  });
});

const describeIfInfra = HAS_INFRA ? describe : describe.skip;

describeIfInfra('single sign-on against a mock provider', () => {
  let fx: ApiFixture;
  let provider: MockProvider;
  let app: OpenAPIHono<Env>;
  let di: DI;

  const cookiesOf = (res: Response): string[] =>
    res.headers.getSetCookie().map((c) => c.split(';')[0] ?? '');
  const events = async (event: string): Promise<Record<string, unknown>[]> =>
    (
      await fx.di.pool.query<{ payload: Record<string, unknown> }>(
        `select payload from audit_logs where category = 'security' and event = $1`,
        [event],
      )
    ).rows.map((r) => r.payload);

  /** Runs one login through start, the provider, and the callback. Returns the callback response and the cookies it set. */
  const login = async (
    variant: Login = {},
    start: Record<string, unknown> = { returnTo: '/dashboard' },
  ): Promise<{ res: Response; cookie: string; location: URL }> => {
    const started = await app.request('/api/auth/single-sign-on/start', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify(start),
    });
    expect(started.status).toBe(200);
    const { url } = (await started.json()) as { url: string };
    const authorize = new URL(url);
    expect(authorize.origin).toBe(provider.issuer);
    // The code comes back to the configured public origin, never to whatever host the request used.
    expect(authorize.searchParams.get('redirect_uri')).toBe(`${BASE}/api/auth/callback/oidc`);
    const code = provider.issueCode(authorize.searchParams.get('nonce'), variant);
    const state = authorize.searchParams.get('state') ?? '';
    const res = await app.request(
      `/api/auth/callback/oidc?code=${code}&state=${encodeURIComponent(state)}`,
      {
        headers: { cookie: cookiesOf(started).join('; ') },
      },
    );
    const cookie = cookiesOf(res)
      .filter((c) => c.includes('session_token'))
      .join('; ');
    return { res, cookie, location: new URL(res.headers.get('location') ?? '/', BASE) };
  };

  beforeAll(async () => {
    provider = await startProvider();
    fx = await setupApp({ seed: false });
    const config: SingleSignOnConfig = {
      issuer: provider.issuer,
      clientId: CLIENT_ID,
      clientSecret: 'client-secret',
      buttonLabel: 'Sign in with Mock',
    };
    const security = fx.di.security as { -readonly [K in keyof DI['security']]: DI['security'][K] };
    security.singleSignOn = config;
    security.singleSignOnAvailable = true;
    const auth = createAuth({
      db: fx.di.db,
      webOrigins: [BASE],
      authSecret: 'x'.repeat(32),
      isProduction: false,
      passwordSignIn: true,
      publicBaseUrl: BASE,
      singleSignOn: { ...config, discoveryUrl: discoveryUrlFor(config.issuer) },
      securityEpoch: async () => (await repo.authSecuritySettings.get(fx.di.db)).securityEpoch,
      events: fx.di.security.events,
    });
    di = {
      ...fx.di,
      auth,
      env: { ...fx.di.env, PUBLIC_BASE_URL: BASE, SINGLE_SIGN_ON_ENABLED: true },
    } as DI;
    app = new OpenAPIHono<Env>();
    app.onError(errorHandler(pino({ level: 'silent' })));
    app.use(
      '*',
      sessionResolver(auth, null, {
        db: fx.di.db,
        settings: fx.di.security.settings,
        events: fx.di.security.events,
      }),
    );
    app.route('/api/auth', authRouter(di));
  });
  /** Failed sign-ins fold into one row per reason per five minutes; clearing the open windows too means each case sees its own rows. */
  const clearSecurityEvents = async (): Promise<void> => {
    await fx.di.pool.query(`delete from audit_logs where category = 'security'`);
    const redis = fx.di.redis.raw();
    const windows = await redis.keys('auth:agg:*');
    if (windows.length > 0) await redis.del(...windows);
  };
  beforeEach(clearSecurityEvents);
  afterAll(async () => {
    const security = fx.di.security as { -readonly [K in keyof DI['security']]: DI['security'][K] };
    security.singleSignOn = null;
    security.singleSignOnAvailable = false;
    await fx.cleanup();
    await provider.close();
  });

  it('creates the operator through single sign-on when none exists, and stores no provider token', async () => {
    const { res, cookie, location } = await login();
    expect(res.status).toBe(302);
    expect(location.pathname).toBe('/dashboard');
    expect(location.searchParams.get('error')).toBeNull();
    expect(cookie).toMatch(/session_token=/);
    expect(cookiesOf(res).some((c) => c.startsWith('app.known_device='))).toBe(true);
    expect((await fx.di.pool.query(`select 1 from "user"`)).rowCount).toBe(1);
    const accounts = await fx.di.pool.query<{
      accountId: string;
      accessToken: string | null;
      refreshToken: string | null;
      idToken: string | null;
      providerEmail: string | null;
    }>(
      `select "accountId", "accessToken", "refreshToken", "idToken", "providerEmail" from account where "providerId" = 'oidc'`,
    );
    // Identity is issuer plus subject, and the provider's tokens are never kept; its email is kept only to show which account is linked.
    expect(accounts.rows).toEqual([
      {
        accountId: `${provider.issuer}|sub-1`,
        accessToken: null,
        refreshToken: null,
        idToken: null,
        providerEmail: 'operator@example.test',
      },
    ]);
    expect(await events('onboarding-complete')).toEqual([
      expect.objectContaining({
        method: 'singleSignOn',
        detail: { account: 'operator@example.test' },
      }),
    ]);
    expect((await app.request('/api/auth/session', { headers: { cookie } })).status).toBe(200);
  });

  it('signs the same identity in again and records it, naming the provider account', async () => {
    const { res, cookie } = await login();
    expect(res.status).toBe(302);
    expect(cookie).toMatch(/session_token=/);
    expect(await events('sign-in-succeeded')).toEqual([
      expect.objectContaining({
        method: 'singleSignOn',
        detail: { account: 'operator@example.test' },
      }),
    ]);
  });

  const providerEmail = async (): Promise<string | null | undefined> =>
    (
      await fx.di.pool.query<{ providerEmail: string | null }>(
        `select "providerEmail" from account where "providerId" = 'oidc'`,
      )
    ).rows[0]?.providerEmail;

  it('shows the email the provider reports now, filling one never recorded and following a change, without it deciding who signs in', async () => {
    // An identity linked before the column existed has no email.
    await fx.di.pool.query(`update account set "providerEmail" = null where "providerId" = 'oidc'`);
    const { cookie } = await login({ email: 'renamed@example.test' });
    // The same subject still signs in: the email is shown, never matched on.
    expect(cookie).toMatch(/session_token=/);
    expect(await providerEmail()).toBe('renamed@example.test');
    const session = await app.request('/api/auth/session', { headers: { cookie } });
    expect(await session.json()).toMatchObject({
      singleSignOnLinked: true,
      singleSignOnEmail: 'renamed@example.test',
    });
    await login();
    expect(await providerEmail()).toBe('operator@example.test');
  });

  it('keeps the sign-in and its record when the email cannot be written', async () => {
    const record = vi
      .spyOn(repo.authIdentity, 'recordSingleSignOnEmail')
      .mockRejectedValueOnce(new Error('database unavailable'));
    try {
      const { cookie } = await login({ email: 'unwritten@example.test' });
      expect(record).toHaveBeenCalledOnce();
      expect(cookie).toMatch(/session_token=/);
      expect(await events('sign-in-succeeded')).toEqual([
        expect.objectContaining({ method: 'singleSignOn' }),
      ]);
      expect(await providerEmail()).toBe('operator@example.test');
    } finally {
      record.mockRestore();
    }
  });

  it.each<[string, Login, string]>([
    [
      'another identity at the provider, even with the operator email',
      { sub: 'sub-2' },
      'account_not_linked',
    ],
    ['a token response with no ID token', { omitIdToken: true }, 'missing_id_token'],
  ])('refuses %s, creates nothing and records why', async (_label, variant, reason) => {
    const { res, cookie, location } = await login(variant);
    expect(cookie).toBe('');
    expect(location.pathname).toBe('/login');
    expect(location.searchParams.get('error')).toEqual(
      reason === 'account_not_linked' ? expect.any(String) : reason,
    );
    expect(res.status).toBe(302);
    expect((await fx.di.pool.query(`select 1 from "user"`)).rowCount).toBe(1);
    expect(
      (await fx.di.pool.query(`select 1 from account where "providerId" = 'oidc'`)).rowCount,
    ).toBe(1);
    const failed = await events('sign-in-failed');
    expect(failed).toHaveLength(1);
    expect(failed[0]).toMatchObject({
      method: 'singleSignOn',
      ...(reason === 'account_not_linked' ? {} : { reason }),
    });
  });

  it.each<[string, Login]>([
    ['an ID token signed by a key the provider never published', { foreignKey: true }],
    ['an ID token bound to a different nonce', { nonce: 'replayed-nonce' }],
    ['an ID token from a different issuer', { issuer: 'http://127.0.0.1:1' }],
  ])('refuses %s', async (_label, variant) => {
    const { cookie, location } = await login(variant);
    expect(cookie).toBe('');
    expect(location.pathname).toBe('/login');
    expect(location.searchParams.get('error')).not.toBeNull();
    expect(await events('sign-in-failed')).toHaveLength(1);
  });

  it('refuses a callback whose state this browser did not start', async () => {
    const code = provider.issueCode(null, {});
    const res = await app.request(`/api/auth/callback/oidc?code=${code}&state=forged-state`);
    expect(
      new URL(res.headers.get('location') ?? '/', BASE).searchParams.get('error'),
    ).not.toBeNull();
    expect(await events('sign-in-failed')).toEqual([
      expect.objectContaining({ reason: 'state_mismatch' }),
    ]);
  });

  it('asks the provider for a fresh login when re-authenticating, and accepts only a recent one', async () => {
    const started = await app.request('/api/auth/single-sign-on/start', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ reauthenticate: true }),
    });
    const url = new URL(((await started.json()) as { url: string }).url);
    expect(url.searchParams.get('prompt')).toBe('login');
    expect(url.searchParams.get('max_age')).toBe('0');

    const stale = await login({ authTime: Math.floor(Date.now() / 1000) - 600 });
    const refused = await app.request('/api/auth/sign-out-everywhere', {
      method: 'POST',
      headers: { 'content-type': 'application/json', cookie: stale.cookie },
      body: JSON.stringify({ reauthentication: { method: 'singleSignOn' } }),
    });
    expect(refused.status).toBe(403);

    const fresh = await login();
    const accepted = await app.request('/api/auth/sign-out-everywhere', {
      method: 'POST',
      headers: { 'content-type': 'application/json', cookie: fresh.cookie },
      body: JSON.stringify({ reauthentication: { method: 'singleSignOn' } }),
    });
    expect(accepted.status).toBe(204);
  });

  it('lets a single sign-on operator add a password, unlink only while a password still gets them in, and link again', async () => {
    const post = (path: string, cookie: string, body: unknown): Promise<Response> =>
      Promise.resolve(
        app.request(`/api/auth${path}`, {
          method: 'POST',
          headers: { 'content-type': 'application/json', cookie },
          body: JSON.stringify(body),
        }),
      );
    const providers = async (): Promise<string[]> =>
      (
        await fx.di.pool.query<{ providerId: string }>(
          `select "providerId" from account order by 1`,
        )
      ).rows.map((r) => r.providerId);

    // Onboarded through single sign-on, so no password exists yet; a fresh provider login is the proof of presence.
    const sso = await login();
    const added = await post('/password', sso.cookie, {
      newPassword: 'operator-password-123',
      reauthentication: { method: 'singleSignOn' },
    });
    expect(added.status).toBe(204);
    expect(await providers()).toEqual(['credential', 'oidc']);
    expect(await events('password-set')).toEqual([
      expect.objectContaining({ method: 'singleSignOn' }),
    ]);
    expect(
      (
        await post('/password', sso.cookie, {
          newPassword: 'another-password-123',
          reauthentication: { method: 'singleSignOn' },
        })
      ).status,
    ).toBe(409);

    const signedIn = await post('/sign-in/email', '', {
      email: 'operator@example.test',
      password: 'operator-password-123',
    });
    expect(signedIn.status).toBe(200);
    const passwordCookie = cookiesOf(signedIn)
      .filter((c) => c.includes('session_token'))
      .join('; ');
    const withPassword = {
      reauthentication: { method: 'password', password: 'operator-password-123' },
    };

    // With password sign-in switched off, the password cannot get the operator in, so single sign-on is still the only way and must stay.
    const security = fx.di.security as { -readonly [K in keyof DI['security']]: DI['security'][K] };
    security.passwordSignIn = false;
    try {
      expect((await post('/single-sign-on/unlink', passwordCookie, withPassword)).status).toBe(409);
    } finally {
      security.passwordSignIn = true;
    }
    expect(await providers()).toEqual(['credential', 'oidc']);

    expect((await post('/single-sign-on/unlink', passwordCookie, withPassword)).status).toBe(204);
    expect(await providers()).toEqual(['credential']);
    expect(await events('single-sign-on-unlinked')).toHaveLength(1);
    // Unlinked means the provider identity no longer signs anyone in.
    expect((await login()).cookie).toBe('');

    // Linking needs the password too, and hands back the provider's authorization address.
    expect(
      (
        await post('/single-sign-on/link', passwordCookie, {
          reauthentication: { method: 'password', password: 'wrong-password-123' },
        })
      ).status,
    ).toBe(403);
    const linkStart = await post('/single-sign-on/link', passwordCookie, withPassword);
    expect(linkStart.status).toBe(200);
    const authorize = new URL(((await linkStart.json()) as { url: string }).url);
    expect(authorize.origin).toBe(provider.issuer);
    const code = provider.issueCode(authorize.searchParams.get('nonce'), {
      email: 'linked@example.test',
    });
    // The refused login after unlinking recorded a failure; only the link callback's own events count below.
    await clearSecurityEvents();
    const linked = await app.request(
      `/api/auth/callback/oidc?code=${code}&state=${encodeURIComponent(authorize.searchParams.get('state') ?? '')}`,
      { headers: { cookie: [passwordCookie, ...cookiesOf(linkStart)].join('; ') } },
    );
    expect(linked.status).toBe(302);
    expect(
      new URL(linked.headers.get('location') ?? '/', BASE).searchParams.get('error'),
    ).toBeNull();
    expect(await providers()).toEqual(['credential', 'oidc']);
    // A link creates no session, so this was written when the identity was created, not by a sign-in.
    expect(await providerEmail()).toBe('linked@example.test');
    // A link creates no session, which must not be mistaken for a failed sign-in.
    expect(await events('single-sign-on-linked')).toEqual([
      expect.objectContaining({ detail: { account: 'linked@example.test' } }),
    ]);
    expect(await events('sign-in-failed')).toEqual([]);
    expect((await login()).cookie).toMatch(/session_token=/);
  });
});
