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

/** Levels a row can carry. 'debug' rows exist only for windows where deep capture was armed. */
export const ActionLogLevel = z.enum(['debug', 'info', 'warn', 'error']);
export type ActionLogLevel = z.infer<typeof ActionLogLevel>;

/**
 * A row as returned by the paged Logs reader. Adds the stable `id` and the
 * `cursorToken` the client pairs with it to request the next page — the token
 * is the row's `time` at microsecond precision, which `time` itself cannot
 * carry once it round-trips through a JS `Date`.
 */
export const ActionLogPageEntry = ActionLogEntry.extend({
  id: z.uuid(),
  cursorToken: z.string().min(1),
});
export type ActionLogPageEntry = z.infer<typeof ActionLogPageEntry>;

/**
 * One page of profile logs, newest-first. `nextCursor` is null when the page
 * was not full, which is the only reliable end-of-results signal for a keyset
 * reader.
 */
export const ActionLogPageResponse = z.object({
  items: z.array(ActionLogPageEntry),
  nextCursor: z.string().nullable(),
});
export type ActionLogPageResponse = z.infer<typeof ActionLogPageResponse>;

/**
 * Comma-separated repeated values in a query string. Zod v4 has no native
 * "csv list" so each filter that accepts several values splits here, dropping
 * empty segments so a trailing comma is not read as a filter on ''.
 */
const csv = z
  .string()
  .optional()
  .transform((v) => (v ? v.split(',').filter((s) => s.length > 0) : []));

/**
 * Filters shared by the Logs reader and its NDJSON export, so a downloaded file
 * always matches what was on screen. `cursor` is `<isoMicros>|<uuid>`; a
 * malformed one is rejected at the edge rather than silently paging from the
 * head, which would loop the client forever.
 */
export const ActionLogQuery = z.object({
  from: z.iso.datetime().optional(),
  to: z.iso.datetime().optional(),
  levels: csv,
  symbols: csv,
  source: z.string().min(1).optional(),
  q: z.string().min(1).max(200).optional(),
  limit: z.coerce.number().int().min(1).max(500).default(100),
  cursor: z
    .string()
    .regex(
      // The uuid half is spelled out group by group rather than as 36 chars of
      // `[0-9a-fA-F-]`: that looser class accepts all-hyphens, which reaches
      // Postgres as an invalid `uuid` literal and 500s a route that should have
      // rejected it at the edge with a 422.
      /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{6}Z\|[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{12}$/,
      'cursor must be <isoMicroseconds>|<uuid>',
    )
    .optional(),
});
export type ActionLogQuery = z.infer<typeof ActionLogQuery>;

/** Distinct symbols present in the log window, for the filter control. */
export const ActionLogSymbolsResponse = z.object({
  symbols: z.array(z.string()),
});
export type ActionLogSymbolsResponse = z.infer<typeof ActionLogSymbolsResponse>;
