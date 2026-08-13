import { z } from 'zod';

/**
 * One raw per-tick audit entry, read straight back from the Redis stream the
 * worker already writes on every tick.
 *
 * This is the highest-fidelity record that exists: it is what the drainer sees
 * before it decides which ticks are worth a durable row. Reading it costs
 * nothing extra because the entries are already there, but the window is short
 * — the stream is trimmed to `auditStreamMaxlen` entries across all of a
 * profile's symbols, so a busy profile reaches back hours, not days. Use deep
 * capture when the window has to outlive that.
 *
 * `payload` is rendered opaquely: its shape is the strategy's audit block merged
 * with the executor's results, and it is deliberately not narrowed here so a
 * strategy can add detail without a contract change.
 */
export const TickTraceEntry = z.object({
  /** Redis stream entry id, `<ms>-<seq>`. Unique and monotonic, so it doubles as the paging cursor. */
  streamId: z.string().min(1),
  ts: z.iso.datetime(),
  symbol: z.string().nullable(),
  event: z.string(),
  decisionTypes: z.array(z.string()),
  latencyMs: z.number().nullable(),
  payload: z.unknown().optional(),
});
export type TickTraceEntry = z.infer<typeof TickTraceEntry>;

/**
 * Newest-first window of raw trace entries. `oldestStreamId` is the id of the
 * last entry returned; pass it back as `before` to walk further into the past.
 * `truncated` says the stream had been trimmed past the requested start, which
 * is the difference between "nothing happened then" and "we no longer know".
 */
export const TickTraceResponse = z.object({
  items: z.array(TickTraceEntry),
  oldestStreamId: z.string().nullable(),
  truncated: z.boolean(),
});
export type TickTraceResponse = z.infer<typeof TickTraceResponse>;

/** Query for the raw trace reader. `before` is a Redis stream id from a previous page. */
export const TickTraceQuery = z.object({
  symbol: z.string().min(1).optional(),
  limit: z.coerce.number().int().min(1).max(500).default(100),
  before: z
    .string()
    .regex(/^\d+-\d+$/, 'before must be a Redis stream id, <ms>-<seq>')
    .optional(),
});
export type TickTraceQuery = z.infer<typeof TickTraceQuery>;
