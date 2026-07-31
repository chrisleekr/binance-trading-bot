// Guards the one escape hatch in the env-var reference.
//
// `defNote` redirects the strict "documented default == schema default"
// assertion in each app's env-docs test from `def` onto `defParsed` rather than
// lifting it. Without the second field the redirect lands nowhere and asserts
// nothing, so a default could flip and both app suites would still pass.
// `defParsed` is what it redirects to: state what an empty environment really
// parses to, and the app tests pin that instead.
//
// This lives here rather than only in the apps so a missing declaration fails
// the unit suite directly, without waiting on the doc generator.

import { describe, expect, it } from 'vitest';

import { ENV_CATALOGUE, type EnvVar } from '../../src/env/catalogue.js';

const noted = (): (readonly [string, EnvVar])[] =>
  Object.entries(ENV_CATALOGUE).filter(([, v]) => v.parsed && v.defNote !== undefined);

describe('env catalogue', () => {
  it('has noted-default entries to check, so the walk is not vacuous', () => {
    expect(noted().length).toBeGreaterThanOrEqual(1);
  });

  it.each(noted())('%s: a noted default declares what the schema really parses to', (name, v) => {
    // `exactOptionalPropertyTypes` is on, so an absent key and an explicit
    // `undefined` are different things. Test presence, not the value.
    expect(
      'defParsed' in v,
      `${name} has a defNote, so it must also declare defParsed (null when the schema yields no value)`,
    ).toBe(true);
  });

  it('declares no defParsed that nothing will ever read', () => {
    // Asserted as a list rather than a per-entry walk: the correct set is empty,
    // and an `it.each` over an empty list would assert nothing at all.
    // Unparsed entries count too: no app suite walks them, so a `defParsed`
    // there is inert even next to a `defNote`.
    const inert = Object.entries(ENV_CATALOGUE)
      .filter(([, v]) => 'defParsed' in v && (v.defNote === undefined || !v.parsed))
      .map(([name]) => name);
    expect(
      inert,
      `${inert.join(', ')}: defParsed is read only on a parsed variable whose defNote redirects the assertion onto it`,
    ).toEqual([]);
  });
});
