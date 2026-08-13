import { Decimal } from '@app/money';
import { describe, expect, it } from 'vitest';

import {
  hasDownsideExitConfigured,
  noExitCandidates,
  resolveExitBlocker,
  type ExitBlockerContext,
} from '../src/exit-blocker.js';
import { TTConfigSchema, type TTConfig } from '../src/schema.js';

// Every rung cleared; each test fills only the slots it exercises so the
// priority ordering is unambiguous. currentPrice is set because the operator
// reads the rung threshold against it — a resolver that dropped it would still
// name the right rung while leaving the record unreadable.
const empty = (): ExitBlockerContext => ({
  ...noExitCandidates(),
  sellDisabled: false,
  openSellOrder: false,
  currentPrice: new Decimal('100'),
  hasDownsideExit: true,
});

const baseConfig = (sell: Record<string, unknown>): TTConfig =>
  TTConfigSchema.parse({
    symbol: 'BTCUSDT',
    buy: {
      enabled: true,
      entrySizing: { mode: 'fixed', amount: '50' },
      avgEntryPriceRemoveThreshold: '0',
    },
    sell: { enabled: true, triggerPercentage: '1.05', ...sell },
  });

describe('resolveExitBlocker — every reason maps through with its threshold', () => {
  it('sell-disabled', () => {
    expect(resolveExitBlocker({ ...empty(), sellDisabled: true })).toEqual({
      reason: 'sell-disabled',
      changeKey: 'sell-disabled',
      detail: { currentPrice: '100', hasDownsideExit: true },
    });
  });

  it('exit-order-open', () => {
    expect(resolveExitBlocker({ ...empty(), openSellOrder: true })).toEqual({
      reason: 'exit-order-open',
      changeKey: 'exit-order-open',
      detail: { currentPrice: '100', hasDownsideExit: true },
    });
  });

  it('exit-unsellable carries the sizing rejection', () => {
    expect(resolveExitBlocker({ ...empty(), unsellable: { skip: 'no-balance' } })).toEqual({
      reason: 'exit-unsellable',
      changeKey: 'exit-unsellable|skip=no-balance',
      detail: { skip: 'no-balance', currentPrice: '100', hasDownsideExit: true },
    });
  });

  it('exit-config-invalid names the dead field', () => {
    expect(resolveExitBlocker({ ...empty(), configInvalid: { field: 'highSinceBuy' } })).toEqual({
      reason: 'exit-config-invalid',
      changeKey: 'exit-config-invalid|field=highSinceBuy',
      detail: { field: 'highSinceBuy', currentPrice: '100', hasDownsideExit: true },
    });
  });

  it('trail-high-raised carries the new high', () => {
    expect(
      resolveExitBlocker({ ...empty(), trailHighRaised: { high: new Decimal('120') } }),
    ).toEqual({
      reason: 'trail-high-raised',
      changeKey: 'trail-high-raised|highSinceBuy=120',
      detail: { highSinceBuy: '120', currentPrice: '100', hasDownsideExit: true },
    });
  });

  it('atr-trail-above-price when the armed trail is ATR-sourced', () => {
    expect(
      resolveExitBlocker({
        ...empty(),
        armedTrail: { source: 'atr', trailPrice: new Decimal('95'), high: new Decimal('120') },
      }),
    ).toEqual({
      reason: 'atr-trail-above-price',
      changeKey: 'atr-trail-above-price|trailPrice=95|highSinceBuy=120',
      detail: {
        trailPrice: '95',
        highSinceBuy: '120',
        currentPrice: '100',
        hasDownsideExit: true,
      },
    });
  });

  it('trail-above-price when the armed trail is the fixed percentage', () => {
    expect(
      resolveExitBlocker({
        ...empty(),
        armedTrail: { source: 'fixed', trailPrice: new Decimal('98'), high: new Decimal('120') },
      }),
    ).toEqual({
      reason: 'trail-above-price',
      changeKey: 'trail-above-price|trailPrice=98|highSinceBuy=120',
      detail: {
        trailPrice: '98',
        highSinceBuy: '120',
        currentPrice: '100',
        hasDownsideExit: true,
      },
    });
  });

  it('awaiting-sell-arm names the arm price, the gate the position is waiting on', () => {
    expect(
      resolveExitBlocker({ ...empty(), awaitingArm: { armPrice: new Decimal('105') } }),
    ).toEqual({
      reason: 'awaiting-sell-arm',
      changeKey: 'awaiting-sell-arm|armPrice=105',
      detail: { armPrice: '105', currentPrice: '100', hasDownsideExit: true },
    });
  });

  it('break-even-floor-not-hit', () => {
    expect(
      resolveExitBlocker({ ...empty(), breakEvenFloor: { floorPrice: new Decimal('99') } }),
    ).toEqual({
      reason: 'break-even-floor-not-hit',
      changeKey: 'break-even-floor-not-hit|floorPrice=99',
      detail: { floorPrice: '99', currentPrice: '100', hasDownsideExit: true },
    });
  });

  it('break-even-not-armed', () => {
    expect(
      resolveExitBlocker({ ...empty(), breakEvenArm: { armPrice: new Decimal('101') } }),
    ).toEqual({
      reason: 'break-even-not-armed',
      changeKey: 'break-even-not-armed|armPrice=101',
      detail: { armPrice: '101', currentPrice: '100', hasDownsideExit: true },
    });
  });

  it('stop-loss-not-hit', () => {
    expect(resolveExitBlocker({ ...empty(), stopLoss: { stopPrice: new Decimal('90') } })).toEqual({
      reason: 'stop-loss-not-hit',
      changeKey: 'stop-loss-not-hit|stopPrice=90',
      detail: { stopPrice: '90', currentPrice: '100', hasDownsideExit: true },
    });
  });

  it('time-stop-pending carries the bar counts', () => {
    expect(
      resolveExitBlocker({ ...empty(), timeStop: { closedBars: 2, requiredBars: 8 } }),
    ).toEqual({
      reason: 'time-stop-pending',
      changeKey: 'time-stop-pending|closedBars=2|requiredBars=8',
      detail: { closedBars: 2, requiredBars: 8, currentPrice: '100', hasDownsideExit: true },
    });
  });

  it('no-exit-configured is the total fallback, and reports the missing downside exit', () => {
    expect(resolveExitBlocker({ ...empty(), hasDownsideExit: false })).toEqual({
      reason: 'no-exit-configured',
      changeKey: 'no-exit-configured',
      detail: { currentPrice: '100', hasDownsideExit: false },
    });
  });

  it('omits currentPrice when the market price could not be read', () => {
    expect(resolveExitBlocker({ ...empty(), currentPrice: null })).toEqual({
      reason: 'no-exit-configured',
      changeKey: 'no-exit-configured',
      detail: { hasDownsideExit: true },
    });
  });
});

