// `infraGate` is the single predicate that replaced twelve hand-copied ones, so its decision table is the thing that decides whether the integration lane runs at all. Until now the only check on it was a source-text scan asserting each suite's gate mentions `TESTCONTAINERS`, which proves the string is present and nothing about what the table decides.
//
// The failure this pins is a gate that ADMITS a suite it cannot serve: `withRedis()` then falls through to spinning a container against a machine with no Docker socket, and the suite dies inside `beforeAll` with a socket error that reads like a broken test. That is the exact shape the retired hand-written gates warned about in prose, which is why `both` is checked against each URL alone rather than only against the pair.
//
// This file deliberately sits OUTSIDE `__tests__/integration/`: the honesty checker counts `*.test.ts` in that directory as the lane's own suites, and a unit test living there would inflate the count it audits.

import { afterEach, describe, expect, it, vi } from 'vitest';

import { infraGate, type InfraNeed } from './integration/_infra-gate.js';

/** Clears the three variables the gate reads, so each case states its whole environment rather than inheriting the developer's. */
const withEnv = (env: Record<string, string | undefined>): void => {
  for (const name of ['TESTCONTAINERS', 'DATABASE_TEST_URL', 'REDIS_TEST_URL']) {
    vi.stubEnv(name, env[name]);
  }
};

const DB_URL = 'postgres://postgres:postgres@localhost:5432/test';
const REDIS_URL = 'redis://localhost:6379';

afterEach(() => {
  vi.unstubAllEnvs();
});

describe('infraGate decision table', () => {
  // Docker satisfies every need on its own, because `withPostgres` / `withRedis` provision whatever the suite asks for.
  it.each<InfraNeed>(['db', 'redis', 'both'])(
    'admits need=%s on TESTCONTAINERS=1 alone',
    (need) => {
      withEnv({ TESTCONTAINERS: '1' });

      expect(infraGate(need)).toEqual({ enabled: true, reason: '' });
    },
  );

  it('admits each single need from its own URL', () => {
    withEnv({ DATABASE_TEST_URL: DB_URL });
    expect(infraGate('db').enabled).toBe(true);

    withEnv({ REDIS_TEST_URL: REDIS_URL });
    expect(infraGate('redis').enabled).toBe(true);
  });

  // The half-configured environment is the case that matters: admitting here is what produces a Docker socket error deep inside a hook instead of a stand-down.
  it('refuses need=both when only one URL is present', () => {
    withEnv({ DATABASE_TEST_URL: DB_URL });
    expect(infraGate('both')).toEqual({
      enabled: false,
      reason: 'needs Docker via TESTCONTAINERS=1, or REDIS_TEST_URL',
    });

    withEnv({ REDIS_TEST_URL: REDIS_URL });
    expect(infraGate('both')).toEqual({
      enabled: false,
      reason: 'needs Docker via TESTCONTAINERS=1, or DATABASE_TEST_URL',
    });
  });

  it('names both variables when neither is present', () => {
    withEnv({});

    expect(infraGate('both')).toEqual({
      enabled: false,
      reason: 'needs Docker via TESTCONTAINERS=1, or DATABASE_TEST_URL + REDIS_TEST_URL',
    });
  });

  // A need is refused by the URL it actually requires, not by whichever happens to be missing: a redis suite must not ride in on DATABASE_TEST_URL.
  it('does not let the wrong URL satisfy a need', () => {
    withEnv({ DATABASE_TEST_URL: DB_URL });
    expect(infraGate('redis').enabled).toBe(false);

    withEnv({ REDIS_TEST_URL: REDIS_URL });
    expect(infraGate('db').enabled).toBe(false);
  });

  // Only the literal '1' counts, which is the same comparison `withPostgres` / `withRedis` make (`!== '1'`) when they choose between provisioning and reusing a supplied URL. Accepting any truthy value here would admit a suite on `TESTCONTAINERS=true` with no URL set, and the gate's whole job is to refuse before a hook discovers that.
  it('treats a non-1 TESTCONTAINERS value as unset', () => {
    withEnv({ TESTCONTAINERS: 'true' });

    expect(infraGate('db').enabled).toBe(false);
  });
});
