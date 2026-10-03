// The MCP protocol boundary itself, driven the way a real client drives it.
//
// Every other file in this directory calls `dispatchMcpTool` directly, which means the whole protocol layer (`requireMcpAuth`, the rate limit, `createMcpHandler`, the per-request envelope, the JSON-RPC codec) has never served a successful request anywhere. A tool table that is correct and a server that cannot answer `tools/list` look identical to those suites.
//
// So this file stands the app up on a loopback HTTP server and talks to it over the wire with a token obtained from the REAL OAuth flow: create a client while signed in, run `authorize`, approve at `consent`, exchange the code at `token`. Nothing is hand-minted. The token is verified by `requireMcpAuth` against the authorization server's published JWKS, which it fetches over HTTP from that same loopback origin. That is the one thing an in-process `app.request()` could never exercise, because the fetch is real and the fixture's fake hostname would fail it. That is the same sequence MCP Inspector performs, so this test is its rehearsal.

import { createHash, randomBytes } from 'node:crypto';
import { createServer, type Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import {
  CLIENT_CAPABILITIES_META_KEY,
  CLIENT_INFO_META_KEY,
  PROTOCOL_VERSION_META_KEY,
} from '@modelcontextprotocol/server';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createAuth, type Auth } from '../../src/auth.js';
import type { DI } from '../../src/di.js';
import { MCP_RESOURCES } from '../../src/mcp/resources.js';
import { MCP_SCOPE_READ, MCP_SCOPE_TRADE } from '../../src/mcp/scopes.js';
import { MCP_TOOLS } from '../../src/mcp/tools.js';
import { sessionResolver } from '../../src/middleware/auth.js';
import { errorHandler } from '../../src/middleware/error.js';
import { mountMcpRoutes } from '../../src/routes/mcp.js';
import { mountApiRouters } from '../../src/routes/mount.js';
import { createApiHono } from '../../src/types.js';
import { HAS_INFRA, setupApp, TRAILING_TRADE_VERSION, type ApiFixture } from '../_helpers.js';

/** The revision this endpoint serves. Stated once here and asserted against what the server itself reports, so a drift shows up as a failure rather than as two literals agreeing with each other. */
const PROTOCOL_REVISION = '2026-07-28';

/** A revision from the 2025 era, used to prove `legacy: 'reject'` actually refuses one. */
const LEGACY_REVISION = '2025-11-25';

const OPERATOR_EMAIL = 'mcp-operator@example.test';
const OPERATOR_PASSWORD = 'correct-horse-battery-staple';

interface JsonRpcEnvelope {
  readonly id?: number;
  readonly result?: Record<string, unknown>;
  readonly error?: { code: number; message: string; data?: Record<string, unknown> };
}

interface RpcAnswer {
  readonly status: number;
  readonly body: JsonRpcEnvelope;
}

interface ServedTool {
  readonly name: string;
  readonly annotations?: Record<string, unknown>;
  readonly _meta?: Record<string, unknown>;
}

interface ServedResource {
  readonly uri: string;
  readonly name: string;
}

interface ToolCallResult {
  readonly isError?: boolean;
  readonly content?: { type: string; text?: string }[];
}

/** Headers a Node request carries that a `Request` must not: they describe the hop, not the message, and undici rejects or mis-handles several of them. */
const HOP_BY_HOP = new Set([
  'connection',
  'keep-alive',
  'transfer-encoding',
  'upgrade',
  'proxy-connection',
  'host',
  'content-length',
  'expect',
]);

/** The text of the first content block, which is where `dispatchMcpTool` puts its serialised answer and its refusals alike. */
const firstText = (result: Record<string, unknown> | undefined): string =>
  ((result as ToolCallResult | undefined)?.content ?? [])[0]?.text ?? '';

