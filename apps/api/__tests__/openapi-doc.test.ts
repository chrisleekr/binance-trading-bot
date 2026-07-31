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

  it('serves /openapi.json', async () => {
    const app = fx.app as unknown as OpenAPIHono;
    mountDocs(app as never);
    const res = await app.request('/openapi.json');
    expect(res.status).toBe(200);
    const body = (await res.json()) as { openapi?: string };
    expect(body.openapi).toBe('3.1.0');
  });
});
