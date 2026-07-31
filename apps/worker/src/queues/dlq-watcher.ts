// DLQ worker: persists dead-lettered jobs into action_logs (severity=error)
// and publishes a Redis pub/sub event for an ops dashboard. The DLQ itself
// is a BullMQ Queue named 'dlq'; see queue-set.ts.

import type { Redis } from 'ioredis';
import type { Logger } from 'pino';
import type { Job } from 'bullmq';
import type { DlqJobData } from './job-payloads.js';
import type { QueueSet } from './queue-set.js';

export interface DlqDeps {
  readonly redis: Redis;
  readonly logger: Logger;
  readonly persist: (data: DlqJobData) => Promise<void>;
  /**
   * Fed each dead-lettered job AFTER the durable persist/publish. Grouping,
   * throttling, and the operator notification live downstream (the burst
   * aggregator), so a systemic failure alerts once per error class, not once
   * per job. MUST be synchronous and never throw — a notifier problem cannot
   * be allowed to re-fail (and re-queue) the DLQ job. Absent = no notification.
   */
  readonly onEntry?: (data: DlqJobData) => void;
  readonly pubsubChannel?: string;
}

export const registerDlqWorker = (queueSet: QueueSet, deps: DlqDeps): void => {
  const channel = deps.pubsubChannel ?? 'dlq:events';
  queueSet.registerWorker<DlqJobData>('dlq', async (job: Job<DlqJobData>) => {
    try {
      await deps.persist(job.data);
      await deps.redis.publish(
        channel,
        JSON.stringify({
          ts: Date.now(),
          fromQueue: job.data.fromQueue,
          fromJobId: job.data.fromJobId,
          errorMessage: job.data.errorMessage,
          userId: job.data.userId,
          profileId: job.data.profileId,
        }),
      );
      // Feed the burst aggregator after the durable persist/publish. It is
      // synchronous and never throws, so a notifier outage cannot re-fail the
      // DLQ job. persist + publish stay ungated, so no DLQ data is ever dropped.
      deps.onEntry?.(job.data);
    } catch (err) {
      deps.logger.error(
        { err, fromQueue: job.data.fromQueue },
        'dlq persist failed, letting BullMQ retry',
      );
      throw err;
    }
  });
};
