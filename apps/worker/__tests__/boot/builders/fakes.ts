// Lightweight fakes for the boot builders. The builders are DI glue over
// already-tested deep modules, so a unit test only needs a dep that is present
// and callable — the deep modules store what they are handed and act later. A
// Proxy that answers every property access with a no-op function is enough for
// construction-time wiring, and named stubs cover the few methods a builder
// invokes eagerly (redis.duplicate, klineFetcher.setOnReconnect, ...).

import type { Logger } from 'pino';
import pino from 'pino';

export const silentLogger = (): Logger => pino({ level: 'silent' });

// A callable Proxy: any property read returns a no-op fn, and calling the object
// itself returns the same proxy. `duplicate` yields a fresh proxy so the audit
// builder's dedicated connection is a distinct object.
export const anyProxy = (): any => {
  const target = (): unknown => proxy;
  const proxy: any = new Proxy(target, {
    get: (_t, prop) => {
      if (prop === 'duplicate') return () => anyProxy();
      if (prop === 'then') return undefined; // not a thenable
      return () => proxy; // chainable: metrics.gauge('x').set(1) stays a no-op
    },
    apply: () => proxy,
  });
  return proxy;
};

export const fakeRedis = (): any => anyProxy();
export const fakeDb = (): any => anyProxy();

export const fakeQueueSet = (): any => ({
  queues: new Proxy({}, { get: () => ({}) }),
  workers: [],
  enqueueDlq: () => Promise.resolve(),
  registerWorker: () => ({}),
  closeAll: () => Promise.resolve(),
});
