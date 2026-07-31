// Design-system guard: the micro-label tier (uppercase, letter-spaced section
// labels, table column headers, status chips) is defined as 11-12px in
// DESIGN.md ("buttons, badges, table column headers, nav items, and panel
// micro-labels are uppercase, 11-12px, letter-spaced"). `text-[10px]` drifts
// below that floor, so it is banned in shipped source — keeping the rendered
// tier conformant and preventing silent re-drift.

import { existsSync, readdirSync, readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

import { describe, expect, it, vi } from 'vitest';

// Filesystem-walking guard test: generous headroom so CI coverage +
// parallel-suite contention on the fs walk cannot trip the test-level timeout.
vi.setConfig({ testTimeout: 30_000 });

// Resolve `src` relative to this test file, not `process.cwd()`. `turbo test`
// runs with cwd = apps/web, but an ad-hoc `vitest run --root apps/web` from the
// repo root leaves cwd at the repo root — a cwd-based path would then miss and
// the guard would silently pass. This file lives in apps/web/__tests__, so src
// is one level up.
const SRC = join(dirname(fileURLToPath(import.meta.url)), '..', 'src');

function walk(dir: string): string[] {
  return readdirSync(dir, { withFileTypes: true }).flatMap((entry) => {
    const full = join(dir, entry.name);
    if (entry.isDirectory()) return entry.name === '__tests__' ? [] : walk(full);
    return /\.(tsx?)$/.test(entry.name) ? [full] : [];
  });
}

describe('design-system: micro-label size floor', () => {
  it('no web source uses text-[10px] (DESIGN.md micro-labels are 11-12px)', () => {
    expect(existsSync(SRC)).toBe(true); // guard against a wrong cwd silently passing
    const offenders = walk(SRC)
      .filter((file) => readFileSync(file, 'utf8').includes('text-[10px]'))
      .map((file) => file.slice(SRC.length + 1));
    expect(offenders).toEqual([]);
  });
});
