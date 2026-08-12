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

describe('TimescaleDB image pin', () => {
  it('keeps the production and testcontainers image references identical', () => {
    expect(productionImage).toBeDefined();
    expect(testcontainersImage).toBe(productionImage);
  });

  it('keeps the shared image on latest-pg17 with a SHA-256 digest', () => {
    expect(productionImage).toMatch(/^timescale\/timescaledb:latest-pg17@sha256:[0-9a-f]{64}$/);
  });
});
