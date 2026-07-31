import { describe, expect, it } from 'vitest';

import {
  isCapArmed,
  needsAccountDeployedQuote,
  readAccountExposureCap,
} from '../src/account-exposure.js';

describe('isCapArmed', () => {
  it('is armed only for a non-empty value other than the literal "0"', () => {
    expect(isCapArmed('15000')).toBe(true);
    expect(isCapArmed('0.0')).toBe(true); // not the literal '0' — armed (matches the TT rule)
    expect(isCapArmed('')).toBe(false);
    expect(isCapArmed('0')).toBe(false);
    expect(isCapArmed(undefined)).toBe(false);
    expect(isCapArmed(null)).toBe(false);
    expect(isCapArmed(15000)).toBe(false); // non-string
  });
});

describe('readAccountExposureCap', () => {
  it('reads an amount-mode cap', () => {
    expect(
      readAccountExposureCap({ buy: { accountCap: { mode: 'amount', amount: '15000' } } }),
    ).toEqual({ armed: true, mode: 'amount', amount: '15000', percent: null });
  });

  it('reads a percent-mode cap', () => {
    expect(
      readAccountExposureCap({ buy: { accountCap: { mode: 'percent', percent: '0.5' } } }),
    ).toEqual({ armed: true, mode: 'percent', amount: null, percent: '0.5' });
  });

  it("normalises momentum's top-level percentOfAccount cap onto percent mode", () => {
    expect(
      readAccountExposureCap({ accountCap: { mode: 'percentOfAccount', percent: '0.5' } }),
    ).toEqual({ armed: true, mode: 'percent', amount: null, percent: '0.5' });
  });

  it('returns off for off-mode, a disarmed value, missing, or a non-object config', () => {
    const off = { armed: false, mode: 'off', amount: null, percent: null };
    expect(readAccountExposureCap({ buy: { accountCap: { mode: 'off' } } })).toEqual(off);
    // mode set but the value is the disarmed sentinel ('0' / empty).
    expect(
      readAccountExposureCap({ buy: { accountCap: { mode: 'amount', amount: '0' } } }),
    ).toEqual(off);
    expect(
      readAccountExposureCap({ buy: { accountCap: { mode: 'percent', percent: '' } } }),
    ).toEqual(off);
    expect(readAccountExposureCap({ accountCap: { mode: 'off', percent: '' } })).toEqual(off);
    expect(
      readAccountExposureCap({ accountCap: { mode: 'percentOfAccount', percent: '' } }),
    ).toEqual(off);
    expect(readAccountExposureCap({ buy: {} })).toEqual(off);
    expect(readAccountExposureCap({})).toEqual(off);
    expect(readAccountExposureCap(null)).toEqual(off);
  });

  it('prefers the nested TT cap when a config carries both shapes', () => {
    expect(
      readAccountExposureCap({
        buy: { accountCap: { mode: 'amount', amount: '15000' } },
        accountCap: { mode: 'percentOfAccount', percent: '0.5' },
      }),
    ).toEqual({ armed: true, mode: 'amount', amount: '15000', percent: null });
  });
});

describe('needsAccountDeployedQuote', () => {
  it('is true when an account cap is armed (TT buy.accountCap)', () => {
    expect(
      needsAccountDeployedQuote({ buy: { accountCap: { mode: 'amount', amount: '500' } } }),
    ).toBe(true);
    expect(
      needsAccountDeployedQuote({ buy: { accountCap: { mode: 'percent', percent: '0.5' } } }),
    ).toBe(true);
  });

  it('is true for percent-of-account entry sizing (TT under buy, momentum top-level)', () => {
    expect(
      needsAccountDeployedQuote({
        buy: { entrySizing: { mode: 'percentOfAccount', percent: '0.1' } },
      }),
    ).toBe(true);
    expect(
      needsAccountDeployedQuote({ entrySizing: { mode: 'percentOfAccount', percent: '0.1' } }),
    ).toBe(true);
  });

  it('is true for a momentum top-level percent account cap', () => {
    expect(
      needsAccountDeployedQuote({ accountCap: { mode: 'percentOfAccount', percent: '0.5' } }),
    ).toBe(true);
  });

  it('is false for fixed sizing with no cap, or a non-object config', () => {
    expect(
      needsAccountDeployedQuote({ buy: { entrySizing: { mode: 'fixed', amount: '10' } } }),
    ).toBe(false);
    expect(needsAccountDeployedQuote({ entrySizing: { mode: 'fixed', amount: '10' } })).toBe(false);
    expect(needsAccountDeployedQuote({})).toBe(false);
    expect(needsAccountDeployedQuote(null)).toBe(false);
  });

  it('is false for a momentum cap whose percent is disarmed', () => {
    expect(
      needsAccountDeployedQuote({ accountCap: { mode: 'percentOfAccount', percent: '' } }),
    ).toBe(false);
    expect(
      needsAccountDeployedQuote({ accountCap: { mode: 'percentOfAccount', percent: '0' } }),
    ).toBe(false);
  });
});

// The two duck-readers drifted once already: `needsAccountDeployedQuote` learned
// momentum's shape and `readAccountExposureCap` did not, so the api gauge read
// `off` for a cap the worker was actively enforcing. Pin the direction that
// matters: an armed cap must always pull the deployed-quote aggregate in.
describe('readAccountExposureCap / needsAccountDeployedQuote agreement', () => {
  const configs: readonly { readonly label: string; readonly config: unknown }[] = [
    {
      label: 'TT amount cap',
      config: { buy: { accountCap: { mode: 'amount', amount: '15000' } } },
    },
    {
      label: 'TT percent cap',
      config: { buy: { accountCap: { mode: 'percent', percent: '0.5' } } },
    },
    {
      label: 'TT disarmed amount',
      config: { buy: { accountCap: { mode: 'amount', amount: '0' } } },
    },
    { label: 'TT off', config: { buy: { accountCap: { mode: 'off' } } } },
    {
      label: 'momentum percentOfAccount cap',
      config: { accountCap: { mode: 'percentOfAccount', percent: '0.5' } },
    },
    {
      label: 'momentum disarmed percent',
      config: { accountCap: { mode: 'percentOfAccount', percent: '' } },
    },
    { label: 'momentum off', config: { accountCap: { mode: 'off', percent: '' } } },
    { label: 'no cap block', config: {} },
    { label: 'null config', config: null },
  ];

  it.each(configs)('an armed cap implies deployed-quote is needed: $label', ({ config }) => {
    if (readAccountExposureCap(config).armed) expect(needsAccountDeployedQuote(config)).toBe(true);
  });

  it('a cap block present but unarmed never needs deployed-quote on its own account', () => {
    for (const { config } of configs) {
      if (!readAccountExposureCap(config).armed) {
        expect(needsAccountDeployedQuote(config)).toBe(false);
      }
    }
  });
});
