import { readdirSync, readFileSync, statSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it, vi } from 'vitest';

// Filesystem-walking guard test: generous headroom so CI coverage +
// parallel-suite contention on the fs walk cannot trip the test-level timeout.
vi.setConfig({ testTimeout: 30_000 });

// Architectural fitness guard for the per-(profile, symbol) serialisation lock.
//
// `chainByKey` is what makes it safe to converge a position from FOUR different
// callers — the tick handler, the fill-adopter, the `symbol-reconcile` queue job,
// and the 15-minute backstop cron. None of them may interleave a state write with
// a live tick on the same symbol.
//
// That guarantee rests entirely on OBJECT IDENTITY: they must all hold the SAME
// `ChainByKey`. Two instances serialise against themselves and not against each
// other, so the lock silently stops meaning anything — and every existing unit
// test still passes, because each one builds its own chain and never observes the
// wiring. A `chain: createChainByKey()` written inside `reconcileDeps` would be
// invisible to the whole suite.
//
// So pin the structural fact instead: the worker mints exactly ONE chain, in the
// chain builder, and every consumer is handed that binding.

const HERE = dirname(fileURLToPath(import.meta.url));
const SRC_DIR = resolve(HERE, '..', '..', 'src');
// The chain is minted in `builders/chain.ts` and the shared reconcile bag is
// assembled in `builders/reconcile.ts`; the composer threads the binding between
// them. Both call sites are pinned so a fresh chain in either cannot slip in.
const RECONCILE_BUILDER = join(SRC_DIR, 'boot', 'builders', 'reconcile.ts');

const tsFiles = (dir: string): string[] => {
  const out: string[] = [];
  for (const entry of readdirSync(dir)) {
    const full = join(dir, entry);
    if (statSync(full).isDirectory()) out.push(...tsFiles(full));
    else if (entry.endsWith('.ts')) out.push(full);
  }
  return out;
};

describe('the worker has exactly one ChainByKey', () => {
  it('createChainByKey() is called exactly once across src/**, in the chain builder', () => {
    const callSites: string[] = [];
    for (const file of tsFiles(SRC_DIR)) {
      readFileSync(file, 'utf8')
        .split('\n')
        .forEach((line, i) => {
          if (/createChainByKey\s*\(/.test(line)) {
            callSites.push(`${file.slice(SRC_DIR.length + 1)}:${i + 1}`);
          }
        });
    }
    expect(
      callSites,
      'The tick handler, fill-adopter, symbol-reconcile job and backstop cron must all ' +
        'share ONE ChainByKey — a second instance serialises against itself and lets a ' +
        'cron interleave a state write with a live tick on the same symbol. Mint it once ' +
        `in the chain builder and pass the binding. Call sites found:\n${callSites.join('\n')}`,
    ).toEqual(['boot/builders/chain.ts:11']);
  });

  it('reconcileDeps is handed the shared `chain` binding, not a fresh one', () => {
    // The cron and the queue job both reconcile through `reconcileDeps`. If it ever
    // carries its own chain, the reconcile stops being serialised against the tick.
    const src = readFileSync(RECONCILE_BUILDER, 'utf8');
    const reconcileDeps = /const reconcileDeps[^=]*=\s*\{([\s\S]*?)\n {2}\};/.exec(src);
    expect(
      reconcileDeps,
      'could not locate the reconcileDeps object literal in the reconcile builder',
    ).not.toBeNull();

    const body = reconcileDeps?.[1] ?? '';
    // The shorthand `chain,` re-uses the single binding. `chain: createChainByKey()`
    // — or any other expression — does not.
    expect(body).toMatch(/^\s*chain,\s*$/m);
    expect(body).not.toMatch(/chain\s*:/);
  });
});
