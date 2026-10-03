// The api cannot send a notification. The only production dispatch chokepoint is this worker's `dispatchNotify`, which also owns the live-demo kill switch, so an agent action reaches the operator only by arriving here as a registered pipeline job.
//
// Two failure modes are worth pinning, and neither is loud on its own. A job name the switch does not handle hits `default:` and dead-letters, which is at least visible. A dependency the deps bag never received would let the case return having notified nobody, which is not visible at all, so that path throws rather than acknowledging.

import { AgentActionNotifyJob } from '@app/contracts';
import type { Job } from 'bullmq';
import { describe, expect, it, vi } from 'vitest';
import {
  parseAgentActionNotifyJob,
  registerPipelineWorker,
  type PipelineWorkerDeps,
} from '../../src/queues/pipeline-worker.js';
import type { QueueSet } from '../../src/queues/queue-set.js';

const ACCOUNT = '00000000-0000-4000-8000-00000000a201';
const USER = '00000000-0000-4000-8000-00000000a001';

const harness = (accountNotify?: PipelineWorkerDeps['accountNotify']) => {
  let handler: ((job: Job) => Promise<void>) | null = null;
  const queueSet = {
    registerWorker: (_name: string, fn: (job: Job) => Promise<void>) => {
      handler = fn;
    },
  } as unknown as QueueSet;
  const deps = {
    logger: { warn: vi.fn(), info: vi.fn(), error: vi.fn(), debug: vi.fn() },
    chain: { run: async (_k: string, fn: () => Promise<void>) => fn() },
    metrics: { record: vi.fn(), forget: vi.fn() },
    ...(accountNotify ? { accountNotify } : {}),
  } as unknown as PipelineWorkerDeps;
  registerPipelineWorker(queueSet, deps);
  if (handler === null) throw new Error('test setup: registerWorker did not capture a handler');
  const invoke = handler as (job: Job) => Promise<void>;
  return {
    run: (data: unknown) =>
      invoke({ name: 'notify-agent-action', data, id: 'job-1' } as unknown as Job),
  };
};

describe('notify-agent-action pipeline job', () => {
  it('fans the event out through the account notifier with the acting account', async () => {
    const accountNotify = vi.fn(async () => 'delivered');
    await harness(accountNotify as never).run({
      userId: USER,
      accountId: ACCOUNT,
      tool: 'place_manual_order',
      summary: 'An AI agent ran place_manual_order on BTCUSDT.',
      symbol: 'BTCUSDT',
    });
    // The accountId is not decoration: without it the fan-out falls back to every configured notifier across every account, which on a multi-account box tells the wrong operator.
    expect(accountNotify).toHaveBeenCalledWith({
      category: 'agent-action',
      accountId: ACCOUNT,
      body: 'An AI agent ran place_manual_order on BTCUSDT.',
      symbol: 'BTCUSDT',
    });
  });

  it('acknowledges a muted category rather than dead-lettering the completed action', async () => {
    // The operator turned the agent-action category off. The write already happened in the api, so a throw here would retry and eventually raise `job-failed` about a notification that was deliberately silenced.
    // What this pins is the acknowledgement, not the muting. Whether a muted category actually suppresses the send is decided in the notifier, and is pinned there against a delivering control.
    const accountNotify = vi.fn(async () => 'muted');
    await expect(
      harness(accountNotify as never).run({
        userId: USER,
        accountId: ACCOUNT,
        tool: 'trigger_buy',
        summary: 'An AI agent ran trigger_buy.',
      }),
    ).resolves.toBeUndefined();
    expect(accountNotify).toHaveBeenCalledTimes(1);
  });

  it('throws when every notifier failed, so the job retries instead of dropping the notice', async () => {
    // `failed` means nothing was delivered: acknowledging it would leave an agent trade the operator never hears about, and a retry cannot double-notify.
    const accountNotify = vi.fn(async () => 'failed');
    await expect(
      harness(accountNotify as never).run({
        userId: USER,
        accountId: ACCOUNT,
        tool: 'trigger_buy',
        summary: 'An AI agent ran trigger_buy.',
      }),
    ).rejects.toThrow(/agent_action_notification_failed: trigger_buy/);
  });

  it('acknowledges no-notifier, since a retry cannot create a notifier', async () => {
    const accountNotify = vi.fn(async () => 'no-notifier');
    await expect(
      harness(accountNotify as never).run({
        userId: USER,
        accountId: ACCOUNT,
        tool: 'trigger_buy',
        summary: 'An AI agent ran trigger_buy.',
      }),
    ).resolves.toBeUndefined();
  });

  it('dead-letters rather than acknowledging when the notifier dependency is absent', async () => {
    await expect(
      harness(undefined).run({
        userId: USER,
        accountId: ACCOUNT,
        tool: 'trigger_sell',
        summary: 'An AI agent ran trigger_sell.',
      }),
    ).rejects.toThrow(/accountNotify/);
  });

  it('dead-letters a payload the api shaped wrongly instead of notifying nobody', async () => {
    const accountNotify = vi.fn(async () => 'delivered');
    await expect(
      harness(accountNotify as never).run({ userId: USER, accountId: ACCOUNT, tool: 'x' }),
    ).rejects.toThrow(/pipeline_invalid_payload/);
    expect(accountNotify).not.toHaveBeenCalled();
  });
});

describe('agent-action payload seam', () => {
  it.each([
    ['no summary', { userId: USER, accountId: ACCOUNT, tool: 'x' }],
    ['no tool', { userId: USER, accountId: ACCOUNT, summary: 's' }],
    ['no accountId', { userId: USER, tool: 'x', summary: 's' }],
    ['empty tool', { userId: USER, accountId: ACCOUNT, tool: '', summary: 's' }],
    ['not an object', 'nope'],
  ])('rejects a payload with %s', (_label, data) => {
    // The producer lives in another package, so a renamed field is invisible to the type system on both sides. Parsing to null is what turns that into a dead-letter instead of an agent action nobody hears about.
    expect(parseAgentActionNotifyJob(data)).toBeNull();
  });

  it('accepts a payload conforming to the shared contract, so the rejections above are discriminating', () => {
    // Conformance only. Whether the api actually SENDS this shape is asserted where the api can be run, by capturing a real `queue.add` payload and feeding it through this same contract; a literal here can only ever prove that the literal parses.
    expect(
      parseAgentActionNotifyJob(
        AgentActionNotifyJob.parse({
          userId: USER,
          accountId: ACCOUNT,
          tool: 'trigger_buy',
          summary: 'An AI agent ran trigger_buy on BTCUSDT.',
          symbol: 'BTCUSDT',
        }),
      ),
    ).toMatchObject({ tool: 'trigger_buy', symbol: 'BTCUSDT' });
  });
});
