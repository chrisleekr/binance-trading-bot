import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';

// The extensibility doc is the canonical prose home of the plugin contract,
// and packages/strategy/core is the canonical type home. This guard fails the
// build when the two drift in the one way that misleads a strategy author: the
// doc naming a Decision variant the union does not expose, or re-stubbing the
// page. CLAUDE.md names this file the contract reference; the title must render.

const here = fileURLToPath(new URL('.', import.meta.url));
const read = (rel: string) => readFileSync(fileURLToPath(new URL(rel, import.meta.url)), 'utf8');

const decisionSrc = read('../src/decision.ts');
const contractSrc = read('../src/contract.ts');
const doc = read('../../../../docs/architecture/extensibility.md');

// The Decision-union variant literals as they actually compile, scraped from
// the union body so the doc is checked against the code, not a transcription.
const unionBody = decisionSrc.slice(decisionSrc.indexOf('export type Decision'));
const actualVariants = [...unionBody.matchAll(/readonly type: '([a-z-]+)'/g)].map((m) => m[1]);

describe('extensibility.md stays in sync with the strategy-core contract', () => {
  it('scrapes the real Decision variants (guards the scraper itself)', () => {
    expect(new Set(actualVariants)).toEqual(
      new Set(['noop', 'place-order', 'cancel-order', 'emit-event', 'set-kv', 'delete-kv']),
    );
    expect(here).toContain('strategy');
  });

  it('renders a correct title and is no longer a stub', () => {
    expect(doc.split('\n')[0]).toBe('# Extensibility');
    expect(doc).not.toMatch(/uextensibility/);
    expect(doc).not.toMatch(/Stub page/i);
  });

  it('documents every Decision variant the union exposes', () => {
    for (const v of actualVariants) expect(doc).toContain(`\`${v}\``);
  });

  it('keeps the load-bearing contract sections and authoritative anchors', () => {
    // Pins the structural promises (issue #384 criteria 1 and 4) so a future
    // edit that guts a section fails loudly instead of silently re-stubbing.
    for (const anchor of [
      '## The Strategy interface',
      '## Capabilities',
      'operatorActions',
      '## The Decision union',
      '## State-adapter seams',
      '## Adding a strategy',
      'packages/contracts/src/operator-actions.ts',
      'buildStrategyRegistry',
      'replayFixture',
    ]) {
      expect(doc, `missing anchor: ${anchor}`).toContain(anchor);
    }
  });

  it('documents the cross-symbol KV variants as shipped, not planned', () => {
    // set-kv / delete-kv landed with tracker #267; the doc must describe the
    // read side and the opt-in, and must not still flag the seam unshipped near
    // any KV mention (the inverse of the old "annotate as planned" guard).
    expect(doc).toContain('profileKv');
    expect(doc).toContain('needsProfileKv');
    for (const m of doc.matchAll(/\bset-kv\b|\bdelete-kv\b/g)) {
      const window = doc.slice(Math.max(0, m.index - 160), m.index + 240);
      expect(
        /\bnot yet\b|\bplanned\b/i.test(window),
        `stale "planned" near a shipped KV variant: ${window.slice(0, 80)}`,
      ).toBe(false);
    }
    // The contract type must expose the read field consumers depend on.
    expect(contractSrc).toContain('readonly profileKv?');
  });
});
