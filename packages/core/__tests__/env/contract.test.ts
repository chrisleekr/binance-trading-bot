// Pins the wire contract this repo publishes as `env-contract.json`, which the
// helm chart at chrisleekr/helm-charts is meant to fetch at a release tag and
// diff against its own ConfigMap and Secret. The chart sync is version-only, so
// an env var added here and never mirrored simply fails to render and
// `helm template` still succeeds. Nothing downstream can catch that, which is
// why the shape, the serialisation and the misclassification gate are asserted
// on this side of the wire.
//
// Everything under test is the pure logic in `src/env/contract.ts`, imported
// from the module rather than from `@app/core/env`: the barrel publishes only
// the three functions the generator shell calls, and the rule lists below are
// internal to the module. The file I/O and argv handling live in
// `scripts/gen-env-contract.ts` and are deliberately not exercised here.

import { describe, expect, it } from 'vitest';

import { ENV_CATALOGUE } from '../../src/env/catalogue.js';
import {
  buildEnvContract,
  bundleCredentialShaped,
  credentialShaped,
  envContractErrors,
  renderEnvContract,
  ENV_CONTRACT_FLOOR,
  CONNECTION_SEGMENTS,
  CREDENTIAL_SEGMENTS,
  CREDENTIAL_SUBSTRINGS,
  NON_SECRET_NAME_ALLOWLIST,
  type EnvContractEntry,
} from '../../src/env/contract.js';

const catalogueKeys = Object.keys(ENV_CATALOGUE);
const entries = buildEnvContract();

const allowlisted: string[] = Object.keys(NON_SECRET_NAME_ALLOWLIST);

// Walks derived from the exported lists, not from a second copy of the words:
// a copy drifts silently, and the whole point of the gate is that adding a word
// starts protecting names immediately.
const segments: string[] = [...CREDENTIAL_SEGMENTS];
const substrings: string[] = [...CREDENTIAL_SUBSTRINGS];

describe('env contract: shape and source', () => {
  it('emits one entry per ENV_CATALOGUE key, in catalogue order', () => {
    // Equality against the whole key list pins the order; the separate count
    // assertion states the intent directly, so a filter added to the builder
    // cannot pass as an ordering change.
    expect(entries.map((e) => e.env)).toEqual(catalogueKeys);
    expect(entries.length).toBe(catalogueKeys.length);
  });

  it('sources every entry from the catalogue, never from .env.example', () => {
    // `.env.example` omits optional and image-injected variables, so a builder
    // that read it would publish a contract the chart could satisfy while
    // still missing live keys.
    for (const e of entries) expect(catalogueKeys).toContain(e.env);
  });

  it.each(entries.map((e) => [e.env, e] as const))(
    '%s: carries exactly env, group and kind',
    (name, e) => {
      expect(Object.keys(e).sort()).toEqual(['env', 'group', 'kind']);
      expect(e.group).toBe(ENV_CATALOGUE[name]?.group);
      expect(e.kind).toBe(ENV_CATALOGUE[name]?.kind);
    },
  );
});

describe('env contract: serialisation', () => {
  const rendered = renderEnvContract(entries);

  it('matches the exact bytes the consumer and prettier both expect', () => {
    expect(rendered).toBe(`${JSON.stringify(entries, null, 2)}\n`);
  });

  it('round-trips back to the same array', () => {
    expect(JSON.parse(rendered)).toEqual(entries);
  });

  it('ends with exactly one newline', () => {
    expect(rendered.endsWith('\n')).toBe(true);
    expect(rendered.endsWith('\n\n')).toBe(false);
  });

  it('indents with two spaces', () => {
    expect(rendered.split('\n')[1]).toBe('  {');
  });
});

describe('env contract: classification is required', () => {
  // The REQUIRED `kind` field on `EnvVar` is the real gate and fails
  // `bun run typecheck`. This is the runtime backstop for a value that
  // typechecks but is neither literal.
  it.each(catalogueKeys)('%s: declares kind as config or secret', (name) => {
    expect(['config', 'secret']).toContain(ENV_CATALOGUE[name]?.kind);
  });
});

