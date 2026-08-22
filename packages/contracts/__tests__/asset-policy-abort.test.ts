// The copy is the whole feature: an operator whose coin list stopped moving is told which upstream fault stopped it, in words that mean something without this repo open. A cause that reaches the page as its own enum literal is the failure these cases exist to catch.

import { describe, expect, it } from 'vitest';
import {
  ASSET_POLICY_ABORT_CAUSES,
  ASSET_POLICY_ABORT_CAUSE_COPY,
  assetPolicyAbortRecordSchema,
} from '../src/asset-policy-abort.js';

describe('ASSET_POLICY_ABORT_CAUSE_COPY', () => {
  // Derived from the array, never a hand-listed set: a cause added to the union arrives here as a failing case rather than as a finding whose detail is undefined.
  it.each(ASSET_POLICY_ABORT_CAUSES)('gives %s a sentence an operator can act on', (cause) => {
    const copy = ASSET_POLICY_ABORT_CAUSE_COPY[cause];
    expect(copy.length).toBeGreaterThan(60);
    // The literal is already the item's `code`. Repeating it in the prose is the placeholder tell, and it is exactly what the finding must not read as.
    expect(copy).not.toContain(cause);
    expect(copy.trim()).toBe(copy);
  });

  it('says something different for each cause, because each has a different remedy', () => {
    // A dead classification route is a schema change to chase at Binance; a cold admission map is local and self-healing. One shared sentence would send the operator to the wrong one half the time.
    const sentences = ASSET_POLICY_ABORT_CAUSES.map((c) => ASSET_POLICY_ABORT_CAUSE_COPY[c]);
    expect(new Set(sentences).size).toBe(ASSET_POLICY_ABORT_CAUSES.length);
  });
});

describe('assetPolicyAbortRecordSchema', () => {
  it('accepts the record the discovery cron parks', () => {
    const parsed = assetPolicyAbortRecordSchema.parse({
      cause: 'cross-check-gap',
      atMs: 1_700_000_000_000,
    });
    expect(parsed.cause).toBe('cross-check-gap');
  });

  it('rejects a cause outside the union', () => {
    // The value is a plain Redis string that outlives any deploy, so an older worker's vocabulary must degrade to "no abort recorded" rather than reach the copy lookup, which has no fallback and would hand the page `undefined`.
    expect(assetPolicyAbortRecordSchema.safeParse({ cause: 'tag-moved', atMs: 1 }).success).toBe(
      false,
    );
  });
});
