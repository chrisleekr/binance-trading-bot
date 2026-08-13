import { describe, expect, it, vi } from 'vitest';

import { buildExecutor } from '../../../src/boot/builders/executor.js';
import { fakeDb, fakeRedis, silentLogger } from './fakes.js';

const buildProfileBindings = vi.fn(async () => null);
const buildProfileBindingsFromScope = vi.fn(async () => null);
vi.mock('../../../src/profile-bindings/index.js', () => ({
  buildProfileBindings: (...args: unknown[]) => buildProfileBindings(...(args as [])),
  buildProfileBindingsFromScope: (...args: unknown[]) =>
    buildProfileBindingsFromScope(...(args as [])),
}));

// Captured rather than asserted through a real executor: the wire under test is
// the `resolveProfile` closure buildExecutor hands down, and reaching it through
// applyAll would need a whole tick's worth of fixtures to prove one argument.
let liveExecutorDeps: { resolveProfile: (...args: unknown[]) => Promise<unknown> } | null = null;
vi.mock('../../../src/executor/live-executor.js', () => ({
  createLiveExecutor: (deps: never) => {
    liveExecutorDeps = deps;
    return { applyAll: async () => [] };
  },
}));

const orderGovernorFor = vi.fn();

const deps = () =>
  ({
    db: fakeDb(),
    redis: fakeRedis(),
    logger: silentLogger(),
    liveDemo: false,
    profileManager: { listActive: () => [] },
    enqueueSymbolReconcile: async () => undefined,
    orderGovernorFor,
    metrics: { record: () => undefined },
  }) as never;

describe('buildExecutor', () => {
  it('constructs the live executor', () => {
    const { liveExecutor } = buildExecutor(deps());
    expect(liveExecutor).toBeDefined();
  });

  it('threads the account ORDERS governor into every profile binding it resolves', async () => {
    // Nothing else can catch an omitted wire here. The dep is optional on the
    // bindings side (tests leave it off), so dropping it costs no compile error
    // and no failing assertion — the governor simply never reaches the executor
    // and every placement charges nothing, with all gates still green.
    buildExecutor(deps());
    await liveExecutorDeps?.resolveProfile('op-1', 'acct-1', 'prof-1', undefined, undefined);
    await liveExecutorDeps?.resolveProfile('op-1', 'acct-1', 'prof-1', { proven: true }, undefined);

    expect(buildProfileBindings).toHaveBeenCalledWith(
      expect.objectContaining({ orderGovernorFor }),
      'op-1',
      'acct-1',
      'prof-1',
    );
    // The scope-carrying path is a separate call site, so it needs its own pin.
    expect(buildProfileBindingsFromScope).toHaveBeenCalledWith(
      expect.objectContaining({ orderGovernorFor }),
      { proven: true },
      undefined,
    );
  });
});
