import { describe, expect, it } from 'vitest';

import { ttStopBandSettings } from '../src/stop-level.js';
import { TTConfigSchema, type TTConfig } from '../src/index.js';

// The reader hands a host the three numbers the band arithmetic needs. It is fed
// a schema-parsed config by the API and a RAW stored one by anything that reuses
// it, so the cases below also stand in for a config leaf that is simply absent.
const cfg = (sell: Record<string, unknown>): TTConfig =>
  TTConfigSchema.parse({
    symbol: 'BTCUSDT',
    buy: { enabled: true, entrySizing: { mode: 'fixed', amount: '50' } },
    sell: { enabled: true, triggerPercentage: '1.05', ...sell },
  });

describe('ttStopBandSettings', () => {
  it('reads the stop distance as the complement of the stop-loss fraction', () => {
    const settings = ttStopBandSettings(
      cfg({
        stopLossPercentage: '0.96',
        protectiveStop: { enabled: true, limitOffsetPercentage: '0.995', onBandBlock: 'clamp' },
      }),
    );
    // `0.96` rests the stop at 96% of entry, which is 4% BELOW it.
    expect(settings?.stopDistancePct.toString()).toBe('0.04');
    expect(settings?.limitOffsetPct.toString()).toBe('0.995');
    expect(settings?.onBandBlock).toBe('clamp');
    // The path is what points the operator's form at the field to change.
    expect(settings?.path).toEqual(['sell', 'stopLossPercentage']);
  });

  it('reads a config saved before onBandBlock existed as the notify default', () => {
    // The live worker never schema-parses, so the key is genuinely absent on
    // stored rows. Defaulting anywhere but here would misname the consequence.
    const raw = {
      sell: { stopLossPercentage: '0.96', protectiveStop: { enabled: true } },
    } as unknown as TTConfig;
    const settings = ttStopBandSettings(raw);
    expect(settings?.onBandBlock).toBe('notify');
    // Same fallback the resting order derives its price floor from; a second
    // default would judge the band against an offset the order never carries.
    expect(settings?.limitOffsetPct.toString()).toBe('0.995');
  });

  it('is null when no stop rests at the exchange', () => {
    expect(ttStopBandSettings(cfg({ stopLossPercentage: '0.96' }))).toBeNull();
    expect(
      ttStopBandSettings(cfg({ stopLossPercentage: '0.96', protectiveStop: { enabled: false } })),
    ).toBeNull();
  });

  it('is null on a stop-loss fraction the sell gate itself reads as unset', () => {
    // Empty / zero is "no stop-loss"; `1` stops at entry, which is not a
    // loss-side stop. Neither leaves a distance to judge a band against.
    for (const stopLossPercentage of ['', '0', '1']) {
      expect(
        ttStopBandSettings(cfg({ stopLossPercentage, protectiveStop: { enabled: true } })),
      ).toBeNull();
    }
  });
});
