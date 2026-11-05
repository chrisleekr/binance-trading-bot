// Real-Redis check of the pipeline retry policy through the real queue set: a transient throw is retried without dead-lettering, and a persistent one dead-letters exactly once after the last attempt.

import { afterAll, beforeAll, expect, it } from 'vitest';
import { pino } from 'pino';

import { PIPELINE_JOB_OPTIONS } from '@app/core/queue';
import { createBullMQConnection } from '@app/db';
import { withRedis } from '@app/testcontainers';

import { createQueueSet, type QueueSet } from '../../src/queues/queue-set.js';

import { describeInfra } from './_infra-gate.js';

describeInfra('redis', 'pipeline queue retry policy', () => {
  let queueSet: QueueSet;
  let stop: () => Promise<void>;
  const listDlqJobs = () =>
    queueSet.queues.dlq.getJobs(['waiting', 'active', 'delayed', 'completed']);

  beforeAll(async () => {
    const fx = await withRedis();
    stop = fx.stop;
    queueSet = createQueueSet({
      connection: createBullMQConnection({ url: fx.redisUrl }),
      logger: pino({ level: 'silent' }),
    });
    // A reused REDIS_TEST_URL keeps earlier jobs, and both cases assert exact counts.
    await queueSet.queues.pipeline.obliterate({ force: true });
    await queueSet.queues.dlq.obliterate({ force: true });
  });

  afterAll(async () => {
    // The lane shares one Redis, so a later suite's DLQ worker must not consume this file's dead-letter entry.
    await queueSet?.queues.pipeline.obliterate({ force: true });
    await queueSet?.queues.dlq.obliterate({ force: true });
    await queueSet?.closeAll();
    await stop?.();
  });

  it('retries a pipeline job that throws once and writes no DLQ entry', async () => {
    let calls = 0;
    const worker = queueSet.registerWorker('pipeline', async () => {
      calls += 1;
      if (calls === 1) throw new Error('transient');
    });
    const completed = new Promise<void>((resolve) => worker.on('completed', () => resolve()));

    const job = await queueSet.queues.pipeline.add('subscribe-profile', {});
    await completed;
    await worker.close();

    expect(calls).toBe(2);
    // attemptsMade counts the finished successful attempt as well as the failed one.
    expect((await queueSet.queues.pipeline.getJob(job.id ?? ''))?.attemptsMade).toBe(2);
    expect(
      await queueSet.queues.dlq.getJobCounts('waiting', 'active', 'delayed', 'completed'),
    ).toEqual({
      waiting: 0,
      active: 0,
      delayed: 0,
      completed: 0,
    });
  }, 30_000);

  it('runs an always-throwing pipeline job for every attempt and then writes exactly one DLQ entry', async () => {
    let calls = 0;
    const worker = queueSet.registerWorker('pipeline', async () => {
      calls += 1;
      throw new Error('persistent');
    });
    const job = await queueSet.queues.pipeline.add('subscribe-profile', {});

    const deadline = Date.now() + 20_000;
    let dlqJobs = await listDlqJobs();
    while (dlqJobs.length === 0 && Date.now() < deadline) {
      await new Promise((resolve) => setTimeout(resolve, 100));
      dlqJobs = await listDlqJobs();
    }
    // enqueueDlq is fire-and-forget, so give a duplicate entry time to land before asserting there is exactly one.
    await new Promise((resolve) => setTimeout(resolve, PIPELINE_JOB_OPTIONS.backoff.delay * 1.5));
    dlqJobs = await listDlqJobs();
    await worker.close();

    expect(calls).toBe(PIPELINE_JOB_OPTIONS.attempts);
    expect(dlqJobs).toHaveLength(1);
    expect(dlqJobs[0]?.data).toMatchObject({
      reason: 'attempts-exhausted',
      fromQueue: 'pipeline',
      fromJobId: job.id,
    });
  }, 30_000);
});