describe('resolveExitBlocker — changeKey', () => {
  it('ignores the live price, so a steady rung stays the same blocker tick after tick', () => {
    // Keying on `currentPrice` would make every tick a "change" and turn the
    // on-change condition record into one row per tick per symbol.
    const rung = { awaitingArm: { armPrice: new Decimal('105') } };
    const a = resolveExitBlocker({ ...empty(), ...rung, currentPrice: new Decimal('100') });
    const b = resolveExitBlocker({ ...empty(), ...rung, currentPrice: new Decimal('104.99') });
    expect(a.changeKey).toBe(b.changeKey);
    expect(a.detail).not.toEqual(b.detail);
  });

  it('changes when the threshold moves, so the operator sees the new level', () => {
    const a = resolveExitBlocker({ ...empty(), awaitingArm: { armPrice: new Decimal('105') } });
    const b = resolveExitBlocker({ ...empty(), awaitingArm: { armPrice: new Decimal('110') } });
    expect(a.changeKey).not.toBe(b.changeKey);
  });

  it('changes when the rung changes at an identical threshold', () => {
    const a = resolveExitBlocker({ ...empty(), awaitingArm: { armPrice: new Decimal('105') } });
    const b = resolveExitBlocker({ ...empty(), breakEvenArm: { armPrice: new Decimal('105') } });
    expect(a.changeKey).not.toBe(b.changeKey);
  });
});

