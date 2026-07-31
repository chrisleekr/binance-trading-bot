import { describe, it, expect } from 'vitest';
import { Decimal } from '@app/money';
import { parseAccountSnapshot } from '../../src/tick/snapshot-loader.js';

describe('parseAccountSnapshot — Decimal revival', () => {
  // Wire stays decimal-strings (see `AccountInfoSnapshot` in @app/contracts);
  // the strategy boundary sees `Decimal`. snapshot-loader is the single
  // revival site, so this test pins the type and value-equality contract
  // strategies rely on.
  it('revives free/locked as Decimal instances equal in value to the wire string', () => {
    const wire = JSON.stringify({
      balances: {
        BTC: { free: '0.5', locked: '0.1' },
        USDT: { free: '100', locked: '0' },
      },
    });
    const snap = parseAccountSnapshot(wire);
    expect(snap.balances['BTC']?.free).toBeInstanceOf(Decimal);
    expect(snap.balances['BTC']?.locked).toBeInstanceOf(Decimal);
    expect(snap.balances['BTC']?.free.eq('0.5')).toBe(true);
    expect(snap.balances['BTC']?.locked.eq('0.1')).toBe(true);
    expect(snap.balances['USDT']?.free.eq('100')).toBe(true);
    expect(snap.balances['USDT']?.locked.eq('0')).toBe(true);
  });

  it('degrades a malformed free/locked string to Decimal(0) and reports via onWarn', () => {
    const wire = JSON.stringify({
      balances: {
        BTC: { free: 'not-a-number', locked: '0' },
      },
    });
    const warnings: { asset: string; field: string; raw: string }[] = [];
    const snap = parseAccountSnapshot(wire, (info) => warnings.push(info));
    expect(snap.balances['BTC']?.free.eq(0)).toBe(true);
    expect(warnings).toEqual([{ asset: 'BTC', field: 'free', raw: 'not-a-number' }]);
  });
});
