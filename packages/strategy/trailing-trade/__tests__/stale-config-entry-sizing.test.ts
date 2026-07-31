import { describe, expect, it } from 'vitest';
import { TTConfigSchema, defaultTTConfig } from '../src/schema.js';

// A config stored BEFORE `buy.entrySizing` shipped (v1: only `buy.maxPurchaseAmount`)
// must still parse, so a stale profile can be backtested instead of erroring on
// `buy.entrySizing: expected object, received undefined`. The forward-compat
// default fills it; a grid profile ignores the block anyway.
describe('forward-compat: stale TT config missing buy.entrySizing', () => {
  it('parses with a defaulted entrySizing instead of throwing', () => {
    const stale = defaultTTConfig() as Record<string, unknown>;
    const buy = { ...(stale.buy as Record<string, unknown>) };
    delete buy.entrySizing;
    // Mimic a v1 config: a single buy-level maxPurchaseAmount (no entrySizing).
    (buy as Record<string, unknown>).maxPurchaseAmount = '20';
    const result = TTConfigSchema.safeParse({ ...stale, buy });
    expect(result.success).toBe(true);
    if (result.success) {
      expect(result.data.buy.entrySizing).toEqual({ mode: 'fixed', amount: '15', percent: '' });
    }
  });

  it('leaves an explicit entrySizing untouched', () => {
    const cfg = defaultTTConfig() as Record<string, unknown>;
    const buy = {
      ...(cfg.buy as Record<string, unknown>),
      entrySizing: { mode: 'percentOfAccount', amount: '', percent: '0.02' },
    };
    const result = TTConfigSchema.safeParse({ ...cfg, buy });
    expect(result.success).toBe(true);
    if (result.success) {
      expect(result.data.buy.entrySizing.mode).toBe('percentOfAccount');
      expect(result.data.buy.entrySizing.percent).toBe('0.02');
    }
  });
});
