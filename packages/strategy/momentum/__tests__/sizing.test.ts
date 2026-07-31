import { describe, expect, it } from 'vitest';
import { Decimal } from '@app/money';
import type { AccountSnapshot } from '@app/strategy-core';

import type { MomentumConfig } from '../src/schema.js';
import { resolveEntryBudget } from '../src/sizing.js';

const bal = (free: string, locked = '0') => ({
  asset: 'USDT',
  free: new Decimal(free),
  locked: new Decimal(locked),
});

const account = (over: Partial<AccountSnapshot> = {}): AccountSnapshot => ({
  balances: { USDT: bal('1000') },
  readable: true,
  ...over,
});

// `config` only needs the sizing fields; cast a partial so the test stays focused.
const sizing = (entrySizing: unknown, accountCap?: unknown): MomentumConfig =>
  ({ entrySizing, accountCap }) as unknown as MomentumConfig;

describe('resolveEntryBudget', () => {
  it('does not throw when the quote balance is wire-format (string free/locked)', () => {
    // A snapshot that reached sizing without revival: free/locked are wire
    // strings, not Decimals. The free-cash clamp must coerce before comparing,
    // mirroring trailing-trade, so a pure tick() never throws here.
    const wire = {
      balances: { USDT: { asset: 'USDT', free: '500', locked: '0' } },
      readable: true,
    } as unknown as AccountSnapshot;
    expect(resolveEntryBudget(sizing({ mode: 'fixed', amount: '140' }), wire, 'USDT')).toEqual({
      budget: '140',
    });
  });

  it('returns the fixed amount, clamped by free cash', () => {
    expect(resolveEntryBudget(sizing({ mode: 'fixed', amount: '140' }), account(), 'USDT')).toEqual(
      { budget: '140' },
    );
    // free cash 50 < desired 140 -> clamped to 50.
    expect(
      resolveEntryBudget(
        sizing({ mode: 'fixed', amount: '140' }),
        account({ balances: { USDT: bal('50') } }),
        'USDT',
      ),
    ).toEqual({ budget: '50' });
  });

  it('returns percent of equity, clamped by free cash', () => {
    // equity = 200 cash + 800 deployed = 1000; 25% = 250; free cash 200 -> 200.
    expect(
      resolveEntryBudget(
        sizing({ mode: 'percentOfAccount', percent: '0.25' }),
        account({ balances: { USDT: bal('200') }, deployedQuoteAcrossProfiles: '800' }),
        'USDT',
      ),
    ).toEqual({ budget: '200' });
  });

  it('downsizes to reserve-cap headroom', () => {
    // equity 1000; cap 50% = 500; deployed 400 -> headroom 100; desired 140 -> 100.
    expect(
      resolveEntryBudget(
        sizing({ mode: 'fixed', amount: '140' }, { mode: 'percentOfAccount', percent: '0.5' }),
        account({ balances: { USDT: bal('600') }, deployedQuoteAcrossProfiles: '400' }),
        'USDT',
      ),
    ).toEqual({ budget: '100' });
  });

  it('treats an absent deployed total as zero when the cap is armed', () => {
    // cap 50% of equity (= free 100, no deployed) = 50; desired 140 -> 50.
    expect(
      resolveEntryBudget(
        sizing({ mode: 'fixed', amount: '140' }, { mode: 'percentOfAccount', percent: '0.5' }),
        { balances: { USDT: bal('100') } },
        'USDT',
      ),
    ).toEqual({ budget: '50' });
  });

  it('skips with cap-reached when deployed is at/over the cap', () => {
    expect(
      resolveEntryBudget(
        sizing({ mode: 'fixed', amount: '140' }, { mode: 'percentOfAccount', percent: '0.5' }),
        account({ balances: { USDT: bal('100') }, deployedQuoteAcrossProfiles: '900' }),
        'USDT',
      ),
    ).toEqual({ skip: 'cap-reached' });
  });

  it('ignores a cap whose mode is off or whose percent is blank', () => {
    const acct = account();
    expect(
      resolveEntryBudget(sizing({ mode: 'fixed', amount: '10' }, { mode: 'off' }), acct, 'USDT'),
    ).toEqual({ budget: '10' });
    expect(
      resolveEntryBudget(
        sizing({ mode: 'fixed', amount: '10' }, { mode: 'percentOfAccount', percent: '' }),
        acct,
        'USDT',
      ),
    ).toEqual({ budget: '10' });
  });

  it('fails safe (sizing-unconfigured) for an absent, blank, or unknown sizing mode', () => {
    const acct = account();
    expect(resolveEntryBudget({} as unknown as MomentumConfig, acct, 'USDT')).toEqual({
      skip: 'sizing-unconfigured',
    });
    expect(resolveEntryBudget(sizing({ mode: 'fixed', amount: '' }), acct, 'USDT')).toEqual({
      skip: 'sizing-unconfigured',
    });
    expect(resolveEntryBudget(sizing({ mode: 'fixed', amount: 'abc' }), acct, 'USDT')).toEqual({
      skip: 'sizing-unconfigured',
    });
    expect(
      resolveEntryBudget(sizing({ mode: 'percentOfAccount', percent: '' }), acct, 'USDT'),
    ).toEqual({ skip: 'sizing-unconfigured' });
    expect(resolveEntryBudget(sizing({ mode: 'bogus' }), acct, 'USDT')).toEqual({
      skip: 'sizing-unconfigured',
    });
  });

  it('clamps to zero when there is no free cash (missing balance or zero free)', () => {
    expect(
      resolveEntryBudget(sizing({ mode: 'fixed', amount: '140' }), { balances: {} }, 'USDT'),
    ).toEqual({ budget: '0' });
    // Balance present but zero free -> the `free.gt(0)` guard is false.
    expect(
      resolveEntryBudget(
        sizing({ mode: 'fixed', amount: '140' }),
        account({ balances: { USDT: bal('0') } }),
        'USDT',
      ),
    ).toEqual({ budget: '0' });
  });
});
