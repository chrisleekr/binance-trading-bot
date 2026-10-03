// What a stranger gets from the two endpoints that face the internet before any token exists.
//
// Both are asserted against a REAL Better Auth instance rather than the mounted route table. The route table answers "is a path registered", and for these two questions that is the wrong oracle: the challenge header is produced by the plugin, and the registration endpoint is served by `auth.handler` behind a wildcard mount the table never enumerates, so a table-based assertion holds whether or not the option that disables it is set.

import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createAuth, type Auth } from '../../src/auth.js';
import type { DI } from '../../src/di.js';
import { MCP_SCOPES } from '../../src/mcp/scopes.js';
import { mcpRouter } from '../../src/routes/mcp.js';
import { wellKnownRouter } from '../../src/routes/well-known.js';
import type { ApiHono } from '../../src/types.js';
import { HAS_INFRA, setupApp, type ApiFixture } from '../_helpers.js';

const RESOURCE = 'https://bot.example.test/api/mcp';

describe.skipIf(!HAS_INFRA)('MCP endpoint before authentication', () => {
  let fx: ApiFixture;
  let auth: Auth;
  let app: ApiHono;

  beforeAll(async () => {
    fx = await setupApp();
    auth = createAuth({
      db: fx.di.db,
      webOrigins: ['http://localhost:5173'],
      authSecret: 'x'.repeat(32),
      isProduction: false,
      mcpResource: RESOURCE,
    });
    app = mcpRouter({
      ...fx.di,
      auth,
      env: { ...fx.di.env, LIVE_DEMO: false, MCP_ENABLED: true, MCP_RESOURCE_URL: RESOURCE },
    } as unknown as DI);
  });

  afterAll(async () => {
    await fx.cleanup();
  });

  const post = async (headers: Record<string, string> = {}): Promise<Response> =>
    app.request('/', {
      method: 'POST',
      headers: { 'content-type': 'application/json', ...headers },
      body: '{"jsonrpc":"2.0","id":1,"method":"tools/list"}',
    });

  it('answers an unauthenticated call with 401 and the challenge a client needs to start', async () => {
    // Without this header a client has a closed door and no handle: RFC 9728 makes `resource_metadata` the pointer from the protected resource to the document naming its authorization server, and that document is the only thing telling the client where to send the operator.
    const res = await post();
    expect(res.status).toBe(401);
    const challenge = res.headers.get('www-authenticate') ?? '';
    expect(challenge).toMatch(/^Bearer/);
    // The document URL is derived from the resource identifier the way the specification derives it, rather than retyped: a retyped literal agrees with itself even when the two drift.
    const resource = new URL(RESOURCE);
    const metadataUrl = `${resource.origin}/.well-known/oauth-protected-resource${resource.pathname}`;
    expect(challenge).toContain(`resource_metadata="${metadataUrl}"`);
    for (const scope of MCP_SCOPES) expect(challenge).toContain(scope);
  });

  it('points that challenge at a document this app actually serves', async () => {
    // A challenge naming a 404 is the same dead end as no challenge at all, and the two halves live in different files, so nothing else asks whether the URL in the header is one the router answers.
    const challenge =
      (await post()).headers.get('www-authenticate')?.match(/resource_metadata="([^"]+)"/)?.[1] ??
      '';
    expect(challenge).not.toBe('');
    const doc = await wellKnownRouter({ auth } as unknown as DI).request(challenge);
    expect(doc.status).toBe(200);
    expect((await doc.json()) as { resource?: string }).toMatchObject({ resource: RESOURCE });
  });

  it('refuses a bearer token it cannot verify rather than falling through', async () => {
    // The discriminating half: a 401 that is returned for every request, verified or not, would satisfy the case above while proving nothing about verification.
    const res = await post({ authorization: 'Bearer not-a-real-token' });
    expect(res.status).toBe(401);
  });
});

