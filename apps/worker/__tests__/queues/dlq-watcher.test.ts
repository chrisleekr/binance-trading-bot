// Contract for the DLQ watcher: on a dead-lettered job it persists the row,
// publishes the ops-dashboard event, and feeds the burst aggregator. Grouping /
// throttling of the operator notification lives in the aggregator (see
// dlq-notify-aggregator.test.ts), so the watcher itself is ungated per-job.

import { describe, expect, it, vi } from 'vitest';
import pino from 'pino';
import type { Job } from 'bullmq';

import { registerDlqWorker } from '../../src/queues/dlq-watcher.js';
import type { DlqJobData } from '../../src/queues/job-payloads.js';

const silent = pino({ level: 'silent' });

const data: DlqJobData = {
  fromQueue: 'db-backup',
  fromJobId: 'job-1',
  reason: 'failed',
  errorName: 'Error',
  errorMessage: 'pg_dump exited 1',
  originalData: {},
};

describe('registerDlqWorker', () => {
  const capture = () => {
    let handler: ((job: Job<DlqJobData>) => Promise<void>) | undefined;
    const queueSet = {
      registerWorker: (_name: string, h: (job: Job<DlqJobData>) => Promise<void>) => {
        handler = h;
      },
    } as never;
    return { queueSet, run: (d: DlqJobData) => handler?.({ data: d } as Job<DlqJobData>) };
  };

  it('persists, publishes, and feeds the aggregator on a dead-lettered job', async () => {
    const persist = vi.fn(async () => undefined);
    const onEntry = vi.fn();
    const redis = { publish: vi.fn(async () => 1) };
    const { queueSet, run } = capture();
    registerDlqWorker(queueSet, { redis: redis as never, logger: silent, persist, onEntry });

    await run(data);
    expect(persist).toHaveBeenCalledTimes(1);
    expect(redis.publish).toHaveBeenCalledTimes(1);
    expect(onEntry).toHaveBeenCalledWith(data);
  });

  it('works without an onEntry dep (it is optional)', async () => {
    const persist = vi.fn(async () => undefined);
    const redis = { publish: vi.fn(async () => 1) };
    const { queueSet, run } = capture();
    registerDlqWorker(queueSet, { redis: redis as never, logger: silent, persist });
    await expect(run(data)).resolves.toBeUndefined();
    expect(persist).toHaveBeenCalledTimes(1);
  });

  it('persists, publishes, and feeds the aggregator for EVERY entry (no per-job gating here)', async () => {
    const persist = vi.fn(async () => undefined);
    const onEntry = vi.fn();
    const redis = { publish: vi.fn(async () => 1) };
    const { queueSet, run } = capture();
    registerDlqWorker(queueSet, { redis: redis as never, logger: silent, persist, onEntry });

    await run(data);
    await run(data);
    // Every entry is durably recorded and handed to the aggregator; the
    // aggregator (not the watcher) decides whether/when to notify.
    expect(persist).toHaveBeenCalledTimes(2);
    expect(redis.publish).toHaveBeenCalledTimes(2);
    expect(onEntry).toHaveBeenCalledTimes(2);
  });
});
