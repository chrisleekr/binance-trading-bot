// A cap on the request body every `/api` route is willing to read.
//
// Without one, an unbounded POST is answered by allocating it: the zod-openapi validator parses whatever arrives before any handler sees it, and the api is internet-facing with `LIVE_DEMO` making most of it reachable without a session.
//
// What the cap costs depends on how the body arrives. A request carrying `Content-Length` and no `Transfer-Encoding` is decided from that header alone, so an oversized one is refused for the price of a header read and nothing is allocated. A chunked request has no such header, and `bodyLimit` then reads the stream and accumulates every chunk in memory until the running total crosses the cap — so the refusal costs up to `maxSize` bytes of allocation. That asymmetry is why the exempt route is SKIPPED here rather than given a larger ceiling: a large ceiling at this layer is a large pre-auth allocation budget, and this middleware runs above `sessionResolver`.
//
// One route cannot live under a JSON-sized cap. `POST /api/restore` receives a `pg_dump` archive. Its cap is applied inside the backup router, behind that router's own `requireUser()` and `requireNotDemo()`, so only an authenticated non-demo operator can select it.

import { bodyLimit } from 'hono/body-limit';
import type { MiddlewareHandler } from 'hono';

import { errorResponse } from 'middleware/error.js';
import type { Env } from 'types.js';

/**
 * The cap for every route that does not name its own.
 *
 * 1 MiB is far above anything this api legitimately accepts — the largest ordinary body is a profile config — and far below a size worth allocating from an anonymous caller. A module constant rather than an env var because nothing has asked to tune it, and an env var would pull in `.env.example`, the env catalogue, the phantom-env-var gate and the generated docs table for a value with no consumer.
 */
export const DEFAULT_MAX_BODY_BYTES: number = 1024 * 1024;

/** The cap for the backup-restore upload, sized for a `pg_dump` custom-format archive of the whole database rather than for a request body. Also the process-wide ceiling `Bun.serve` is given, since Bun terminates anything larger before Hono ever sees it. */
export const RESTORE_MAX_BODY_BYTES: number = 2 * 1024 * 1024 * 1024;

/**
 * Paths the global cap does not apply to at all, keyed by the concrete path a request carries.
 *
 * Skipped rather than raised. `bodyLimit` with a large `maxSize` still READS a chunked body to count it, so granting the larger ceiling here would let an anonymous caller — this middleware runs above `sessionResolver` — make the process buffer that many bytes. A skipped path reads nothing at this layer and reaches its own router's guards first, where the real cap is imposed.
 *
 * Concrete paths only, never route patterns: the lookup is against `c.req.path`, so a `:param` or `*` spelling would match no request and the exemption would be silently dead.
 */
export const LARGE_BODY_ROUTES: ReadonlySet<string> = new Set(['/api/restore']);

/**
 * Build a `bodyLimit` that answers in the project error envelope.
 *
 * @param maxSize - The ceiling in bytes; also interpolated into the message so the operator can tell which cap refused them.
 * @returns The configured middleware.
 */
const cappedAt = (maxSize: number): MiddlewareHandler<Env> =>
  bodyLimit({
    maxSize,
    // Returned, not thrown. The cap can fire before any route matched, so there is no handler for `app.onError` to unwind from; going through the shared envelope producer is what keeps the response shape identical to every other error the SPA branches on.
    onError: () =>
      errorResponse(
        'PAYLOAD_TOO_LARGE',
        `request body exceeds the ${maxSize}-byte limit for this endpoint`,
        undefined,
      ),
  }) as MiddlewareHandler<Env>;

/**
 * The global request-body cap.
 *
 * @returns A middleware that answers 413 in the project error envelope when the body exceeds {@link DEFAULT_MAX_BODY_BYTES}, is a no-op for a request carrying no body, and stands aside entirely for a path in {@link LARGE_BODY_ROUTES}.
 */
export const requestBodyLimit = (): MiddlewareHandler<Env> => {
  // Built once at mount rather than per request: `bodyLimit` closes over its `maxSize`, so a fresh call per request would allocate a closure on every asset fetch to answer a question that never changes.
  const limiter = cappedAt(DEFAULT_MAX_BODY_BYTES);
  return async (c, next) => (LARGE_BODY_ROUTES.has(c.req.path) ? next() : limiter(c, next));
};

/**
 * The backup-restore cap, for mounting INSIDE the backup router after its auth guards.
 *
 * @returns A middleware capping the body at {@link RESTORE_MAX_BODY_BYTES}.
 */
export const restoreBodyLimit = (): MiddlewareHandler<Env> => cappedAt(RESTORE_MAX_BODY_BYTES);
