import { z } from 'zod';

/**
 * One action_logs row as served by `GET /profiles/:id/symbols/:symbol/logs`.
 * Mirrors the shape the WS `logs` topic carries minus its envelope, plus a
 * server-stamped `time` so a virtualised list can sort and de-duplicate
 * frames against backfilled REST rows. `ctx` stays `unknown`: strategies
 * own their structured-log shape and the operator UI never renders it as
 * anything richer than JSON.
 */
export const SymbolLogEntry = z.object({
  time: z.iso.datetime(),
  symbol: z.string().nullable(),
  level: z.string(),
  msg: z.string(),
  ctx: z.unknown().optional(),
});
/** TS type derived from {@link SymbolLogEntry} so consumers don't re-run z.infer at every call site. */
export type SymbolLogEntry = z.infer<typeof SymbolLogEntry>;

/**
 * Whole-page reply for the per-symbol logs endpoint. The response is a flat
 * array because the route is bounded by the caller's `from`/`to` window;
 * pagination is window-driven, not cursor-driven, which matches how the UI
 * pages backwards by widening `from`.
 */
export const SymbolLogList = z.array(SymbolLogEntry);
/** TS type derived from {@link SymbolLogList} so consumers don't re-run z.infer at every call site. */
export type SymbolLogList = z.infer<typeof SymbolLogList>;
