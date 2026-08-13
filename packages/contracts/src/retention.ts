import { z } from 'zod';

/**
 * One retention-prune receipt. The action-log-prune and audit-prune crons
 * write one of these to Redis on every run; the API reads both and the
 * operator dashboard renders "last sweep was N hours ago, M rows pruned".
 *
 * `kind` is the cron name verbatim so the response is self-describing
 * without a parallel enum on the consumer side. `retentionDays` echoes the
 * `retention_config` value the sweep actually read, so the number the operator
 * sees here is the one that deleted the rows — not a second, independently
 * configured horizon that merely claims to be.
 */
export const RetentionReceiptSchema = z.object({
  kind: z.enum(['action-log-prune', 'audit-prune']),
  /** Wall-clock ms when the cron handler finished writing this receipt. */
  ranAtMs: z.number().int().nonnegative(),
  /**
   * Whether the sweep finished. A failing cron throws into the DLQ, which no
   * operator surface reads, so without this flag the previous success receipt
   * stays on the dashboard and reports a horizon that is no longer being
   * applied. Defaults to true: receipts written by a successful run say nothing,
   * so a run that says nothing succeeded.
   */
  ok: z.boolean().default(true),
  /**
   * Failure text when `ok` is false, for the dashboard to name what broke. Null
   * otherwise. Bounded because `GET /retention-status` is readable without a
   * login on a LIVE_DEMO box: the producer writes a short classification rather
   * than the driver's own message, and the bound keeps that a property of the
   * contract instead of a habit of one writer.
   */
  error: z.string().max(120).nullable().default(null),
  /** Rows the prune deleted on this run, all rules together. Zero is normal during quiet windows. */
  deleted: z.number().int().nonnegative(),
  /**
   * Retention horizon the cron applied (`<now - days>` was the cutoff). Null
   * only on a failure receipt whose run died before it could read the config.
   */
  retentionDays: z.number().int().positive().nullable().default(null),
  /**
   * Per-rule split for a sweep that applies more than one rule; null for a cron
   * with a single rule, and for receipts written before the split existed. Kept
   * apart from `deleted` because one combined number cannot distinguish a quiet
   * night from an age horizon deleting nothing while a mis-set cap deletes a
   * profile's whole history.
   */
  byRule: z
    .object({
      age: z.number().int().nonnegative(),
      /**
       * Whole hypertable chunks the age rule dropped. Counted apart from `age`
       * rather than added to it: dropping a chunk never reads its rows, so the
       * row figure for a night that discarded a month of history is legitimately
       * near zero and a receipt carrying only `deleted` would read as "did
       * nothing".
       */
      ageChunks: z.number().int().nonnegative().default(0),
      rowCap: z.number().int().nonnegative(),
    })
    .nullable()
    .default(null),
  /** Newest-rows-per-profile cap the sweep applied. Null when the cron has no cap rule. */
  maxRows: z.number().int().positive().nullable().default(null),
});
/**
 * Response from `GET /retention-status`. Each receipt is null when the
 * corresponding cron has not run since the worker last started (or its
 * Redis key was wiped). Returning both nullable rather than omitting the
 * key keeps the response shape stable, so the UI can render a deterministic
 * "never run" row instead of "this kind doesn't exist".
 */
export const RetentionStatusResponseSchema = z.object({
  actionLogPrune: RetentionReceiptSchema.nullable(),
  auditPrune: RetentionReceiptSchema.nullable(),
});
export type RetentionStatusResponse = z.infer<typeof RetentionStatusResponseSchema>;
