// The protected-resource document is how an MCP client finds the authorization server at all. A `WWW-Authenticate` header points at it, the client fetches it, and everything after that depends on what it says.
//
// It is asserted against a REAL Better Auth instance rather than a fixture, because the document is produced by the plugin and the only interesting failure is the one where our configuration and the plugin's output disagree.

import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createAuth } from '../../src/auth.js';
import type { DI } from '../../src/di.js';
import { wellKnownRouter } from '../../src/routes/well-known.js';
import type { ApiHono } from '../../src/types.js';
import { HAS_INFRA, setupApp, type ApiFixture } from '../_helpers.js';

const RESOURCE = 'https://bot.example.test/api/mcp';

interface ProtectedResourceMetadata {
  readonly resource?: string;
  readonly authorization_servers?: readonly string[];
  readonly scopes_supported?: readonly string[];
}

describe.skipIf(!HAS_INFRA)('MCP protected-resource metadata', () => {
  // One fixture and one auth instance for the file. Provisioning per test put a container cold start under the 5s test timeout, so the first case timed out while every later one passed on the warm fixture, which reads as a defect in the code under test rather than in the harness.
  let fx: ApiFixture;
  let app: ApiHono;

  beforeAll(async () => {
    fx = await setupApp();
    const auth = createAuth({
      db: fx.di.db,
      webOrigins: ['http://localhost:5173'],
      authSecret: 'x'.repeat(32),
      isProduction: false,
      mcpResource: RESOURCE,
    });
    app = wellKnownRouter({ auth } as unknown as DI);
  });

  afterAll(async () => {
    await fx.cleanup();
  });

  const fetchDocument = async (
    path: string,
  ): Promise<{ status: number; body: ProtectedResourceMetadata }> => {
    // An absolute URL, not a bare path: Better Auth derives its own origin from the incoming request when no baseURL is configured, and a relative request leaves it with nothing to derive from.
    const res = await app.request(`https://bot.example.test${path}`);
    return { status: res.status, body: (await res.json()) as ProtectedResourceMetadata };
  };

  it('serves the RFC 9728 document at the origin root, naming the resource and both scopes', async () => {
    // Root-mounted, not under `/api/auth`: the specification inserts `.well-known` between the ORIGIN and the resource path, so a client following a challenge header looks here and nowhere else.
    const { status, body } = await fetchDocument('/.well-known/oauth-protected-resource');
    expect(status).toBe(200);
    expect(body.resource).toBe(RESOURCE);
    expect(body.authorization_servers?.length ?? 0).toBeGreaterThan(0);
    expect([...(body.scopes_supported ?? [])].sort()).toEqual(['mcp:read', 'mcp:trade']);
  });

  it('also answers the path-suffixed spelling a client derives from the resource identifier', async () => {
    // A resource identifier with a path produces `/.well-known/oauth-protected-resource/api/mcp`. Serving only the bare form leaves a conforming client with a 404 and no way to start.
    const { status, body } = await fetchDocument('/.well-known/oauth-protected-resource/api/mcp');
    expect(status).toBe(200);
    expect(body.resource).toBe(RESOURCE);
  });

  it('serves the authorization-server metadata the resource document points at, offering offline_access there', async () => {
    const { status, body } = await fetchDocument('/.well-known/oauth-authorization-server');
    expect(status).toBe(200);
    // The resource document above deliberately omits it; the refresh-token scope belongs to the authorization server.
    expect(body.scopes_supported).toContain('offline_access');
  });
});
