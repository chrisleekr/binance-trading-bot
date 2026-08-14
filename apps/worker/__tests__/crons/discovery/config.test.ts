import { describe, expect, it } from 'vitest';
import { asAccountId, asProfileId, asUserId, DiscoveryConfigSchema } from '@app/contracts';
import type { ActiveProfile } from '../../../src/profile-manager/profile-manager.js';
import {
  discoveryResyncRequest,
  parseDiscoveryConfig,
  toPureConfig,
} from '../../../src/crons/discovery/config.js';
import { parseProfileJob } from '../../../src/queues/pipeline-worker.js';

const permissiveConfig = () =>
  DiscoveryConfigSchema.parse({
    enabled: true,
    minAgeDays: 1,
    maxAutoSymbols: 5,
    minHoldMinutes: 60,
    min24hPairVolumeUsd: '1',
    min24hAssetVolumeUsd: '1',
    maxSpreadRatio: '1',
    changeMinPercent: '0',
    rankTopPercent: 100,
    rankExcludeTopPercent: 0,
    trendConfirm: {
      adxPeriod: 2,
      adxMin: '0',
      emaPeriod: 2,
      volSmaPeriod: 2,
      volMultiple: '0.0001',
    },
  });

describe('discoveryResyncRequest', () => {
  // Four DISTINCT UUIDs so the mapping is unambiguous: the request must read
  // operatorId (not userId) and must carry accountId. Omitting accountId or
  // using userId makes parseProfileJob reject the payload as invalid, and the
  // resync fails as an invalid payload and dead-letters (#672).
  const OPERATOR = asUserId('00000000-0000-4000-8000-0000000000a1');
  const USER = asUserId('00000000-0000-4000-8000-0000000000b2');
  const ACCOUNT = asAccountId('00000000-0000-4000-8000-0000000000c3');
  const PROFILE = asProfileId('00000000-0000-4000-8000-0000000000d4');
  const activeProfile: ActiveProfile = {
    profileId: PROFILE,
    userId: USER,
    operatorId: OPERATOR,
    accountId: ACCOUNT,
    candleInterval: '1h',
    symbols: [],
    technicalsIntervals: [],
  };

  it('maps operatorId→userId and carries accountId + profileId', () => {
    expect(discoveryResyncRequest(activeProfile)).toEqual({
      userId: OPERATOR,
      accountId: ACCOUNT,
      profileId: PROFILE,
    });
  });

  it('produces a payload the pipeline worker accepts (round-trips through parseProfileJob)', () => {
    // The seam guard. parseProfileJob is the consumer contract; a request that
    // dropped accountId or used userId would parse to null and no-op the resync.
    expect(parseProfileJob(discoveryResyncRequest(activeProfile))).toEqual({
      userId: OPERATOR,
      accountId: ACCOUNT,
      profileId: PROFILE,
    });
  });
});

describe('toPureConfig', () => {
  it('drops the cron-only fields', () => {
    const pure = toPureConfig(permissiveConfig(), 'USDT');
    expect(pure).not.toHaveProperty('enabled');
    expect(pure).not.toHaveProperty('refreshPeriodMs');
    expect(pure.maxAutoSymbols).toBe(5);
  });

  it('carries the profile quote asset into the pure config', () => {
    const pure = toPureConfig(permissiveConfig(), 'BTC');
    expect(pure.quoteAsset).toBe('BTC');
  });

  it('carries marketBreadthMinPercent through to the pure config', () => {
    const pure = toPureConfig(
      DiscoveryConfigSchema.parse({ marketBreadthMinPercent: '60' }),
      'USDT',
    );
    expect(pure.marketBreadthMinPercent).toBe('60');
  });
});

describe('parseDiscoveryConfig', () => {
  it('parses an empty/absent block to a disabled config', () => {
    expect(parseDiscoveryConfig(undefined)).toMatchObject({ ok: true, cfg: { enabled: false } });
    expect(parseDiscoveryConfig({})).toMatchObject({ ok: true, cfg: { enabled: false } });
  });

  it('parses a valid enabled block', () => {
    expect(parseDiscoveryConfig({ enabled: true })).toMatchObject({
      ok: true,
      cfg: { enabled: true },
    });
  });

  it('reports a malformed block as invalid, distinctly from disabled', () => {
    // Both used to be `null`, which is why a corrupt config looked exactly like
    // a profile the operator had switched off.
    const bad = parseDiscoveryConfig({ maxAutoSymbols: -1 });
    expect(bad.ok).toBe(false);
    const disabled = parseDiscoveryConfig({});
    expect(disabled.ok).toBe(true);
  });

  it('names the offending field so the condition can say what to fix', () => {
    const bad = parseDiscoveryConfig({ maxAutoSymbols: -1 });
    if (bad.ok) throw new Error('expected an invalid parse');
    expect(bad.issues).toHaveLength(1);
    expect(bad.issues[0]).toMatch(/^maxAutoSymbols: /);
  });
});
