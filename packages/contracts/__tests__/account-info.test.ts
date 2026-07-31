import { describe, it, expect } from 'vitest';

import { AccountInfoSnapshot } from '../src/account-info.js';

describe('AccountInfoSnapshot', () => {
  it('accepts the worker `account-info` payload shape', () => {
    const payload = {
      balances: {
        BTC: { free: '0.5', locked: '0' },
        USDT: { free: '1000.25', locked: '12' },
      },
    };
    const result = AccountInfoSnapshot.safeParse(payload);
    expect(result.success).toBe(true);
    if (result.success) {
      expect(result.data.balances['BTC']).toEqual({ free: '0.5', locked: '0' });
    }
  });

  it('accepts an empty balances record', () => {
    expect(AccountInfoSnapshot.safeParse({ balances: {} }).success).toBe(true);
  });

  it('rejects a missing balances field', () => {
    expect(AccountInfoSnapshot.safeParse({}).success).toBe(false);
  });

  it('rejects numeric balance amounts — money crosses the wire as strings', () => {
    const result = AccountInfoSnapshot.safeParse({
      balances: { BTC: { free: 0.5, locked: 0 } },
    });
    expect(result.success).toBe(false);
  });

  it('rejects a balance entry missing free or locked', () => {
    expect(AccountInfoSnapshot.safeParse({ balances: { BTC: { free: '0.5' } } }).success).toBe(
      false,
    );
  });
});
