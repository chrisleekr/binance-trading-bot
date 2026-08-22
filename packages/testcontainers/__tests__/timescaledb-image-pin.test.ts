import { readFileSync } from 'node:fs';

import { describe, expect, it } from 'vitest';

const read = (rel: string): string => readFileSync(new URL(rel, import.meta.url), 'utf8');

const productionCompose = read('../../../deploy/compose/docker-compose.prod.yml');
const testcontainersSource = read('../src/index.ts');

const postgresService = productionCompose.match(
  /^  postgres:\n(?<body>[\s\S]*?)(?=^  \S|(?![\s\S]))/m,
)?.groups?.['body'];
const productionImage = postgresService?.match(/^    image:\s*(\S+)\s*$/m)?.[1];

/**
 * Reads one named image constant from the Testcontainers source so the test validates the committed configuration rather than importing its own subject.
 *
 * @param name - The source constant whose pinned image is required.
 * @returns The configured image reference, or undefined when the declaration is missing.
 */
const imageFromSource = (name: string): string | undefined =>
  testcontainersSource.match(new RegExp(`const ${name}\\s*=\\s*['"]([^'"]+)['"]`))?.[1];

const testcontainersImage = imageFromSource('POSTGRES_IMAGE');

const PINNED = /timescale\/timescaledb:\S+@sha256:[0-9a-f]{64}/g;

/**
 * Extracts pins only from `db-isolation`; other jobs intentionally use a moving image and must not satisfy these assertions by accident.
 *
 * @param source - A GitHub Actions or GitLab CI configuration.
 * @returns Every pinned TimescaleDB reference inside that file's `db-isolation` job.
 */
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

  it('spells the runtime image with an explicit version and a SHA-256 digest', () => {
    expect(productionImage).toMatch(
      /^timescale\/timescaledb:\d+\.\d+\.\d+-pg\d+@sha256:[0-9a-f]{64}$/,
    );
  });

  // One pin per lane, compared whole so the tag has to describe the digest Docker resolves. The lane runs `turbo test --filter '@app/db'`, i.e. every migration-replay suite in the package, so a second or different service means those suites validate a database nobody deploys.
  it.each(ciPins)('pins %s db-isolation to the deployed image', (_label, pins) => {
    expect(pins).toHaveLength(1);
    expect(pins[0]).toBe(productionImage);
  });
});
