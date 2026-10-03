import { describe, expect, it } from 'vitest';
import { Decimal } from '@app/money';
import { baseAssetHeld } from '../../../src/crons/discovery/held.js';

describe('baseAssetHeld', () => {
  const wallet = (over: Record<string, string>): Record<string, Decimal> =>
    Object.fromEntries(Object.entries(over).map(([k, v]) => [k, new Decimal(v)]));

  describe('the lot-size bound', () => {
    it('is held when the balance is at or above minQty', () => {
      expect(baseAssetHeld(wallet({ WLD: '29.2' }), 'WLD', '1', null, null)).toBe(true);
    });

    it('is held exactly at the minQty boundary', () => {
      expect(baseAssetHeld(wallet({ WLD: '1' }), 'WLD', '1', null, null)).toBe(true);
    });

    it('is not held when the balance is below minQty', () => {
      expect(baseAssetHeld(wallet({ WLD: '0.5' }), 'WLD', '1', null, null)).toBe(false);
    });

    it('is not held when the asset is absent from the wallet', () => {
      expect(baseAssetHeld(wallet({ BTC: '1' }), 'WLD', '1', null, null)).toBe(false);
    });

    it('throws on a non-numeric minQty so the caller can fail safe', () => {
      expect(() =>
        baseAssetHeld(wallet({ WLD: '5' }), 'WLD', 'not-a-number', null, null),
      ).toThrow();
    });
  });

  describe('the order-value bound', () => {
    // The live SHIBUSDT slot that pinned the Momentum profile for 167 consecutive cycles: 1.1 SHIB clears a minQty of 1, and is worth 0.0006% of the 1 USDT NOTIONAL floor. No SELL of it can ever be accepted, so it is not a position.
    it('is not held when the balance clears minQty but is valueless against the order floor', () => {
      expect(baseAssetHeld(wallet({ SHIB: '1.1' }), 'SHIB', '1', '1', '0.00000545')).toBe(false);
    });

    // The live BNBBTC balance: below one minimum order, but 52% of it — the deliberately-small holding the 1% ratio exists to protect. This arm must NOT free it; only the never-traded check may, and that lives in the caller.
    it('is still held when the balance is below one minimum order but not residue', () => {
      expect(
        baseAssetHeld(wallet({ BNB: '0.00566274' }), 'BNB', '0.001', '0.0001', '0.009249'),
      ).toBe(true);
    });

    it('is held just above the 1%-of-one-minimum-order bar', () => {
      // 0.011 units at price 1 against a floor of 1 => 1.1% of one minimum order.
      expect(baseAssetHeld(wallet({ X: '0.011' }), 'X', '0.001', '1', '1')).toBe(true);
    });

    it('is not held just below the 1%-of-one-minimum-order bar', () => {
      // 0.009 units at price 1 against a floor of 1 => 0.9% of one minimum order.
      expect(baseAssetHeld(wallet({ X: '0.009' }), 'X', '0.001', '1', '1')).toBe(false);
    });
  });

  describe('fails safe on each missing input independently', () => {
    // One injection per input. A single test that dropped both would pass on either guard alone and leave the other deletable.
    it('stays held when only the price is missing', () => {
      expect(baseAssetHeld(wallet({ SHIB: '1.1' }), 'SHIB', '1', '1', null)).toBe(true);
    });

    it('stays held when only the order floor is missing', () => {
      expect(baseAssetHeld(wallet({ SHIB: '1.1' }), 'SHIB', '1', null, '0.00000545')).toBe(true);
    });

    it('stays held when the price is unparseable rather than absent', () => {
      expect(baseAssetHeld(wallet({ SHIB: '1.1' }), 'SHIB', '1', '1', 'not-a-number')).toBe(true);
    });

    it('stays held when the order floor is unparseable rather than absent', () => {
      expect(
        baseAssetHeld(wallet({ SHIB: '1.1' }), 'SHIB', '1', 'not-a-number', '0.00000545'),
      ).toBe(true);
    });

    // The severe direction, and the one finiteness cannot catch: `1e-9000` is finite, positive and parses fine, but it values half an ETH at effectively zero, arms the residue bound and reaps a live position. Exchange filters are narrowed to plain decimal text upstream; the ticker's `lastPrice` is not, so this is where the grammar has to be enforced.
    it('keeps a real holding when the reference price arrives in exponent notation', () => {
      expect(baseAssetHeld(wallet({ ETH: '0.5' }), 'ETH', '0.0001', '10', '1e-9000')).toBe(true);
      expect(baseAssetHeld(wallet({ ETH: '0.5' }), 'ETH', '0.0001', '10', '2000')).toBe(true);
    });

    // decimal.js reads 'Infinity' as a value rather than throwing, so nothing but the grammar refuses it. It is the direction that matters: an infinite floor makes EVERY balance compare as worth less than it, so a symbol whose floor arrived unreadable would be reaped rather than kept.
    it('stays held when the order floor is the word Infinity rather than decimal text', () => {
      expect(baseAssetHeld(wallet({ SHIB: '1.1' }), 'SHIB', '1', 'Infinity', '0.00000545')).toBe(
        true,
      );
    });
  });
});
