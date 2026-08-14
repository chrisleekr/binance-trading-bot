// The machine-readable env surface this repo publishes as `env-contract.json`.
//
// WHY: the helm chart is synced by version only. When a release adds or removes
// an environment variable, nothing updates the chart's ConfigMap or Secret and
// nothing fails: an unmirrored variable simply does not render, so
// `helm template` still succeeds and the gap surfaces as a runtime default
// nobody chose. This file is published so the chart's parity check can fetch it
// for the release tag it is syncing and diff the names, so the contract has to
// be published from the catalogue rather than reconstructed from `.env.example`,
// which omits every optional and image-injected key.
//
// Pure by design: the generator shell (`scripts/gen-env-contract.ts`) owns argv
// and fs so this logic is unit-testable, matching how the config-table generator
// is split.

import { ENV_CATALOGUE } from './catalogue.js';

/** One published variable. The field names are the wire contract; do not rename. */
export interface EnvContractEntry {
  /** The variable name, exactly as the process reads it. */
  readonly env: string;
  /** The catalogue's doc section. Informational, for a human reading the file. */
  readonly group: string;
  /** Which of the chart's two surfaces the value belongs on. */
  readonly kind: 'config' | 'secret';
}

/**
 * Connection-string words. The usual form of each embeds `user:password@host`,
 * so the name alone settles it. They are ordinary segments rather than trailing
 * suffixes because the password sits in the value wherever the word sits in the
 * name: `DATABASE_URL_REPLICA` and `AMQP_URI_PRIMARY` carry the same credential
 * as the bare spelling.
 *
 * Split out because a build-time variable treats them differently: see
 * `bundleCredentialShaped`.
 */
export const CONNECTION_SEGMENTS: ReadonlySet<string> = new Set([
  'URL',
  'URI',
  'DSN',
  'CONN',
  'CONNECTION',
]);

/**
 * Name segments that mark a value as credential material. Matched as whole
 * `_`-delimited segments, so `MONKEY_COUNT` is not a key and no allowlist entry
 * is needed to say so.
 *
 * `ENDPOINT` is deliberately absent. The OTLP spec defines
 * `OTEL_EXPORTER_OTLP_ENDPOINT` as a target URL whose scheme, host, port and
 * path an implementation MUST honour while it MAY ignore every other URL
 * component, so userinfo in an endpoint is not a portable way to authenticate
 * and vendors put the credential in `OTEL_EXPORTER_OTLP_HEADERS`, which this
 * list does catch.
 *
 * `AUTH` is deliberately absent too. Every credential spelling under it is
 * already caught by a more specific word (`AUTH_SECRET`, `AUTH_TOKEN`,
 * `AUTH_KEY`), so all it would uniquely catch is non-credential knobs like
 * `AUTH_COOKIE_NAME` or `AUTH_SESSION_TTL_DAYS`, each of which would fail
 * generation and teach operators to reach for the allowlist. `AUTHORIZATION`
 * stays, because it names a header value rather than a subsystem.
 */
export const CREDENTIAL_SEGMENTS: ReadonlySet<string> = new Set([
  'KEY',
  'KEYS',
  'TOKEN',
  'TOKENS',
  'SECRET',
  'SECRETS',
  'PASS',
  'PWD',
  'PASSPHRASE',
  'CREDENTIAL',
  'CREDENTIALS',
  'BEARER',
  'AUTHORIZATION',
  'HEADER',
  'HEADERS',
  'WEBHOOK',
  'SALT',
  'SIGNATURE',
  ...CONNECTION_SEGMENTS,
]);

/**
 * Credential words that real variables spell without a `_` boundary, so the
 * segment pass misses them (`PGPASSWORD`). Each has no plausible
 * non-credential reading, which is what makes substring matching safe here and
 * not for a bare `KEY`.
 *
 * Matching is a plain `includes`, which is strictly broader than the segment
 * rule for the same word. So a word listed here must NOT also sit in
 * `CREDENTIAL_SEGMENTS`: the segment entry could never be the deciding rule,
 * and a dead rule reads as coverage.
 */
export const CREDENTIAL_SUBSTRINGS: readonly string[] = [
  'PASSWORD',
  'PASSWD',
  'APIKEY',
  'ACCESSKEY',
  'SECRETKEY',
  'PRIVATEKEY',
];

/**
 * Names exempt from the shape rules entirely, mapped to why the exemption
 * holds. The allowlist is consulted before every rule, so an entry defeats all
 * of them; the reason string is what makes that an explicit reviewed claim
 * rather than a name someone added to clear a red gate.
 */
export const NON_SECRET_NAME_ALLOWLIST: Readonly<Record<string, string>> = {
  PUBLIC_WEB_URL:
    'the operator-facing base URL notification links are built from; an origin with no userinfo',
  VITE_API_BASE_URL:
    'a path or origin bundled into the browser and visible in the page; no userinfo',
};

/**
 * Names are compared upper-cased with `-` folded to `_`. A process can read
 * `github_token` as readily as `GITHUB_TOKEN`, and a rule that only sees one
 * spelling fails open on the other.
 */
const normaliseName = (name: string): string => name.toUpperCase().replace(/-/g, '_');

/**
 * Lower bound on the published entry count. A contract that generates almost
 * nothing would pass a byte-comparison gate while mirroring nothing, so the
 * floor turns an import or catalogue regression into a failure. Sits a margin
 * below the real count so ordinary removals do not red it.
 */
export const ENV_CONTRACT_FLOOR: number = 35;

