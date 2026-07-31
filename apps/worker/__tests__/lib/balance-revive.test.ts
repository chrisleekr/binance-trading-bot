import { describe, expect, it, vi } from 'vitest';
import { Decimal } from '@app/money';

import { reviveBalanceField } from '../../src/lib/balance-revive.js';

describe('reviveBalanceField', () => {
  it('revives a plain decimal wire string as a Decimal', () => {
    expect(reviveBalanceField('BTC', 'free', '0.40000000').eq(new Decimal('0.4'))).toBe(true);
  });

  it('degrades to zero and warns on an unparseable string', () => {
    const onWarn = vi.fn();
    const out = reviveBalanceField('BTC', 'free', 'not-a-number', onWarn);
    expect(out.eq(new Decimal(0))).toBe(true);
    expect(onWarn).toHaveBeenCalledWith({ asset: 'BTC', field: 'free', raw: 'not-a-number' });
  });

  it('degrades a non-finite string (Infinity) instead of returning a poisoned Decimal', () => {
    // `new Decimal('Infinity')` succeeds but is non-finite; the shared
    // plain-decimal grammar rejects it so it can never reach downstream math.
    const onWarn = vi.fn();
    const out = reviveBalanceField('USDT', 'locked', 'Infinity', onWarn);
    expect(out.eq(new Decimal(0))).toBe(true);
    expect(out.isFinite()).toBe(true);
    expect(onWarn).toHaveBeenCalledOnce();
  });

  it('degrades scientific-notation strings the wire never legitimately produces', () => {
    const onWarn = vi.fn();
    expect(reviveBalanceField('USDT', 'free', '1e5', onWarn).eq(new Decimal(0))).toBe(true);
    expect(onWarn).toHaveBeenCalledOnce();
  });
});
