import { z } from 'zod';

/**
 * One cron's last-run health, as recorded by the worker's cron-status wrapper
 * and served by `GET /worker/crons`. `lastRunAtMs` is the terminal-run epoch ms;
 * the operator panel renders its age, and a large age on a frequent cron is the
 * "this cron has stalled" signal. `error` is present only on a failed run.
 */
export const CronStatusEntry = z.object({
  name: z.string(),
  lastRunAtMs: z.number().int().nonnegative(),
  status: z.enum(['ok', 'error']),
  durationMs: z.number().int().nonnegative(),
  error: z.string().nullable().default(null),
});
export type CronStatusEntry = z.infer<typeof CronStatusEntry>;

/**
 * Response for `GET /worker/crons` — every cron that has run at least once since
 * the worker last started, newest-run first. A cron absent from the list has not
 * run yet (e.g. just after a deploy), which is itself informative.
 */
export const WorkerCronsResponse = z.object({
  asOf: z.iso.datetime(),
  crons: z.array(CronStatusEntry),
});
export type WorkerCronsResponse = z.infer<typeof WorkerCronsResponse>;
