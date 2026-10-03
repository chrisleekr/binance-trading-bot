import { existsSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { requireMcpAuth } from '@better-auth/mcp';
import { createMcpHandler, McpServer } from '@modelcontextprotocol/server';
import type { UserId } from '@app/contracts';
import { repo } from '@app/db';
import { clientIpFromHeaders } from '../auth/client-address.js';
import { rateLimitedResponse } from '../auth/http.js';
import type { DI } from '../di.js';
import { dispatchMcpTool, EMPTY_CLIENT_CONTEXT, type McpClientContext } from '../mcp/dispatch.js';
import { MCP_RESOURCES, readMcpResource } from '../mcp/resources.js';
import { MCP_SCOPES } from '../mcp/scopes.js';
import { MCP_TOOLS } from '../mcp/tools.js';
import { HttpError } from '../middleware/error.js';
import { createApiHono, type ApiHono } from '../types.js';
import { wellKnownRouter } from './well-known.js';

/**
 * Absolute path of the documentation the MCP resources are served from.
 *
 * Anchored to this module rather than to the working directory. A bare relative `docs` resolves against `process.cwd()`, which is `/app` under the image but `apps/api` when turbo runs the api in dev, and the miss is silent: every `resources/read` answers `unknown resource`, which reads like a bad URI rather than a misconfigured root. Walking up covers both layouts, whose depths differ because the image runs a bundle at `/app/dist` while dev runs the source.
 */
const findDocsRoot = (): string => {
  // `import.meta.url` rather than Bun's `import.meta.dir`: the latter is undefined under vitest, where it would throw on the first join.
  let dir = dirname(fileURLToPath(import.meta.url));
  for (let depth = 0; depth < 8; depth += 1) {
    const candidate = join(dir, 'docs');
    if (existsSync(candidate)) return candidate;
    const parent = dirname(dir);
    if (parent === dir) break;
    dir = parent;
  }
  // Nothing found: keep the previous cwd-relative behaviour so a layout this walk does not anticipate degrades no worse than before.
  return 'docs';
};

const DOCS_ROOT = findDocsRoot();

/**
 * Key the agent's network identity travels under inside `authInfo.extra`.
 *
 * Namespaced with a slash so it cannot collide with a JWT claim, since `extra` is the token's claim set and this rides beside it.
 */
const CLIENT_CONTEXT_CLAIM = 'app/clientContext';

/**
 * Lifts the caller's forwarded network identity off the MCP request.
 *
 * Read here because this is the last frame that holds the request the agent actually sent. Everything downstream runs against a request this process builds, which carries no headers but the ones put on it deliberately.
 *
 * @param request - The agent's HTTP request, after the bearer token has been verified.
 * @returns The forwarding headers and user agent, each null when the request did not carry it.
 */
const clientContextOf = (request: Request): McpClientContext => ({
  forwardedFor: request.headers.get('x-forwarded-for'),
  realIp: request.headers.get('x-real-ip'),
  // Bounded at the same 256 characters the audit column stores, so an oversized header is trimmed once here rather than silently at the write.
  userAgent: request.headers.get('user-agent')?.slice(0, 256) ?? null,
});

/**
 * Narrows a value recovered from `authInfo.extra` back to a client context.
 *
 * The bag is typed as unknown values because it is the token's claim set, so what comes out is checked rather than asserted: a malformed entry degrades to no context, which costs an audit row its address, instead of throwing inside the server factory and failing the whole call.
 *
 * @param value - Candidate lifted from the extra bag.
 * @returns True when the value carries the three context fields.
 */
const isClientContext = (value: unknown): value is McpClientContext =>
  typeof value === 'object' &&
  value !== null &&
  'forwardedFor' in value &&
  'realIp' in value &&
  'userAgent' in value;

/** Requests the operator's agents may make together in a window, and the window. Counted per operator rather than per token, so a second agent or a re-authorized one does not add a budget. A model in a loop is the expected failure mode here, not an attacker: the limit exists so runaway agents burn this budget rather than the account's Binance request weight. */
const RATE_LIMIT_MAX = 120;
const RATE_LIMIT_WINDOW_SEC = 60;

interface TokenClaims {
  readonly sub?: unknown;
  readonly scope?: unknown;
  readonly scopes?: unknown;
}

/**
 * Reads the granted scopes off a verified token.
 *
 * RFC 6749 puts them in a space-delimited `scope` string; some issuers emit an array. Both are read, and an unreadable claim yields an EMPTY set rather than a permissive one, so a token whose scopes cannot be determined can invoke nothing.
 *
 * @param claims - Verified JWT payload.
 * @returns The scopes the token actually carries.
 */
const grantedScopesOf = (claims: TokenClaims): ReadonlySet<string> => {
  if (typeof claims.scope === 'string') return new Set(claims.scope.split(' ').filter(Boolean));
  if (Array.isArray(claims.scopes)) {
    return new Set(claims.scopes.filter((s): s is string => typeof s === 'string'));
  }
  return new Set();
};

/**
 * Builds the MCP server for one request, wired to the tool table and the documentation resources.
 *
 * Constructed per request rather than once at boot because the identity and the granted scopes differ per token, and a shared server would have to carry them out of band.
 *
 * @param di - Container the dispatched routes run against.
 * @param operatorId - Owner the verified token resolved to.
 * @param grantedScopes - Scopes that token carries.
 * @returns A server exposing exactly the tool table and nothing else.
 */
// Exported so a suite can assert the registered set equals the tool table. A denied route acquiring a tool has to be visible somewhere other than the table that declares it.
export const buildMcpServer = (
  di: DI,
  operatorId: UserId,
  grantedScopes: ReadonlySet<string>,
  clientContext: McpClientContext = EMPTY_CLIENT_CONTEXT,
): McpServer => {
  const server = new McpServer({ name: 'binance-trading-bot', version: '1.0.0' });
  for (const tool of MCP_TOOLS) {
    server.registerTool(
      tool.name,
      {
        description: tool.description,
        inputSchema: tool.inputShape,
        annotations: { ...tool.annotations },
        // The anthropic-namespaced hints are read here and ignored anywhere else, so `_meta` is the only field that makes a trade tool prompt. Omitted rather than sent empty, so a tool asking for nothing says nothing.
        ...(tool.meta === undefined ? {} : { _meta: { ...tool.meta } }),
      },
      async (args: unknown) => {
        const result = await dispatchMcpTool(
          { di, operatorId, grantedScopes, clientContext },
          tool.name,
          args,
        );
        return { isError: result.isError, content: [{ type: 'text' as const, text: result.text }] };
      },
    );
  }
  for (const resource of MCP_RESOURCES) {
    server.registerResource(
      resource.name,
      resource.uri,
      { title: resource.title, description: resource.description, mimeType: resource.mimeType },
      async (uri: URL) => {
        const found = await readMcpResource(uri.toString(), DOCS_ROOT);
        if (!found) throw new Error(`unknown resource: ${uri.toString()}`);
        return {
          contents: [{ uri: uri.toString(), mimeType: found.resource.mimeType, text: found.text }],
        };
      },
    );
  }
  return server;
};

/**
 * The MCP control plane.
 *
 * Three refusals sit in front of the protocol handler, and their order is the design:
 *
 * 1. `LIVE_DEMO` is refused outright. That mode injects the sole operator id for every anonymous caller, so an MCP endpoint reachable on a demo box is an anonymous trading control plane with a consent screen nobody has to pass.
 * 2. `requireMcpAuth` verifies the bearer token against the authorization server's JWKS and answers an unauthenticated request with the RFC 9728 `WWW-Authenticate` header MCP clients need to start the flow.
 * 3. A per-operator rate limit, applied inside the verified-token callback so an unauthenticated caller cannot consume the agents' budget. Callers without a verified token pay the anonymous per-address budget instead.
 *
 * The route itself is only mounted while `MCP_ENABLED` is on, so the operator kill switch removes the surface rather than guarding it.
 */
export const mcpRouter = (di: DI): ApiHono => {
  const app = createApiHono();
  // Read once and refused rather than defaulted. This value is what binds an access token's `aud` claim to this endpoint, so the empty string a `??` would supply does not fail the mount, it turns audience checking off and accepts a token minted for anything. `env.ts` already requires the value whenever `MCP_ENABLED` is on and `mountMcpRoutes` returns early when it is off, so this is unreachable; it is written as a throw because the alternative default is the permissive one, and this router is exported and constructible from any `DI`.
  const resource = di.env.MCP_RESOURCE_URL;
  if (resource === undefined) {
    throw new Error('mcp: MCP_RESOURCE_URL is required to mount the control plane');
  }
  const handler = createMcpHandler(
    (ctx) => {
      const info = ctx.authInfo;
      const extra = (info?.extra ?? {}) as Record<string, unknown>;
      const claims = extra as TokenClaims;
      const operatorId = String(claims.sub ?? info?.clientId ?? '') as UserId;
      // `authInfo` is the only per-request channel this factory is given, so the agent's network identity rides alongside the claims under a namespaced key. The handler itself is built once per router rather than per request, deliberately: rebuilding it would also rebuild the auth wrapper and lose its JWKS cache, paying a key fetch on every tool call.
      const carried = extra[CLIENT_CONTEXT_CLAIM];
      const clientContext = isClientContext(carried) ? carried : EMPTY_CLIENT_CONTEXT;
      return buildMcpServer(di, operatorId, grantedScopesOf(claims), clientContext);
    },
    // Modern-only. The 2025-era stateless fallback would serve a second protocol surface with its own session semantics on a route that can place orders, for no gain: both clients this targets negotiate 2026-07-28.
    { legacy: 'reject' },
  );

  const protectedHandler = requireMcpAuth(
    di.auth,
    async (request, claims) => {
      const operatorId = String(claims.sub ?? '') as UserId;
      if (operatorId === '') {
        return new Response(JSON.stringify({ error: 'invalid_token' }), {
          status: 401,
          headers: { 'content-type': 'application/json' },
        });
      }
      // The token is a signed JWT that stays valid until it expires, whatever happened to its grant. Revoking agent access (directly, by a password change, sign-out-everywhere or a reset) stamps a cutoff, and a token issued before it is refused here. `iat` is whole seconds, so a token minted in the same second as the revocation is refused too; the agent just authorizes again.
      // Read uncached, one primary-key lookup per verified call: the reset command revokes from another process and a scaled deployment runs several api replicas, so the cached settings would let a revoked token keep working for up to half a minute. A failed read throws, refusing the call rather than skipping the cutoff.
      const cutoff = (await repo.authSecuritySettings.get(di.db)).agentAccessNotBefore;
      const issuedAtMs = Number(claims.iat) * 1000;
      if (cutoff !== null && !(issuedAtMs > cutoff.getTime())) {
        return new Response(
          JSON.stringify({
            error: 'invalid_token',
            error_description: 'agent access was revoked; authorize again',
          }),
          {
            status: 401,
            headers: {
              'content-type': 'application/json',
              'www-authenticate': 'Bearer error="invalid_token"',
            },
          },
        );
      }
      const granted = grantedScopesOf(claims as TokenClaims);
      const allowed = await consumeRateLimit(di, operatorId);
      if (!allowed) {
        return new Response(JSON.stringify({ error: 'rate_limited' }), {
          status: 429,
          headers: {
            'content-type': 'application/json',
            'retry-after': String(RATE_LIMIT_WINDOW_SEC),
          },
        });
      }
      return handler.fetch(request, {
        authInfo: {
          token: '',
          clientId: String(claims.aud ?? ''),
          scopes: [...granted],
          extra: {
            ...(claims as Record<string, unknown>),
            [CLIENT_CONTEXT_CLAIM]: clientContextOf(request),
          },
        },
      });
    },
    {
      resource,
      requiredScopes: [],
      challengeScopes: [...MCP_SCOPES],
    },
  );

  app.all('/', async (c) => {
    // Ahead of authentication on purpose: on a demo box there is no meaningful identity to authenticate, so refusing here is the only answer that is not a lie.
    if (di.env.LIVE_DEMO) {
      throw new HttpError('FORBIDDEN', 'The MCP control plane is disabled in the live demo.');
    }
    const ipAddress = clientIpFromHeaders(c.req.raw.headers);
    const presented = /^bearer\s/i.test(c.req.header('authorization') ?? '');
    // The public app's per-address flood limit skips this route, so a verified agent is metered only by the per-operator budget above. Anyone who has not proved a token still pays the anonymous budget: a caller presenting none pays before any work, and one whose token is refused pays once the refusal is known, since telling the two apart costs only a local signature check.
    if (!presented) {
      const refusal = await di.security.protection.checkApiFlood(ipAddress, false);
      if (refusal !== null) return rateLimitedResponse(refusal.retryAfterMs);
    }
    const response = await protectedHandler(c.req.raw);
    // A request with no bearer token is how every client discovers the authorization server, so only a token that was presented and refused is recorded.
    if (response.status === 401 && presented) {
      await di.security.events.record({
        event: 'agent-authentication-failed',
        actor: 'agent',
        method: 'agent',
        reason: 'invalid_credentials',
        ipAddress,
        userAgent: c.req.header('user-agent') ?? null,
      });
      const refusal = await di.security.protection.checkApiFlood(ipAddress, false);
      if (refusal !== null) return rateLimitedResponse(refusal.retryAfterMs);
    }
    return response;
  });
  return app;
};

/**
 * The window each identity is counted in while Redis cannot be reached, one entry per identity.
 *
 * Holds only the current window, so an entry is overwritten rather than accumulated and the map stays the size of the set of callers. It is per process: with several api replicas an outage leaves each replica metering on its own, which is a looser limit than the shared one but still a limit.
 */
const fallbackWindows = new Map<string, { readonly window: number; readonly count: number }>();

/**
 * Fixed-window request budget for one token identity.
 *
 * A counter with an expiry, not a lock: nothing is owned, nothing is released, and a crashed request costs the caller one slot rather than wedging the window.
 *
 * A Redis fault falls back to counting the same window in this process instead of waving the call through. Refusing every agent call on a cache outage would be worse than a looser budget, but deleting the budget outright is what a runaway agent loop needs, and it removes the only throttle in front of an internet-reachable endpoint that places real orders at exactly the moment the idempotency records sharing that Redis are unavailable too.
 *
 * Exported so the fallback can be exercised without minting a real access token, since the route only reaches this after `requireMcpAuth` has verified one.
 *
 * @param di - Container supplying Redis and the logger.
 * @param operatorId - Identity the budget is charged to.
 * @returns True when the request may proceed within the budget, whether that budget was counted in Redis or, during an outage, in this process.
 */
export const consumeRateLimit = async (di: DI, operatorId: string): Promise<boolean> => {
  const window = Math.floor(Date.now() / (RATE_LIMIT_WINDOW_SEC * 1000));
  const key = `mcp:rate:${operatorId}:${window}`;
  try {
    // One MULTI rather than two round trips: an EXPIRE that failed after its INCR landed would leave the key in Redis with no TTL forever. The TTL is reset on every call, which is harmless because the window is part of the key name.
    const replies = await di.redis
      .raw()
      .multi()
      .incr(key)
      .expire(key, RATE_LIMIT_WINDOW_SEC)
      .exec();
    // ioredis resolves a discarded transaction to null and reports a per-command failure in the reply slot rather than rejecting, so both are thrown into the fallback below instead of reading as an unmetered call.
    const [incrErr, count] = replies?.[0] ?? [new Error('mcp rate limit transaction discarded')];
    if (incrErr) throw incrErr;
    return Number(count) <= RATE_LIMIT_MAX;
  } catch (err) {
    di.logger.warn({ err }, 'mcp_rate_limit_unavailable');
    const entry = fallbackWindows.get(operatorId);
    const count = entry?.window === window ? entry.count + 1 : 1;
    fallbackWindows.set(operatorId, { window, count });
    return count <= RATE_LIMIT_MAX;
  }
};

/**
 * Mounts the MCP control plane and its discovery documents, or nothing at all.
 *
 * Kept as its own function, called from `createApp`, because the operator kill switch is a mounting decision rather than a guard and the only honest way to test "there is no route" is to inspect the route table. `createApp` itself pulls in the WebSocket upgrade router, which needs the Bun global, so a suite that asked it this question could not run.
 *
 * @param app - The root application to mount onto.
 * @param di - Container supplying the environment flag, the auth instance and the dispatch dependencies.
 * @returns Nothing; the mount is the effect.
 */
export const mountMcpRoutes = (app: ApiHono, di: DI): void => {
  if (!di.env.MCP_ENABLED) return;
  app.route('/', wellKnownRouter(di));
  app.route('/api/mcp', mcpRouter(di));
};