describe('resolveExitBlocker — priority ordering', () => {
  // Filling every slot at once and walking the winner down proves the order,
  // not just that each reason is reachable in isolation.
  const all = (): ExitBlockerContext => ({
    ...empty(),
    sellDisabled: true,
    openSellOrder: true,
    unsellable: { skip: 'no-balance' },
    configInvalid: { field: 'highSinceBuy' },
    trailHighRaised: { high: new Decimal('120') },
    armedTrail: { source: 'fixed', trailPrice: new Decimal('98'), high: new Decimal('120') },
    awaitingArm: { armPrice: new Decimal('105') },
    breakEvenFloor: { floorPrice: new Decimal('99') },
    breakEvenArm: { armPrice: new Decimal('101') },
    stopLoss: { stopPrice: new Decimal('90') },
    timeStop: { closedBars: 2, requiredBars: 8 },
  });

  it('resolves strictly down the documented order as each higher rung clears', () => {
    const order = [
      ['sellDisabled', 'sell-disabled'],
      ['openSellOrder', 'exit-order-open'],
      ['unsellable', 'exit-unsellable'],
      ['configInvalid', 'exit-config-invalid'],
      ['trailHighRaised', 'trail-high-raised'],
      ['armedTrail', 'trail-above-price'],
      ['awaitingArm', 'awaiting-sell-arm'],
      ['breakEvenFloor', 'break-even-floor-not-hit'],
      ['breakEvenArm', 'break-even-not-armed'],
      ['stopLoss', 'stop-loss-not-hit'],
      ['timeStop', 'time-stop-pending'],
    ] as const;
    const ctx: Record<string, unknown> = { ...all() };
    for (const [slot, reason] of order) {
      expect(resolveExitBlocker(ctx as unknown as ExitBlockerContext).reason).toBe(reason);
      ctx[slot] = slot === 'sellDisabled' || slot === 'openSellOrder' ? false : null;
    }
    expect(resolveExitBlocker(ctx as unknown as ExitBlockerContext).reason).toBe(
      'no-exit-configured',
    );
  });
});

describe('hasDownsideExitConfigured', () => {
  it('is false when only a sell trigger and a trail are configured', () => {
    expect(
      hasDownsideExitConfigured(
        baseConfig({ stopLossPercentage: '0', trailingStopPercentage: '0.98' }),
        false,
      ),
    ).toBe(false);
  });

  it.each([
    ['a stop-loss', { stopLossPercentage: '0.9' }, false],
    [
      'break-even',
      { breakEven: { enabled: true, armAtPercentage: '1.01', floorPercentage: '1' } },
      false,
    ],
    ['an ATR trail', { atrTrailing: { enabled: true, period: 14, multiplier: '3' } }, false],
    ['a protective stop', { protectiveStop: { enabled: true, offsetPercentage: '0.99' } }, false],
    ['a time stop', { timeStopBars: 8 }, false],
    ['a discovery time stop', { discoveryTimeStopBars: 8 }, true],
  ])('is true with %s configured', (_label, sell, discoveryEntry) => {
    expect(
      hasDownsideExitConfigured(
        baseConfig({ stopLossPercentage: '0', ...sell }),
        discoveryEntry as boolean,
      ),
    ).toBe(true);
  });

  it('counts only the time-stop the entry kind can actually reach', () => {
    // The production ETHBTC row this record was written for: a 24-bar DISCOVERY
    // time stop on a position that is not a discovery entry. The sell ladder
    // runs that rung only on a discovery entry, so counting it left a position
    // with no way down reading as protected.
    const prod = baseConfig({
      stopLossPercentage: '',
      timeStopBars: 0,
      discoveryTimeStopBars: 24,
    });
    expect(hasDownsideExitConfigured(prod, false)).toBe(false);
    expect(hasDownsideExitConfigured(prod, true)).toBe(true);
  });

  it('does not count the general time stop on a discovery entry', () => {
    // The mirror case: the general rung stands down for a discovery entry, so
    // its bar count protects nothing here.
    const general = baseConfig({ stopLossPercentage: '', timeStopBars: 8 });
    expect(hasDownsideExitConfigured(general, true)).toBe(false);
  });

  it('reads an empty stop-loss as disabled', () => {
    expect(hasDownsideExitConfigured(baseConfig({ stopLossPercentage: '' }), false)).toBe(false);
  });

  it('treats a config row saved before these fields existed as having no downside exit', () => {
    // The live worker ticks RAW stored config: a pre-feature row has no
    // breakEven / atrTrailing / protectiveStop block and no bar counts at all.
    const legacy = { symbol: 'BTCUSDT', sell: { enabled: true } } as unknown as TTConfig;
    expect(hasDownsideExitConfigured(legacy, false)).toBe(false);
    expect(hasDownsideExitConfigured(legacy, true)).toBe(false);
  });
});
