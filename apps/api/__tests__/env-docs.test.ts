// Pins the env-var reference to the api's real schema.
//
// The operator-facing table (docs/operations/env-vars.md) is generated from the
// catalogue in `@app/core/env`, which carries the prose. The zod schema carries
// the actual defaults. Nothing structural connects the two, so this test does:
// it parses an EMPTY environment through the real loader and asserts every
// default the catalogue documents is the default the process will apply.
//
// Without it, changing `.default(9100)` to `.default(9200)` would ship a
// reference that confidently states the wrong port with CI green — the exact
// drift that reached the technicals doc (#718).

import { ENV_CATALOGUE, type EnvVar } from '@app/core/env';
import { describe, expect, it } from 'vitest';

import { loadEnv } from '../src/env.js';

/** The minimum a parse needs to succeed, so optional defaults can be observed. */
const MINIMUM = {
  DATABASE_URL: 'postgres://u:p@localhost:5432/db',
  REDIS_URL: 'redis://localhost:6379',
  AUTH_SECRET: 'x'.repeat(32),
  WEB_ORIGIN: 'http://localhost:5173',
} satisfies NodeJS.ProcessEnv;

/**
 * True for the entries this process parses. `shared` counts: the api schema
 * spreads `sharedEnvFields`, so it really does parse and require DATABASE_URL
 * and REDIS_URL alongside its own fields.
 */
const consumed = (v: EnvVar): boolean =>
  v.parsed && (v.consumers.includes('api') || v.consumers.includes('shared'));

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
 * representation gap (LIVE_DEMO documents `off` for a boolean `false`), a value
 * `.env.example` ships, or one resolved at boot. They still get pinned, against
 * `defParsed` instead of `def`.
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

describe('api env documentation', () => {
  const env = loadEnv(MINIMUM) as unknown as Record<string, unknown>;

  it('documents at least the api-specific variables, so the walk is not vacuous', () => {
    // A regression that emptied the catalogue, or narrowed `consumers`, would
    // otherwise make every assertion below pass by iterating nothing.
    expect(documented().length).toBeGreaterThanOrEqual(8);
  });

  it.each(documented())('%s: the documented default is the schema default', (name, v) => {
    expect(v.def, `${name} is documented as required but the schema has a default`).not.toBeNull();
    expect(String(env[name])).toBe(v.def);
  });

  it('pins at least one noted-default variable, so that walk is not vacuous', () => {
    expect(pinned().length).toBeGreaterThanOrEqual(1);
  });

  it.each(pinned())('%s: the noted default records what the schema really yields', (name, v) => {
    expect(
      'defParsed' in v,
      `${name} has a defNote, so it must also declare defParsed: what an empty environment really parses to`,
    ).toBe(true);
    // `null` is not the same as the string 'undefined'. An absent key stringifies
    // to 'undefined', so comparing that way would pass on any absent variable.
    if (v.defParsed === null) {
      expect(name in env).toBe(false);
    } else {
      expect(String(env[name])).toBe(v.defParsed);
    }
  });

  it('documents at least the api-specific required variables, so that walk is not vacuous', () => {
    expect(required().length).toBeGreaterThanOrEqual(4);
  });

  it.each(required())('%s: documented as required, so the schema rejects its absence', (name) => {
    // The required vars live in MINIMUM and so escape the default walk above.
    // Drop each in turn: `def: null` is a claim about boot, and only a failed
    // parse proves it. Matching the name is what makes it proof: the schema
    // also has a cross-field refine whose message names neither key, so a bare
    // throw could come from something other than the key that was dropped.
    const withoutIt: NodeJS.ProcessEnv = { ...MINIMUM };
    delete withoutIt[name];
    expect(() => loadEnv(withoutIt)).toThrow(name);
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

  it('every api variable the schema parses is in the catalogue', () => {
    // The reverse direction: a new field added to the schema and forgotten in
    // the catalogue would leave the reference silently incomplete.
    const catalogued = new Set(Object.keys(ENV_CATALOGUE));
    const undocumented = Object.keys(env).filter((k) => !catalogued.has(k));
    expect(undocumented).toEqual([]);
  });
});
