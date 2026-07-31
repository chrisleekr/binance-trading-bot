import { describe, expect, it } from 'vitest';
import { Decimal } from '@app/money';
import type { AccountSnapshot } from '@app/strategy-core';

import type { TTConfig } from '../src/index.js';
import { resolveAccountCapQuote, resolveEntryBudget, stopDistanceFraction } from '../src/sizing.js';

// Balances reach resolveEntryBudget as revived Decimals; the wire-string
// coercion path lives with accountEquity in @app/strategy-core balances.test.ts.
const balDec = (free: string, locked = '0') => ({
  asset: 'USDT',
  free: new Decimal(free),
  locked: new Decimal(locked),
});
const account = (over: Partial<AccountSnapshot> = {}): AccountSnapshot =>
  ({ balances: { USDT: balDec('1000') }, readable: true, ...over }) as AccountSnapshot;

const sizing = (entrySizing: unknown, accountCap?: unknown): TTConfig =>
  ({ buy: { entrySizing, accountCap } }) as unknown as TTConfig;

// percentOfAccount sizing is risk-based only when an ACTIVE stop is configured
// (sell.enabled true + a valid stopLossPercentage); this variant attaches both so
// the risk path is exercised.
const sizingStop = (
  entrySizing: unknown,
  stopLossPercentage: string,
  accountCap?: unknown,
): TTConfig =>
  ({
    buy: { entrySizing, accountCap },
    sell: { enabled: true, stopLossPercentage },
  }) as unknown as TTConfig;

describe('resolveAccountCapQuote', () => {
  const eq = new Decimal(1000);
  it('amount mode returns the amount; percent mode returns pct × equity', () => {
    expect(
      resolveAccountCapQuote(
        { mode: 'amount', amount: '400' } as TTConfig['buy']['accountCap'],
        eq,
      )?.toString(),
    ).toBe('400');
    expect(
      resolveAccountCapQuote(
        { mode: 'percent', percent: '0.5' } as TTConfig['buy']['accountCap'],
        eq,
      )?.toString(),
    ).toBe('500');
  });
  it('off / absent / blank → null', () => {
    expect(resolveAccountCapQuote({ mode: 'off' } as TTConfig['buy']['accountCap'], eq)).toBeNull();
    expect(resolveAccountCapQuote(undefined, eq)).toBeNull();
    expect(
      resolveAccountCapQuote({ mode: 'amount', amount: '' } as TTConfig['buy']['accountCap'], eq),
    ).toBeNull();
    expect(
      resolveAccountCapQuote({ mode: 'percent', percent: '' } as TTConfig['buy']['accountCap'], eq),
    ).toBeNull();
  });
});

