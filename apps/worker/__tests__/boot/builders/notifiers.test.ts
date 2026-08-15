import { describe, expect, it, vi } from 'vitest';

import { buildNotifiers } from '../../../src/boot/builders/notifiers.js';
import { fakeDb, fakeQueueSet, fakeRedis, silentLogger } from './fakes.js';

describe('buildNotifiers', () => {
  it('returns the notifier surface and registers the DLQ worker on the queue set', () => {
    const queueSet = fakeQueueSet();
    const registerWorker = vi.fn(() => ({}));
    queueSet.registerWorker = registerWorker;

    const n = buildNotifiers({
      db: fakeDb(),
      redis: fakeRedis(),
      logger: silentLogger(),
      liveDemo: false,
      queueSet,
    });

    expect(Object.keys(n).sort()).toEqual([
      'accountNotify',
      'accountNotifyBatch',
      'notifierGapThrottle',
      'notifyEvent',
      'orderFailedThrottle',
      'protectiveStopBlockedThrottle',
    ]);
    expect(typeof n.accountNotify).toBe('function');
    expect(typeof n.notifyEvent).toBe('function');
    // The DLQ alert path is wired into the queue set here, not in the composer.
    expect(registerWorker).toHaveBeenCalledWith('dlq', expect.any(Function));
  });
});
