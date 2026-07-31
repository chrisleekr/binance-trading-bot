import { describe, expect, it } from 'vitest';

import {
  RECOMMENDATION_LABEL,
  RECOMMENDATION_TONE,
  RECOMMENDATION_VARIANT,
  recommendationLabel,
  recommendationTone,
} from '../src/shared/lib/technicals-format';

describe('technicals-format', () => {
  it('humanizes every recommendation tier', () => {
    expect(RECOMMENDATION_LABEL.STRONG_BUY).toBe('Strong buy');
    expect(RECOMMENDATION_LABEL.BUY).toBe('Buy');
    expect(RECOMMENDATION_LABEL.NEUTRAL).toBe('Neutral');
    expect(RECOMMENDATION_LABEL.SELL).toBe('Sell');
    expect(RECOMMENDATION_LABEL.STRONG_SELL).toBe('Strong sell');
  });

  it('maps every tier to a badge variant', () => {
    expect(RECOMMENDATION_VARIANT.STRONG_BUY).toBe('up');
    expect(RECOMMENDATION_VARIANT.BUY).toBe('up');
    expect(RECOMMENDATION_VARIANT.NEUTRAL).toBe('outline');
    expect(RECOMMENDATION_VARIANT.SELL).toBe('down');
    expect(RECOMMENDATION_VARIANT.STRONG_SELL).toBe('down');
  });

  it('maps every tier to a text tone', () => {
    expect(RECOMMENDATION_TONE.STRONG_BUY).toBe('text-up');
    expect(RECOMMENDATION_TONE.BUY).toBe('text-up');
    expect(RECOMMENDATION_TONE.NEUTRAL).toBe('text-muted-fg');
    expect(RECOMMENDATION_TONE.SELL).toBe('text-down');
    expect(RECOMMENDATION_TONE.STRONG_SELL).toBe('text-down');
  });

  describe('lenient lookups for untyped audit payloads', () => {
    it('labels a known token and falls back to the raw token otherwise', () => {
      expect(recommendationLabel('STRONG_SELL')).toBe('Strong sell');
      expect(recommendationLabel('FUTURE_TIER')).toBe('FUTURE_TIER');
      expect(recommendationLabel(null)).toBe('unknown');
      expect(recommendationLabel(42)).toBe('unknown');
    });

    it('tones a known token and stays muted for unknown or non-string input', () => {
      expect(recommendationTone('BUY')).toBe('text-up');
      expect(recommendationTone('FUTURE_TIER')).toBe('text-muted-fg');
      expect(recommendationTone(undefined)).toBe('text-muted-fg');
    });
  });
});
