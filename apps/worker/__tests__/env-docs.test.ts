// Pins the env-var reference to the worker's real schema. Same contract as the
// api's env-docs test: the catalogue in `@app/core/env` owns the prose, the zod
// schema owns the defaults, and this parses an EMPTY environment to assert the
// two agree. See that file for the full rationale.

import { ENV_CATALOGUE, type EnvVar } from '@app/core/env';
import { describe, expect, it } from 'vitest';

import { loadWorkerEnv } from '../src/env.js';

/** The minimum a parse needs to succeed, so optional defaults can be observed. */
const MINIMUM = {
  DATABASE_URL: 'postgres://u:p@localhost:5432/db',
  REDIS_URL: 'redis://localhost:6379',
} satisfies NodeJS.ProcessEnv;

/** True for the entries this process parses. */
const consumed = (v: EnvVar): boolean =>
  v.parsed && (v.consumers.includes('worker') || v.consumers.includes('shared'));

/**
 * Catalogue entries this process parses whose documented default is the
 * schema's, excluding the required ones.
 */
const documented = (): (readonly [string, EnvVar])[] =>
  Object.entries(ENV_CATALOGUE).filter(
    ([name, v]) => consumed(v) && !(name in MINIMUM) && v.defNote === undefined,
  );

/**
 * Entries whose documented default legitimately differs from the schema's: a
 * representation gap (LIVE_DEMO documents `off` for a boolean `false`), plain
 * optionality (PUBLIC_WEB_URL has no default at all), or a value resolved at
 * boot (STUDY_CPU_SHARE depends on ROLE, so the schema itself has none). They
 * still get pinned, against `defParsed` instead of `def`.
 */
const pinned = (): (readonly [string, EnvVar])[] =>
  Object.entries(ENV_CATALOGUE).filter(
    ([name, v]) => consumed(v) && !(name in MINIMUM) && v.defNote !== undefined,
  );

/** Entries documented as required, i.e. boot must fail without them. */
const required = (): (readonly [string, EnvVar])[] =>
  Object.entries(ENV_CATALOGUE).filter(
    ([, v]) => consumed(v) && v.def === null && v.defNote === undefined,
  );

describe('worker env documentation', () => {
  const env = loadWorkerEnv(MINIMUM) as unknown as Record<string, unknown>;

  it('documents at least the worker-specific variables, so the walk is not vacuous', () => {
    // 13, down from 15: the action-log and audit-log retention horizons stopped
    // being env vars and became operator-settable rows in `retention_config`.
    // The floor only guards against the walk silently emptying out; it is not a
    // ratchet, so a deliberate removal moves it.
    expect(documented().length).toBeGreaterThanOrEqual(13);
  });

  it.each(documented())('%s: the documented default is the schema default', (name, v) => {
    expect(v.def, `${name} is documented as required but the schema has a default`).not.toBeNull();
    expect(String(env[name])).toBe(v.def);
  });

  it('pins the noted-default variables, so that walk is not vacuous', () => {
    expect(pinned().length).toBeGreaterThanOrEqual(3);
  });

  it.each(pinned())('%s: the noted default records what the schema really yields', (name, v) => {
    expect(
      'defParsed' in v,
      `${name} has a defNote, so it must also declare defParsed: what an empty environment really parses to`,
    ).toBe(true);
    // `null` is not the same as the string 'undefined'. PUBLIC_WEB_URL and
    // STUDY_CPU_SHARE are absent keys after an empty parse, and an absent key
    // stringifies to 'undefined', which would pass vacuously.
    if (v.defParsed === null) {
      expect(name in env).toBe(false);
    } else {
      expect(String(env[name])).toBe(v.defParsed);
    }
  });

  it('walks the entries the parse leaves absent, which the coverage walk cannot see', () => {
    // PUBLIC_WEB_URL and STUDY_CPU_SHARE are fully optional, so zod omits the
    // key and they never reach `Object.keys(env)`. The coverage walk below is
    // structurally blind to them, leaving only a count between them and a
    // silent drop out of every walk. Anchor them by name so a `parsed` flip or
    // a narrowed `consumers` fails even once the floor has slack.
    expect(
      pinned()
        .map(([name]) => name)
        .sort(),
    ).toEqual(['LIVE_DEMO', 'PUBLIC_WEB_URL', 'STUDY_CPU_SHARE']);
  });

  it('documents at least the shared required variables, so that walk is not vacuous', () => {
    expect(required().length).toBeGreaterThanOrEqual(2);
  });

  it.each(required())('%s: documented as required, so the schema rejects its absence', (name) => {
    // The required vars live in MINIMUM and so escape the default walk above.
    // Drop each in turn: `def: null` is a claim about boot, and only a failed
    // parse proves it. Matching the name is what makes it proof, so an
    // unrelated rule firing cannot stand in for the key that was dropped.
    const withoutIt: NodeJS.ProcessEnv = { ...MINIMUM };
    delete withoutIt[name];
    expect(() => loadWorkerEnv(withoutIt)).toThrow(name);
  });

  it('walks every default the schema actually applied', () => {
    // The floors above catch a walk that went empty, never one that quietly
    // lost a single entry: flipping `parsed` or narrowing `consumers` on one
    // variable drops it out of every walk while the count stays over the floor.
    // Anchoring to the real parse output makes `parsed` and `consumers` as
    // accountable as `defNote` now is.
    const walked = new Set([...documented(), ...pinned()].map(([name]) => name));
    const unwalked = Object.keys(env).filter((k) => !(k in MINIMUM) && !walked.has(k));
    expect(unwalked).toEqual([]);
  });

  it('every worker variable the schema parses is in the catalogue', () => {
    const catalogued = new Set(Object.keys(ENV_CATALOGUE));
    const undocumented = Object.keys(env).filter((k) => !catalogued.has(k));
    expect(undocumented).toEqual([]);
  });
});
