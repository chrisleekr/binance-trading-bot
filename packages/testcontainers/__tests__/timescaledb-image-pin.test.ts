import { readFileSync } from 'node:fs';

import { describe, expect, it } from 'vitest';

const productionCompose = readFileSync(
  new URL('../../../deploy/compose/docker-compose.prod.yml', import.meta.url),
  'utf8',
);
const testcontainersSource = readFileSync(new URL('../src/index.ts', import.meta.url), 'utf8');

const postgresService = productionCompose.match(
  /^  postgres:\n(?<body>[\s\S]*?)(?=^  \S|(?![\s\S]))/m,
)?.groups?.['body'];
const productionImage = postgresService?.match(/^    image:\s*(\S+)\s*$/m)?.[1];
const testcontainersImage = testcontainersSource.match(
  /const POSTGRES_IMAGE\s*=\s*['"]([^'"]+)['"]/,
)?.[1];

// Both CI lanes run the same migration-replay job, and its root-heap fixture only
// builds below TimescaleDB 2.28.0. Digest-pinned references are the ones claiming
// to be that server; the bare `latest-pg17` services in the other jobs float on
// purpose and are not matched here.
const ciDigestPins = ['../../../.github/workflows/ci.yml', '../../../.gitlab-ci.yml'].map(
  (rel) =>
    [
      rel,
      readFileSync(new URL(rel, import.meta.url), 'utf8').match(
        /timescale\/timescaledb:\S+@sha256:[0-9a-f]{64}/g,
      ),
    ] as const,
);

describe('TimescaleDB image pin', () => {
  it('keeps the production and testcontainers image references identical', () => {
    expect(productionImage).toBeDefined();
    expect(testcontainersImage).toBe(productionImage);
  });

  it('keeps the shared image on latest-pg17 with a SHA-256 digest', () => {
    expect(productionImage).toMatch(/^timescale\/timescaledb:latest-pg17@sha256:[0-9a-f]{64}$/);
  });

  // The tag is documentation and differs between compose and CI; the digest is what
  // actually resolves, so it is the digest the lanes have to agree on.
  it.each(ciDigestPins)('pins %s to the production digest', (_rel, pins) => {
    const productionDigest = productionImage?.split('@')[1];
    expect(productionDigest).toMatch(/^sha256:[0-9a-f]{64}$/);
    expect(pins).not.toBeNull();
    for (const pin of pins ?? []) expect(pin.split('@')[1]).toBe(productionDigest);
  });

  // The digest is what boots, so a wrong tag beside a right digest changes nothing
  // at runtime and everything for the reader — and the reader is the only reason
  // the CI lanes spell the version out at all.
  it('keeps both CI lanes on one reference, tag included', () => {
    const [github, gitlab] = ciDigestPins.map(([, pins]) => pins);
    expect(github).toEqual(gitlab);
  });

  // Guards the tag TEXT, not the resolved server: Docker pulls by digest, so a
  // digest moved past 2.28.0 under an unchanged tag still passes here. The
  // runtime backstop is `action-logs-root-heap-migration`, which names the server
  // version when it cannot strand a row. What this catches is the cheaper and
  // likelier mistake — copying the compose pin forward and relabelling it — and
  // when it fires the answer is a separate pin for the migration lanes, not a
  // relabel.
  it('keeps the CI lane tags below the 2.28.0 root-heap change', () => {
    for (const [, pins] of ciDigestPins) {
      for (const pin of pins ?? []) {
        const version = pin.match(/:(\d+)\.(\d+)\.\d+-pg\d+@/);
        expect(version).not.toBeNull();
        const [major, minor] = [Number(version?.[1]), Number(version?.[2])];
        expect(major * 1000 + minor).toBeLessThan(2 * 1000 + 28);
      }
    }
  });
});