describe('env contract: credential shape', () => {
  it('has every rule list at its shipped size, so the walks below are not vacuous', () => {
    // Exact, not a floor: a list that lost a word would otherwise keep passing
    // while every `it.each` below quietly ran one case fewer.
    expect(segments.length).toBe(23);
    expect(substrings.length).toBe(6);
    expect(CONNECTION_SEGMENTS.size).toBe(5);
  });

  it.each(segments)('%s is a single upper-case segment, with no `_`', (word) => {
    // Matched against `key.split('_')`, so an entry carrying a `_` is
    // unreachable. A lower-case or punctuated entry matches no real variable
    // name either, so it would sit in the list inert while every derived walk
    // below still passed: those walks build their fixture from the word itself
    // and so agree with the function by construction.
    expect(word).toMatch(/^[A-Z][A-Z0-9]*$/);
  });

  it.each(substrings)('%s is a single upper-case segment, with no `_`', (word) => {
    expect(word).toMatch(/^[A-Z][A-Z0-9]*$/);
  });

  it.each(substrings)(
    '%s is not also a segment, which would make the segment entry dead',
    (word) => {
      // `includes` is strictly broader than whole-segment matching for the same
      // word, so a duplicate could never be the deciding rule.
      expect(CREDENTIAL_SEGMENTS.has(word)).toBe(false);
    },
  );

  it.each(segments)('%s is credential-shaped in suffix position', (word) => {
    expect(credentialShaped(`APP_${word}`)).toBe(true);
  });

  it.each(segments)('%s is credential-shaped mid-name', (word) => {
    expect(credentialShaped(`APP_${word}_V2`)).toBe(true);
  });

  it.each(substrings)('%s is credential-shaped fused, with no `_` boundary', (word) => {
    // `PGPASSWORD` is the shape that motivated this pass: the segment walk sees
    // one segment and matches nothing.
    expect(credentialShaped(`PG${word}`)).toBe(true);
  });

  it.each([
    'DATABASE_URL',
    'DATABASE_URL_REPLICA',
    'REDIS_URL_SESSIONS',
    'SENTRY_DSN_BACKEND',
    'AMQP_URI_PRIMARY',
    'SOME_DSN',
  ])('%s is credential-shaped wherever the connection word sits', (name) => {
    // The word marks the value, not the position: a suffix-only rule read
    // `DATABASE_URL_REPLICA` as ordinary config and would publish the password
    // into a plaintext ConfigMap.
    expect(credentialShaped(name)).toBe(true);
  });

  it.each(['github_token', 'sentry-auth-token', 'Pgpassword'])(
    '%s is credential-shaped despite its spelling',
    (name) => {
      // Names are normalised before matching, so a lower-case or hyphenated
      // process variable cannot walk past a rule the upper-case one hits.
      expect(credentialShaped(name)).toBe(true);
    },
  );

  it('catches the OTLP headers variable, which carries the exporter credential', () => {
    expect(credentialShaped('OTEL_EXPORTER_OTLP_HEADERS')).toBe(true);
  });

  it('does not treat an endpoint as credential material', () => {
    // Deliberate omission: the OTLP spec lets an implementation ignore every
    // URL component but scheme, host, port and path, so userinfo in an endpoint
    // authenticates nothing portably and vendors use `_HEADERS`, asserted above.
    expect(credentialShaped('OTEL_EXPORTER_OTLP_ENDPOINT')).toBe(false);
  });

  it.each(['AUTH_SECRET', 'AWS_BEARER_TOKEN_BEDROCK', 'POSTGRES_PASSWORD'])(
    '%s is credential-shaped',
    (name) => {
      expect(credentialShaped(name)).toBe(true);
    },
  );

  it('matches a whole `_`-delimited segment, not a substring', () => {
    // `MONKEY_COUNT` contains KEY. Substring matching would force a
    // false-positive allowlist, which is the escape hatch this gate exists to
    // avoid.
    expect(credentialShaped('MONKEY_COUNT')).toBe(false);
  });

  it.each(['PORT', 'LOG_LEVEL', 'NODE_ENV', 'TICK_CONCURRENCY'])(
    '%s is not credential-shaped',
    (name) => {
      expect(credentialShaped(name)).toBe(false);
    },
  );

  it.each(['AUTH_COOKIE_NAME', 'AUTH_SESSION_TTL_DAYS', 'AUTH_TRUST_PROXY'])(
    '%s is not credential-shaped, because AUTH is not a rule on its own',
    (name) => {
      // Every credential spelling under AUTH is caught by a more specific word,
      // so an AUTH rule would only red ordinary knobs like these and teach
      // operators to reach for the allowlist.
      expect(credentialShaped(name)).toBe(false);
    },
  );
});

