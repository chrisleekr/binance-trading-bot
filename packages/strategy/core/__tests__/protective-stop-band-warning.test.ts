// The band arithmetic shared by three surfaces — the tick-time refusal, the
// bind-time warning, and the operator gloss — plus the two ways a stop can be
// silently moved off the configured level.

import { Decimal } from '@app/money';
import { describe, expect, it } from 'vitest';

import {
  clampStopToExchangeFloor,
  maxStopDistancePct,
  protectiveStopBandAdjustment,
  protectiveStopBandWarning,
} from '../src/protective-stop.js';
import type {
  PercentPriceBySideFilter,
  ProtectiveStopBandSettings,
  TrailingDeltaFilter,
} from '../src/contract.js';

const BAND: PercentPriceBySideFilter = {
  bidMultiplierUp: '1.1',
  bidMultiplierDown: '0.5',
  askMultiplierUp: '2',
  askMultiplierDown: '0.95',
  avgPriceMins: 5,
};

// Binance's own documented example bounds, and the ones every USDT pair measured
// on this exchange publishes: 10–2000 bips accepts any stop distance an operator
// would plausibly set, so a test that does NOT mean to exercise the trail's own
// limits gets them out of the way.
const TRAILING: TrailingDeltaFilter = {
  minTrailingAboveDelta: 10,
  maxTrailingAboveDelta: 2000,
  minTrailingBelowDelta: 10,
  maxTrailingBelowDelta: 2000,
};

const settings = (over: Partial<ProtectiveStopBandSettings> = {}): ProtectiveStopBandSettings => ({
  stopDistancePct: new Decimal('0.15'),
  limitOffsetPct: new Decimal('0.995'),
  onBandBlock: 'notify',
  path: ['sell', 'stopLossPercentage'],
  ...over,
});

describe('maxStopDistancePct', () => {
  it('inverts the floor the LOWER leg has to clear', () => {
    // 1 − 0.95 ÷ 0.995 = 4.52%: a deeper stop puts its limit under the floor.
    expect(maxStopDistancePct(BAND, new Decimal('0.995'))?.toDecimalPlaces(6).toString()).toBe(
      '0.045226',
    );
  });

  it('widens as the limit leg is moved back toward the trigger', () => {
    const tight = maxStopDistancePct(BAND, new Decimal('0.9'));
    const wide = maxStopDistancePct(BAND, new Decimal('0.999'));
    expect(tight?.lt(wide ?? 0)).toBe(true);
  });

  it('goes non-positive when no stop distance at all is placeable', () => {
    // An offset at the floor multiplier leaves the limit leg on the floor with
    // the trigger at the reference, which no falling market can improve.
    expect(maxStopDistancePct(BAND, new Decimal('0.95'))?.isZero()).toBe(true);
    expect(maxStopDistancePct(BAND, new Decimal('0.9'))?.isNegative()).toBe(true);
  });

  it('imposes no constraint on any ambiguity', () => {
    // Null must read as "no limit" everywhere. Zero would refuse every stop on
    // the symbol, which is the opposite of failing open.
    expect(maxStopDistancePct(undefined, new Decimal('0.995'))).toBeNull();
    expect(maxStopDistancePct(null, new Decimal('0.995'))).toBeNull();
    expect(
      maxStopDistancePct({ ...BAND, askMultiplierDown: 'x' }, new Decimal('0.995')),
    ).toBeNull();
    expect(
      maxStopDistancePct({ ...BAND, askMultiplierDown: '0' }, new Decimal('0.995')),
    ).toBeNull();
    expect(maxStopDistancePct(BAND, new Decimal('0'))).toBeNull();
    expect(maxStopDistancePct(BAND, new Decimal(NaN))).toBeNull();
  });
});