describe.skipIf(!HAS_INFRA)('dynamic client registration', () => {
  let fx: ApiFixture;
  let auth: Auth;

  let cookie: string;

  beforeAll(async () => {
    // `seed: false` leaves the onboarding sign-up open, which is how this suite gets a real session cookie. Without one the registration attempt below is decided by `allowUnauthenticatedClientRegistration` and never reaches the option it is meant to pin.
    fx = await setupApp({ seed: false });
    auth = createAuth({
      db: fx.di.db,
      webOrigins: ['http://localhost:5173'],
      authSecret: 'x'.repeat(32),
      isProduction: false,
      mcpResource: RESOURCE,
    });
    const signUp = await auth.handler(
      new Request('https://bot.example.test/api/auth/sign-up/email', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({
          email: 'operator@example.test',
          password: 'correct-horse-battery',
          name: 'Operator',
        }),
      }),
    );
    expect(signUp.status).toBeLessThan(400);
    // Split to the name=value pairs rather than replayed as the raw `Set-Cookie` line: that line carries `Path`, `HttpOnly` and `SameSite` attributes a request header has no business sending, and `Headers.get` would join two cookies with a comma into something unparseable.
    cookie = signUp.headers
      .getSetCookie()
      .map((entry) => entry.split(';')[0])
      .join('; ');
    expect(cookie).not.toBe('');
    // The registration case below asserts only `status >= 400`, which is also what the anonymous case asserts. Without proving this cookie actually authenticates, the two would be the same test under every setting of the option they exist to pin, and nothing would ever say so.
    const session = await auth.api.getSession({ headers: new Headers({ cookie }) });
    expect(session?.user.email).toBe('operator@example.test');
  });

  afterAll(async () => {
    await fx.cleanup();
  });

  const register = async (headers: Record<string, string> = {}): Promise<Response> =>
    auth.handler(
      new Request('https://bot.example.test/api/auth/oauth2/register', {
        method: 'POST',
        // The Origin header is not decoration. Better Auth answers a state-changing request without one with 403 MISSING_OR_NULL_ORIGIN before any route option is consulted, so a request that omits it is refused by CSRF and says nothing about whether registration is enabled. This origin is the configured `baseURL`, hence trusted.
        headers: {
          'content-type': 'application/json',
          origin: 'https://bot.example.test',
          ...headers,
        },
        body: JSON.stringify({
          redirect_uris: ['https://attacker.example/cb'],
          client_name: 'not-invited',
        }),
      }),
    );

  it('refuses a signed-in operator a registered client, which is the option itself', async () => {
    // The discriminating case, and the only one that can fail if the option is switched back on. Upstream checks `allowDynamicClientRegistration` first and throws FORBIDDEN before it ever looks up a session, so with registration disabled EVERY caller is refused there and an anonymous attempt says nothing about which option did it. Enable registration and the anonymous caller is still refused, now by `allowUnauthenticatedClientRegistration`; only a caller presenting a real session reaches the end and gets a client, so only this case moves when the option moves.
    const res = await register({ cookie });
    expect(res.status).toBeGreaterThanOrEqual(400);
  });

  it('serves no registration endpoint, so a stranger cannot mint a client', async () => {
    // An open `POST /oauth2/register` on a host holding plaintext Binance keys lets anyone create a client and start an authorization flow against it. CIMD is the registration mechanism here instead, so the endpoint has to refuse rather than merely go unadvertised. It is reached and refused, not absent: the case above is the one that moves when the option moves.
    const res = await register();
    expect(res.status).toBeGreaterThanOrEqual(400);
    expect(res.status).not.toBe(429);
  });

  it('still serves the authorization-server metadata from the same handler', async () => {
    // Proves the refusal above is about that one endpoint and not about a handler that answers 4xx to everything, which is how this assertion would otherwise pass on a broken instance.
    const res = await auth.handler(
      new Request('https://bot.example.test/api/auth/.well-known/oauth-authorization-server'),
    );
    expect(res.status).toBe(200);
  });
});
