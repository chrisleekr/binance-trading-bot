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
const rootHeapMigrationImage = imageFromSource('ROOT_HEAP_MIGRATION_POSTGRES_IMAGE');

const PINNED = /timescale\/timescaledb:\S+@sha256:[0-9a-f]{64}/g;

/**
 * Extracts pins only from `db-isolation`; other jobs intentionally use a moving image and must not satisfy these assertions by accident.
 *
 * Order is significant to the callers below: the job declares the deployed server first and the legacy root-heap fixture second, and asserting them positionally is what catches the two being swapped — a swap that would otherwise leave both references present and every test here green while the migration lane silently ran on the old server again.
 *
 * @param source - A GitHub Actions or GitLab CI configuration.
 * @returns Every pinned TimescaleDB reference inside that file's `db-isolation` job, in declaration order.
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

  it('keeps the legacy migration fixture separate from the runtime image', () => {
    expect(rootHeapMigrationImage).toMatch(
      /^timescale\/timescaledb:\d+\.\d+\.\d+-pg\d+@sha256:[0-9a-f]{64}$/,
    );
    expect(rootHeapMigrationImage).not.toBe(productionImage);
  });

  // Whole reference, tag included, because the label must describe the digest Docker actually resolves.
  //
  // The db-isolation lane runs `turbo test --filter '@app/db'`, i.e. EVERY migration-replay suite in the package, so its primary server has to be the deployed one. Only the action_logs root-heap fixture needs a pre-2.28.0 server, and it gets a second service of its own rather than pulling the whole lane back with it.
  it.each(ciPins)('runs %s db-isolation on the deployed server', (_label, pins) => {
    expect(pins).toHaveLength(2);
    expect(pins[0]).toBe(productionImage);
  });

  it.each(ciPins)('gives %s db-isolation a separate legacy fixture service', (_label, pins) => {
    expect(pins[1]).toBe(rootHeapMigrationImage);
  });

  // Guards the tag text cheaply; the root-heap migration test verifies the resolved server's behavior at runtime. Only the legacy references are bounded — the deployed pin must stay free to move past 2.28.0, which is the whole point of the split.
  it.each([
    ...ciPins.map(([label, pins]) => [label, pins[1]] as const),
    ['Testcontainers legacy fixture', rootHeapMigrationImage] as const,
  ])('keeps %s below the 2.28.0 root-heap change', (_label, reference) => {
    const version = reference?.match(/:(\d+)\.(\d+)\.\d+-pg\d+@/);
    expect(version).not.toBeNull();
    const [major, minor] = [Number(version?.[1]), Number(version?.[2])];
    expect(major * 1000 + minor).toBeLessThan(2 * 1000 + 28);
  });
});
