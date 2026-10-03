import type { DI } from '../di.js';
import { createApiHono, type ApiHono } from '../types.js';

/**
 * Discovery documents, exposed at the origin root where the specifications say they live.
 *
 * RFC 9728 and RFC 8414 both locate these by inserting `.well-known/<name>` between the ORIGIN and the resource path, never under an application's own base path. Hono has to route them somewhere, and without this bridge an MCP client following a `WWW-Authenticate` header reaches the SPA fallback instead of the authorization server.
 *
 * The two document families need opposite treatment, which is the only subtle thing here:
 *
 * - The protected-resource document is served by an `onRequest` hook in the MCP plugin that matches the ROOT pathname itself, both bare and with the resource path appended. It is forwarded unchanged, because rewriting the path is exactly what stops that hook matching.
 * - The authorization-server and OpenID documents are ordinary endpoints under Better Auth's base path, so those are rewritten to it.
 *
 * Either way the body comes from the plugin rather than from a second copy here, so a change to the advertised scopes or endpoints reaches clients without anything drifting.
 */
const AUTH_BASE = '/api/auth';

/** Served by the plugin's root-path hook. Forwarded with the pathname intact. */
const ROOT_HOOK_DOCUMENTS = ['oauth-protected-resource'] as const;

/** Endpoints under the Better Auth base path. Rewritten to it. */
const BASE_PATH_DOCUMENTS = ['oauth-authorization-server', 'openid-configuration'] as const;

/**
 * Root-mounted discovery router bridging to the Better Auth handler.
 *
 * @param di - Container supplying the Better Auth instance whose handler owns the documents.
 * @returns A router to mount at the origin root.
 */
export const wellKnownRouter = (di: DI): ApiHono => {
  const app = createApiHono();

  for (const name of ROOT_HOOK_DOCUMENTS) {
    for (const path of [`/.well-known/${name}`, `/.well-known/${name}/*`]) {
      app.get(path, async (c) => di.auth.handler(c.req.raw));
    }
  }

  for (const name of BASE_PATH_DOCUMENTS) {
    for (const path of [`/.well-known/${name}`, `/.well-known/${name}/*`]) {
      app.get(path, async (c) => {
        const url = new URL(c.req.url);
        url.pathname = `${AUTH_BASE}/.well-known/${name}`;
        return di.auth.handler(
          new Request(url.toString(), { method: 'GET', headers: c.req.raw.headers }),
        );
      });
    }
  }

  return app;
};
