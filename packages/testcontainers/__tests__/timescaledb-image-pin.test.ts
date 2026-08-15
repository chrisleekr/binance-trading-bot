import { readFileSync } from 'node:fs';

import { describe, expect, it } from 'vitest';

const read = (rel: string): string => readFileSync(new URL(rel, import.meta.url), 'utf8');

const productionCompose = read('../../../deploy/compose/docker-compose.prod.yml');
const testcontainersSource = read('../src/index.ts');

const postgresService = productionCompose.match(
  /^  postgres:\n(?<body>[\s\S]*?)(?=^  \S|(?![\s\S]))/m,
)?.groups?.['body'];
const productionImage = postgresService?.match(/^    image:\s*(\S+)\s*$/m)?.[1];
const testcontainersImage = testcontainersSource.match(
  /const POSTGRES_IMAGE\s*=\s*['"]([^'"]+)['"]/,
)?.[1];

const PINNED = /timescale\/timescaledb:\S+@sha256:[0-9a-f]{64}/g;

// Scoped to the `db-isolation` job, not the whole file: the other jobs run a bare `latest-pg17` on purpose, and a file-wide match would let db-isolation lose its pin while some other job's pinned reference kept these assertions green. GitHub indents its jobs two spaces and GitLab none, so the block is captured off whatever indent `db-isolation:` itself sits at.
const dbIsolationPins = (source: string): readonly string[] =>
  source
    .match(/^(?<indent> *)db-isolation:\n(?<body>[\s\S]*?)(?=^\k<indent>\S|(?![\s\S]))/m)
    ?.groups?.['body']?.match(PINNED) ?? [];

const ciPins = [
  ['.github/workflows/ci.yml', '../../../.github/workflows/ci.yml'],
  ['.gitlab-ci.yml', '../../../.gitlab-ci.yml'],
].map(([label, rel]) => [label, dbIsolationPins(read(rel as string))] as const);

describe('TimescaleDB image pin', () => {
  it('keeps the production and testcontainers image references identical', () => {
    expect(productionImage).toBeDefined();
    expect(testcontainersImage).toBe(productionImage);
  });

  // `latest-pg17` is what the reference must NOT be: this one boots the migration replay, and a floating tag silently walks it past the 2.28.0 root-heap change the fixture depends on.
  it('spells the shared image with an explicit version and a SHA-256 digest', () => {
    expect(productionImage).toMatch(
      /^timescale\/timescaledb:\d+\.\d+\.\d+-pg\d+@sha256:[0-9a-f]{64}$/,
    );
  });

  // Whole reference, tag included, not just the digest. Docker resolves by digest, so a stale tag beside a correct digest changes nothing at runtime and misleads every reader — and the reader is the only reason these lanes spell the version out.
  it.each(ciPins)('pins %s db-isolation to exactly the production reference', (_label, pins) => {
    expect(pins).toHaveLength(1);
    expect(pins[0]).toBe(productionImage);
  });

  // Guards the tag TEXT, not the resolved server: Docker pulls by digest, so a digest moved past 2.28.0 under an unchanged tag still passes here. The runtime backstop is `action-logs-root-heap-migration`, which names the server version when it cannot strand a row. What this catches is the cheaper and likelier mistake, copying a pin forward and relabelling it, and when it fires the answer is a separate pin for the migration lanes rather than a relabel.
  it.each([
    ...ciPins.map(([label, pins]) => [label, pins[0]] as const),
    ['compose', productionImage] as const,
  ])('keeps %s below the 2.28.0 root-heap change', (_label, reference) => {
    const version = reference?.match(/:(\d+)\.(\d+)\.\d+-pg\d+@/);
    expect(version).not.toBeNull();
    const [major, minor] = [Number(version?.[1]), Number(version?.[2])];
    expect(major * 1000 + minor).toBeLessThan(2 * 1000 + 28);
  });
});
