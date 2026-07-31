import { describe, it, expect } from 'vitest';
import { z } from 'zod';
import { createRegistry } from '../src/registry.js';
import type { AnyStrategy } from '../src/registry.js';
import type { Strategy } from '../src/contract.js';

const makeStrategy = (name: string): AnyStrategy => {
  const empty = z.object({});
  const s: Strategy<unknown, unknown, Readonly<Record<string, unknown>>> = {
    name,
    version: '1.0.0',
    displayName: name,
    description: `${name} test stub`,
    capabilities: {
      candleIntervals: [],
      needsUserDataStream: false,
      needsMiniTicker: false,
      bundleProviders: [],
      operatorActions: [],
    },
    configSchema: empty,
    overrideConfigSchema: empty,
    stateSchema: z.unknown(),
    bundleSchema: z.record(z.string(), z.unknown()),
    events: {},
    defaultConfig: {},
    initialState: () => ({}),
    tick: (input) => ({
      nextState: input.state,
      decisions: [],
      logs: [],
      metrics: [],
    }),
  };
  return s;
};

describe('createRegistry', () => {
  it('registers, gets, and lists strategies', () => {
    const r = createRegistry();
    const a = makeStrategy('alpha');
    const b = makeStrategy('beta');
    r.register(a);
    r.register(b);
    expect(r.get('alpha')).toBe(a);
    expect(r.get('beta')).toBe(b);
    expect(r.get('missing')).toBeUndefined();
    expect(r.list()).toEqual([a, b]);
  });

  it('throws on duplicate name', () => {
    const r = createRegistry();
    r.register(makeStrategy('alpha'));
    expect(() => r.register(makeStrategy('alpha'))).toThrow(/duplicate strategy: alpha/);
  });

  it('returns isolated instances per call', () => {
    const r1 = createRegistry();
    const r2 = createRegistry();
    r1.register(makeStrategy('alpha'));
    expect(r2.list()).toHaveLength(0);
  });
});

describe('describeForProfile', () => {
  it('reports a matching stored version as current', () => {
    const r = createRegistry();
    const a = makeStrategy('alpha'); // version 1.0.0
    r.register(a);
    expect(r.describeForProfile('alpha', '1.0.0')).toEqual({ status: 'current', strategy: a });
  });

  it('reports a drifted stored version as migratable, still returning the live plugin', () => {
    // The bug this guards: a profile pinned to an old version must resolve to
    // the plugin that actually runs in tick(), not null. Version is diagnostic.
    const r = createRegistry();
    const a = makeStrategy('alpha'); // live version 1.0.0
    r.register(a);
    expect(r.describeForProfile('alpha', '0.9.0')).toEqual({
      status: 'migratable',
      strategy: a,
      liveVersion: '1.0.0',
      storedVersion: '0.9.0',
    });
  });

  it('reports an unregistered name as unknown', () => {
    const r = createRegistry();
    expect(r.describeForProfile('missing', '1.0.0')).toEqual({
      status: 'unknown',
      name: 'missing',
    });
  });
});
