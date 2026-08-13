// Shared fetch-stub plumbing for the override-outcome race tests. Not collected
// as a suite: the config's include glob only takes `*.test.*`. The underscore is
// a naming convention for a helper, not the thing that excludes it.

const json = (body: unknown): Response =>
  new Response(JSON.stringify(body), {
    status: 200,
    headers: { 'content-type': 'application/json' },
  });

/**
 * A responder that hands every request its own resolver, so a test can settle
 * them out of issue order.
 *
 * Ordinary responders answer in the order they were asked, which cannot express
 * the override-outcome race: a read issued BEFORE an arm can land AFTER it,
 * and react-query stamps `dataUpdatedAt` at resolution, not at issue. Holding
 * the first request open across the arm is the only way to reproduce that from
 * a test. Requests are settled by issue order, counting from zero.
 */
export const deferredResponder = (): {
  responder: () => Promise<Response>;
  issued: () => number;
  settle: (index: number, body: unknown) => void;
  settleAllPending: (body: unknown) => void;
} => {
  const pending: ((body: unknown) => void)[] = [];
  return {
    responder: () =>
      new Promise<Response>((resolve) => {
        pending.push((body) => resolve(json(body)));
      }),
    issued: () => pending.length,
    settle: (index, body) => {
      const resolver = pending[index];
      if (!resolver) throw new Error(`no request #${index} is in flight`);
      resolver(body);
    },
    // For tests that cannot name the index they need: this stub queues every GET
    // in one array, and the keyed watches poll on their own 2s cadences, so which
    // pending request is which depends on wall-clock timing. Re-resolving an
    // already-settled promise is a no-op, so no bookkeeping is needed to skip them.
    settleAllPending: (body) => {
      for (const resolver of pending) resolver(body);
    },
  };
};
