import { describe, expect, it } from 'vitest';
import { Decimal } from '@app/money';
import type { Candle, StopBandContext } from '@app/strategy-core';

import { MomentumConfigSchema, type MomentumConfig } from '../src/index.js';
import {
  isBucketEnd,
  profitTrailEpoch,
  ratchetProfitHigh,
  resolveStopLevel,
} from '../src/stop-level.js';

const MINUTE = 60_000;

// No reference and no published band: the exchange floor cannot be evaluated, so
// the clamp is inert and every level below is the operator's own.
const NO_BAND: StopBandContext = { reference: null, band: undefined };

const cfg = (over: Record<string, unknown> = {}): MomentumConfig =>
  MomentumConfigSchema.parse({
    candleInterval: '1h',
    entrySizing: { mode: 'fixed', amount: '140' },
    ema: { fast: 2, slow: 3 },
    trailingStopPct: '0.05',
    ...over,
  });

// The live worker stores config unparsed, so a malformed leaf must be coerced,
// not trusted. Schema.parse would reject these, so they bypass it deliberately.
const rawCfg = (over: Record<string, unknown>): MomentumConfig =>
  ({ ...cfg(), ...over }) as MomentumConfig;

/** 1m candles starting at `startMs`, one per minute, closed unless told otherwise. */
const oneMinute = (startMs: number, closes: readonly string[], isClosed = true): Candle[] =>
  closes.map((c, i) => ({
    openTimeMs: startMs + i * MINUTE,
    closeTimeMs: startMs + (i + 1) * MINUTE,
    open: c,
    high: c,
    low: c,
    close: c,
    volume: '1',
    isClosed,
  }));

const TRAIL_ON = { profitTrail: { enabled: true, activationPct: '0.05', trailPct: '0.03' } };

describe('stop-level — isBucketEnd', () => {
  it('accepts every 1m close at N = 1', () => {
    for (const c of oneMinute(0, ['1', '2', '3'])) expect(isBucketEnd(c, 1)).toBe(true);
  });

  it('accepts only the final minute of an aligned 5m window', () => {
    // The candle OPENING at 04:00 ends at 05:00, so it is the 5m close.
    const closes = oneMinute(0, ['1', '2', '3', '4', '5', '6']);
    expect(closes.map((c) => isBucketEnd(c, 5))).toEqual([false, false, false, false, true, false]);
  });

  it('accepts only the final minute of an aligned hour at N = 60', () => {
    expect(isBucketEnd(oneMinute(58 * MINUTE, ['1'])[0] as Candle, 60)).toBe(false);
    expect(isBucketEnd(oneMinute(59 * MINUTE, ['1'])[0] as Candle, 60)).toBe(true);
  });
});

describe('stop-level — profitTrailEpoch', () => {
  it('reports no epoch for an empty window', () => {
    expect(profitTrailEpoch([])).toBeNull();
  });

  it('reports the close instant of the newest closed candle', () => {
    // Three closed 1m candles from 00:00; the last ENDS at 03:00.
    expect(profitTrailEpoch(oneMinute(0, ['1', '2', '3']))).toBe(3 * MINUTE);
  });

  it('ignores the forming candle, so a partial minute cannot advance the epoch', () => {
    // Advancing past a still-open candle would exclude that candle from its own
    // position's fold once it closes, silently shortening the trail's window.
    const window = [...oneMinute(0, ['1', '2']), ...oneMinute(2 * MINUTE, ['3'], false)];
    expect(profitTrailEpoch(window)).toBe(2 * MINUTE);
  });

  it('reports no epoch when every candle is still forming', () => {
    expect(profitTrailEpoch(oneMinute(0, ['1', '2'], false))).toBeNull();
  });

  it('takes the newest close, not the last element, on an out-of-order window', () => {
    const [first, second] = oneMinute(0, ['1', '2']) as [Candle, Candle];
    expect(profitTrailEpoch([second, first])).toBe(2 * MINUTE);
  });
});

