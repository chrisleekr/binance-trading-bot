// Pins the banner's file count to the suites that are actually infra-gated.
// The first cut counted every `.test.ts` under `__tests__` and reported ~65 of
// 66 files as skipped, when 30 of them run fine without Postgres — a warning
// that overstates by ~2x is the same untrustworthy signal the banner exists to
// replace, so anchor it to a file that must be counted and one that must not.

import { readdirSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';

import { findInfraGatedTests } from './global-setup.js';

function allTestFiles(dir: string): string[] {
  return readdirSync(dir, { withFileTypes: true }).flatMap((entry) =>
    entry.isDirectory()
      ? allTestFiles(join(dir, entry.name))
      : entry.name.endsWith('.test.ts')
        ? [join(dir, entry.name)]
        : [],
  );
}

describe('infra-gated test discovery', () => {
  const gated = findInfraGatedTests();

  it('counts the suites that gate on infra, not every test file', () => {
    expect(gated).not.toBeNull();
    expect(gated!.length).toBeGreaterThan(0);
    expect(gated!.length).toBeLessThan(allTestFiles(import.meta.dirname).length * 0.75);
  });

  it('includes a Postgres-backed route suite and excludes a pure-unit one', () => {
    expect(gated).toContain(join('routes', 'profiles.test.ts'));
    expect(gated).not.toContain(join('routes', 'status-parse.test.ts'));
  });
});