describe('protectiveStopBandWarning', () => {
  it('warns a stop deeper than the band will hold, naming the achievable maximum', () => {
    const warning = protectiveStopBandWarning({
      settings: settings(),
      band: BAND,
      trailing: TRAILING,
    });
    expect(warning?.level).toBe('warn');
    expect(warning?.code).toBe('stop-outside-exchange-band');
    expect(warning?.message).toContain('15%');
    expect(warning?.message).toContain('4.52%');
    expect(warning?.path).toEqual(['sell', 'stopLossPercentage']);
  });

  it('names what the profile will do instead, per fallback mode', () => {
    const say = (onBandBlock: ProtectiveStopBandSettings['onBandBlock']): string =>
      protectiveStopBandWarning({
        settings: settings({ onBandBlock }),
        band: BAND,
        trailing: TRAILING,
      })?.message ?? '';
    // Every message points at the setting by the label the form shows.
    for (const mode of ['notify', 'clamp', 'native-trail'] as const) {
      expect(say(mode)).toContain('"If Binance rejects the backup stop"');
      expect(say(mode)).toContain(mode);
    }
    expect(say('notify')).toContain('no resting stop behind it');
    expect(say('clamp')).toContain('closer to the market');
    expect(say('native-trail')).toContain('trailing stop');
  });

  it('does not quote a negative maximum as a target', () => {
    const warning = protectiveStopBandWarning({
      settings: settings({ limitOffsetPct: new Decimal('0.9') }),
      band: BAND,
      trailing: TRAILING,
    });
    expect(warning?.message).toContain('no resting stop at all');
    expect(warning?.message).not.toContain('-');
  });

  it('stops promising the clamp fallback once there is no level to clamp to', () => {
    // `limitOffsetPct <= askMultiplierDown` puts the maximum at or below zero, and
    // `clampStopToExchangeFloor` answers that by returning the level untouched. The
    // ordinary clamp sentence would tell the operator a fallback is covering them
    // while the profile in fact behaves exactly like `notify`.
    const message =
      protectiveStopBandWarning({
        settings: settings({ onBandBlock: 'clamp', limitOffsetPct: new Decimal('0.9') }),
        band: BAND,
        trailing: TRAILING,
      })?.message ?? '';
    expect(message).toContain('no level to clamp to');
    expect(message).toContain('no resting stop behind it');
    expect(message).not.toContain('closer to the market');
  });

  it('stops promising the clamp before the maximum reaches zero', () => {
    // The margin the clamp lifts its floor by makes it inert slightly EARLIER
    // than a non-positive maximum does. Here the maximum is a real 0.52% and the
    // clamp still declines, so a predicate reading the maximum alone would
    // promise a raise across this window that never happens. Asserted against
    // the clamp itself rather than against the threshold, so the sentence cannot
    // drift from the behaviour it describes.
    const limitOffsetPct = new Decimal('0.955');
    expect(maxStopDistancePct(BAND, limitOffsetPct)?.gt(0)).toBe(true);
    expect(
      clampStopToExchangeFloor({
        stop: new Decimal('8'),
        reference: '10',
        band: BAND,
        limitOffset: limitOffsetPct,
      }).clamped,
    ).toBe(false);
    const message =
      protectiveStopBandWarning({
        settings: settings({ onBandBlock: 'clamp', limitOffsetPct }),
        band: BAND,
        trailing: TRAILING,
      })?.message ?? '';
    expect(message).toContain('no level to clamp to');
    expect(message).not.toContain('closer to the market');
  });

  it('stops promising the trail on a symbol whose bounds refuse the distance', () => {
    // `TRAILING_DELTA` bounds are per symbol. A 15% stop is 1500 bips, so a
    // symbol capping the trail at 1000 yields no delta, the arm falls through to
    // the refusal, and nothing rests — the same shape as the spent clamp. Each
    // escape is judged against its OWN filter: the clamp is still promised here,
    // because the band that governs it has not changed.
    const trailing = { ...TRAILING, maxTrailingBelowDelta: 1000 };
    const say = (onBandBlock: ProtectiveStopBandSettings['onBandBlock']): string =>
      protectiveStopBandWarning({ settings: settings({ onBandBlock }), band: BAND, trailing })
        ?.message ?? '';
    expect(say('native-trail')).toContain('will not accept a trailing stop at this distance');
    expect(say('native-trail')).toContain('no resting stop behind it');
    expect(say('clamp')).toContain('closer to the market');
    // An unpublished filter is ambiguity, and the arm treats it the same way:
    // no delta, no trail. Saying the trail will cover the position would be the
    // one fail-open reading of a missing filter that costs the operator a stop.
    expect(
      protectiveStopBandWarning({
        settings: settings({ onBandBlock: 'native-trail' }),
        band: BAND,
        trailing: undefined,
      })?.message,
    ).toContain('will not accept a trailing stop at this distance');
  });

  it('is silent on a stop the band accepts', () => {
    expect(
      protectiveStopBandWarning({
        settings: settings({ stopDistancePct: new Decimal('0.04') }),
        band: BAND,
        trailing: TRAILING,
      }),
    ).toBeNull();
    // Exactly at the maximum is placeable, so it is not a finding.
    expect(
      protectiveStopBandWarning({
        settings: settings({ stopDistancePct: new Decimal('0.045226') }),
        band: BAND,
        trailing: TRAILING,
      }),
    ).toBeNull();
  });

  it('fails open when there is no band or no stop to judge', () => {
    // A symbol Binance publishes no band for must bind unimpeded, and a profile
    // resting nothing at the exchange has nothing to warn about.
    expect(
      protectiveStopBandWarning({ settings: settings(), band: undefined, trailing: TRAILING }),
    ).toBeNull();
    expect(
      protectiveStopBandWarning({ settings: settings(), band: null, trailing: TRAILING }),
    ).toBeNull();
    expect(
      protectiveStopBandWarning({
        settings: settings(),
        band: { ...BAND, askMultiplierDown: '' },
        trailing: TRAILING,
      }),
    ).toBeNull();
    expect(
      protectiveStopBandWarning({ settings: null, band: BAND, trailing: TRAILING }),
    ).toBeNull();
  });
});

describe('protectiveStopBandAdjustment', () => {
  it('names the cause that moved the stop', () => {
    expect(
      protectiveStopBandAdjustment({
        symbol: 'BTCUSDT',
        floorClamped: true,
        nativeTrailed: false,
      }),
    ).toEqual([
      {
        name: 'protective_stop_band_adjusted',
        value: 1,
        tags: { symbol: 'BTCUSDT', reason: 'floor-clamped' },
      },
    ]);
    expect(
      protectiveStopBandAdjustment({
        symbol: 'BTCUSDT',
        floorClamped: false,
        nativeTrailed: true,
      }),
    ).toEqual([
      {
        name: 'protective_stop_band_adjusted',
        value: 1,
        tags: { symbol: 'BTCUSDT', reason: 'native-trail' },
      },
    ]);
  });

  it('carries only tags the metrics sink projects', () => {
    // Anything beyond `symbol` / `reason` is dropped on the drain, so a tag that
    // never arrives would read as a series that cannot distinguish two causes.
    const [entry] = protectiveStopBandAdjustment({
      symbol: 'BTCUSDT',
      floorClamped: true,
      nativeTrailed: false,
    });
    expect(Object.keys(entry?.tags ?? {}).sort()).toEqual(['reason', 'symbol']);
  });

  it('emits nothing when the configured stop is the one resting', () => {
    expect(
      protectiveStopBandAdjustment({
        symbol: 'BTCUSDT',
        floorClamped: false,
        nativeTrailed: false,
      }),
    ).toEqual([]);
  });
});