describe('stop-level — ratchetProfitHigh', () => {
  const entry = new Decimal('100');

  it('is null while the profit trail is off', () => {
    expect(
      ratchetProfitHigh(cfg(), new Decimal('120'), entry, oneMinute(0, ['130']), 0),
    ).toBeNull();
  });

  it('floors at the entry price, so a revived mark can never sit below cost', () => {
    const high = ratchetProfitHigh(cfg(TRAIL_ON), new Decimal('90'), entry, [], 0);
    expect(high?.toString()).toBe('100');
  });

  it('folds the bucket-end closes and ignores the minutes between them', () => {
    // N defaults to 5. Only the candle opening at 04:00 (close 130) is a bucket
    // end; the higher 140 at 03:00 is mid-bucket and must not count.
    const candles = oneMinute(0, ['101', '102', '103', '140', '130']);
    const high = ratchetProfitHigh(cfg(TRAIL_ON), null, entry, candles, 0);
    expect(high?.toString()).toBe('130');
  });

  it('ignores an unclosed bucket-end candle', () => {
    const candles = oneMinute(0, ['101', '102', '103', '104', '130'], false);
    expect(ratchetProfitHigh(cfg(TRAIL_ON), null, entry, candles, 0)?.toString()).toBe('100');
  });

  it('excludes candles that opened before the epoch', () => {
    // Two bucket ends: 04:00 (pre-entry peak 200) and 09:00 (110). The epoch is
    // 05:00, so only the later one may lift the mark.
    const candles = oneMinute(0, [
      '101',
      '102',
      '103',
      '104',
      '200',
      '105',
      '106',
      '107',
      '108',
      '110',
    ]);
    const high = ratchetProfitHigh(cfg(TRAIL_ON), null, entry, candles, 5 * MINUTE);
    expect(high?.toString()).toBe('110');
  });

  it('keeps the previous mark when the window only offers lower closes', () => {
    const candles = oneMinute(0, ['101', '102', '103', '104', '110']);
    const high = ratchetProfitHigh(cfg(TRAIL_ON), new Decimal('125'), entry, candles, 0);
    expect(high?.toString()).toBe('125');
  });

  it('folds nothing when the epoch is unknown', () => {
    // A wallet-reconciled position the bot never opened: no epoch means no way to
    // tell which highs the position actually held, so only the floor applies.
    const candles = oneMinute(0, ['101', '102', '103', '104', '130']);
    const high = ratchetProfitHigh(cfg(TRAIL_ON), null, entry, candles, null);
    expect(high?.toString()).toBe('100');
  });

  it('honours a wider bucket', () => {
    // At N = 15 the 05:00 close is mid-bucket; only 14:00 -> 15:00 counts.
    const closes = Array.from({ length: 15 }, (_, i) => (i === 4 ? '150' : '120'));
    const high = ratchetProfitHigh(
      cfg({ profitTrail: { ...TRAIL_ON.profitTrail, ratchetMinutes: 15 } }),
      null,
      entry,
      oneMinute(0, closes),
      0,
    );
    expect(high?.toString()).toBe('120');
  });

  it('falls back to the 5m default when ratchetMinutes is unparseable', () => {
    const config = rawCfg({ profitTrail: { ...TRAIL_ON.profitTrail, ratchetMinutes: 'soon' } });
    const candles = oneMinute(0, ['101', '102', '103', '140', '130']);
    expect(ratchetProfitHigh(config, null, entry, candles, 0)?.toString()).toBe('130');
  });
});

