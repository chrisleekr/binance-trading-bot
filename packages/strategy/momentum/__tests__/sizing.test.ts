import { describe, expect, it } from 'vitest';
import { Decimal } from '@app/money';
import type { AccountSnapshot, Candle } from '@app/strategy-core';

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
// `extra` carries the stop-distance concerns the risk cap reads (riskSizing, atrTrailingStop, trailingStopPct) without disturbing the two positional sizing fields every other case sets.
const sizing = (
  entrySizing: unknown,
  accountCap?: unknown,
  extra: Record<string, unknown> = {},
): MomentumConfig => ({ entrySizing, accountCap, ...extra }) as unknown as MomentumConfig;

const mkCandles = (closes: readonly string[]): Candle[] =>
  closes.map((c, i) => ({
    openTimeMs: i * 3_600_000,
    closeTimeMs: (i + 1) * 3_600_000,
    open: c,
    high: c,
    low: c,
    close: c,
    volume: '1',
    isClosed: true,
  }));

// high=low=close and a constant +1 step, so every true range is exactly 1 and ATR over its first full window is exactly 1 — a stop distance that stays an exact decimal through the division.
const STEP_CANDLES = mkCandles(['10', '11', '12', '13']);

// The entry context for every case the fixed-percent stop branch serves: a positive, parsable price and an empty candle window, which is all that branch needs. On this branch the price's VALUE is inert: `resolveEntryBudget` parses it and `initialStopDistanceFraction` then reads it only for positivity before returning `trailingStopPct` itself, which is not measured against the price, so '100' could be any positive number without moving a fixed-branch assertion. Those are still the two ways the branch can refuse, and they are pinned in different places: the unparsable-price case below covers the parse, while the non-positive price is covered by a direct call in trailing-stop.test.ts rather than through this boundary. The window is read only once the ATR stop is on, so an ATR case supplies its own candles instead.
const FIXED_STOP_CTX = { price: '100', candles: [] };

