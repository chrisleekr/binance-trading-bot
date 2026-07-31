import { describe, expect, it } from 'vitest';
import { Decimal } from '@app/money';
import { baseAssetHeld } from '../../../src/crons/discovery/held.js';

describe('baseAssetHeld', () => {
  const wallet = (over: Record<string, string>): Record<string, Decimal> =>
    Object.fromEntries(Object.entries(over).map(([k, v]) => [k, new Decimal(v)]));

  it('is held when the balance is at or above minQty', () => {
    expect(baseAssetHeld(wallet({ WLD: '29.2' }), 'WLD', '1')).toBe(true);
  });

  it('is held exactly at the minQty boundary', () => {
    expect(baseAssetHeld(wallet({ WLD: '1' }), 'WLD', '1')).toBe(true);
  });

  it('is not held when the balance is below minQty', () => {
    expect(baseAssetHeld(wallet({ WLD: '0.5' }), 'WLD', '1')).toBe(false);
  });

  it('is not held when the asset is absent from the wallet', () => {
    expect(baseAssetHeld(wallet({ BTC: '1' }), 'WLD', '1')).toBe(false);
  });

  it('throws on a non-numeric minQty so the caller can fail safe', () => {
    expect(() => baseAssetHeld(wallet({ WLD: '5' }), 'WLD', 'not-a-number')).toThrow();
  });
});
