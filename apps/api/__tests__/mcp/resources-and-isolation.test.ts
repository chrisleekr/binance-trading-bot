// Two things that have nothing to do with each other except that both are about what an MCP client CANNOT reach: the documentation reader's path handling, and the fact that an MCP access token is worthless against the REST API.

import { mkdtempSync, mkdirSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { Hono } from 'hono';
import { describe, expect, it } from 'vitest';
import type { Auth } from '../../src/auth.js';
import { MCP_RESOURCES, readMcpResource } from '../../src/mcp/resources.js';
import { sessionResolver } from '../../src/middleware/auth.js';
import type { Env } from '../../src/types.js';

const docsFixture = (): string => {
  const root = mkdtempSync(join(tmpdir(), 'mcp-docs-'));
  for (const resource of MCP_RESOURCES) {
    const target = join(root, resource.relativePath);
    mkdirSync(join(target, '..'), { recursive: true });
    writeFileSync(target, `# ${resource.title}\n`);
  }
  writeFileSync(join(root, '..', 'outside-the-root.md'), 'secret\n');
  // Readable, inside the docs root, and NOT a published resource. Without it every refusal below is decided by the containment check alone, and the closed list, the actual primary control, is never the thing under test.
  writeFileSync(join(root, 'unpublished-note.md'), 'not for an agent\n');
  return root;
};

describe('MCP documentation resources', () => {
  it('serves every published resource from the closed list', async () => {
    const root = docsFixture();
    // Non-emptiness first: an empty resource list would make every refusal below hold for want of anything to serve.
    expect(MCP_RESOURCES.length).toBeGreaterThan(0);
    for (const resource of MCP_RESOURCES) {
      const found = await readMcpResource(resource.uri, root);
      expect(found?.text).toContain(resource.title);
    }
  });

  it('resolves every published resource against the repo docs tree, not a fixture of its own making', async () => {
    // Every other case in this file reads a tree built from MCP_RESOURCES itself, which proves the reader works against whatever the list says and nothing more. Rename one page under `docs/` and all of them stay green while `resources/read` answers an agent "unknown resource". Resolved from this file's own URL because `process.cwd()` is the workspace under a filtered run and the repo root under a root run, and a wrong root here would point the whole walk at nothing.
    const docsRoot = fileURLToPath(new URL('../../../../docs', import.meta.url));
    // A list silently emptied down to one entry would satisfy the loop below, so the size is pinned alongside it.
    expect(MCP_RESOURCES).toHaveLength(8);
    for (const resource of MCP_RESOURCES) {
      const found = await readMcpResource(resource.uri, docsRoot);
      expect(found, `${resource.uri} does not resolve to ${resource.relativePath}`).not.toBeNull();
      // A real page, not a stub someone left behind to satisfy a path check.
      expect(found?.text.length ?? 0).toBeGreaterThan(200);
    }
  });

  it.each([
    'docs://../../etc/passwd',
    'docs://concepts/strategies/../../../outside-the-root',
    'file:///etc/passwd',
    '/etc/passwd',
    'docs://config/trailing-trade/../../../../outside-the-root',
  ])('refuses the crafted uri %s', async (uri) => {
    // There is no path arithmetic to attack: the URI is a map key, and a key that is not in the map never reaches the filesystem. The assertion is that this stays true for inputs that LOOK like paths, because the day someone makes `relativePath` dynamic is the day it stops being true silently.
    expect(await readMcpResource(uri, docsFixture())).toBeNull();
  });

  it('refuses a readable file inside the docs root that the list does not publish', async () => {
    // The case the containment check cannot decide: the path resolves cleanly inside the root and the file is there to be read. Only membership of the closed list refuses it, so this is what pins that list rather than the traversal backstop behind it.
    const root = docsFixture();
    expect(await readMcpResource('docs://unpublished-note', root)).toBeNull();
    expect(await readMcpResource('unpublished-note.md', root)).toBeNull();
  });

  it('refuses a published resource whose file is missing rather than reporting the path it tried', async () => {
    const empty = mkdtempSync(join(tmpdir(), 'mcp-docs-empty-'));
    const first = MCP_RESOURCES[0];
    expect(first).toBeDefined();
    expect(await readMcpResource(first?.uri ?? '', empty)).toBeNull();
  });
});

describe('MCP tokens on the REST API', () => {
  /** The REST API resolves identity ONLY through `sessionResolver`, which reads the Better Auth session cookie. This probe asks it the question a stolen MCP token would ask. */
  const probe = async (headers: Record<string, string>): Promise<string | null> => {
    const auth = { api: { getSession: async () => null } } as unknown as Auth;
    const app = new Hono<Env>();
    app.use('*', sessionResolver(auth, null));
    app.get('/probe', (c) => c.json({ userId: c.get('userId') ?? null }));
    const res = await app.request('/probe', { headers });
    return ((await res.json()) as { userId: string | null }).userId;
  };

  it('treats a bearer token as no identity at all', async () => {
    // A token accepted here would reach `GET /api/backup`, which streams a full database dump including every plaintext Binance key. The MCP token is verified at `/api/mcp` and nowhere else, so the REST API must see a bearer header as exactly what it is: not a session.
    expect(await probe({ authorization: 'Bearer an-mcp-access-token' })).toBeNull();
    expect(await probe({ authorization: 'DPoP an-mcp-access-token' })).toBeNull();
  });

  it('still resolves a real Better Auth session, so the check above is not refusing everything', async () => {
    const auth = {
      api: {
        getSession: async () => ({
          user: { id: '00000000-0000-4000-8000-00000000b001' },
          session: { id: 'session-1' },
        }),
      },
    } as unknown as Auth;
    const app = new Hono<Env>();
    app.use('*', sessionResolver(auth, null));
    app.get('/probe', (c) => c.json({ userId: c.get('userId') ?? null }));
    const res = await app.request('/probe', { headers: { authorization: 'Bearer irrelevant' } });
    expect(((await res.json()) as { userId: string | null }).userId).toBe(
      '00000000-0000-4000-8000-00000000b001',
    );
  });
});
