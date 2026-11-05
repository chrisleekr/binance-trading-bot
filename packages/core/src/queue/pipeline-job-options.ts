import type { DefaultJobOptions } from 'bullmq';

/**
 * Default options for every job on the `pipeline` queue, applied by both the api producer and the worker queue set. A BullMQ job runs exactly once unless `attempts` says otherwise, so without this a handler throw that is meant to retry would go straight to the DLQ. A retry keeps the job id, so static ids still coalesce, and `removeOnFail` applies only after the last attempt. A per-add option wins over these defaults, which is how dispose-profile keeps its own longer envelope.
 */
export const PIPELINE_JOB_OPTIONS: DefaultJobOptions & {
  readonly attempts: number;
  readonly backoff: { readonly type: 'fixed'; readonly delay: number };
} = {
  attempts: 3,
  backoff: { type: 'fixed', delay: 1_000 },
};
