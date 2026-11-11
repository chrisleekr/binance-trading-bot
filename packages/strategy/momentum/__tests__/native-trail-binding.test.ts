import { describe, expect, it } from 'vitest';
import { Decimal } from '@app/money';
import type { OpenOrder } from '@app/strategy-core';

import { desiredTrailDistance, replaceDecision } from '../src/protective-stop.js';
import { MomentumConfigSchema, type MomentumConfig } from '../src/schema.js';
import { resolveStopLevel, type StopResolution } from '../src/stop-level.js';

const config = (over: Record<string, unknown> = {}): MomentumConfig =>
  MomentumConfigSchema.parse({
    candleInterval: '1h',
    entrySizing: { mode: 'fixed', amount: '100' },
    ema: { fast: 2, slow: 3 },
    trailingStopPct: '0.1',
    ...over,
  });

const level = (over: Partial<StopResolution> = {}): StopResolution => ({
  effectiveHigh: new Decimal('100'),
  profitHigh: null,
  nativeStop: new Decimal('90'),
  stop: new Decimal('90'),
  floorClamped: false,
  ...over,
});

describe('desiredTrailDistance', () => {
  it('uses the armed profit leg ahead of every other distance', () => {
    const distance = desiredTrailDistance(
      config({
        profitTrail: { enabled: true, activationPct: '0.05', trailPct: '0.03' },
        atrTrailingStop: { enabled: true, period: 3, multiple: '2' },
      }),
      level({ profitHigh: new Decimal('110'), stop: new Decimal('80') }),
      new Decimal('100'),
    );

    expect(distance?.toString()).toBe('0.03');
  });

  it('measures the resolved ATR-mode level from the effective high', () => {
    const distance = desiredTrailDistance(
      config({ atrTrailingStop: { enabled: true, period: 3, multiple: '2' } }),
      level({ nativeStop: new Decimal('85'), stop: new Decimal('85') }),
      new Decimal('100'),
    );

    expect(distance?.toString()).toBe('0.15');
  });

  it('ignores an armed break-even lock floor in the ATR-mode distance', () => {
    const candles = ['90', '100', '95', '110', '105', '120'].map((c, i) => ({
      openTimeMs: i * 3_600_000,
      closeTimeMs: (i + 1) * 3_600_000,
      open: c,
      high: c,
      low: c,
      close: c,
      volume: '1',
      isClosed: true,
    }));
    const atr = { atrTrailingStop: { enabled: true, period: 3, multiple: '2' } };
    const lock = { breakEvenLock: { enabled: true, activationPct: '0.015', floorPct: '0.005' } };
    const entry = new Decimal('100');
    const noBand = { reference: null, band: undefined };
    // Effective high 120 is above the 101.5 activation, so the lock is armed.
    const distance = (over: Record<string, unknown>): Decimal | null => {
      const cfg = config({ ...atr, ...over });
      const resolved = resolveStopLevel(
        cfg,
        entry,
        new Decimal('120'),
        null,
        candles,
        noBand,
        null,
        0,
        false,
      );
      return desiredTrailDistance(cfg, resolved, entry);
    };

    const withLock = distance(lock);
    expect(withLock?.toString()).toBe(distance({})?.toString());
    expect(withLock?.gt('0.05')).toBe(true);
  });

  it('keeps the pinned and clamped distance when the lock is off', () => {
    // Pin 95 under high 100 with a 20% ATR-style hard leg: the pre-lock distance was 1 - 95/100, not 1 - 80/100.
    const cfg = config({
      trailingStopPct: '0.2',
      atrTrailingStop: { enabled: true, period: 3, multiple: '2' },
    });
    const resolved = resolveStopLevel(
      cfg,
      new Decimal('100'),
      new Decimal('100'),
      null,
      [],
      { reference: null, band: undefined },
      new Decimal('95'),
      null,
      false,
    );
    expect(resolved.stop?.toString()).toBe('95');
    expect(desiredTrailDistance(cfg, resolved, new Decimal('100'))?.toString()).toBe('0.05');
  });

  it('does not pin the native distance to a resting stop the lock itself raised', () => {
    // Entry 100, high 102 arms the lock (floor 100.5); the resting 100.5 is the lock's own trigger, so the native distance stays the 20% hard leg, not 1.5%.
    const cfg = config({
      trailingStopPct: '0.2',
      atrTrailingStop: { enabled: true, period: 3, multiple: '2' },
      breakEvenLock: { enabled: true, activationPct: '0.015', floorPct: '0.005' },
    });
    const closed = {
      openTimeMs: 0,
      closeTimeMs: 3_600_000,
      open: '102',
      high: '102',
      low: '102',
      close: '102',
      volume: '1',
      isClosed: true,
    };
    const resolved = resolveStopLevel(
      cfg,
      new Decimal('100'),
      new Decimal('102'),
      null,
      [closed],
      { reference: null, band: undefined },
      new Decimal('100.5'),
      0,
      false,
    );
    expect(resolved.stop?.toString()).toBe('100.5');
    expect(desiredTrailDistance(cfg, resolved, new Decimal('100'))?.toString()).toBe('0.2');
  });

  it('falls back to the fixed configured retrace', () => {
    expect(desiredTrailDistance(config(), level(), new Decimal('100'))?.toString()).toBe('0.1');
  });

  it('returns null when no branch yields a usable distance', () => {
    const invalid = { ...config(), trailingStopPct: 'not-a-distance' } as MomentumConfig;
    expect(
      desiredTrailDistance(invalid, level({ nativeStop: null, stop: null }), new Decimal('100')),
    ).toBeNull();
  });
});

describe('replaceDecision', () => {
  it('rejects a successor that is not a place-order', () => {
    const resting = { orderId: 7 } as OpenOrder;
    expect(() => replaceDecision(resting, { type: 'noop' })).toThrow(
      'protective-stop successor builder returned a decision that was not place-order',
    );
  });
});
