// The api records a security event and queues its notification; this worker is the only place one can be sent. A security notification that silently reaches nobody is the failure that matters here, because the most likely reason nobody hears about a break-in is that the intruder removed the notifiers. So an undelivered one is always counted on a metric Alertmanager watches, whatever the in-app channels did.

import type { Job } from 'bullmq';
import { describe, expect, it, vi } from 'vitest';
import {
  registerPipelineWorker,
  type PipelineWorkerDeps,
} from '../../src/queues/pipeline-worker.js';
import type { QueueSet } from '../../src/queues/queue-set.js';

const JOB = {
  category: 'auth-alert',
  event: 'account-locked',
  body: 'Password sign-in for the operator email is locked after repeated failures.',
  fields: [{ label: 'IP address', value: '198.51.100.1' }],
};

const harness = (accountNotify?: PipelineWorkerDeps['accountNotify']) => {
  let handler: ((job: Job) => Promise<void>) | null = null;
  const queueSet = {
    registerWorker: (_name: string, fn: (job: Job) => Promise<void>) => {
      handler = fn;
    },
  } as unknown as QueueSet;
  const record = vi.fn();
  const deps = {
    logger: { warn: vi.fn(), info: vi.fn(), error: vi.fn(), debug: vi.fn() },
    chain: { run: async (_k: string, fn: () => Promise<void>) => fn() },
    metrics: { record, forget: vi.fn() },
    ...(accountNotify ? { accountNotify } : {}),
  } as unknown as PipelineWorkerDeps;
  registerPipelineWorker(queueSet, deps);
  if (handler === null) throw new Error('test setup: registerWorker did not capture a handler');
  const invoke = handler as (job: Job) => Promise<void>;
  return {
    record,
    run: (data: unknown, attempt?: { attemptsMade: number; attempts: number }) =>
      invoke({
        name: 'notify-auth-security',
        data,
        id: 'job-1',
        attemptsMade: attempt?.attemptsMade ?? 0,
        opts: { attempts: attempt?.attempts ?? 1 },
      } as unknown as Job),
  };
};

const undelivered = (record: ReturnType<typeof vi.fn>) =>
  record.mock.calls
    .filter((call) => call[0] === 'auth_alert_undelivered_total' && call[1] === 1)
    .map((call) => call[2]);

describe('notify-auth-security pipeline job', () => {
  it('sends to every enabled notifier, naming no account, with the fields the api composed', async () => {
    const accountNotify = vi.fn(async () => 'delivered');
    const h = harness(accountNotify as never);
    await h.run(JOB);
    // No accountId: a security event concerns the operator, not one Binance account, so the fan-out is every enabled channel.
    expect(accountNotify).toHaveBeenCalledWith({
      category: 'auth-alert',
      body: JOB.body,
      fields: JOB.fields,
    });
    expect(undelivered(h.record)).toEqual([]);
  });

  it('seeds the undelivered counter at zero for every category and outcome, so the first miss is an observable rise', () => {
    const h = harness(vi.fn(async () => 'delivered') as never);
    const seeded = h.record.mock.calls
      .filter((call) => call[0] === 'auth_alert_undelivered_total' && call[1] === 0)
      .map((call) => call[2]);
    expect(seeded).toEqual(
      expect.arrayContaining([
        { category: 'auth-activity', outcome: 'no-notifier' },
        { category: 'auth-activity', outcome: 'failed' },
        { category: 'auth-alert', outcome: 'no-notifier' },
        { category: 'auth-alert', outcome: 'failed' },
      ]),
    );
  });

  it('counts a notification with no notifier to receive it, and acknowledges it because a retry cannot create one', async () => {
    const h = harness(vi.fn(async () => 'no-notifier') as never);
    await expect(h.run(JOB)).resolves.toBeUndefined();
    expect(undelivered(h.record)).toEqual([{ category: 'auth-alert', outcome: 'no-notifier' }]);
  });

  it('counts a notification every notifier failed to send, and dead-letters it for a durable trace', async () => {
    const h = harness(vi.fn(async () => 'failed') as never);
    await expect(h.run(JOB)).rejects.toThrow(/auth_security_notification_failed/);
    expect(undelivered(h.record)).toEqual([{ category: 'auth-alert', outcome: 'failed' }]);
  });

  it('does not count a failed attempt that will be retried, so an alert delivered on retry never pages', async () => {
    const h = harness(vi.fn(async () => 'failed') as never);
    await expect(h.run(JOB, { attemptsMade: 0, attempts: 3 })).rejects.toThrow(
      /auth_security_notification_failed/,
    );
    expect(undelivered(h.record)).toEqual([]);
  });

  it('counts a failure once, on the final attempt', async () => {
    const h = harness(vi.fn(async () => 'failed') as never);
    await expect(h.run(JOB, { attemptsMade: 2, attempts: 3 })).rejects.toThrow(
      /auth_security_notification_failed/,
    );
    expect(undelivered(h.record)).toEqual([{ category: 'auth-alert', outcome: 'failed' }]);
  });

  it('dead-letters a payload that does not match the contract instead of notifying nobody', async () => {
    const accountNotify = vi.fn(async () => 'delivered');
    await expect(
      harness(accountNotify as never).run({ ...JOB, category: 'auth-anything' }),
    ).rejects.toThrow(/pipeline_invalid_payload/);
    expect(accountNotify).not.toHaveBeenCalled();
  });

  it('dead-letters rather than acknowledging when the notifier dependency is absent, and counts it as failed', async () => {
    const h = harness(undefined);
    await expect(h.run(JOB)).rejects.toThrow(/accountNotify/);
    expect(undelivered(h.record)).toEqual([{ category: 'auth-alert', outcome: 'failed' }]);
  });

  it('counts a dispatch that throws as failed, then rethrows so the job still fails', async () => {
    // Nothing was delivered either way; without the count the alert watching this series stays at zero exactly when delivery is broken.
    const h = harness(
      vi.fn(async () => {
        throw new Error('notifier registry unavailable');
      }) as never,
    );
    await expect(h.run(JOB)).rejects.toThrow(/notifier registry unavailable/);
    expect(undelivered(h.record)).toEqual([{ category: 'auth-alert', outcome: 'failed' }]);
  });
});
