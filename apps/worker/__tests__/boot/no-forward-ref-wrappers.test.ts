import { readdirSync, readFileSync, statSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it, vi } from 'vitest';

// Filesystem-walking guard test: generous headroom so CI coverage +
// parallel-suite contention on the fs walk cannot trip the test-level timeout.
vi.setConfig({ testTimeout: 30_000 });

// Architectural fitness guard for the worker boot graph.
//
// The two-phase wire (#285) removed the `{ current: T | null }` forward-ref
// wrappers that the boot DI graph used to collapse construction-order
// cycles. Those wrappers degraded a wiring mistake into either a runtime
// `"not initialised"` throw or — worse — a silent `ref.current?.` no-op.
// Genuine back-edges are now closed by typed setters (KlineFetcher
// .setOnReconnect, ProfileManager.setMarket) called in a dedicated Phase 3
// block.
//
// This test fails if a forward-ref wrapper creeps back into boot/**. The
// signal is a local typed as a single-field mutable holder of a nullable
// value, i.e. `: { current: <Type> | null }`. Matching on the type
// annotation (not the value) keeps it robust against formatting.

const HERE = dirname(fileURLToPath(import.meta.url));
const BOOT_DIR = resolve(HERE, '..', '..', 'src', 'boot');

const tsFiles = (dir: string): string[] => {
  const out: string[] = [];
  for (const entry of readdirSync(dir)) {
    const full = join(dir, entry);
    if (statSync(full).isDirectory()) {
      out.push(...tsFiles(full));
    } else if (entry.endsWith('.ts')) {
      out.push(full);
    }
  }
  return out;
};

// `{ current: <something> | null }` as a type annotation, whitespace-
// tolerant and permitting one level of nested braces in the inner type
// (e.g. `Map<K, V>` is brace-free, but `{ port: X } | null` is not).
const FORWARD_REF_TYPE = /\{\s*current:\s*(?:[^{}]|\{[^{}]*\})*\|\s*null\s*\}/;

describe('boot graph has no forward-ref wrappers', () => {
  it('no `{ current: T | null }` holder type appears under src/boot', () => {
    const offenders: string[] = [];
    for (const file of tsFiles(BOOT_DIR)) {
      const src = readFileSync(file, 'utf8');
      src.split('\n').forEach((line, i) => {
        if (FORWARD_REF_TYPE.test(line)) {
          offenders.push(`${file.slice(BOOT_DIR.length + 1)}:${i + 1}  ${line.trim()}`);
        }
      });
    }
    expect(
      offenders,
      `Forward-ref wrappers are banned in boot/**. Use a typed setter for the back-edge ` +
        `(see KlineFetcher.setOnReconnect / ProfileManager.setMarket). Offenders:\n${offenders.join('\n')}`,
    ).toEqual([]);
  });
});
