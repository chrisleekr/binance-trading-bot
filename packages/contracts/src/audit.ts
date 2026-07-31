import { z } from 'zod';

/**
 * Single audit-log row as exposed by `GET /profiles/:id/audit-logs`. The
 * payload is `unknown` because every state-changing route writes its own
 * shape via the audit middleware; the page renders it through a stable
 * `JSON.stringify` rather than a per-event renderer until the operator
 * needs more.
 */
export const AuditLogEntry = z.object({
  id: z.uuid(),
  event: z.string().min(1),
  actor: z.string().min(1),
  payload: z.unknown(),
  ip: z.string().nullable(),
  userAgent: z.string().nullable(),
  createdAt: z.iso.datetime(),
});
/** TS type derived from {@link AuditLogEntry} so consumers don't re-run z.infer at every call site. */
export type AuditLogEntry = z.infer<typeof AuditLogEntry>;

/**
 * Paginated reply for the per-profile audit view. `nextCursor` is opaque
 * (composite `<createdAt-iso>__<id>` so a same-timestamp group is paged
 * stably); the client treats it as a string and echoes it back via
 * `?cursor=`. Null when the page came up shorter than the requested
 * limit (i.e. there's no more history).
 */
export const AuditLogListResponse = z.object({
  items: z.array(AuditLogEntry),
  nextCursor: z.string().nullable(),
});
/** TS type derived from {@link AuditLogListResponse} so consumers don't re-run z.infer at every call site. */
export type AuditLogListResponse = z.infer<typeof AuditLogListResponse>;
