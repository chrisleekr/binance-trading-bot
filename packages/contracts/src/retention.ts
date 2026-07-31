import { z } from 'zod';

/**
 * One retention-prune receipt. The action-log-prune and audit-prune crons
 * write one of these to Redis on every run; the API reads both and the
 * operator dashboard renders "last sweep was N hours ago, M rows pruned".
 *
 * `kind` is the cron name verbatim so the response is self-describing
 * without a parallel enum on the consumer side. `retentionDays` echoes the
 * worker env var that drove the sweep so the operator can see the policy
 * without ssh'ing into the host.
 */
export const RetentionReceiptSchema = z.object({
  kind: z.enum(['action-log-prune', 'audit-prune']),
  /** Wall-clock ms when the cron handler finished writing this receipt. */
  ranAtMs: z.number().int().nonnegative(),
  /** Rows the prune deleted on this run. Zero is normal during quiet windows. */
  deleted: z.number().int().nonnegative(),
  /** Retention horizon the cron applied (`<now - days>` was the cutoff). */
  retentionDays: z.number().int().positive(),
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
