// The rate limit as a caller meets it: through the mounted route, after token verification.
//
// `rate-limit.test.ts` asks the counter whether a call is allowed. Nothing there proves the route turns a refusal into the 429 and `retry-after` an MCP client backs off on, so a route that computed the verdict and ignored it would pass that suite.

import { afterEach, describe, expect, it, vi } from 'vitest';
import type { DI } from '../../src/di.js';
import { mcpRouter } from '../../src/routes/mcp.js';

// Token verification is replaced by a stand-in that hands the callback a verified identity, because minting a real access token needs a database and this suite is about what happens around verification. The token `refused` stands for one that failed verification, and a request without a token gets the challenge a real client discovers the authorization server from.
vi.mock('@better-auth/mcp', () => ({
  requireMcpAuth:
    (
      _auth: unknown,
      handler: (request: Request, claims: Record<string, unknown>) => Promise<Response>,
    ) =>
    (request: Request) => {
      const header = request.headers.get('authorization') ?? '';
      if (header === '' || header === 'Bearer refused')
        return Promise.resolve(new Response(null, { status: 401 }));
      // Issued a minute ago, so a cutoff stamped now is after it.
      return handler(request, {
        sub: 'op-429',
        scopes: ['mcp:read'],
        iat: Math.floor(Date.now() / 1000) - 60,
      });
    },
}));

// The revocation cutoff is read from the settings row on every verified call. `cutoff.at` is what that row holds.
const cutoff: { at: Date | null } = { at: null };
vi.mock('@app/db', () => ({
  repo: { authSecuritySettings: { get: async () => ({ agentAccessNotBefore: cutoff.at }) } },
}));

/**
 * A container whose Redis reports a fixed INCR count for every call.
 *
 * @param count - The value the INCR slot of the transaction resolves to, standing in for how many calls this window has already seen.
 * @returns A DI carrying only what `mcpRouter` reads before and during the rate-limit check.
 */
const diCounting = (
  count: number,
  checkApiFlood: (ip: string, signedIn: boolean) => Promise<unknown> = async () => null,
): DI =>
  ({
    env: {
      LIVE_DEMO: false,
      MCP_ENABLED: true,
      MCP_RESOURCE_URL: 'https://bot.example.test/api/mcp',
    },
    logger: { warn: vi.fn(), info: vi.fn(), error: vi.fn(), debug: vi.fn() },
    auth: {},
    db: {},
    // The cached settings never carry the cutoff; the route has to read the row.
    security: {
      settings: { get: async () => ({}) },
      events: { record: async () => undefined },
      protection: { checkApiFlood },
    },
    redis: {
      raw: () => {
        const chain = {
          incr: () => chain,
          expire: () => chain,
          exec: async () => [
            [null, count],
            [null, 1],
          ],
        };
        return { multi: () => chain };
      },
    },
  }) as unknown as DI;

const call = async (di: DI, token: string | null = 'verified-by-mock'): Promise<Response> =>
  mcpRouter(di).request('/', {
    method: 'POST',
    headers: {
      'content-type': 'application/json',
      accept: 'application/json, text/event-stream',
      ...(token === null ? {} : { authorization: `Bearer ${token}` }),
    },
    body: '{"jsonrpc":"2.0","id":1,"method":"tools/list"}',
  });

describe('MCP route rate limit', () => {
  it('answers a caller over budget with 429 and the window to wait', async () => {
    const res = await call(diCounting(121));
    expect(res.status).toBe(429);
    // An MCP client backs off on this header; without it a looping agent retries immediately into the same refusal.
    expect(res.headers.get('retry-after')).toBe('60');
    expect(await res.json()).toEqual({ error: 'rate_limited' });
  });

  it('lets a caller within budget through to the protocol handler', async () => {
    // The discriminating half: a route that answered 429 to every verified call would satisfy the case above.
    const res = await call(diCounting(1));
    expect(res.status).not.toBe(429);
    // A JSON-RPC envelope is only produced by the protocol handler, so this proves the call got past the limiter rather than being refused some other way. The request omits a protocol version, so the handler's own answer is an error, which is irrelevant here.
    expect(((await res.json()) as { jsonrpc?: string }).jsonrpc).toBe('2.0');
  });
});

// The public app's per-address flood limit skips this route, so the route itself decides who pays the anonymous budget.
describe('MCP route and the anonymous flood budget', () => {
  const floodRefusing = () =>
    vi.fn(async () => ({ limit: 'anonymous_api', reason: 'anonymous_api', retryAfterMs: 1500 }));

  it('never charges a verified agent the anonymous budget', async () => {
    // An agent authenticates with a bearer token and never carries a session cookie, so charging it here would cap it at the anonymous budget, below its own limit, and let its loop starve the sign-in page on the same address.
    const flood = floodRefusing();
    const res = await call(diCounting(1, flood), 'verified-by-mock');
    expect(res.status).not.toBe(429);
    expect(flood).not.toHaveBeenCalled();
  });

  it('charges a caller with no token before verification, and refuses one over budget', async () => {
    const flood = floodRefusing();
    const res = await call(diCounting(1, flood), null);
    expect(res.status).toBe(429);
    expect(res.headers.get('retry-after')).toBe('2');
    expect(flood).toHaveBeenCalledWith(expect.any(String), false);
  });

  it('lets a caller with no token within budget reach the challenge', async () => {
    const flood = vi.fn(async () => null);
    const res = await call(diCounting(1, flood), null);
    expect(res.status).toBe(401);
    expect(flood).toHaveBeenCalledTimes(1);
  });

  it('charges a refused token once the refusal is known, and answers 429 once over budget', async () => {
    const within = vi.fn(async () => null);
    const refused = await call(diCounting(1, within), 'refused');
    expect(refused.status).toBe(401);
    expect(within).toHaveBeenCalledTimes(1);
    expect(within).toHaveBeenCalledWith(expect.any(String), false);
    const over = await call(diCounting(1, floodRefusing()), 'refused');
    expect(over.status).toBe(429);
  });
});

describe('MCP route and a revoked agent', () => {
  afterEach(() => {
    cutoff.at = null;
  });

  it('refuses a token issued before a revocation another process wrote, whatever this process has cached', async () => {
    // The reset command revokes from its own process and a scaled deployment runs several api replicas, so a cached cutoff would let a revoked token work for up to half a minute.
    cutoff.at = new Date();
    const res = await call(diCounting(1));
    expect(res.status).toBe(401);
    expect(((await res.json()) as { error_description?: string }).error_description).toMatch(
      /revoked/,
    );
  });

  it('accepts a token issued after the cutoff', async () => {
    cutoff.at = new Date(Date.now() - 3_600_000);
    const res = await call(diCounting(1));
    expect(res.status).not.toBe(401);
  });
});
