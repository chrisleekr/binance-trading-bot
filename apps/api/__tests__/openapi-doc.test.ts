// The OpenAPI document is generated from EVERY mounted route at once, so a
// single schema the generator cannot introspect (a ZodCatch, a bare transform, a
// branded type with no `.openapi()` metadata) throws and takes the whole document
// with it — `/openapi.json` and `/docs` then 500 for every route, not just the
// offending one. Nothing exercised that path, so the failure was invisible until
// an operator opened the docs. This is the gate.

import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { OpenAPIHono } from '@hono/zod-openapi';
import { mountDocs, OPENAPI_DOC } from '../src/routes/docs.js';
import { HAS_INFRA, setupApp, type ApiFixture } from './_helpers.js';

const describeIfInfra = HAS_INFRA ? describe : describe.skip;

describeIfInfra('OpenAPI document', () => {
  let fx: ApiFixture;
  beforeAll(async () => {
    fx = await setupApp();
  });
  afterAll(async () => {
    await fx.cleanup();
  });

  it('generates from the fully mounted app without throwing', () => {
    const app = fx.app as unknown as OpenAPIHono;
    const doc = app.getOpenAPI31Document(OPENAPI_DOC) as unknown as {
      paths?: Record<string, unknown>;
    };
    // A generated-but-empty document would pass a bare "does not throw", so
    // assert it actually described the routes.
    expect(Object.keys(doc.paths ?? {}).length).toBeGreaterThan(20);
  });

  it('declares the statuses the archive routes can actually answer', () => {
    // The document is what a generated client is built from, so a status a handler can return and this block does not name reaches that client as a protocol error rather than the failure it is. Both gaps below were real: the detail route validates `archiveId` as a uuid and so can 422, and the export route runs its unpaginated read under the same statement budget as the list route and so can 503 — on the request that budget most exists for, since an export defaults to the whole archive.
    const app = fx.app as unknown as OpenAPIHono;
    const doc = app.getOpenAPI31Document(OPENAPI_DOC) as unknown as {
      paths: Record<string, { get?: { responses?: Record<string, unknown> } }>;
    };
    // Matched by suffix, so the assertion survives a change to the account-scoped prefix.
    const statuses = (suffix: string): string[] => {
      const key = Object.keys(doc.paths).find((path) => path.endsWith(suffix));
      expect(key, `no path ending in ${suffix}`).toBeDefined();
      return Object.keys(doc.paths[key as string]?.get?.responses ?? {});
    };
    expect(statuses('/trade-archive/{archiveId}')).toContain('422');
    expect(statuses('/trade-archive/export')).toContain('503');
  });

  it('serves /openapi.json', async () => {
    const app = fx.app as unknown as OpenAPIHono;
    mountDocs(app as never);
    const res = await app.request('/openapi.json');
    expect(res.status).toBe(200);
    const body = (await res.json()) as { openapi?: string };
    expect(body.openapi).toBe('3.1.0');
  });
});