/**
 * True when the name alone is enough to conclude the value is credential
 * material. Deliberately name-based: the gate has to work without reading any
 * value, and a name is what the chart author sees when deciding where to put it.
 */
export const credentialShaped = (
  name: string,
  allowlist: Readonly<Record<string, string>> = NON_SECRET_NAME_ALLOWLIST,
): boolean => {
  const key = normaliseName(name);
  // Allowlist first, so it is an escape hatch for every shape below and the
  // error message that points operators at it is true whichever rule fired.
  if (Object.hasOwn(allowlist, key)) return false;
  if (key.split('_').some((segment) => CREDENTIAL_SEGMENTS.has(segment))) return true;
  return CREDENTIAL_SUBSTRINGS.some((word) => key.includes(word));
};

/**
 * Credential-shaped in the sense that matters for a value the bundler stamps
 * into the browser. No allowlist parameter, because a build-time value is
 * readable in the shipped page whichever chart surface holds it: waiving the
 * rule waives the warning, not the exposure.
 *
 * The connection-string words are excluded. A build variable's `_URL` is
 * normally the browser-facing origin the bundle has to contain, so treating it
 * as unwaivable would block the ordinary case; everything else on the list
 * names material that must never be bundled at all.
 */
export const bundleCredentialShaped = (name: string): boolean => {
  const key = normaliseName(name);
  return (
    key
      .split('_')
      .some((segment) => CREDENTIAL_SEGMENTS.has(segment) && !CONNECTION_SEGMENTS.has(segment)) ||
    CREDENTIAL_SUBSTRINGS.some((word) => key.includes(word))
  );
};

/** Every catalogue entry, in catalogue order. Never filtered: the chart needs the whole surface. */
export const buildEnvContract = (): EnvContractEntry[] =>
  Object.entries(ENV_CATALOGUE).map(([env, v]) => ({ env, group: v.group, kind: v.kind }));

/**
 * The exact bytes written to `env-contract.json`. Two-space JSON with a trailing
 * newline is also what prettier produces, so the committed file survives the
 * pre-commit format hook unchanged and the staleness gate cannot fight it.
 */
export const renderEnvContract = (entries: readonly EnvContractEntry[]): string =>
  `${JSON.stringify(entries, null, 2)}\n`;

/**
 * Everything wrong with a contract, as operator-readable lines. Empty means
 * publishable.
 *
 * Misclassification is checked here rather than at the catalogue's type, which
 * can only require that `kind` is one of two literals, not that it is the right
 * one. A credential shipped in a ConfigMap is the failure with no recovery, so
 * it fails generation as well as the check.
 *
 * `consumers` is read back off the catalogue rather than carried on the entry:
 * the published shape is the wire contract and the chart reads only
 * `{env, group, kind}`.
 */
export const envContractErrors = (entries: readonly EnvContractEntry[]): string[] => {
  const errors: string[] = [];

  for (const e of entries) {
    // Looked up once and required: an absent key used to make the consumer
    // checks below no-op silently, so an entry from anywhere but the catalogue
    // was exempt from the rule that matters most for it.
    // Own-property check for the same reason the allowlist uses one: a bare
    // index resolves `constructor` and `toString` off Object.prototype,
    // slipping past an `=== undefined` guard and crashing on `.consumers`.
    const catalogued = Object.hasOwn(ENV_CATALOGUE, e.env) ? ENV_CATALOGUE[e.env] : undefined;
    if (catalogued === undefined) {
      errors.push(
        `${e.env}: not in ENV_CATALOGUE, so its consumers cannot be checked. Every published entry is built from the catalogue; add it there.`,
      );
      continue;
    }

    // A build variable's whole decision lives here, and the branch returns
    // rather than falling through to the generic config rule below. Emitting
    // both would tell the author to classify it `secret` and, in the same run,
    // that a build variable cannot be secret, with no stated way out.
    if (catalogued.consumers.includes('build')) {
      if (bundleCredentialShaped(e.env)) {
        errors.push(
          `${e.env}: a build-time variable must not be credential material. Vite bundles the value into the browser, so no chart surface can protect it and NON_SECRET_NAME_ALLOWLIST does not apply. Read the credential at runtime through the api instead.`,
        );
      } else if (e.kind === 'secret') {
        errors.push(
          `${e.env}: a build-time variable cannot be secret. Vite stamps the value into the web bundle, so it reaches every browser whichever chart surface holds it. Classify it \`config\` in ENV_CATALOGUE.`,
        );
      } else if (credentialShaped(e.env)) {
        errors.push(
          `${e.env}: a build-time connection-string name has one legal resolution, NON_SECRET_NAME_ALLOWLIST. \`kind: 'secret'\` is rejected for a build variable, so the config error is not a second option. Before allowlisting, confirm the value carries no userinfo and no token in its path: Vite stamps it verbatim into the browser bundle.`,
        );
      }
      continue;
    }

    if (e.kind === 'config' && credentialShaped(e.env)) {
      errors.push(
        `${e.env}: name is credential-shaped but classified \`config\`. Set \`kind: 'secret'\` in ENV_CATALOGUE, or add it to NON_SECRET_NAME_ALLOWLIST with the reason its value carries no credential.`,
      );
    }
  }

  if (entries.length < ENV_CONTRACT_FLOOR) {
    errors.push(
      `built only ${entries.length} entries, expected at least ${ENV_CONTRACT_FLOOR}. Likely an ENV_CATALOGUE import failure or a catalogue regression. If the catalogue really shrank this far, lower ENV_CONTRACT_FLOOR in the same change.`,
    );
  }
  return errors;
};
