import { describe, expect, it } from 'vitest';
import { Decimal } from '@app/money';
import type { OpenOrder } from '@app/strategy-core';

import { desiredTrailDistance, replaceDecision } from '../src/protective-stop.js';
import { MomentumConfigSchema, type MomentumConfig } from '../src/schema.js';
import type { StopResolution } from '../src/stop-level.js';

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
      level({ stop: new Decimal('85') }),
      new Decimal('100'),
    );

    expect(distance?.toString()).toBe('0.15');
  });

  it('falls back to the fixed configured retrace', () => {
    expect(desiredTrailDistance(config(), level(), new Decimal('100'))?.toString()).toBe('0.1');
  });

  it('returns null when no branch yields a usable distance', () => {
    const invalid = { ...config(), trailingStopPct: 'not-a-distance' } as MomentumConfig;
    expect(desiredTrailDistance(invalid, level({ stop: null }), new Decimal('100'))).toBeNull();
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