describe.skipIf(!HAS_INFRA)('MCP protocol boundary over a real token', () => {
  // One fixture, one loopback server and one OAuth flow for the file. A container cold start inside an `it` blows the 5s test timeout, which reads as a defect in the code under test rather than in the harness.
  let fx: ApiFixture;
  let auth: Auth;
  let server: Server;
  let origin: string;
  let operatorId: string;
  let accountId: string;
  let profileId: string;
  let fullToken: string;
  let readOnlyToken: string;
  let rpcId = 0;

  /** The Hono app the loopback server serves, assigned once the port is known because the resource identifier, and therefore the whole auth configuration, is derived from it. */
  let route: ((request: Request) => Promise<Response>) | null = null;

  const listen = async (): Promise<void> => {
    server = createServer((req, res) => {
      const chunks: Buffer[] = [];
      req.on('data', (chunk: Buffer) => chunks.push(chunk));
      req.on('end', () => {
        void (async () => {
          const headers = new Headers();
          for (const [key, value] of Object.entries(req.headers)) {
            if (HOP_BY_HOP.has(key)) continue;
            if (typeof value === 'string') headers.set(key, value);
            else if (Array.isArray(value)) for (const one of value) headers.append(key, one);
          }
          const body = Buffer.concat(chunks);
          const request = new Request(`${origin}${req.url ?? '/'}`, {
            method: req.method ?? 'GET',
            headers,
            ...(body.length > 0 ? { body } : {}),
          });
          const response = await (route ?? (async () => new Response(null, { status: 503 })))(
            request,
          );
          for (const [key, value] of response.headers) {
            if (key !== 'set-cookie') res.setHeader(key, value);
          }
          // Set-Cookie is the one header that must stay several headers. Collapsed into one comma-joined value it is unparseable, and the session cookie this whole flow depends on is the first casualty.
          const cookies = response.headers.getSetCookie();
          if (cookies.length > 0) res.setHeader('set-cookie', cookies);
          res.writeHead(response.status);
          res.end(Buffer.from(await response.arrayBuffer()));
        })();
      });
    });
    await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
    origin = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  };

  let cookie = '';

  const authPost = async (path: string, body: unknown): Promise<Response> =>
    fetch(`${origin}/api/auth${path}`, {
      method: 'POST',
      // Better Auth refuses a state-changing request with no Origin as MISSING_OR_NULL_ORIGIN before any route option is consulted, so omitting it would answer every step below with a CSRF error that says nothing about OAuth.
      headers: {
        'content-type': 'application/json',
        origin,
        ...(cookie === '' ? {} : { cookie }),
      },
      body: JSON.stringify(body),
      redirect: 'manual',
    });

  /**
   * Where a Better Auth OAuth step is sending the browser next.
   *
   * The authorization server answers a redirect either as a real 302 or as a 200 carrying the target in the body, depending on what the caller said it accepts. A client following only one of the two silently stalls on the other, so both are read here rather than assuming the shape.
   *
   * @param res - Response from an authorize, consent or continue step.
   * @returns The absolute URL to follow.
   */
  const redirectTargetOf = async (res: Response): Promise<URL> => {
    const header = res.headers.get('location');
    if (header !== null) return new URL(header, origin);
    // `url`, and only `url`. The endpoint's own OpenAPI metadata advertises `redirect_uri`, but the implementation never sends it, so reading that name first would be a fallback that can only ever be undefined and would hide the day the real field is renamed.
    const body = (await res
      .clone()
      .json()
      .catch(() => ({}))) as { url?: string };
    const target = body.url;
    expect(target, await res.clone().text()).toBeTruthy();
    return new URL(target ?? '', origin);
  };

  /**
   * Runs one complete authorization-code flow and returns the access token it produced.
   *
   * A fresh client per call, so the two tokens this file needs cannot share a stored consent: a second flow against the same client would be auto-approved on the first flow's grant and would stop proving that the consent step decides the scopes.
   *
   * @param scopes - Space-delimited scopes to request.
   * @returns The bearer token the token endpoint issued.
   */
  const accessTokenFor = async (scopes: string): Promise<string> => {
    const redirectUri = `${origin}/agent-callback`;
    const created = await authPost('/oauth2/create-client', {
      client_name: `agent-${scopes.replace(/\W+/g, '-')}`,
      redirect_uris: [redirectUri],
      scope: `${MCP_SCOPE_READ} ${MCP_SCOPE_TRADE}`,
      grant_types: ['authorization_code'],
      response_types: ['code'],
      token_endpoint_auth_method: 'client_secret_post',
      // `native`, because the redirect lands on an http loopback port. A `web` client is required to use https on a non-loopback host, which is the right rule and the wrong one for a locally-run agent client: MCP Inspector is exactly this shape.
      application_type: 'native',
    });
    // Each OAuth step carries its own response body into the failure message. A bare status assertion here reports "expected 400 to be less than 400" and leaves the actual `error_description`, the only thing that says which step disagreed, unread.
    expect(created.status, await created.clone().text()).toBeLessThan(400);
    const client = (await created.json()) as { client_id: string; client_secret: string };

    const verifier = randomBytes(32).toString('base64url');
    const challenge = createHash('sha256').update(verifier).digest('base64url');
    const authorizeQuery = new URLSearchParams({
      response_type: 'code',
      client_id: client.client_id,
      redirect_uri: redirectUri,
      scope: scopes,
      state: randomBytes(8).toString('hex'),
      code_challenge: challenge,
      code_challenge_method: 'S256',
      resource: `${origin}/api/mcp`,
    });
    const authorized = await fetch(`${origin}/api/auth/oauth2/authorize?${authorizeQuery}`, {
      headers: { cookie },
      redirect: 'manual',
    });
    expect(authorized.status, await authorized.clone().text()).toBeLessThan(400);
    const consentLocation = await redirectTargetOf(authorized);
    // The operator is sent to the consent screen, not straight back to the client. A flow that skipped it would hand an agent the trade scope with nobody having approved it.
    expect(consentLocation.pathname).toBe('/consent');

    // The signed query the authorization server minted is handed straight back. It carries the request's own signature, so the consent decision can only ever apply to the request that produced it.
    const consented = await authPost('/oauth2/consent', {
      accept: true,
      oauth_query: consentLocation.search.replace(/^\?/, ''),
    });
    expect(consented.status, await consented.clone().text()).toBeLessThan(400);
    const codeUrl = await redirectTargetOf(consented);
    const code = codeUrl.searchParams.get('code');
    expect(code, codeUrl.toString()).not.toBeNull();

    const tokenRes = await fetch(`${origin}/api/auth/oauth2/token`, {
      method: 'POST',
      headers: { 'content-type': 'application/x-www-form-urlencoded', origin },
      body: new URLSearchParams({
        grant_type: 'authorization_code',
        code: code ?? '',
        redirect_uri: redirectUri,
        client_id: client.client_id,
        client_secret: client.client_secret,
        code_verifier: verifier,
        resource: `${origin}/api/mcp`,
      }),
    });
    expect(tokenRes.status).toBe(200);
    const tokens = (await tokenRes.json()) as { access_token?: string; scope?: string };
    expect(tokens.access_token).toBeTruthy();
    return tokens.access_token ?? '';
  };

  /**
   * Sends one JSON-RPC request over HTTP with the 2026-07-28 per-request envelope.
   *
   * The envelope is what makes a request modern-era at all; without it `legacy: 'reject'` refuses the call before any handler sees it. The `Mcp-Method` and `Mcp-Name` headers are cross-checks the endpoint requires, and they are derived from the body here rather than passed in, so a case cannot accidentally send a disagreeing pair.
   *
   * @param token - Bearer access token to present.
   * @param method - JSON-RPC method to invoke.
   * @param params - Method parameters, before the envelope is added.
   * @returns The HTTP status and the decoded JSON-RPC envelope.
   */
  const rpc = async (
    token: string,
    method: string,
    params: Record<string, unknown> = {},
  ): Promise<RpcAnswer> => {
    const subject = params['name'] ?? params['uri'];
    const res = await fetch(`${origin}/api/mcp`, {
      method: 'POST',
      headers: {
        authorization: `Bearer ${token}`,
        'content-type': 'application/json',
        accept: 'application/json, text/event-stream',
        'mcp-protocol-version': PROTOCOL_REVISION,
        'mcp-method': method,
        ...(typeof subject === 'string' ? { 'mcp-name': subject } : {}),
      },
      body: JSON.stringify({
        jsonrpc: '2.0',
        id: ++rpcId,
        method,
        params: {
          ...params,
          _meta: {
            [PROTOCOL_VERSION_META_KEY]: PROTOCOL_REVISION,
            [CLIENT_CAPABILITIES_META_KEY]: {},
            [CLIENT_INFO_META_KEY]: { name: 'protocol-boundary-suite', version: '1.0.0' },
          },
        },
      }),
    });
    return { status: res.status, body: (await res.json()) as JsonRpcEnvelope };
  };

  /** Every tool the endpoint serves, following the cursor so a paginated listing cannot be mistaken for a short one. */
  const servedTools = async (token: string): Promise<ServedTool[]> => {
    const all: ServedTool[] = [];
    let cursor: string | undefined;
    do {
      const answer = await rpc(token, 'tools/list', cursor === undefined ? {} : { cursor });
      expect(answer.status).toBe(200);
      const result = answer.body.result ?? {};
      all.push(...((result['tools'] as ServedTool[] | undefined) ?? []));
      cursor = result['nextCursor'] as string | undefined;
    } while (cursor !== undefined);
    return all;
  };

  const auditCount = async (): Promise<number> => {
    const rows = await fx.di.pool.query<{ n: string }>(
      `select count(*)::text as n from audit_logs where operator_id = $1`,
      [operatorId],
    );
    return Number(rows.rows[0]?.n ?? '0');
  };

  beforeAll(async () => {
    // `seed: false` leaves onboarding open, which is how this suite gets a real Better Auth session. The sign-up hook then materialises the domain `users` row and a default testnet account, so the operator this flow authorizes is a genuine one rather than a fixture id with no auth identity behind it.
    fx = await setupApp({ seed: false });
    await listen();
    const resource = `${origin}/api/mcp`;
    auth = createAuth({
      db: fx.di.db,
      webOrigins: [origin],
      authSecret: 'x'.repeat(32),
      isProduction: false,
      mcpResource: resource,
    });
    const di = {
      ...fx.di,
      auth,
      env: { ...fx.di.env, LIVE_DEMO: false, MCP_ENABLED: true, MCP_RESOURCE_URL: resource },
    } as unknown as DI;
    const app = createApiHono();
    // Registered first, exactly as production does, because Hono dispatches in registration order: a session resolver added after the routes below would never run ahead of them, and the cookie-vs-bearer test would then be asserting against an app where nothing resolves a session at all.
    app.use('*', sessionResolver(auth));
    // `requireUser()` signals by throwing, so without production's `onError` the REST surface would answer an unauthenticated request with a 500 that is indistinguishable from a genuine fault.
    app.onError(errorHandler(fx.di.logger));
    // The Better Auth handler, mounted where production mounts it. `requireMcpAuth` fetches `/api/auth/jwks` from this origin to verify a token, so without this mount every verified call would 401 for want of a key.
    app.all('/api/auth/*', async (c) => auth.handler(c.req.raw));
    // The production mount function, not a hand-assembled route table: the kill switch and the discovery documents are part of what a client meets.
    mountMcpRoutes(app, di);
    // The cookie-authenticated REST surface, in production's order and from production's own mount list. It is what an MCP token must NOT reach, and a replay of one against it is only a real question when the routes are actually here to answer.
    mountApiRouters(app, di);
    route = app.fetch.bind(app) as (request: Request) => Promise<Response>;

    const signUp = await authPost('/sign-up/email', {
      email: OPERATOR_EMAIL,
      password: OPERATOR_PASSWORD,
      name: 'MCP Operator',
    });
    expect(signUp.status).toBeLessThan(400);
    cookie = signUp.headers
      .getSetCookie()
      .map((entry) => entry.split(';')[0])
      .join('; ');
    expect(cookie).not.toBe('');
    const operator = await fx.di.pool.query<{ id: string }>(`select id from users limit 1`);
    operatorId = operator.rows[0]?.id ?? '';
    expect(operatorId).not.toBe('');
    const account = await fx.di.pool.query<{ id: string }>(
      `select id from accounts where owner_id = $1`,
      [operatorId],
    );
    accountId = account.rows[0]?.id ?? '';
    expect(accountId).not.toBe('');
    const profile = await fx.di.pool.query<{ id: string }>(
      `insert into profiles (account_id, name, strategy_name, strategy_version, config, state)
       values ($1, 'agent-target', 'trailing-trade', $2, '{}', '{}') returning id`,
      [accountId, TRAILING_TRADE_VERSION],
    );
    profileId = profile.rows[0]?.id ?? '';
    expect(profileId).not.toBe('');

    fullToken = await accessTokenFor(`${MCP_SCOPE_READ} ${MCP_SCOPE_TRADE}`);
    readOnlyToken = await accessTokenFor(MCP_SCOPE_READ);
  });

  afterAll(async () => {
    await new Promise<void>((resolve) => server.close(() => resolve()));
    await fx.cleanup();
  });

  it('negotiates protocol revision 2026-07-28 on the modern handshake', async () => {
    // The 2026 era replaced the `initialize` handshake with `server/discover`; this is the call a modern client opens a session with, and what it reports is the negotiation result.
    const answer = await rpc(fullToken, 'server/discover');
    expect(answer.status).toBe(200);
    expect(answer.body.error).toBeUndefined();
    expect(answer.body.result?.['supportedVersions']).toEqual([PROTOCOL_REVISION]);
    // Capabilities, not just a version: a handshake that negotiated the revision and advertised nothing would leave a client with no reason to call anything.
    expect(answer.body.result?.['capabilities']).toMatchObject({ tools: {}, resources: {} });
  });

  it('serves exactly the tool table on tools/list', async () => {
    // This is the authoritative pin for "the client is offered exactly MCP_TOOLS". The registration spy beside it asks the same question one layer lower, where a codec that dropped or renamed an entry on the way out would still look correct.
    const tools = await servedTools(fullToken);
    expect(MCP_TOOLS.length).toBeGreaterThan(0);
    expect(tools.map((tool) => tool.name).sort()).toEqual(MCP_TOOLS.map((t) => t.name).sort());
  });

  it('carries the trade-tool hints across the wire, each in the field its reader looks at', async () => {
    // What the client actually reads to decide whether to prompt, and it reads the two halves from two different fields. Serving `anthropic/requiresUserInteraction` inside `annotations` is not a cosmetic misplacement: the client ignores it there, so the listing looks fully hinted while every real order arrives as a one-tap approval.
    const byName = new Map((await servedTools(fullToken)).map((tool) => [tool.name, tool]));
    const tradeTools = MCP_TOOLS.filter((tool) => tool.scope === MCP_SCOPE_TRADE);
    expect(tradeTools.length).toBeGreaterThan(0);
    for (const tool of tradeTools) {
      const served = byName.get(tool.name);
      expect(served?.annotations).toMatchObject({ destructiveHint: true });
      // Strict `true`, because the client accepts nothing else: a truthy string would satisfy a loose check and still be discarded.
      expect(served?._meta?.['anthropic/requiresUserInteraction']).toBe(true);
      expect(served?.annotations?.['anthropic/requiresUserInteraction']).toBeUndefined();
    }
  });

  it('serves the raised result cap under _meta, not annotations', async () => {
    // The other half of the same misplacement, and the silent one: a cap the client never sees leaves a large read truncated at the default, which reads as a short answer rather than an error.
    const byName = new Map((await servedTools(fullToken)).map((tool) => [tool.name, tool]));
    const capped = MCP_TOOLS.filter(
      (tool) => tool.meta?.['anthropic/maxResultSizeChars'] !== undefined,
    );
    expect(capped.length).toBeGreaterThan(0);
    for (const tool of capped) {
      const served = byName.get(tool.name);
      expect(served?._meta?.['anthropic/maxResultSizeChars']).toBe(
        tool.meta?.['anthropic/maxResultSizeChars'],
      );
      expect(served?.annotations?.['anthropic/maxResultSizeChars']).toBeUndefined();
    }
  });

  it('answers tools/call on a read tool with a real result', async () => {
    const answer = await rpc(fullToken, 'tools/call', { name: 'list_accounts', arguments: {} });
    expect(answer.status).toBe(200);
    expect(answer.body.result?.['isError']).toBe(false);
    const payload = JSON.parse(firstText(answer.body.result)) as {
      result?: { id: string; binanceMode?: string }[];
    };
    // `list_accounts` is operator-global, so the mode rides on each account rather than on the envelope. It is the field that tells an agent whether the next call spends real money.
    expect(payload.result?.map((account) => account.id)).toContain(accountId);
    expect(payload.result?.[0]?.binanceMode).toBe('test');
  });

  it('completes a write tool end to end: result, agent audit row, and the operator notification', async () => {
    const before = await auditCount();
    const answer = await rpc(fullToken, 'tools/call', {
      name: 'update_profile',
      arguments: { accountId, profileId, name: 'renamed-over-the-wire' },
    });
    expect(answer.status).toBe(200);
    expect(answer.body.result?.['isError']).toBe(false);
    const payload = JSON.parse(firstText(answer.body.result)) as {
      binanceMode?: string;
      result?: { name?: string };
    };
    expect(payload.binanceMode).toBe('test');
    expect(payload.result?.name).toBe('renamed-over-the-wire');

    // The attribution half. Both paths write the same row and `actor` is the only thing that distinguishes a model's edit from the operator's own click.
    const rows = await fx.di.pool.query<{ actor: string; event: string }>(
      `select actor, event from audit_logs where operator_id = $1 order by created_at desc limit 1`,
      [operatorId],
    );
    expect(await auditCount()).toBe(before + 1);
    expect(rows.rows[0]).toMatchObject({ actor: 'agent', event: 'update-profile' });

    // The notification half, read back off the real queue rather than from a stub: the api cannot send anything itself, so an unenqueued job is an agent write the operator never hears about.
    const jobs = await fx.di.queue.getJobs(['waiting', 'delayed', 'prioritized', 'active']);
    const agentJobs = jobs.filter((job) => job.name === 'notify-agent-action');
    expect(agentJobs).toHaveLength(1);
    expect(agentJobs[0]?.data).toMatchObject({ accountId, tool: 'update_profile' });
  });

  it('refuses a trade tool on a read-only token at the protocol layer, reaching no route', async () => {
    const before = await auditCount();
    const answer = await rpc(readOnlyToken, 'tools/call', {
      name: 'update_profile',
      arguments: { accountId, profileId, name: 'should-not-apply' },
    });
    expect(answer.status).toBe(200);
    expect(answer.body.result?.['isError']).toBe(true);
    // The refusal names the missing scope so the client knows what to re-authorize for, rather than reporting an opaque failure the model will retry forever.
    expect(firstText(answer.body.result)).toContain(MCP_SCOPE_TRADE);
    // The discriminating half: a refusal that still dispatched would leave a row and a renamed profile behind.
    expect(await auditCount()).toBe(before);
    const stored = await fx.di.pool.query<{ name: string }>(
      `select name from profiles where id = $1`,
      [profileId],
    );
    expect(stored.rows[0]?.name).not.toBe('should-not-apply');
  });

  it('serves the closed resource list and reads a document off it', async () => {
    const listed = await rpc(fullToken, 'resources/list');
    expect(listed.status).toBe(200);
    const resources = (listed.body.result?.['resources'] as ServedResource[] | undefined) ?? [];
    expect(MCP_RESOURCES.length).toBeGreaterThan(0);
    expect(resources.map((r) => r.uri).sort()).toEqual(MCP_RESOURCES.map((r) => r.uri).sort());

    const first = MCP_RESOURCES[0];
    const read = await rpc(fullToken, 'resources/read', { uri: first?.uri ?? '' });
    expect(read.status).toBe(200);
    expect(read.body.error).toBeUndefined();
    const contents =
      (read.body.result?.['contents'] as { uri: string; text?: string }[] | undefined) ?? [];
    expect(contents[0]?.uri).toBe(first?.uri);
    // Real bytes off disk, not merely a non-empty envelope: a reader that answered every URI with an empty string would satisfy a length check. This is also the only pin on the docs-root walk, which resolves from the route module's own location at import time and so cannot be steered from a test.
    expect((contents[0]?.text ?? '').length).toBeGreaterThan(100);
  });

  it('honours an MCP access token at /api/mcp only, leaving the REST surface unauthenticated', async () => {
    // The security claim the whole control plane rests on. An MCP token is a bearer credential a consent screen handed to a third-party agent; the operator's own REST surface is cookie-authenticated, and `GET /api/backup` on it streams a pg_dump carrying every plaintext Binance key. If Better Auth resolved a session from an `Authorization: Bearer` header, that replay would simply work. Asked here of the REAL instance built with jwt() + mcp() + cimd(), because a stubbed `getSession` answers this question the same way whatever the real plugin set does.

    // Same token, same moment, accepted where it belongs. Without this the 401 below could equally mean the token had expired or was never valid.
    const atMcp = await rpc(fullToken, 'server/discover');
    expect(atMcp.status).toBe(200);
    expect(atMcp.body.error).toBeUndefined();

    const bearerSession = await auth.api.getSession({
      headers: new Headers({ authorization: `Bearer ${fullToken}` }),
    });
    expect(bearerSession).toBeNull();

    // The discriminating half: the same resolver DOES mint a session from this suite's real cookie, so the null above is the bearer header being ignored rather than `getSession` refusing everything.
    const cookieSession = await auth.api.getSession({ headers: new Headers({ cookie }) });
    expect(cookieSession?.user.id).toBe(operatorId);

    // And the end-to-end shape of it, through `sessionResolver` and `requireUser()` on a real mounted route rather than through the resolver in isolation.
    const replayed = await fetch(`${origin}/api/accounts`, {
      headers: { authorization: `Bearer ${fullToken}` },
    });
    expect(replayed.status).toBe(401);
    const asOperator = await fetch(`${origin}/api/accounts`, { headers: { cookie } });
    expect(asOperator.status, await asOperator.clone().text()).toBe(200);
  });

  it("refuses a 2025-era request rather than serving it, which is what legacy: 'reject' buys", async () => {
    // A legacy `initialize` with no modern envelope. Serving it would stand up a second protocol surface, with its own session semantics, on a route that can place orders.
    const res = await fetch(`${origin}/api/mcp`, {
      method: 'POST',
      headers: {
        authorization: `Bearer ${fullToken}`,
        'content-type': 'application/json',
        accept: 'application/json, text/event-stream',
      },
      body: JSON.stringify({
        jsonrpc: '2.0',
        id: ++rpcId,
        method: 'initialize',
        params: {
          protocolVersion: LEGACY_REVISION,
          capabilities: {},
          clientInfo: { name: 'legacy-client', version: '1.0.0' },
        },
      }),
    });
    expect(res.status).toBe(400);
    const body = (await res.json()) as JsonRpcEnvelope;
    expect(body.result).toBeUndefined();
    // The refusal is self-describing: it names what the endpoint does serve, so a legacy client can discover the modern revision from the error alone instead of retrying blind.
    expect(body.error?.data).toMatchObject({
      supported: [PROTOCOL_REVISION],
      requested: LEGACY_REVISION,
    });
  });
});
