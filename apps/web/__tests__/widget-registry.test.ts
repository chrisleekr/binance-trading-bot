import { describe, it, expect } from 'vitest';

import { widgetRegistry, lookupWidget } from '@/shared/forms/widgetRegistry';

describe('widgetRegistry', () => {
  it('returns null for unknown hints so the renderer can fall back', () => {
    expect(lookupWidget('does-not-exist')).toBeNull();
    expect(lookupWidget('')).toBeNull();
    expect(lookupWidget(null)).toBeNull();
    expect(lookupWidget(undefined)).toBeNull();
  });

  it('returns the registered component for every known hint', () => {
    for (const hint of Object.keys(widgetRegistry)) {
      expect(lookupWidget(hint)).toBe(widgetRegistry[hint]);
    }
  });
});
