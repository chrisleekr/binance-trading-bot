import { readdirSync, readFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it, vi } from 'vitest';

// Filesystem-walking guard test: generous headroom so CI coverage +
// parallel-suite contention on the fs walk cannot trip the test-level timeout.
vi.setConfig({ testTimeout: 30_000 });

// `orders.intent` is intentionally an OPEN, strategy-owned string: each
// strategy names its own intents (TT: grid-buy/grid-sell/...; momentum:
// entry/exit), so a second strategy's orders must not be rejected at insert.
// Migration 0026 dropped the closed `orders_intent_chk` CHECK, which also
// retired the #352 drift class (a CHECK that diverged from the @app/contracts
// enum crashed the executor on the bookkeeping insert).
//
// This test guards the invariant in the only direction that can still break
// it: re-introducing a closed CHECK. It replays the migrations and asserts the
// freshly-migrated database ends up with NO `orders_intent_chk` constraint.

const HERE = dirname(fileURLToPath(import.meta.url));
const MIGRATIONS_DIR = resolve(HERE, '..', 'migrations');

/**
 * Replays the migrations in lexicographic apply-order and returns whether an
 * `orders_intent_chk` CHECK constraint exists in the final state. Each
 * statement that establishes the constraint (`... constraint orders_intent_chk
 * check (...)`, inline or via ALTER ADD) sets it present; each `drop
 * constraint orders_intent_chk` sets it absent.
 */
function ordersIntentCheckPresentAfterMigrations(): boolean {
  const files = readdirSync(MIGRATIONS_DIR)
    .filter((n) => n.endsWith('.sql'))
    .sort();
  const addRe = /constraint\s+orders_intent_chk\s+check\b/gi;
  const dropRe = /drop\s+constraint\s+(?:if\s+exists\s+)?orders_intent_chk\b/gi;
  let present = false;
  for (const name of files) {
    const body = readFileSync(join(MIGRATIONS_DIR, name), 'utf8');
    // Walk the statements in file order so add-then-drop within one file
    // resolves correctly. Statements are semicolon-delimited.
    for (const stmt of body.split(';')) {
      if (dropRe.test(stmt)) present = false;
      else if (addRe.test(stmt)) present = true;
      addRe.lastIndex = 0;
      dropRe.lastIndex = 0;
    }
  }
  return present;
}

describe('orders.intent is an open, strategy-owned vocabulary', () => {
  it('the migrated schema has no closed orders_intent_chk CHECK', () => {
    // If this fails, a migration re-introduced a closed intent enum. Don't:
    // it rejects other strategies' orders at insert and resurrects the #352
    // executor crash. Validate intents in the strategy, not the DB.
    expect(ordersIntentCheckPresentAfterMigrations()).toBe(false);
  });
});