describe('resolveEntryBudget', () => {
  it('fixed mode takes the amount as-is (NOT clamped by free cash)', () => {
    expect(
      resolveEntryBudget(
        sizing({ mode: 'fixed', amount: '140' }),
        account({ balances: { USDT: balDec('50') } }),
        'USDT',
      ),
    ).toEqual({ budget: '140' });
  });

  it('percent mode = pct × equity, clamped to free cash', () => {
    // equity = 200 cash + 800 deployed = 1000; 25% = 250; free cash 200 → 200.
    expect(
      resolveEntryBudget(
        sizing({ mode: 'percentOfAccount', percent: '0.25' }),
        account({ balances: { USDT: balDec('200') }, deployedQuoteAcrossProfiles: '800' }),
        'USDT',
      ),
    ).toEqual({ budget: '200' });
  });

  it('downsizes to reserve-cap headroom', () => {
    // equity 1000; cap 50% = 500; deployed 400 → headroom 100; desired 140 → 100.
    expect(
      resolveEntryBudget(
        sizing({ mode: 'fixed', amount: '140' }, { mode: 'percent', percent: '0.5' }),
        account({ balances: { USDT: balDec('600') }, deployedQuoteAcrossProfiles: '400' }),
        'USDT',
        '400',
      ),
    ).toEqual({ budget: '100' });
  });

  it('downsizes to an amount-mode cap headroom', () => {
    expect(
      resolveEntryBudget(
        sizing({ mode: 'fixed', amount: '140' }, { mode: 'amount', amount: '500' }),
        account(),
        'USDT',
        '450',
      ),
    ).toEqual({ budget: '50' });
  });

  it('treats an empty/malformed deployed total as zero when a cap is armed', () => {
    // cap amount 500, deployed '' → 0 → headroom 500; desired 140 stays 140.
    expect(
      resolveEntryBudget(
        sizing({ mode: 'fixed', amount: '140' }, { mode: 'amount', amount: '500' }),
        account(),
        'USDT',
        '',
      ),
    ).toEqual({ budget: '140' });
  });

  it('percent mode applies the tightest of percent×equity, free cash, and cap headroom', () => {
    // equity = 200 cash + 450 deployed = 650; 90% = 585; free cash 200; cap
    // amount 500 − deployed 450 = headroom 50 → 50 is the tightest bound.
    expect(
      resolveEntryBudget(
        sizing({ mode: 'percentOfAccount', percent: '0.9' }, { mode: 'amount', amount: '500' }),
        account({ balances: { USDT: balDec('200') }, deployedQuoteAcrossProfiles: '450' }),
        'USDT',
        '450',
      ),
    ).toEqual({ budget: '50' });
  });

  it('skips cap-reached when deployed is at/over the cap', () => {
    expect(
      resolveEntryBudget(
        sizing({ mode: 'fixed', amount: '140' }, { mode: 'amount', amount: '500' }),
        account(),
        'USDT',
        '500',
      ),
    ).toEqual({ skip: 'cap-reached' });
  });

  it('fails safe (sizing-unconfigured) for absent / blank / unknown sizing', () => {
    const a = account();
    expect(resolveEntryBudget({ buy: {} } as unknown as TTConfig, a, 'USDT')).toEqual({
      skip: 'sizing-unconfigured',
    });
    expect(resolveEntryBudget(sizing({ mode: 'fixed', amount: '' }), a, 'USDT')).toEqual({
      skip: 'sizing-unconfigured',
    });
    expect(
      resolveEntryBudget(sizing({ mode: 'percentOfAccount', percent: '' }), a, 'USDT'),
    ).toEqual({ skip: 'sizing-unconfigured' });
    expect(resolveEntryBudget(sizing({ mode: 'bogus' }), a, 'USDT')).toEqual({
      skip: 'sizing-unconfigured',
    });
    // A non-numeric amount throws in the Decimal ctor → decOrNull() catch → null.
    expect(resolveEntryBudget(sizing({ mode: 'fixed', amount: 'abc' }), a, 'USDT')).toEqual({
      skip: 'sizing-unconfigured',
    });
    // A parseable-but-non-finite amount fails the isFinite guard → null.
    expect(resolveEntryBudget(sizing({ mode: 'fixed', amount: 'Infinity' }), a, 'USDT')).toEqual({
      skip: 'sizing-unconfigured',
    });
  });

  it('percent mode with no free cash clamps to zero budget (missing or zero balance)', () => {
    expect(
      resolveEntryBudget(
        sizing({ mode: 'percentOfAccount', percent: '0.5' }),
        { balances: {} } as AccountSnapshot,
        'USDT',
      ),
    ).toEqual({ budget: '0' });
    // Balance present but zero free → the free.gt(0) guard is false.
    expect(
      resolveEntryBudget(
        sizing({ mode: 'percentOfAccount', percent: '0.5' }),
        account({ balances: { USDT: balDec('0') } }),
        'USDT',
      ),
    ).toEqual({ budget: '0' });
  });

  it('risk-based: percent is risk per trade, sized against the stop distance', () => {
    // equity 1000; risk 1% = 10; stop 0.95 → distance 0.05; size = 10 / 0.05 = 200.
    expect(
      resolveEntryBudget(
        sizingStop({ mode: 'percentOfAccount', percent: '0.01' }, '0.95'),
        account(),
        'USDT',
      ),
    ).toEqual({ budget: '200' });
  });

  it('caps a risk-based entry at half of equity when the stop is tight', () => {
    // equity 1000; risk 2% = 20; stop 0.99 → distance 0.01; raw size 2000;
    // clamped to MAX_DEPLOY_FRACTION 0.5 × 1000 = 500.
    expect(
      resolveEntryBudget(
        sizingStop({ mode: 'percentOfAccount', percent: '0.02' }, '0.99'),
        account(),
        'USDT',
      ),
    ).toEqual({ budget: '500' });
  });

  it('falls back to deploy-percent (uncapped) when no stop is configured', () => {
    // No stop → legacy behaviour: 90% × equity 1000 = 900, clamped only by free
    // cash (1000), NOT by the half-equity risk cap. Proves the fallback path is
    // unchanged and not subject to MAX_DEPLOY_FRACTION.
    expect(
      resolveEntryBudget(sizing({ mode: 'percentOfAccount', percent: '0.9' }), account(), 'USDT'),
    ).toEqual({ budget: '900' });
  });

  it('falls back to deploy-percent when the sell side (and thus the stop) is disabled', () => {
    // sell.enabled false → the stop never fires, so there is no real risk cap;
    // size must NOT be leveraged. Legacy deploy-percent: 90% × 1000 = 900.
    const config = {
      buy: { entrySizing: { mode: 'percentOfAccount', percent: '0.9' } },
      sell: { enabled: false, stopLossPercentage: '0.95' },
    } as unknown as TTConfig;
    expect(resolveEntryBudget(config, account(), 'USDT')).toEqual({ budget: '900' });
  });

  it('risk-based size is still bounded by reserve-cap headroom', () => {
    // risk 1% = 10 / stop distance 0.05 = 200; cap amount 500, deployed 480 →
    // headroom 20 wins over the 200 risk size.
    expect(
      resolveEntryBudget(
        sizingStop({ mode: 'percentOfAccount', percent: '0.01' }, '0.95', {
          mode: 'amount',
          amount: '500',
        }),
        account(),
        'USDT',
        '480',
      ),
    ).toEqual({ budget: '20' });
  });
});

describe('stopDistanceFraction', () => {
  const c = (stopLossPercentage?: string, enabled = true): TTConfig =>
    ({
      sell: { enabled, ...(stopLossPercentage === undefined ? {} : { stopLossPercentage }) },
    }) as unknown as TTConfig;

  it('returns 1 − stopLossPercentage for an active, valid stop', () => {
    expect(stopDistanceFraction(c('0.97'))?.toString()).toBe('0.03');
  });

  it('is null for absent / empty / 0 / ≥1 / malformed stops', () => {
    expect(stopDistanceFraction(c())).toBeNull();
    expect(stopDistanceFraction(c(''))).toBeNull();
    expect(stopDistanceFraction(c('0'))).toBeNull();
    expect(stopDistanceFraction(c('1'))).toBeNull();
    expect(stopDistanceFraction(c('1.5'))).toBeNull();
    expect(stopDistanceFraction(c('abc'))).toBeNull();
  });

  it('is null when the sell side is disabled, even with a valid stop', () => {
    // A disabled sell side never runs the stop, so it cannot bound the loss.
    expect(stopDistanceFraction(c('0.97', false))).toBeNull();
  });
});
