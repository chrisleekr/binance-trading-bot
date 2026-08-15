import { describe, expect, it } from 'vitest';

import { momentumStopBandSettings } from '../src/protective-stop.js';
import { defaultMomentumConfig, type MomentumConfig } from '../src/schema.js';

// The reader hands a host the three numbers the band arithmetic needs. It is
// fed a schema-parsed config by the API and a RAW stored one by anything that
// reuses it, so every case below also stands in for a config leaf that is simply
// absent.
// The seed config arms the protective stop, so the block is dropped from the
// base: every case below opts back in explicitly, and the absent case is really
// absent.
const cfg = (over: Record<string, unknown>): MomentumConfig => {
  const { protectiveStop: _seeded, ...base } = defaultMomentumConfig();
  return { ...base, ...over } as MomentumConfig;
};

describe('momentumStopBandSettings', () => {
  it('reads the trail distance, the limit offset and the fallback mode', () => {
    const settings = momentumStopBandSettings(
      cfg({
        trailingStopPct: '0.15',
        protectiveStop: { enabled: true, limitOffsetPercentage: '0.98', onBandBlock: 'clamp' },
      }),
    );
    expect(settings?.stopDistancePct.toString()).toBe('0.15');
    expect(settings?.limitOffsetPct.toString()).toBe('0.98');
    expect(settings?.onBandBlock).toBe('clamp');
    // The path is what points the operator's form at the field to change.
    expect(settings?.path).toEqual(['trailingStopPct']);
  });

  it('reads a config saved before onBandBlock existed as the notify default', () => {
    // The live worker never schema-parses, so the key is genuinely absent on
    // stored rows. Defaulting anywhere but here would misname the consequence.
    const settings = momentumStopBandSettings(
      cfg({ trailingStopPct: '0.15', protectiveStop: { enabled: true } }),
    );
    expect(settings?.onBandBlock).toBe('notify');
    // Same fallback the resting order derives its price floor from; a second
    // default would judge the band against an offset the order never carries.
    expect(settings?.limitOffsetPct.toString()).toBe('0.98');
  });

  it('is null when no stop rests at the exchange', () => {
    expect(momentumStopBandSettings(cfg({ trailingStopPct: '0.15' }))).toBeNull();
    expect(
      momentumStopBandSettings(
        cfg({ trailingStopPct: '0.15', protectiveStop: { enabled: false } }),
      ),
    ).toBeNull();
  });

  it('is null on a limit offset the resting order would not use', () => {
    // The default covers an ABSENT key only. Anything else outside (0, 1) leaves
    // no price to judge the floor against: below the range there is nothing to
    // parse or nothing positive, and at or above it the limit prices at or over
    // the trigger. `computeProtectiveStopLevel` refuses all of them, so a warning
    // derived here would describe a stop that never goes out.
    for (const limitOffsetPercentage of ['abc', '0', '-0.5', '1', '1.5']) {
      expect(
        momentumStopBandSettings(
          cfg({
            trailingStopPct: '0.15',
            protectiveStop: { enabled: true, limitOffsetPercentage },
          }),
        ),
      ).toBeNull();
    }
  });

  it('is null on a trail fraction the trail itself would not use', () => {
    // `resolveStopLevel` ignores a fraction outside (0, 1) rather than
    // substituting one, so there is no distance to judge a band against.
    for (const trailingStopPct of ['0', '1', '-0.1', 'abc']) {
      expect(
        momentumStopBandSettings(cfg({ trailingStopPct, protectiveStop: { enabled: true } })),
      ).toBeNull();
    }
  });
});
