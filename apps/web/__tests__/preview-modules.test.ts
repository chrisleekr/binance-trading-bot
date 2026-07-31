// The lazy per-strategy preview loader map. Guards two things the `as` casts in
// preview-modules.ts would otherwise let regress silently: every registered
// strategy resolves to a module whose previewLevels/previewDataNeeds are real
// functions (a renamed export would be a runtime-only blank preview), and a
// prototype key ('constructor') never resolves to an Object member.

import { describe, expect, it } from 'vitest';

import {
  hasPreviewModule,
  loadPreviewModule,
} from '../src/features/symbol/preview/preview-modules.js';

const STRATEGIES = ['trailing-trade', 'momentum', 'rebalance'] as const;

describe('loadPreviewModule — resolution', () => {
  it.each(STRATEGIES)('resolves %s to a module exposing both preview functions', async (name) => {
    const mod = await loadPreviewModule(name);
    expect(typeof mod.previewLevels).toBe('function');
    expect(typeof mod.previewDataNeeds).toBe('function');
  });

  it('rejects for an unregistered strategy', async () => {
    await expect(loadPreviewModule('no-such')).rejects.toThrow('no preview module');
  });
});

describe('hasPreviewModule / loadPreviewModule — prototype-key hardening', () => {
  it('treats a prototype-chain key as absent, not an Object member', async () => {
    expect(hasPreviewModule('constructor')).toBe(false);
    expect(hasPreviewModule('toString')).toBe(false);
    await expect(loadPreviewModule('constructor')).rejects.toThrow('no preview module');
  });

  it('recognises a real registered strategy', () => {
    expect(hasPreviewModule('trailing-trade')).toBe(true);
  });
});