describe('resolveEntryBudget', () => {
  it('does not throw when the quote balance is wire-format (string free/locked)', () => {
    // A snapshot that reached sizing without revival: free/locked are wire
    // strings, not Decimals. The free-cash clamp must coerce before comparing,
    // mirroring trailing-trade, so a pure tick() never throws here.
    const wire = {
      balances: { USDT: { asset: 'USDT', free: '500', locked: '0' } },
      readable: true,
    } as unknown as AccountSnapshot;
    expect(
      resolveEntryBudget(sizing({ mode: 'fixed', amount: '140' }), wire, 'USDT', FIXED_STOP_CTX),
    ).toEqual({
      budget: '140',
    });
  });

  it('returns the fixed amount, clamped by free cash', () => {
    expect(
      resolveEntryBudget(
        sizing({ mode: 'fixed', amount: '140' }),
        account(),
        'USDT',
        FIXED_STOP_CTX,
      ),
    ).toEqual({ budget: '140' });
    // free cash 50 < desired 140 -> clamped to 50.
    expect(
      resolveEntryBudget(
        sizing({ mode: 'fixed', amount: '140' }),
        account({ balances: { USDT: bal('50') } }),
        'USDT',
        FIXED_STOP_CTX,
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
        FIXED_STOP_CTX,
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
        FIXED_STOP_CTX,
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
        FIXED_STOP_CTX,
      ),
    ).toEqual({ budget: '50' });
  });

  it('skips with cap-reached when deployed is at/over the cap', () => {
    expect(
      resolveEntryBudget(
        sizing({ mode: 'fixed', amount: '140' }, { mode: 'percentOfAccount', percent: '0.5' }),
        account({ balances: { USDT: bal('100') }, deployedQuoteAcrossProfiles: '900' }),
        'USDT',
        FIXED_STOP_CTX,
      ),
    ).toEqual({ skip: 'cap-reached' });
  });

  it('ignores a cap whose mode is off or whose percent is blank', () => {
    const acct = account();
    expect(
      resolveEntryBudget(
        sizing({ mode: 'fixed', amount: '10' }, { mode: 'off' }),
        acct,
        'USDT',
        FIXED_STOP_CTX,
      ),
    ).toEqual({ budget: '10' });
    expect(
      resolveEntryBudget(
        sizing({ mode: 'fixed', amount: '10' }, { mode: 'percentOfAccount', percent: '' }),
        acct,
        'USDT',
        FIXED_STOP_CTX,
      ),
    ).toEqual({ budget: '10' });
  });

  it('fails safe (sizing-unconfigured) for an absent, blank, or unknown sizing mode', () => {
    const acct = account();
    expect(
      resolveEntryBudget({} as unknown as MomentumConfig, acct, 'USDT', FIXED_STOP_CTX),
    ).toEqual({
      skip: 'sizing-unconfigured',
    });
    expect(
      resolveEntryBudget(sizing({ mode: 'fixed', amount: '' }), acct, 'USDT', FIXED_STOP_CTX),
    ).toEqual({
      skip: 'sizing-unconfigured',
    });
    expect(
      resolveEntryBudget(sizing({ mode: 'fixed', amount: 'abc' }), acct, 'USDT', FIXED_STOP_CTX),
    ).toEqual({
      skip: 'sizing-unconfigured',
    });
    expect(
      resolveEntryBudget(
        sizing({ mode: 'percentOfAccount', percent: '' }),
        acct,
        'USDT',
        FIXED_STOP_CTX,
      ),
    ).toEqual({ skip: 'sizing-unconfigured' });
    expect(resolveEntryBudget(sizing({ mode: 'bogus' }), acct, 'USDT', FIXED_STOP_CTX)).toEqual({
      skip: 'sizing-unconfigured',
    });
  });

  it('clamps to zero when there is no free cash (missing balance or zero free)', () => {
    expect(
      resolveEntryBudget(
        sizing({ mode: 'fixed', amount: '140' }),
        { balances: {} },
        'USDT',
        FIXED_STOP_CTX,
      ),
    ).toEqual({ budget: '0' });
    // Balance present but zero free -> the `free.gt(0)` guard is false.
    expect(
      resolveEntryBudget(
        sizing({ mode: 'fixed', amount: '140' }),
        account({ balances: { USDT: bal('0') } }),
        'USDT',
        FIXED_STOP_CTX,
      ),
    ).toEqual({ budget: '0' });
  });

  it('leaves the budget byte-identical when riskSizing is absent', () => {
    // Same equity 1000 and the same 0.1 stop distance the cap would divide by, so if the cap were live it would bind at 0.01*1000/0.1 = 100. Absent, the entrySizing figure 0.3*1000 = 300 stands untouched.
    const withoutRisk = resolveEntryBudget(
      sizing({ mode: 'percentOfAccount', percent: '0.3' }, undefined, {
        trailingStopPct: '0.1',
      }),
      account(),
      'USDT',
      FIXED_STOP_CTX,
    );
    expect(withoutRisk).toEqual({ budget: '300' });
    // The enabled variant must move off that same number, or the absent-case assertion would pass even with the cap mis-scoped to always apply.
    expect(
      resolveEntryBudget(
        sizing({ mode: 'percentOfAccount', percent: '0.3' }, undefined, {
          trailingStopPct: '0.1',
          riskSizing: { enabled: true, riskPct: '0.01' },
        }),
        account(),
        'USDT',
        FIXED_STOP_CTX,
      ),
    ).toEqual({ budget: '100' });
  });

  it('leaves the budget unchanged when riskSizing is present but disabled', () => {
    // A stored-but-off block is a different input from an absent one; only the `enabled !== true` disjunct covers it.
    expect(
      resolveEntryBudget(
        sizing({ mode: 'percentOfAccount', percent: '0.3' }, undefined, {
          trailingStopPct: '0.1',
          riskSizing: { enabled: false, riskPct: '0.01' },
        }),
        account(),
        'USDT',
        FIXED_STOP_CTX,
      ),
    ).toEqual({ budget: '300' });
  });

  it('shrinks the budget to riskPct*equity/stopDistance with the ATR stop off', () => {
    // equity 1000, free cash 1000 and no accountCap, so the risk cap is the only clamp that can bind: desired 0.3*1000 = 300; cap 0.01*1000/0.1 = 100.
    expect(
      resolveEntryBudget(
        sizing({ mode: 'percentOfAccount', percent: '0.3' }, undefined, {
          trailingStopPct: '0.1',
          riskSizing: { enabled: true, riskPct: '0.01' },
        }),
        account(),
        'USDT',
        FIXED_STOP_CTX,
      ),
    ).toEqual({ budget: '100' });
  });

  it('is a no-op when riskPct equals percent*stopDistance (identity, pins the arithmetic only)', () => {
    // 0.03/0.1 = 0.3 = the entrySizing percent, so the cap lands exactly on the desired figure. This pins the formula's constants; it does NOT prove the cap is wired in, since an unwired cap yields the same 300.
    expect(
      resolveEntryBudget(
        sizing({ mode: 'percentOfAccount', percent: '0.3' }, undefined, {
          trailingStopPct: '0.1',
          riskSizing: { enabled: true, riskPct: '0.03' },
        }),
        account(),
        'USDT',
        FIXED_STOP_CTX,
      ),
    ).toEqual({ budget: '300' });
  });

  it('never raises the budget above the entrySizing figure', () => {
    // cap 0.05*1000/0.1 = 500, above both desired figures: the cap only ever shrinks.
    expect(
      resolveEntryBudget(
        sizing({ mode: 'percentOfAccount', percent: '0.3' }, undefined, {
          trailingStopPct: '0.1',
          riskSizing: { enabled: true, riskPct: '0.05' },
        }),
        account(),
        'USDT',
        FIXED_STOP_CTX,
      ),
    ).toEqual({ budget: '300' });
    expect(
      resolveEntryBudget(
        sizing({ mode: 'fixed', amount: '140' }, undefined, {
          trailingStopPct: '0.1',
          riskSizing: { enabled: true, riskPct: '0.05' },
        }),
        account(),
        'USDT',
        FIXED_STOP_CTX,
      ),
    ).toEqual({ budget: '140' });
  });

  it('still lets the free-cash clamp win below the risk cap', () => {
    // equity stays 1000 (free 60 + deployed 940): desired 300, risk cap 100, free cash 60. The 60 proves the risk cap is one more `min` operand rather than a replacement for the free-cash clamp — an implementation that returned the cap instead of minimising with it would yield 100. It says NOTHING about which of the two runs first: `Decimal.min` is commutative, so 60 comes out under either order. The ordering that does matter, the reported skip reason, is pinned by the two precedence cases below.
    expect(
      resolveEntryBudget(
        sizing({ mode: 'percentOfAccount', percent: '0.3' }, undefined, {
          trailingStopPct: '0.1',
          riskSizing: { enabled: true, riskPct: '0.01' },
        }),
        account({ balances: { USDT: bal('60') }, deployedQuoteAcrossProfiles: '940' }),
        'USDT',
        FIXED_STOP_CTX,
      ),
    ).toEqual({ budget: '60' });
  });

  it('still applies reserve-cap headroom below the risk cap', () => {
    // equity 1000 (free 550 + deployed 450): desired 300, risk cap 100, headroom 0.5*1000 - 450 = 50. The 50 proves the risk cap is one more `min` operand rather than a replacement for the headroom clamp — an implementation that returned the cap instead of minimising with it would yield 100. It says NOTHING about which of the two runs first: `Decimal.min` is commutative, so 50 comes out under either order. The ordering that does matter, the reported skip reason, is pinned by the two precedence cases below.
    expect(
      resolveEntryBudget(
        sizing(
          { mode: 'percentOfAccount', percent: '0.3' },
          { mode: 'percentOfAccount', percent: '0.5' },
          { trailingStopPct: '0.1', riskSizing: { enabled: true, riskPct: '0.01' } },
        ),
        account({ balances: { USDT: bal('550') }, deployedQuoteAcrossProfiles: '450' }),
        'USDT',
        FIXED_STOP_CTX,
      ),
    ).toEqual({ budget: '50' });
  });

  it('shrinks the budget using the ATR stop distance when the ATR mode is on', () => {
    // ATR(3) over STEP_CANDLES is exactly 1; multiple 2 at price 100 -> distance 0.02. Cap 0.01*1000/0.02 = 500; desired 0.8*1000 = 800.
    expect(
      resolveEntryBudget(
        sizing({ mode: 'percentOfAccount', percent: '0.8' }, undefined, {
          atrTrailingStop: { enabled: true, period: 3, multiple: '2' },
          riskSizing: { enabled: true, riskPct: '0.01' },
        }),
        account(),
        'USDT',
        { price: '100', candles: STEP_CANDLES },
      ),
    ).toEqual({ budget: '500' });
  });

  it('fails closed when the ATR window is shorter than period+1', () => {
    // Sizing off a stop distance the operator did not configure would understate the risk silently, so an unresolvable distance refuses the entry instead.
    expect(
      resolveEntryBudget(
        sizing({ mode: 'percentOfAccount', percent: '0.3' }, undefined, {
          atrTrailingStop: { enabled: true, period: 6, multiple: '2' },
          riskSizing: { enabled: true, riskPct: '0.01' },
        }),
        account(),
        'USDT',
        { price: '100', candles: STEP_CANDLES },
      ),
    ).toEqual({ skip: 'risk-sizing-unavailable' });
  });

  it('fails closed when the ATR distance reaches the entry price', () => {
    // ATR 1 at multiple 100 is a distance of 1.0 of the price: not a fraction in (0, 1), so there is nothing to divide equity risk by.
    expect(
      resolveEntryBudget(
        sizing({ mode: 'percentOfAccount', percent: '0.3' }, undefined, {
          atrTrailingStop: { enabled: true, period: 3, multiple: '100' },
          riskSizing: { enabled: true, riskPct: '0.01' },
        }),
        account(),
        'USDT',
        { price: '100', candles: STEP_CANDLES },
      ),
    ).toEqual({ skip: 'risk-sizing-unavailable' });
  });

  it('fails closed when the entry price is unparsable', () => {
    expect(
      resolveEntryBudget(
        sizing({ mode: 'percentOfAccount', percent: '0.3' }, undefined, {
          trailingStopPct: '0.1',
          riskSizing: { enabled: true, riskPct: '0.01' },
        }),
        account(),
        'USDT',
        { price: 'abc', candles: [] },
      ),
    ).toEqual({ skip: 'risk-sizing-unavailable' });
  });

  it('fails closed when the fixed trailingStopPct is outside (0, 1)', () => {
    // The schema bounds this field, but the live worker reads stored config unparsed, so a 1.5 can reach sizing and must not size an entry off a stop wider than the whole position.
    expect(
      resolveEntryBudget(
        sizing({ mode: 'percentOfAccount', percent: '0.3' }, undefined, {
          trailingStopPct: '1.5',
          riskSizing: { enabled: true, riskPct: '0.01' },
        }),
        account(),
        'USDT',
        FIXED_STOP_CTX,
      ),
    ).toEqual({ skip: 'risk-sizing-unavailable' });
  });

  it('falls back to a 1% riskPct for absent, malformed, non-positive, and at/above-one values', () => {
    // All rows land on the same 0.01 fallback -> cap 0.01*1000/0.1 = 100 against a desired 300. Only the '1' and '2' rows exercise the extra upper-bound guard: coerceDec already returns the 0.01 fallback for the first five, and 0.01 is itself below 1.
    for (const riskPct of [undefined, '', 'abc', '0', '-1', '1', '2']) {
      expect(
        resolveEntryBudget(
          sizing({ mode: 'percentOfAccount', percent: '0.3' }, undefined, {
            trailingStopPct: '0.1',
            riskSizing: { enabled: true, ...(riskPct === undefined ? {} : { riskPct }) },
          }),
          account(),
          'USDT',
          FIXED_STOP_CTX,
        ),
      ).toEqual({ budget: '100' });
    }
  });

  it('reports risk-sizing-unavailable, not cap-reached, when both refusals are live', () => {
    // Two independent refusals, both armed by this one input. (1) Reserve cap: equity is 100 free + 900 deployed = 1000, so headroom is 0.5*1000 - 900 = -400, which is <= 0 and refuses with cap-reached. (2) Risk sizing: the ATR stop asks for period 6, so it needs 7 closed candles and STEP_CANDLES supplies 4, leaving the initial stop distance unresolvable and refusing with risk-sizing-unavailable.
    // Both blocks are `min` operands, so which one runs first cannot change any budget — only which reason the operator is shown. "Cannot size at all" outranks "sized, but no headroom", so the risk block must return first. Move it below the accountCap block and this assertion reads cap-reached instead.
    expect(
      resolveEntryBudget(
        sizing(
          { mode: 'percentOfAccount', percent: '0.3' },
          { mode: 'percentOfAccount', percent: '0.5' },
          {
            atrTrailingStop: { enabled: true, period: 6, multiple: '2' },
            riskSizing: { enabled: true, riskPct: '0.01' },
          },
        ),
        account({ balances: { USDT: bal('100') }, deployedQuoteAcrossProfiles: '900' }),
        'USDT',
        { price: '100', candles: STEP_CANDLES },
      ),
    ).toEqual({ skip: 'risk-sizing-unavailable' });
  });

  it('reports sizing-unconfigured, not risk-sizing-unavailable, when both refusals are live', () => {
    // The same collision one level up. (1) entrySizing is absent, so no desired figure resolves and the sizing-unconfigured return is armed. (2) Risk sizing is on with the same too-short ATR window (period 6 needs 7 candles, STEP_CANDLES has 4), so the stop distance is unresolvable and risk-sizing-unavailable is armed too.
    // Neither refusal can affect a budget, since neither path produces one — only the reported reason is at stake, and an absent entrySizing is the more fundamental fact, so its return must come first. Move the `desired === null` return below the risk block and this assertion reads risk-sizing-unavailable instead.
    expect(
      resolveEntryBudget(
        sizing(undefined, undefined, {
          atrTrailingStop: { enabled: true, period: 6, multiple: '2' },
          riskSizing: { enabled: true, riskPct: '0.01' },
        }),
        account(),
        'USDT',
        { price: '100', candles: STEP_CANDLES },
      ),
    ).toEqual({ skip: 'sizing-unconfigured' });
  });
});
