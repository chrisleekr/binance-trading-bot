import { z } from 'zod';

/**
 * Single action-log row as exposed by `GET /profiles/:id/action-logs`.
 *
 * action_logs is the worker's per-(profile, symbol) telemetry hypertable
 * (distinct from audit_logs, which records operator actions). This reader
 * surfaces the warn+error tail so the dashboard can show "what went wrong
 * while I was away" — e.g. a rejected order — without drilling into a symbol.
 *
 * `symbol` is nullable because profile-wide rows (no single symbol) are
 * allowed; `ctx` is the row's structured detail and is rendered opaquely.
 */
export const ActionLogEntry = z.object({
  time: z.iso.datetime(),
  symbol: z.string().nullable(),
  level: z.string().min(1),
  msg: z.string().min(1),
  // Optional: rows may carry no structured detail, and the activity feed
  // renders `msg` only. `z.unknown()` alone is non-optional in Zod v4, so a
  // missing `ctx` key would otherwise fail the parse.
  ctx: z.unknown().optional(),
});
/** TS type derived from {@link ActionLogEntry} so consumers don't re-run z.infer at every call site. */
export type ActionLogEntry = z.infer<typeof ActionLogEntry>;

/**
 * Reply for the per-profile action-log errors view. Unpaginated: the reader
 * returns a small bounded tail (warn+error, newest-first) for the activity
 * feed, not the full history.
 */
export const ActionLogErrorsResponse = z.object({
  items: z.array(ActionLogEntry),
});
/** TS type derived from {@link ActionLogErrorsResponse} so consumers don't re-run z.infer at every call site. */
export type ActionLogErrorsResponse = z.infer<typeof ActionLogErrorsResponse>;
