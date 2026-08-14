// Pins the three pool sizes to the catalogue prose that documents them.
//
// `API_DB_POOL_MAX` and its siblings are read straight off `process.env` with no
// zod schema, so they carry `parsed: false` and the env-docs default-drift tests
// skip them. That leaves the documented defaults bound to nothing: `DEFAULT_MAX`
// could change from 10 to 20 with every gate green and the operator reference
// still claiming 10. This is the binding.
//
// Asserted through `resolvePoolMax` rather than by reading back
// `new Pool(...).options.max`. pg-pool falls back to 10 of its own when `max` is
// absent, which is also the api default, so a Pool read-back cannot tell our
// value from pg's and would stay green with `DEFAULT_MAX.api` deleted.

import { afterEach, describe, expect, it } from 'vitest';
import { ENV_CATALOGUE } from '@app/core/env';

import { resolvePoolMax, type PoolKind } from '../src/pool.js';

const POOLS: readonly (readonly [PoolKind, string, number])[] = [
  ['api', 'API_DB_POOL_MAX', 10],
  ['worker', 'WORKER_DB_POOL_MAX', 25],
  ['admin', 'ADMIN_DB_POOL_MAX', 2],
];

// Restored rather than deleted: a runner that sizes a pool through the
// environment would otherwise lose that setting for every suite after this one.
const inheritedPoolEnv = new Map(POOLS.map(([, env]) => [env, process.env[env]]));

afterEach(() => {
  for (const [, env] of POOLS) {
    const inherited = inheritedPoolEnv.get(env);
    if (inherited === undefined) delete process.env[env];
    else process.env[env] = inherited;
  }
});

describe('resolvePoolMax: documented defaults', () => {
  it.each(POOLS)('%s pool defaults to %s = %i connections', (kind, env, def) => {
    delete process.env[env];
    expect(resolvePoolMax(kind)).toBe(def);
  });

  it.each(POOLS)('%s pool honours %s when set', (kind, env, def) => {
    process.env[env] = String(def + 7);
    expect(resolvePoolMax(kind)).toBe(def + 7);
  });

  it.each(
    POOLS.flatMap(([kind, env, def]) => ['', '   '].map((raw) => [kind, env, def, raw] as const)),
  )('%s pool falls back to the default when %s is blank (%j)', (kind, env, def, raw) => {
    // An empty value is what a chart renders for an unset optional key, so it
    // has to mean "unset" rather than fail the process at boot. A values file
    // with a stray space says the same thing to whoever wrote it.
    process.env[env] = raw;
    expect(resolvePoolMax(kind)).toBe(def);
  });

  it.each(POOLS)('%s pool tolerates surrounding whitespace in %s', (kind, env) => {
    process.env[env] = ' 12 ';
    expect(resolvePoolMax(kind)).toBe(12);
  });

  it.each(POOLS)('%s pool accepts leading zeros in %s', (kind, env) => {
    // The digits rule says nothing about a leading zero, and `Number` reads it
    // as decimal rather than octal, so this is accepted. Stated because it was
    // not.
    process.env[env] = '007';
    expect(resolvePoolMax(kind)).toBe(7);
  });
});

describe('resolvePoolMax: a bad value fails loudly', () => {
  // Every one of these parsed to something usable under `Number.parseInt`:
  // `1e3` became 1, `10abc` became 10, `10.5` became 10, `+5` became 5. A
  // misconfiguration that quietly caps the pool at one connection is far worse
  // than a failed boot, and the catalogue prose now promises the failure. `+5`
  // is the one an operator would read as a positive integer, so it is pinned
  // here rather than left to whoever next reads the regex.
  // `9007199254740993` is the smallest whole-digit value `Number` cannot hold:
  // it parses to 9007199254740992, so accepting it would size the pool to a
  // number the operator never wrote.
  const REJECTED = ['lots', '1e3', '10abc', '10.5', '0', '-1', '+5', '9007199254740993'];

  it.each(POOLS.flatMap(([kind, env]) => REJECTED.map((raw) => [kind, env, raw] as const)))(
    '%s pool rejects %s=%s',
    (kind, env, raw) => {
      process.env[env] = raw;
      expect(() => resolvePoolMax(kind)).toThrow(/positive integer/);
    },
  );
});

describe('resolvePoolMax: catalogue prose matches the code', () => {
  it.each(POOLS)('%s pool: %s documents def "%i"', (kind, env, def) => {
    // The other half of the binding. Without it, changing both the code and this
    // file would still leave the operator reference stale.
    expect(ENV_CATALOGUE[env]?.def).toBe(String(def));
    expect(resolvePoolMax(kind)).toBe(def);
  });
});
