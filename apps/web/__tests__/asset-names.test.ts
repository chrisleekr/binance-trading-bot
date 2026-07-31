import { describe, expect, it } from 'vitest';

import { assetName } from '../src/shared/lib/asset-names';

describe('assetName', () => {
  it('returns the mapped full name for a known ticker', () => {
    expect(assetName('BTC')).toBe('Bitcoin');
  });

  it('falls back to the ticker itself for an unmapped ticker', () => {
    expect(assetName('FOOBAR')).toBe('FOOBAR');
  });
});
