// The MCP endpoint is a public, internet-reachable trading control plane. Three separate things decide whether it can be reached; two of them are tested here, and each alone is a single point of failure. The third, `requireMcpAuth` verifying the bearer token, cannot be asked of a route table and is asked of a real Better Auth instance in `auth-surface.test.ts`.
//
// The one that matters most is not a guard at all: with `MCP_ENABLED` off the route is never mounted, so there is no surface to misconfigure. A guarded-but-present route would still answer, still parse a token, and still depend on that guard being correct forever.
//
// The absence of dynamic client registration is NOT asserted here, and cannot be: `mountMcpRoutes` mounts only the well-known documents and the endpoint itself, while the Better Auth handler that would serve `POST /oauth2/register` is mounted elsewhere behind a wildcard and never appears in this table. A filter for it over these routes returns nothing whatever the registration option is set to, which is a green that moves for no reason. `auth-surface.test.ts` asks the handler itself instead, with a signed-in operator, which is the only caller whose answer changes when the option changes.

import { describe, expect, it, vi } from 'vitest';
import type { DI } from '../../src/di.js';
import { mountMcpRoutes } from '../../src/routes/mcp.js';
import { createApiHono, type ApiHono } from '../../src/types.js';
import type { Env } from '../../src/env.js';
import { errorHandler } from '../../src/middleware/error.js';

const baseEnv = (overrides: Partial<Env>): Env =>
  ({
    NODE_ENV: 'test',
    PORT: 3000,
    ADMIN_PORT: 9100,
    ADMIN_HOST: '127.0.0.1',
    WEB_ORIGIN: ['http://localhost:5173'],
    DATABASE_URL: 'postgres://x/y',
    REDIS_URL: 'redis://localhost:6379',
    AUTH_SECRET: 'x'.repeat(32),
    PGSSLMODE: 'disable',
    BACKUP_DIR: '/tmp',
    GIT_SHA: 'test',
    WEB_DIST_DIR: 'does-not-exist',
    LIVE_DEMO: false,
    MCP_ENABLED: false,
    ...overrides,
  }) as Env;

/**
 * A container carrying only what `createApp` touches while building its route table. The routers are mounted with an unusable DI on purpose: this suite asks which routes EXIST, and a container complete enough to serve a request would make the answer depend on a database.
 */
const diWith = (env: Env): DI =>
  ({
    env,
    logger: { warn: vi.fn(), info: vi.fn(), error: vi.fn(), debug: vi.fn() },
    metrics: { registry: { registerHttpMetrics: undefined } },
    redis: { raw: () => ({}) },
    auth: { handler: async () => new Response('{}'), $context: Promise.resolve({}) },
    demoOperatorId: null,
  }) as unknown as DI;

const mounted = (env: Env): ApiHono => {
  const app = createApiHono();
  mountMcpRoutes(app, diWith(env));
  return app;
};

const routeSignatures = (env: Env): string[] =>
  mounted(env).routes.map((route) => `${route.method} ${route.path}`);

const mcpSignatures = (signatures: readonly string[]): string[] =>
  signatures.filter((sig) => sig.includes('/api/mcp') || sig.includes('/.well-known/'));

describe('MCP mount gating', () => {
  it('mounts no MCP route at all while MCP_ENABLED is off', () => {
    expect(mcpSignatures(routeSignatures(baseEnv({ MCP_ENABLED: false })))).toEqual([]);
  });

  it('mounts the endpoint and its discovery documents once MCP_ENABLED is on', () => {
    // The discriminating half. Without it the assertion above passes for a build that lost the feature entirely, which is the same observation for an operator who turned it on.
    const signatures = mcpSignatures(
      routeSignatures(
        baseEnv({ MCP_ENABLED: true, MCP_RESOURCE_URL: 'https://bot.example.com/api/mcp' }),
      ),
    );
    expect(signatures).toContain('ALL /api/mcp');
    expect(signatures).toContain('GET /.well-known/oauth-protected-resource');
    expect(signatures).toContain('GET /.well-known/oauth-authorization-server');
  });

  it('refuses every MCP request while LIVE_DEMO is on', async () => {
    // LIVE_DEMO injects the sole operator id for anonymous callers, so an MCP endpoint on a demo box would be an anonymous trading control plane. The refusal sits ahead of token verification because there is no identity there worth verifying.
    const app = mounted(
      baseEnv({
        MCP_ENABLED: true,
        LIVE_DEMO: true,
        MCP_RESOURCE_URL: 'https://bot.example.com/api/mcp',
      }),
    );
    app.onError(errorHandler({ error: vi.fn() } as never));
    const res = await app.request('/api/mcp', {
      method: 'POST',
      headers: { 'content-type': 'application/json', authorization: 'Bearer anything' },
      body: '{"jsonrpc":"2.0","id":1,"method":"tools/list"}',
    });
    expect(res.status).toBe(403);
  });
});