describe('stop-level — resolveStopLevel', () => {
  const entry = new Decimal('100');
  const high = new Decimal('120');

  // Arming is not directly observable any more — only the level is. These two
  // cases straddle the threshold with a LOW hard leg (106 * 0.95 = 100.7) so the
  // armed side reports a different number, which pins the boundary harder than
  // the old boolean did.
  const lowHigh = new Decimal('106');

  it('reports the hard leg alone while the profit trail is off', () => {
    const out = resolveStopLevel(cfg(), entry, high, null, [], NO_BAND);
    expect(out.profitHigh).toBeNull();
    expect(out.stop?.toString()).toBe('114');
  });

  it('does not arm a hair below the activation threshold', () => {
    // 104.99 < 100 * 1.05, so the profit leg contributes nothing and the hard
    // leg stands alone.
    const out = resolveStopLevel(cfg(TRAIL_ON), entry, lowHigh, new Decimal('104.99'), [], NO_BAND);
    expect(out.stop?.toString()).toBe('100.7');
  });

  it('arms exactly at the activation threshold', () => {
    // 105 = 100 * 1.05 exactly. Armed: 105 * 0.97 = 101.85 now outranks the
    // 100.7 hard leg, so the reported level moves.
    const out = resolveStopLevel(cfg(TRAIL_ON), entry, lowHigh, new Decimal('105'), [], NO_BAND);
    expect(out.stop?.toString()).toBe('101.85');
  });

  it('still reports the hard leg when it outranks an armed profit leg', () => {
    // Armed at 105, but 101.85 < 120 * 0.95 = 114, so `max` keeps the hard leg.
    const out = resolveStopLevel(cfg(TRAIL_ON), entry, high, new Decimal('105'), [], NO_BAND);
    expect(out.stop?.toString()).toBe('114');
  });

  it('takes the profit leg once it climbs above the hard leg', () => {
    // 200 * 0.97 = 194 > 120 * 0.95 = 114.
    const out = resolveStopLevel(cfg(TRAIL_ON), entry, high, new Decimal('200'), [], NO_BAND);
    expect(out.stop?.toString()).toBe('194');
    expect(out.profitHigh?.toString()).toBe('200');
  });

  it('never sits below the hard leg, so protection can only tighten', () => {
    const hard = resolveStopLevel(cfg(), entry, high, null, [], NO_BAND).stop as Decimal;
    for (const mark of ['105', '130', '200']) {
      const both = resolveStopLevel(cfg(TRAIL_ON), entry, high, new Decimal(mark), [], NO_BAND)
        .stop as Decimal;
      expect(both.gte(hard)).toBe(true);
    }
  });

  it('cannot arm below entry, whatever the marks say', () => {
    // The schema forbids trailPct >= activationPct / (1 + activationPct); the
    // invariant it buys is that an armed profit stop is always above entry.
    const out = resolveStopLevel(cfg(TRAIL_ON), entry, entry, new Decimal('105'), [], NO_BAND);
    // max(hard 95, profit 101.85) = 101.85 > entry 100.
    expect(out.stop?.toString()).toBe('101.85');
  });

  it('floors the profit leg at entry when stored config escapes the schema rule', () => {
    // The worker reads config unparsed, and lowering a profile's activationPct
    // does not re-validate symbol overrides merged against the old one. With
    // trailPct 0.5 the raw profit stop is 105 * 0.5 = 52.5, below entry; the
    // floor is what stops an armed trail from booking a loss. The hard leg is
    // disabled here so nothing else can mask it.
    const config = rawCfg({
      trailingStopPct: 'nope',
      profitTrail: { enabled: true, activationPct: '0.05', trailPct: '0.5' },
    });
    const out = resolveStopLevel(config, entry, high, new Decimal('105'), [], NO_BAND);
    expect(out.stop?.toString()).toBe('100');
  });

  it('uses the ATR chandelier as the hard leg when it is computable', () => {
    const candles: Candle[] = ['90', '100', '95', '110', '105', '120'].map((c, i) => ({
      openTimeMs: i * 3_600_000,
      closeTimeMs: (i + 1) * 3_600_000,
      open: c,
      high: c,
      low: c,
      close: c,
      volume: '1',
      isClosed: true,
    }));
    const config = cfg({ atrTrailingStop: { enabled: true, period: 3, multiple: '2' } });
    const out = resolveStopLevel(config, entry, high, null, candles, NO_BAND);
    // Anything but the fixed 120 * 0.95 proves the ATR leg was taken.
    expect(out.stop?.toString()).not.toBe('114');
    expect((out.stop as Decimal).lt(high)).toBe(true);
  });

  it('reports no stop at all when the hard leg is unusable and the trail is off', () => {
    // An unparseable retrace with ATR off means the operator has no hard stop
    // configured. Inventing one would be a level they never chose, so the tick
    // holds instead.
    for (const pct of ['nope', '0', '1.5']) {
      expect(
        resolveStopLevel(rawCfg({ trailingStopPct: pct }), entry, high, null, [], NO_BAND).stop,
      ).toBe(null);
    }
  });

  it('still reports the profit leg when the hard leg is unusable', () => {
    const config = rawCfg({ trailingStopPct: 'nope', ...TRAIL_ON });
    const out = resolveStopLevel(config, entry, high, new Decimal('200'), [], NO_BAND);
    expect(out.stop?.toString()).toBe('194');
  });

  it('falls back to the schema defaults when the trail percentages are unparseable', () => {
    const config = rawCfg({
      profitTrail: { enabled: true, activationPct: 'x', trailPct: 'y' },
    });
    // Defaults 0.05 / 0.03 → armed at 105, stop 200 * 0.97 = 194.
    const out = resolveStopLevel(config, entry, high, new Decimal('200'), [], NO_BAND);
    expect(out.stop?.toString()).toBe('194');
  });

  describe('under onBandBlock clamp', () => {
    // Floor is `120 × 0.95 ÷ 0.98 × 1.01` = 117.49, above the 114 the trail asks
    // for, so a working clamp is visible as a raise and an inert one as 114.
    const BAND: StopBandContext = {
      reference: '120',
      band: {
        bidMultiplierUp: '5',
        bidMultiplierDown: '0.2',
        askMultiplierUp: '5',
        askMultiplierDown: '0.95',
        avgPriceMins: 5,
      },
    };
    const clamp = (over: Record<string, unknown> = {}) => ({
      protectiveStop: { enabled: true, onBandBlock: 'clamp', ...over },
    });

    it('reads the same default offset the resting order prices its limit leg from', () => {
      // A profile saved before `limitOffsetPercentage` existed carries no key, so
      // the floor has to come from the same default the order itself uses. A
      // second default here would floor at a price the order never carries.
      const out = resolveStopLevel(rawCfg(clamp()), entry, high, null, [], BAND);
      expect(out.floorClamped).toBe(true);
      expect(out.stop?.gt(new Decimal('114'))).toBe(true);
    });

    it('leaves the level alone when the offset it would divide by is unusable', () => {
      // No offset means no floor to derive, and inventing one would move the stop
      // to a price the operator never chose.
      const out = resolveStopLevel(
        rawCfg(clamp({ limitOffsetPercentage: 'x' })),
        entry,
        high,
        null,
        [],
        BAND,
      );
      expect(out.floorClamped).toBe(false);
      expect(out.stop?.toString()).toBe('114');
    });

    it('leaves the level alone on an offset that arms no order at all', () => {
      // `computeProtectiveStopLevel` refuses an offset at or above 1 — the limit
      // would price at or over the trigger — so nothing rests at the exchange and
      // there is no order for the clamp to keep the level aligned with. Clamping
      // anyway tightens the operator's in-process exit to satisfy a band that is
      // never judged: at '1' the floor is 115.14 and the untouched trail is 114.
      for (const limitOffsetPercentage of ['1', '1.5']) {
        const out = resolveStopLevel(
          rawCfg(clamp({ limitOffsetPercentage })),
          entry,
          high,
          null,
          [],
          BAND,
        );
        expect(out.floorClamped).toBe(false);
        expect(out.stop?.toString()).toBe('114');
      }
    });

    it('leaves the level alone when the band has no reference price to sit against', () => {
      // The band is published but the tick carries no price to apply it to, which
      // is the fail-open case every other band guard already takes.
      const out = resolveStopLevel(rawCfg(clamp()), entry, high, null, [], {
        reference: null,
        band: BAND.band,
      });
      expect(out.floorClamped).toBe(false);
      expect(out.stop?.toString()).toBe('114');
    });
  });
});
