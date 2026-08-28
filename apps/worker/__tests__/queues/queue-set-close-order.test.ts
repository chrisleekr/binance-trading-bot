import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { Logger } from 'pino';
import type { ConnectionOptions } from 'bullmq';

// closeAll's ordering is invisible to every other suite: the only real call to it is an unasserted `afterAll` teardown, so deleting the pre-close handshake wait leaves the whole worker suite green while restoring the "Connection is closed." rejection storm it exists to prevent. bullmq is mocked down to the two things closeAll touches — waitUntilReady and close — and each one records into a shared ordered log, which is what makes "every ready settled before the first close" an assertion rather than a hope.

/** Ordered record of every handshake settlement and every close, across all fake connections. */
let events: string[] = [];

/** Per-connection handshake outcome, keyed by label. Set by each test before the set is built. */
let handshake: (label: string) => Promise<void>;

const sleep = (ms: number): Promise<void> => new Promise((resolve) => setTimeout(resolve, ms));

class FakeConnection {
  constructor(readonly label: string) {}

  waitUntilReady(): Promise<void> {
    return handshake(this.label).then(
      () => {
        events.push(`ready:${this.label}`);
      },
      (err: unknown) => {
        events.push(`ready-rejected:${this.label}`);
        throw err;
      },
    );
  }

  async close(): Promise<void> {
    events.push(`close:${this.label}`);
  }

  on(): this {
    return this;
  }
}

vi.mock('bullmq', () => ({
  Queue: class extends FakeConnection {
    constructor(name: string) {
      super(`queue:${name}`);
    }
  },
  Worker: class extends FakeConnection {
    constructor(name: string) {
      super(`worker:${name}`);
    }
  },
}));

const { createQueueSet } = await import('../../src/queues/queue-set.js');

const logger = { error: vi.fn(), warn: vi.fn(), info: vi.fn() } as unknown as Logger;

const build = (): ReturnType<typeof createQueueSet> => {
  const set = createQueueSet({ connection: {} as ConnectionOptions, logger });
  // At least one Worker as well as the queues, because closeAll walks both lists and workers close first.
  set.registerWorker('tick', async () => undefined);
  return set;
};

const firstCloseIndex = (): number => events.findIndex((e) => e.startsWith('close:'));

describe('createQueueSet().closeAll', () => {
  beforeEach(() => {
    events = [];
  });

  it('lets every handshake settle before it closes the first connection', async () => {
    // BullMQ disconnects a connection that has not reached 'ready' outright, and ioredis then flushes the handshake's in-flight commands as "Connection is closed." rejections that nothing is left to await. The handshakes resolve on a real timer here, so a closeAll that does not wait starts closing in the same tick and the first close lands ahead of every ready.
    handshake = () => sleep(10);
    await build().closeAll();

    const readies = events.filter((e) => e.startsWith('ready:'));
    expect(readies.length).toBeGreaterThan(1);
    expect(firstCloseIndex()).toBeGreaterThan(-1);
    expect(events.slice(0, firstCloseIndex()).filter((e) => e.startsWith('ready:'))).toEqual(
      readies,
    );
  });

  it('still closes when one handshake rejects', async () => {
    // A connection whose init genuinely failed must close like any other. Awaiting the handshakes for SUCCESS turns shutdown into a throw and skips every close after it, which is a leaked connection per queue.
    handshake = async (label) => {
      await sleep(5);
      if (label === 'queue:tick') throw new Error('READONLY You cannot write against a replica');
    };

    await expect(build().closeAll()).resolves.toBeUndefined();
    expect(events).toContain('ready-rejected:queue:tick');
    expect(events.filter((e) => e.startsWith('close:')).length).toBeGreaterThan(1);
  });

  it('gives up on a handshake that never settles instead of burning the drain budget', async () => {
    // SIGTERM during a Redis outage shortly after boot: ioredis retries a failed handshake indefinitely, so an unbounded wait here consumes the caller's whole 10s deadline and turns a fast clean exit into a timed-out one that deliberately skips destructive teardown. The bound has to be well under that budget and still actually reached, so both ends are asserted.
    handshake = () => new Promise<void>(() => undefined);

    const started = Date.now();
    await build().closeAll();
    const elapsed = Date.now() - started;

    expect(events.filter((e) => e.startsWith('ready:'))).toEqual([]);
    expect(events.filter((e) => e.startsWith('close:')).length).toBeGreaterThan(1);
    // Lower bound proves the wait is a bound rather than a skip; upper bound proves it is nowhere near the 10s drain deadline.
    expect(elapsed).toBeGreaterThanOrEqual(1_500);
    expect(elapsed).toBeLessThan(5_000);
  }, 20_000);
});
