// The auth gateway is a default-deny allow-list in front of Better Auth. Before it, a catch-all forwarded every Better Auth endpoint, which exposed an unthrottled password oracle, email change, session tokens and OAuth client administration. These cases enumerate what Better Auth ACTUALLY registers, with every plugin this app can enable, so an upgrade that adds an endpoint fails here until someone decides whether a browser or agent may reach it.

import { readdirSync, readFileSync, statSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import { createAuth } from '../../src/auth.js';
import { AUTH_PASSTHROUGH } from '../../src/auth/gateway.js';

import { HAS_INFRA, setupApp, type ApiFixture } from '../_helpers.js';

const RESOURCE = 'https://bot.example.test/api/mcp';

/** A database stand-in whose every query resolves to no rows. Better Auth starts background reads (signing keys, the adapter) as soon as it is built; an empty answer lets them finish instead of raising unhandled errors, and nothing here depends on their result. */
const inertDb: unknown = new Proxy(() => undefined, {
  get: (_target, prop) =>
    prop === 'then' ? (resolve: (rows: unknown[]) => void) => resolve([]) : inertDb,
  apply: () => inertDb,
});

/** Built with every optional plugin on, so the enumeration covers the widest surface this app can have. */
const fullAuth = () =>
  createAuth({
    db: inertDb as never,
    webOrigins: ['http://localhost:5173'],
    authSecret: 'x'.repeat(32),
    isProduction: false,
    mcpResource: RESOURCE,
    publicBaseUrl: 'https://bot.example.test',
    singleSignOn: {
      issuer: 'https://idp.example.test/',
      clientId: 'client',
      clientSecret: 'secret',
      buttonLabel: 'Single sign-on',
      discoveryUrl: 'https://idp.example.test/.well-known/openid-configuration',
    },
  } as never);

interface Endpoint {
  readonly name: string;
  readonly path: string;
  readonly methods: readonly string[];
}

/** Every endpoint Better Auth serves over HTTP. Server-only ones have no route, so they are not surface. */
const httpEndpoints = (): Endpoint[] =>
  Object.entries(
    fullAuth().api as Record<
      string,
      { path?: string; options?: { method?: unknown; metadata?: { SERVER_ONLY?: boolean } } }
    >,
  )
    .filter(([, e]) => typeof e.path === 'string' && e.options?.metadata?.SERVER_ONLY !== true)
    .map(([name, e]) => {
      const method = e.options?.method;
      const methods = Array.isArray(method)
        ? method.map(String)
        : method === '*'
          ? ['GET', 'POST']
          : [String(method)];
      return { name, path: e.path as string, methods };
    });

/**
 * Better Auth endpoints no browser or agent may reach directly. Each is either replaced by this app's own route (which calls Better Auth server-side with a strict body, limits and an audit trail) or has no use here and would widen the surface. Adding a name here is a security decision; say why in the review.
 */
const DENIED = new Set([
  // Replaced by /api/auth/sign-in/email, /sign-up, /sign-out, /single-sign-on/start and /change-password, which apply limits and never return the session token in a body.
  '/sign-in/email',
  '/sign-up/email',
  '/sign-in/social',
  '/sign-out',
  '/change-password',
  '/get-session',
  // An unthrottled password oracle, and account changes this single-operator app does not offer.
  '/verify-password',
  '/change-email',
  '/update-user',
  '/delete-user',
  '/delete-user/callback',
  '/update-session',
  // No email: there is no reset or verification flow; recovery is the server command.
  '/reset-password',
  '/reset-password/:token',
  '/request-password-reset',
  '/verify-email',
  '/send-verification-email',
  // Sessions and linked identities are managed through this app's routes, which never expose tokens.
  '/list-sessions',
  '/revoke-session',
  '/revoke-sessions',
  '/revoke-other-sessions',
  '/link-social',
  '/list-accounts',
  '/unlink-account',
  '/account-info',
  // Identity provider tokens are never stored, and these would hand them out.
  '/refresh-token',
  '/get-access-token',
  '/token',
  // Agent client administration is closed: clients register through metadata documents, and nothing an agent or a browser needs is here.
  '/oauth2/register',
  '/oauth2/create-client',
  '/oauth2/get-client',
  '/oauth2/public-client',
  '/oauth2/public-client-prelogin',
  '/oauth2/get-clients',
  '/oauth2/update-client',
  '/oauth2/client/rotate-secret',
  '/oauth2/delete-client',
  '/oauth2/get-consent',
  '/oauth2/get-consents',
  '/oauth2/update-consent',
  '/oauth2/delete-consent',
  // Agent access is audience-bound JWTs checked locally; introspection, userinfo and logout are not flows this app uses.
  '/oauth2/continue',
  '/oauth2/introspect',
  '/oauth2/userinfo',
  '/oauth2/end-session',
  '/oauth2/end-session/confirm',
  // Better Auth's own diagnostics.
  '/ok',
  '/error',
]);

describe('auth gateway topology', () => {
  it('classifies every endpoint Better Auth serves as passed through or denied, and nothing twice', () => {
    const endpoints = httpEndpoints();
    // The enumeration must reach the plugin surfaces, or an empty list would pass everything below.
    expect(endpoints.map((e) => e.path)).toEqual(
      expect.arrayContaining(['/oauth2/token', '/callback/:id', '/verify-password']),
    );
    const passed = new Set(
      AUTH_PASSTHROUGH.map((p) => p.path.replace(/\/callback\/oidc$/, '/callback/:id')),
    );
    const unclassified = endpoints
      .filter((e) => !passed.has(e.path) && !DENIED.has(e.path))
      .map((e) => `${e.name} ${e.path}`);
    expect(unclassified).toEqual([]);
    const both = [...passed].filter((p) => DENIED.has(p));
    expect(both).toEqual([]);
    const stale = [...DENIED].filter((p) => !endpoints.some((e) => e.path === p));
    expect(stale).toEqual([]);
  });

  it('passes each allowed endpoint through only on a method Better Auth serves it on', () => {
    const endpoints = httpEndpoints();
    for (const p of AUTH_PASSTHROUGH) {
      const path = p.path.replace(/\/callback\/oidc$/, '/callback/:id');
      const served = endpoints.find((e) => e.path === path);
      expect(served?.methods, p.path).toContain(p.method);
    }
  });

  it('is the only place, with the discovery documents, that hands a request to Better Auth', () => {
    const srcRoot = fileURLToPath(new URL('../../src/', import.meta.url));
    const walk = (dir: string): string[] =>
      readdirSync(dir).flatMap((name) => {
        const full = join(dir, name);
        return statSync(full).isDirectory() ? walk(full) : full.endsWith('.ts') ? [full] : [];
      });
    const files = walk(srcRoot);
    expect(files.some((f) => f.endsWith('auth/gateway.ts'))).toBe(true);
    const callers = files.filter(
      (f) =>
        /\.handler\(/.test(readFileSync(f, 'utf8')) &&
        /auth\.handler|di\.auth\.handler/.test(readFileSync(f, 'utf8')),
    );
    expect(callers.map((f) => f.slice(srcRoot.length)).sort()).toEqual([
      'auth/gateway.ts',
      'routes/well-known.ts',
    ]);
  });
});

const describeIfInfra = HAS_INFRA ? describe : describe.skip;

describeIfInfra('auth gateway over HTTP', () => {
  let fx: ApiFixture;

  beforeAll(async () => {
    fx = await setupApp();
  });
  afterAll(async () => {
    await fx.cleanup();
  });

  it('answers 404 for every denied endpoint and records the probe', async () => {
    await fx.di.pool.query(`delete from audit_logs where category = 'security'`);
    for (const path of DENIED) {
      // Paths this app serves with its own route are reached by that route, not the gateway; the catalogue above covers them.
      if (['/sign-in/email', '/sign-out', '/change-password'].includes(path)) continue;
      const concrete = path.replace(':token', 'abc');
      for (const method of ['GET', 'POST']) {
        const res = await fx.app.request(`/api/auth${concrete}`, {
          method,
          headers: { 'content-type': 'application/json' },
          ...(method === 'POST' ? { body: '{}' } : {}),
        });
        expect(res.status, `${method} ${concrete}`).toBe(404);
      }
    }
    const probes = await fx.di.pool.query(
      `select 1 from audit_logs where category = 'security' and event = 'auth-endpoint-denied'`,
    );
    expect(probes.rowCount).toBeGreaterThan(0);
  });

  it('answers 404 for the agent and single sign-on endpoints when those features are off', async () => {
    for (const p of AUTH_PASSTHROUGH) {
      const res = await fx.app.request(`/api/auth${p.path}`, {
        method: p.method,
        ...(p.method === 'POST'
          ? { body: '{}', headers: { 'content-type': 'application/json' } }
          : {}),
      });
      expect(res.status, `${p.method} ${p.path}`).toBe(404);
    }
  });
});
