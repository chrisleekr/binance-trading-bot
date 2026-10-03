// The rate limit as a caller meets it: through the mounted route, after token verification.
//
// `rate-limit.test.ts` asks the counter whether a call is allowed. Nothing there proves the route turns a refusal into the 429 and `retry-after` an MCP client backs off on, so a route that computed the verdict and ignored it would pass that suite.

import { describe, expect, it, vi } from 'vitest';
import type { DI } from '../../src/di.js';
import { mcpRouter } from '../../src/routes/mcp.js';

// Token verification is replaced by a pass-through that hands the callback a verified identity, because minting a real access token needs a database and this suite is about what happens after verification succeeds.
vi.mock('@better-auth/mcp', () => ({
  requireMcpAuth:
    (
      _auth: unknown,
      handler: (request: Request, claims: Record<string, unknown>) => Promise<Response>,
    ) =>
    (request: Request) =>
      handler(request, { sub: 'op-429', scopes: ['mcp:read'] }),
}));

/**
 * A container whose Redis reports a fixed INCR count for every call.
 *
 * @param count - The value the INCR slot of the transaction resolves to, standing in for how many calls this window has already seen.
 * @returns A DI carrying only what `mcpRouter` reads before and during the rate-limit check.
 */
const diCounting = (count: number): DI =>
  ({
    env: {
      LIVE_DEMO: false,
      MCP_ENABLED: true,
      MCP_RESOURCE_URL: 'https://bot.example.test/api/mcp',
    },
    logger: { warn: vi.fn(), info: vi.fn(), error: vi.fn(), debug: vi.fn() },
    auth: {},
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

const call = async (di: DI): Promise<Response> =>
  mcpRouter(di).request('/', {
    method: 'POST',
    headers: {
      'content-type': 'application/json',
      accept: 'application/json, text/event-stream',
      authorization: 'Bearer verified-by-mock',
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