describe('env contract: the allowlist', () => {
  it('has the allowlist at its shipped size, so the walks below are not vacuous', () => {
    // Exact, not a floor, for the same reason the rule lists are: a dropped
    // entry would keep every `it.each` below green while running one case less.
    expect(allowlisted.length).toBe(2);
  });

  it.each(allowlisted)('%s carries a written reason', (name) => {
    // The allowlist defeats every rule, so a bare name would be an unreviewed
    // exemption. The reason is what makes it a claim someone can disagree with.
    expect(NON_SECRET_NAME_ALLOWLIST[name] ?? '').not.toBe('');
  });

  it.each(allowlisted)('%s is allowlisted, so it is not credential-shaped', (name) => {
    expect(credentialShaped(name)).toBe(false);
  });

  it.each(allowlisted)('%s would match a rule without the allowlist', (name) => {
    // Proves the entry is load-bearing rather than a leftover exempting nothing.
    expect(credentialShaped(name, {})).toBe(true);
  });

  it.each(allowlisted)('%s is a real catalogue key, so the allowlist cannot go stale', (name) => {
    // A name that no longer exists suppresses nothing today, but silently
    // pre-approves whatever variable later takes that name.
    expect(catalogueKeys).toContain(name);
  });

  it.each([
    ['APP_SECRET', 'a whole-segment match'],
    ['PGPASSWORD', 'a fused substring match'],
    ['SOME_DSN', 'a connection-string match'],
  ])('beats %s (%s), not just one rule class', (name) => {
    // The shipped allowlist happens to hold only connection-string names, so
    // reordering the function to check a rule before the allowlist would leave
    // the walks above green. Injecting the name pins the precedence per class.
    expect(credentialShaped(name)).toBe(true);
    expect(credentialShaped(name, { [name]: 'test fixture' })).toBe(false);
  });
});

describe('env contract: misclassification gate', () => {
  /** Flips one real catalogue entry, so the fixture stays a catalogue key. */
  const flip = (name: string, kind: EnvContractEntry['kind']): EnvContractEntry[] =>
    entries.map((e) => (e.env === name ? { ...e, kind } : e));

  it('reports no error for the real contract', () => {
    expect(envContractErrors(entries)).toEqual([]);
  });

  it('names a credential-shaped variable classified as config', () => {
    expect(
      envContractErrors(flip('AUTH_SECRET', 'config')).some((m) => m.includes('AUTH_SECRET')),
    ).toBe(true);
  });

  it('accepts the same variable classified as secret', () => {
    expect(envContractErrors(flip('AUTH_SECRET', 'secret'))).toEqual([]);
  });

  it.each(['FAKE_KNOB', 'constructor', 'toString'])(
    'rejects %s, which is not a catalogue key',
    (name) => {
      // The consumer checks read the catalogue, so an unknown key used to skip
      // them silently while the name rule still fired: a partial pass reading
      // as a full one. `constructor` and `toString` resolve off
      // Object.prototype under a bare index, so before the own-property check
      // they walked past the `undefined` guard and threw on `.consumers`.
      const errors = envContractErrors([
        ...entries,
        { env: name, group: 'Required', kind: 'config' },
      ]);
      expect(errors.some((m) => m.includes(name) && m.includes('ENV_CATALOGUE'))).toBe(true);
    },
  );
});

