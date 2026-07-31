import { readdirSync, readFileSync, statSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it, vi } from 'vitest';

// Filesystem-walking guard test: generous headroom so CI coverage +
// parallel-suite contention on the fs walk cannot trip the test-level timeout.
vi.setConfig({ testTimeout: 30_000 });

// Static guard: the strategy's sell-sizing paths must read `state.heldQuantity`
// (via `resolveHeldForSell`) rather than treating `avgEntryPrice.quantity`
// — the LBP row's qty column — as a sell-sizing source.
//
// `avgEntryPrice.quantity` is still written for audit (the entry buy size)
// and is read by the fill-adopter to apply weighted-average + remainder
// math. Any read in strategy or worker code OUTSIDE the fill-adopter is a
// regression of issue #243 and silently re-introduces wallet/state drift.
//
// This test is intentionally a literal-string scan rather than a full AST
// traversal: the offending shapes are narrow enough that a substring grep
// catches every realistic regression, and the test stays fast and
// dependency-free.

const HERE = dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = resolve(HERE, '..', '..', '..', '..');

const FORBIDDEN_NEEDLES = [
  'avgEntryPrice.quantity',
  "avgEntryPrice['quantity']",
  'avgEntryPrice["quantity"]',
];

// Paths the rule does NOT apply to:
//   - the fill-adopter, which owns the LBP-row math (the *write* path)
//   - the LBP row schema / repo definitions
//   - tests (assert on the field directly)
const ALLOWED_PATHS = ['apps/worker/src/executor/fill-adopter.ts', 'packages/db/', '__tests__/'];

const SCAN_ROOTS = [
  join(REPO_ROOT, 'packages', 'strategy'),
  join(REPO_ROOT, 'apps', 'worker', 'src'),
  join(REPO_ROOT, 'apps', 'api', 'src'),
  join(REPO_ROOT, 'apps', 'web', 'src'),
];

const isAllowed = (path: string): boolean => ALLOWED_PATHS.some((p) => path.includes(p));

const walk = (dir: string, out: string[]): void => {
  let entries: string[];
  try {
    entries = readdirSync(dir);
  } catch {
    return;
  }
  for (const entry of entries) {
    if (entry === 'node_modules' || entry.startsWith('.')) continue;
    const full = join(dir, entry);
    let st;
    try {
      st = statSync(full);
    } catch {
      continue;
    }
    if (st.isDirectory()) {
      walk(full, out);
      continue;
    }
    if (/\.(ts|tsx)$/.test(entry)) out.push(full);
  }
};

describe('issue #243 — avgEntryPrice.quantity is not a sell-sizing source', () => {
  it('no app or strategy file reads `avgEntryPrice.quantity` outside the fill-adopter', () => {
    const offenders: { path: string; needle: string }[] = [];
    for (const root of SCAN_ROOTS) {
      const files: string[] = [];
      walk(root, files);
      for (const file of files) {
        if (isAllowed(file)) continue;
        const text = readFileSync(file, 'utf8');
        for (const needle of FORBIDDEN_NEEDLES) {
          if (text.includes(needle)) offenders.push({ path: file, needle });
        }
      }
    }
    expect(offenders).toEqual([]);
  });
});
