import { repo } from '@app/db';
import pino from 'pino';
import { afterEach, describe, expect, it, vi } from 'vitest';

import { buildNotifiers } from '../../src/boot/builders/notifiers.js';
import { notifyProviders } from '../../src/notifiers.js';
import type { DlqJobData } from '../../src/queues/job-payloads.js';
import { createQueueSet } from '../../src/queues/queue-set.js';

const bullmq = vi.hoisted(() => ({
  adds: new Map<string, ReturnType<typeof vi.fn>>(),
  processors: new Map<string, (job: unknown) => unknown>(),
  failedHandlers: new Map<string, (job: unknown, error: Error) => void>(),
  workerNames: new WeakMap<object, string>(),
}));

vi.mock('bullmq', () => ({
  Queue: class {
    readonly add: ReturnType<typeof vi.fn>;

    constructor(name: string) {
      this.add = vi.fn(async () => undefined);
      bullmq.adds.set(name, this.add);
    }

    async close(): Promise<void> {}
  },
  Worker: class {
    constructor(name: string, processor: (job: unknown) => unknown) {
      bullmq.workerNames.set(this, name);
      bullmq.processors.set(name, processor);
    }

    on(event: string, handler: (job: unknown, error: Error) => void): this {
      if (event === 'failed')
        bullmq.failedHandlers.set(bullmq.workerNames.get(this) ?? '', handler);
      return this;
    }

    async close(): Promise<void> {}
  },
}));

const SENTINEL = 'DLQ-BIND-SENTINEL-DO-NOT-SEND';
const SQL = 'select "state" from "symbol_states" where "profile_id" = $1 and "symbol" = $2';

afterEach(() => {
  vi.useRealTimers();
  vi.restoreAllMocks();
  bullmq.adds.clear();
  bullmq.processors.clear();
  bullmq.failedHandlers.clear();
});

describe('exhausted-job DLQ redaction', () => {
  it('censors Drizzle bind values in the queued record and outbound notifier message', async () => {
    vi.useFakeTimers();
    const send = vi.fn(async () => undefined);
    vi.spyOn(repo.opsNotifyConfig, 'get').mockResolvedValue({ events: {} } as never);
    vi.spyOn(repo.profileNotifiers, 'listAllEnabled').mockResolvedValue([
      { provider: 'test', config: {}, secrets: {}, enabled: true },
    ] as never);
    vi.spyOn(notifyProviders, 'get').mockImplementation((name) =>
      name === 'test' ? ({ name: 'test', send } as never) : undefined,
    );

    const logger = pino({ level: 'silent' });
    const redis = { publish: vi.fn(async () => 1) };
    const queueSet = createQueueSet({ connection: {} as never, logger });
    buildNotifiers({ db: {} as never, redis: redis as never, logger, liveDemo: false, queueSet });
    queueSet.registerWorker('tick', async () => undefined);

    const message = `Failed query: ${SQL}\nparams: profile-1,operator label\n${SENTINEL}`;
    const error = new Error(message);
    error.stack = `Error: ${message}\n    at Object.query (/app/db.ts:10:2)\ncaused by: Error: Failed query: update "profiles" set "state" = $1\nparams: profile-1,${SENTINEL}\n    at Object.execute (/app/profile.ts:20:4)`;
    const failed = bullmq.failedHandlers.get('tick');
    if (!failed) throw new Error('mock worker did not capture the tick failed handler');
    failed(
      {
        id: 'tick-1',
        data: { profileId: 'profile-1', symbol: 'BTCUSDT' },
        attemptsMade: 3,
        opts: { attempts: 3 },
      },
      error,
    );

    const dlqAdd = bullmq.adds.get('dlq');
    expect(dlqAdd).toHaveBeenCalledTimes(1);
    const queued = dlqAdd?.mock.calls[0]?.[1] as DlqJobData;
    expect(queued.errorMessage).toContain(SQL);
    expect(queued.stack).toContain('at Object.query');
    expect(queued.stack).toContain('at Object.execute');
    expect.soft(queued.errorMessage).toContain('\nparams: [redacted]');
    expect.soft(queued.errorMessage).not.toContain(SENTINEL);
    expect.soft(queued.stack).toContain('\nparams: [redacted]');
    expect.soft(queued.stack).not.toContain(SENTINEL);

    const dlqProcessor = bullmq.processors.get('dlq');
    if (!dlqProcessor) throw new Error('mock worker did not capture the DLQ processor');
    await dlqProcessor({ data: queued });
    await vi.advanceTimersByTimeAsync(15_000);

    expect(send).toHaveBeenCalledTimes(1);
    const outbound = send.mock.calls[0]?.[0] as {
      message: { fields?: readonly { label: string; value: string }[] };
    };
    const errorField = outbound.message.fields?.find((field) => field.label === 'Error');
    expect(errorField?.value).toContain(SQL);
    expect.soft(errorField?.value).toContain('\nparams: [redacted]');
    expect.soft(JSON.stringify(outbound)).not.toContain(SENTINEL);
  });
});
