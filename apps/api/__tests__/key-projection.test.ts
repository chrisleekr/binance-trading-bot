import { OpenAPIHono } from '@hono/zod-openapi';
import { describe, expect, it } from 'vitest';

import type { DI } from '../src/di.js';
import { apiKeysRouter } from '../src/routes/api-keys.js';
import { authRouter } from '../src/routes/auth.js';
import { backupRouter } from '../src/routes/backup.js';
import { dashboardRouter } from '../src/routes/dashboard.js';
import { dustTransferRouter } from '../src/routes/dust-transfer.js';
import { killSwitchRouter } from '../src/routes/kill-switch.js';
import { manualOrdersRouter } from '../src/routes/manual-orders.js';
import { ordersRouter } from '../src/routes/orders.js';
import { overrideRouter } from '../src/routes/override.js';
import { profilesRouter } from '../src/routes/profiles.js';
import { strategiesRouter } from '../src/routes/strategies.js';
import { symbolsRouter } from '../src/routes/symbols.js';
import type { Env } from '../src/types.js';

// Forbidden property names. Anything matching these in a response schema is
// a v1.0 threat-model regression — Binance API key material is stored
// plaintext on disk and must never be projected back to the client.
const FORBIDDEN_PROPS = new Set(['key', 'secret', 'apiKey', 'apiSecret', 'password', 'token']);

interface SchemaLike {
  type?: string;
  properties?: Record<string, SchemaLike>;
  items?: SchemaLike;
  oneOf?: SchemaLike[];
  anyOf?: SchemaLike[];
  allOf?: SchemaLike[];
  $ref?: string;
}

/**
 * Resolves a `$ref` against the document's `components.schemas`. The
 * OpenAPI emitter deduplicates shared schemas behind refs; a scan that
 * stops at the ref would miss `key`/`secret`/`password` leaks one
 * indirection away.
 */
const resolveRef = (
  ref: string,
  components: { schemas?: Record<string, SchemaLike> } | undefined,
): SchemaLike | undefined => {
  const prefix = '#/components/schemas/';
  if (!ref.startsWith(prefix)) return undefined;
  return components?.schemas?.[ref.slice(prefix.length)];
};

const collectFindings = (
  node: SchemaLike | undefined,
  path: string,
  out: { path: string; prop: string }[],
  components: { schemas?: Record<string, SchemaLike> } | undefined,
  seen: Set<string>,
): void => {
  if (!node || typeof node !== 'object') return;
  if (node.$ref) {
    if (seen.has(node.$ref)) return;
    seen.add(node.$ref);
    collectFindings(resolveRef(node.$ref, components), path, out, components, seen);
    return;
  }
  if (node.properties) {
    for (const [key, child] of Object.entries(node.properties)) {
      if (FORBIDDEN_PROPS.has(key)) {
        out.push({ path, prop: key });
      }
      collectFindings(child, `${path}.${key}`, out, components, seen);
    }
  }
  if (node.items) collectFindings(node.items, `${path}[]`, out, components, seen);
  for (const variant of [...(node.oneOf ?? []), ...(node.anyOf ?? []), ...(node.allOf ?? [])]) {
    collectFindings(variant, path, out, components, seen);
  }
};

describe('api response schemas — key-projection contract', () => {
  it('no response schema in any registered route exposes a key/secret/password property', () => {
    const di = {} as DI;
    const app = new OpenAPIHono<Env>();
    app.route('/api/auth', authRouter(di));
    app.route('/api', strategiesRouter(di));
    app.route('/api', profilesRouter(di));
    app.route('/api', apiKeysRouter(di));
    app.route('/api', symbolsRouter(di));
    app.route('/api', ordersRouter(di));
    app.route('/api', manualOrdersRouter(di));
    app.route('/api', overrideRouter(di));
    app.route('/api', killSwitchRouter(di));
    app.route('/api', dustTransferRouter(di));
    app.route('/api', dashboardRouter(di));
    app.route('/api', backupRouter(di));

    const doc = app.getOpenAPIDocument({
      openapi: '3.0.0',
      info: { title: 'app', version: '1.0.0' },
    }) as unknown as {
      paths?: Record<
        string,
        Record<
          string,
          {
            responses?: Record<string, { content?: Record<string, { schema?: SchemaLike }> }>;
          }
        >
      >;
      components?: {
        schemas?: Record<string, SchemaLike>;
        responses?: Record<string, { content?: Record<string, { schema?: SchemaLike }> }>;
      };
    };

    const findings: { path: string; prop: string }[] = [];

    for (const [pathName, methods] of Object.entries(doc.paths ?? {})) {
      for (const [method, op] of Object.entries(methods)) {
        for (const [status, response] of Object.entries(op.responses ?? {})) {
          // Errors only carry the standard envelope; skip non-2xx so a
          // generic `error` shape in 4xx never crowds the report.
          if (!status.startsWith('2')) continue;
          for (const [contentType, ct] of Object.entries(response.content ?? {})) {
            if (!ct.schema) continue;
            collectFindings(
              ct.schema,
              `${method.toUpperCase()} ${pathName} ${status} ${contentType}`,
              findings,
              doc.components,
              new Set<string>(),
            );
          }
        }
      }
    }

    expect(
      findings,
      `Forbidden secret-material properties leaked into response schemas:\n${findings
        .map((f) => `  ${f.path} → ${f.prop}`)
        .join('\n')}`,
    ).toEqual([]);
  });

  it('the ApiKeyResponse schema exposes only redacted metadata and verification status', async () => {
    const { ApiKeyResponse } = await import('@app/contracts');
    const props = Object.keys(ApiKeyResponse.shape).sort();
    // Locks the public shape so a future field addition is a conscious edit
    // here. No secret material (key/secret) — the verification trio is the
    // worker's getAccount outcome, not credential data.
    expect(props).toEqual([
      'createdAt',
      'label',
      'last4',
      'verificationError',
      'verificationStatus',
      'verifiedAt',
    ]);
  });
});
