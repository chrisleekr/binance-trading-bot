// Direct unit coverage for the small pure helpers that became
// independently testable once the branch bodies were extracted from
// tick.ts. The large branch functions (handleOverride, evaluateSellGate,
// evaluateGridBuy, emitForcedFirstEntry) stay covered end-to-end by the
// behavioural suites (auto-trigger-buy, technicals-force-sell, replay).

import { describe, expect, it } from 'vitest';
import { Decimal } from '@app/money';

import { safeDecimal } from '../src/branches/safe-decimal.js';
import { armAutoTriggerBuy } from '../src/branches/first-entry.js';
import {
  resolveHeldForSell,
  sellSkipLogLevel,
  technicalsForceSellTriggerPriceOf,
} from '../src/branches/sell-gate.js';
import { evaluateRegimeFilter } from '../src/branches/regime-filter.js';
import type { MarketSnapshot } from '@app/strategy-core';
import type { TTConfig, TTState } from '../src/schema.js';

describe('safeDecimal', () => {
  it('parses a valid decimal string', () => {
    expect(safeDecimal('1.5')?.toString()).toBe('1.5');
  });

  it('returns null on a malformed string instead of throwing', () => {
    expect(safeDecimal('not-a-number')).toBeNull();
  });
});

describe('armAutoTriggerBuy', () => {
  const now = 1_000_000;
  const cfg = (enabled: boolean, triggerAfterMinutes: number): TTConfig =>
    ({ buy: { autoTriggerBuy: { enabled, triggerAfterMinutes } } }) as unknown as TTConfig;

  it('returns now + delay (exact ms) when enabled', () => {
    expect(armAutoTriggerBuy(cfg(true, 5), now)).toBe(now + 5 * 60_000);
  });

  it('returns null when disabled', () => {
    expect(armAutoTriggerBuy(cfg(false, 5), now)).toBeNull();
  });
});

describe('sellSkipLogLevel', () => {
  it('maps idle/dust reasons below warn and config corruption to warn', () => {
    expect(sellSkipLogLevel('no-balance')).toBe('debug');
    expect(sellSkipLogLevel('min-qty')).toBe('info');
    expect(sellSkipLogLevel('min-notional')).toBe('info');
    expect(sellSkipLogLevel('invalid-filters')).toBe('warn');
  });
});

describe('technicalsForceSellTriggerPriceOf', () => {
  const config = (triggerPercentage: string): TTConfig =>
    ({ sell: { triggerPercentage } }) as unknown as TTConfig;
  const state = (avgEntryPrice: string | null): TTState =>
    ({ avgEntryPrice }) as unknown as TTState;

  it('computes avgEntryPrice * triggerPercentage', () => {
    const out = technicalsForceSellTriggerPriceOf(config('1.05'), state('100'));
    expect(new Decimal(out.price).toString()).toBe('105');
    expect(out.parseFail).toBe(false);
  });

  it('returns price 0 (no parseFail) when there is no position or trigger is disabled', () => {
    expect(technicalsForceSellTriggerPriceOf(config('0'), state('100'))).toEqual({
      price: '0',
      parseFail: false,
    });
    expect(technicalsForceSellTriggerPriceOf(config('1.05'), state(null))).toEqual({
      price: '0',
      parseFail: false,
    });
  });

  it('flags parseFail on a corrupted trigger value', () => {
    expect(technicalsForceSellTriggerPriceOf(config('bad'), state('100'))).toEqual({
      price: '0',
      parseFail: true,
    });
  });

  it('returns price 0 (no parseFail) when the trigger parses to a non-positive value', () => {
    // '0.0' is not literally '0', so it passes the disabled check and parses to
    // a non-positive Decimal, which is treated as disabled, not a parse failure.
    expect(technicalsForceSellTriggerPriceOf(config('0.0'), state('100'))).toEqual({
      price: '0',
      parseFail: false,
    });
  });
});

describe('resolveHeldForSell', () => {
  const bal = (free: string) => ({
    balances: { BTC: { asset: 'BTC', free: new Decimal(free), locked: new Decimal(0) } },
    readable: true,
  });

  it('falls back to wallet free when heldQuantity is null', () => {
    expect(resolveHeldForSell({ heldQuantity: null } as unknown as TTState, 'BTC', bal('2'))).toBe(
      '2',
    );
  });

  it('falls back to wallet free when heldQuantity is non-positive', () => {
    expect(resolveHeldForSell({ heldQuantity: '0' } as unknown as TTState, 'BTC', bal('2'))).toBe(
      '2',
    );
  });

  it('caps the sell at wallet free when heldQuantity exceeds it', () => {
    expect(resolveHeldForSell({ heldQuantity: '5' } as unknown as TTState, 'BTC', bal('2'))).toBe(
      '2',
    );
  });
});

describe('evaluateRegimeFilter tolerance', () => {
  // The live worker passes raw stored config (no schema defaults), so the read
  // must tolerate both a disabled and an entirely-absent regime group.
  const emptyMarket = { candlesByInterval: {} } as unknown as MarketSnapshot;

  it('returns ok when promotion suppression is disabled', () => {
    const cfg = { regime: { onBear: { suppressPromotion: false } } } as unknown as TTConfig;
    expect(evaluateRegimeFilter(emptyMarket, cfg).ok).toBe(true);
  });

  it('returns ok (no throw) when the stored config predates the field', () => {
    const legacy = { buy: {} } as unknown as TTConfig;
    expect(evaluateRegimeFilter(emptyMarket, legacy).ok).toBe(true);
  });
});
