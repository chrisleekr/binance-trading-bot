import { asProfileId, AuditLogListResponse, ErrorEnvelope } from '@app/contracts';
import { createRoute, z } from '@hono/zod-openapi';
import type { DI } from 'di.js';
import { HttpError } from 'middleware/error.js';
import { requireUser } from 'middleware/require-user.js';
import { scopeOf } from 'route-helpers.js';
import { createApiHono, type ApiHono } from 'types.js';

const ProfileIdParam = z.object({ profileId: z.uuid() });

// Query lives in this file rather than `@app/contracts/pagination` because
// the audit-page UI specifically wants a small page size by default; the
// shared 50-default would push the operator off the visible viewport on
// mobile.
// Event-name allow-list — at most 32 distinct events so an operator cannot
// build a 10kb query string. The actual catalogue lives at the call sites
// (manual-orders.ts, kill-switch.ts, …); we don't enumerate them here so
// adding a new audit event to the API does not require a contract bump.
const AuditEventFilter = z
  .string()
  .min(1)
  .max(64)
  // Stored event names are lowercase kebab-case (every call site in
  // apps/api/src/routes/*.ts emits lowercase). Reject uppercase here so
  // a typo 422s explicitly instead of silently returning an empty list
  // — Postgres IN (...) is case-sensitive on text columns.
  .regex(/^[a-z0-9-]+$/, 'event filter must be lowercase kebab-case');

const AuditLogQuery = z.object({
  limit: z.coerce.number().int().min(1).max(200).default(25),
  // Opaque pagination token. The handler emits `<createdAt-iso>__<id>` and
  // also accepts a legacy bare-iso cursor, so the shape is parsed there, not
  // gated here — a stricter schema rejects the handler's own `nextCursor`.
  cursor: z.string().optional(),
  // Event-kind filter. Repeatable: `?event=manual-order&event=kill-switch-on`.
  // A single `?event=...` is normalised to a one-element array; an empty
  // filter means "all events" and is the default UI state. Zod 4 coerces
  // `URLSearchParams.getAll`-style scalars to arrays via `.preprocess`
  // because zod-openapi's query parser exposes a single string when only
  // one value is present.
  event: z
    .preprocess((v) => {
      if (v === undefined) return undefined;
      if (Array.isArray(v)) return v;
      return [v];
    }, z.array(AuditEventFilter).max(32))
    .optional(),
});

const route = createRoute({
  method: 'get',
  path: '/profiles/{profileId}/audit-logs',
  tags: ['audit'],
  request: { params: ProfileIdParam, query: AuditLogQuery },
  responses: {
    200: {
      description: 'paginated audit-log entries scoped to this profile',
      content: { 'application/json': { schema: AuditLogListResponse } },
    },
    422: {
      description: 'VALIDATION_FAILED',
      content: { 'application/json': { schema: ErrorEnvelope } },
    },
    404: { description: 'NOT_FOUND', content: { 'application/json': { schema: ErrorEnvelope } } },
  },
});

/**
 * `GET /profiles/:id/audit-logs` — paginated, profile-scoped audit reader.
 *
 * The profile-existence check is intentional: a 404 on the parent profile
 * is more useful to the operator than an empty list on a deleted id, and it
 * matches the pattern used by every other profile-scoped route in this
 * tree.
 *
 * `nextCursor` is null when the current page is shorter than the requested
 * limit; the client treats null as "end of stream" and stops fetching.
 */
export const auditLogsRouter = (di: DI): ApiHono => {
  const app = createApiHono();
  app.use('/profiles/*/audit-logs', requireUser());

  app.openapi(route, async (c) => {
    const profileId = asProfileId(c.req.valid('param').profileId);
    const { limit, cursor, event } = c.req.valid('query');
    const p = await scopeOf(c, di, profileId);
    // Cursor wire format is `<createdAt-iso>__<id>`. Older single-iso
    // cursors keep working: missing `id` lets a same-timestamp group
    // surface in full on the next page (no rows are dropped).
    let cursorObj: { createdAt: string; id: string } | null = null;
    if (cursor !== undefined) {
      const sep = cursor.indexOf('__');
      if (sep > 0) {
        const id = cursor.slice(sep + 2);
        // The id half lands on a uuid column; a non-uuid (or empty) segment
        // would reach Postgres as an uncastable literal and surface as a 500
        // instead of a clean 422.
        if (!z.uuid().safeParse(id).success) {
          throw new HttpError('VALIDATION_FAILED', 'invalid cursor');
        }
        // Keep the timestamp half as the original string: the repo casts it
        // back to timestamptz, so a `new Date()` round-trip (ms-only) would
        // drop the microsecond fraction the cursor exists to preserve.
        cursorObj = {
          createdAt: cursor.slice(0, sep),
          id,
        };
      } else {
        cursorObj = {
          createdAt: cursor,
          id: 'ffffffff-ffff-ffff-ffff-ffffffffffff',
        };
      }
      // A hand-crafted cursor with an unparseable timestamp would otherwise
      // reach the DB as an uncastable literal and surface as a 500.
      if (Number.isNaN(new Date(cursorObj.createdAt).getTime())) {
        throw new HttpError('VALIDATION_FAILED', 'invalid cursor');
      }
    }
    const rows = await p.auditLogs.listForProfile(limit, cursorObj, event ?? []);
    const last = rows.at(-1);
    const nextCursor =
      rows.length === limit && last !== undefined ? `${last.cursorToken}__${last.id}` : null;
    return c.json(
      {
        items: rows.map((r) => ({
          id: r.id,
          event: r.event,
          actor: r.actor,
          payload: r.payload,
          ip: r.ip,
          userAgent: r.userAgent,
          createdAt: r.createdAt.toISOString(),
        })),
        nextCursor,
      },
      200,
    );
  });

  return app;
};
