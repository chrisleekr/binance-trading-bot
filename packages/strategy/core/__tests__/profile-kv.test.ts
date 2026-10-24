import { describe, expect, it } from 'vitest';

import { readsProfileKv } from '../src/profile-kv.js';
import type { Capabilities } from '../src/contract.js';

const caps = (needsProfileKv?: boolean): Capabilities =>
  ({
    bundleProviders: [],
    ...(needsProfileKv === undefined ? {} : { needsProfileKv }),
  }) as unknown as Capabilities;

describe('readsProfileKv', () => {
  it('reads the store for a strategy that always needs it, whatever the config', () => {
    expect(readsProfileKv({ capabilities: caps(true) }, {})).toBe(true);
  });

  it('defers to the config predicate when the capability is absent or false', () => {
    const byConfig = {
      capabilities: caps(false),
      needsProfileKvFor: (c: { on: boolean }) => c.on,
    };
    expect(readsProfileKv(byConfig, { on: true })).toBe(true);
    expect(readsProfileKv(byConfig, { on: false })).toBe(false);
  });

  it('skips the store for a per-symbol strategy that declares neither', () => {
    expect(readsProfileKv({ capabilities: caps() }, {})).toBe(false);
  });
});
