import { readdirSync, readFileSync } from 'node:fs';
import { join, relative } from 'node:path';

// A test file is infra-gated when it reads one of these — `HAS_INFRA` /
// `HAS_REDIS` from `_helpers.ts`, or the env vars those derive from. Counting
// every `.test.ts` instead would roughly double the reported figure and
// contradict vitest's own "N skipped" summary printed a few lines later.
const INFRA_GATE =
  /\bHAS_INFRA\b|\bHAS_REDIS\b|\bTESTCONTAINERS\b|\bDATABASE_TEST_URL\b|\bREDIS_TEST_URL\b/;

/**
 * Walks `__tests__` and returns the paths, relative to it, of the suites that
 * gate themselves on test infrastructure. Returns null when the walk fails, so
 * the banner can degrade to a wordy count rather than assert a wrong number.
 */
export function findInfraGatedTests(): string[] | null {
  const root = import.meta.dirname;
  try {
    const found: string[] = [];
    const stack = [root];
    while (stack.length > 0) {
      const dir = stack.pop()!;
      for (const entry of readdirSync(dir, { withFileTypes: true })) {
        const full = join(dir, entry.name);
        if (entry.isDirectory()) {
          stack.push(full);
        } else if (entry.name.endsWith('.test.ts') && INFRA_GATE.test(readFileSync(full, 'utf8'))) {
          found.push(relative(root, full));
        }
      }
    }
    return found;
  } catch {
    return null;
  }
}

function printSkipBanner() {
  const hasInfra =
    Boolean(process.env['DATABASE_TEST_URL']) || process.env['TESTCONTAINERS'] === '1';
  if (hasInfra) return;

  const gated = findInfraGatedTests();
  const count = gated === null ? 'many' : `~${gated.length}`;
  const sep = '━'.repeat(100);
  const msg = [
    sep,
    'INFRA UNAVAILABLE — integration test files skipped (HAS_INFRA is false)',
    `   ${count} test files gated behind DATABASE_TEST_URL or TESTCONTAINERS=1`,
    '   These suites cover: auth, cross-account, routes, dashboard, backtests,',
    '   archive, backup-config, account-settings, discovery, dust-transfer,',
    '   gate-status, live-demo, manual-orders, notify-providers, ops-notify,',
    '   orphan-orders, override, profiles, profile-lint, research-removed, risk,',
    '   save-feasibility, symbols, more.',
    '   Set DATABASE_TEST_URL + REDIS_TEST_URL for a running dev stack, or',
    '   TESTCONTAINERS=1 to auto-provision (Docker required).',
    '   CI covers this lane in a separate Postgres job.',
    '   TURBO WILL REPORT GREEN — do not trust the top-level green alone.',
    sep,
  ];

  process.stderr.write(`\n${msg.join('\n')}\n\n`);
}

export function setup() {
  printSkipBanner();
}