describe('env contract: build-time variables', () => {
  const buildKeys = catalogueKeys.filter((name) =>
    ENV_CATALOGUE[name]?.consumers.includes('build'),
  );

  it('has every build-consumer variable, so the walks below are not vacuous', () => {
    // Exact, not a floor: flipping one key's `consumers` from `build` to
    // `compose` typechecks, and would drop it from all four walks below with
    // every assertion still green.
    expect(buildKeys.length).toBe(2);
  });

  it.each(buildKeys)('%s: classifying it secret is an error, not assurance', (name) => {
    // Vite stamps the value into the web bundle, so it reaches every browser
    // regardless of which chart surface holds it. A Secret would only hide that.
    const flipped = entries.map((e) => (e.env === name ? { ...e, kind: 'secret' as const } : e));
    expect(envContractErrors(flipped).some((m) => m.includes(name))).toBe(true);
  });

  it.each(buildKeys)('%s: is classified config today', (name) => {
    expect(ENV_CATALOGUE[name]?.kind).toBe('config');
  });

  it.each(buildKeys)('%s: carries no credential the allowlist could waive', (name) => {
    // The allowlist cannot reach a build variable's credential words, so an
    // allowlisted build key is only legal while it stays non-credential by
    // every rule but the connection-string one.
    expect(bundleCredentialShaped(name)).toBe(false);
  });

  it.each(['VITE_SENTRY_AUTH_TOKEN', 'VITE_APP_APIKEY', 'VITE_ADMIN_PASSWORD'])(
    '%s is unwaivable credential material for a bundle',
    (name) => {
      // The Sentry Vite plugin really does read a build-time auth token, so
      // this is the shape an operator would otherwise be told to classify
      // `config` and allowlist, shipping it to every browser.
      expect(bundleCredentialShaped(name)).toBe(true);
    },
  );

  it.each(['VITE_API_BASE_URL', 'VITE_PWA', 'VITE_CDN_URL'])(
    '%s is not bundle credential material',
    (name) => {
      // A build variable's origin is exactly what the bundle has to contain,
      // so the connection-string words stay waivable here.
      expect(bundleCredentialShaped(name)).toBe(false);
    },
  );
});

describe('env contract: vacuity floor', () => {
  it('reports an error when the catalogue yields too few entries', () => {
    const errors = envContractErrors(entries.slice(0, 2));
    expect(errors.some((m) => m.includes(String(ENV_CONTRACT_FLOOR)))).toBe(true);
  });

  it('reports no floor error for the real contract', () => {
    expect(envContractErrors(entries)).toEqual([]);
  });

  it('sits below the real count and within a fifth of it', () => {
    // Bound proportionally, not against a constant: a floor of 2 also sits
    // "below the count and above 1", so the cheapest way to silence a red gate
    // was to lower the floor until it caught nothing.
    expect(ENV_CONTRACT_FLOOR).toBeLessThan(entries.length);
    expect(ENV_CONTRACT_FLOOR).toBeGreaterThanOrEqual(Math.floor(entries.length * 0.8));
  });
});

describe('env contract: pool-size variables', () => {
  it.each(['API_DB_POOL_MAX', 'WORKER_DB_POOL_MAX', 'ADMIN_DB_POOL_MAX'])(
    '%s is published as config',
    (name) => {
      // Read by `packages/db/src/pool.ts` but never declared in
      // `.env.example`, so they are exactly the variables a chart mirroring
      // that file would miss.
      expect(entries.find((e) => e.env === name)).toEqual({
        env: name,
        group: 'Database',
        kind: 'config',
      });
    },
  );
});
