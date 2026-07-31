import { describe, expect, it } from 'vitest';

import {
  DEFAULT_ENABLEMENT_POLICY,
  EnablementPolicy,
  ProfilePatch,
  ProfileResponse,
} from '../src/profiles.js';

describe('EnablementPolicy', () => {
  it('fills sensible defaults from an empty object', () => {
    expect(EnablementPolicy.parse({})).toEqual({
      enabled: true,
      minProfitFactor: 1.1,
      minTrades: 100,
      minAlphaVsHoldPct: 0,
      requireOutOfSample: true,
      minOutOfSampleTrades: 20,
      maxBacktestAgeDays: 14,
      monitor: { mode: 'warn', minTrades: 10, warnFactor: 0.85, breachFactor: 0.6 },
    });
    expect(DEFAULT_ENABLEMENT_POLICY).toEqual(EnablementPolicy.parse({}));
  });

  it('ProfileResponse fills the effective policy when the field is absent', () => {
    const parsed = ProfileResponse.parse({
      id: '00000000-0000-4000-8000-000000000001',
      accountId: '00000000-0000-4000-8000-000000000002',
      name: 'p',
      strategyName: 'trailing-trade',
      strategyVersion: '2.0.0',
      config: {},
      enabled: false,
      binanceMode: 'test',
      quoteAsset: 'USDT',
      createdAt: '2026-06-20T00:00:00.000Z',
      updatedAt: '2026-06-20T00:00:00.000Z',
    });
    expect(parsed.enablementPolicy).toEqual(DEFAULT_ENABLEMENT_POLICY);
  });

  it('ProfilePatch accepts a null policy (reset) and a partial that fills defaults', () => {
    expect(ProfilePatch.parse({ enablementPolicy: null }).enablementPolicy).toBeNull();
    expect(ProfilePatch.parse({ enablementPolicy: { minTrades: 5 } }).enablementPolicy).toEqual({
      enabled: true,
      minProfitFactor: 1.1,
      minTrades: 5,
      minAlphaVsHoldPct: 0,
      requireOutOfSample: true,
      minOutOfSampleTrades: 20,
      maxBacktestAgeDays: 14,
      monitor: { mode: 'warn', minTrades: 10, warnFactor: 0.85, breachFactor: 0.6 },
    });
  });
});

describe('ProfileResponse save diagnostics', () => {
  const base = {
    id: '00000000-0000-4000-8000-000000000001',
    accountId: '00000000-0000-4000-8000-000000000002',
    name: 'p',
    strategyName: 'trailing-trade',
    strategyVersion: '2.0.0',
    config: {},
    enabled: false,
    binanceMode: 'test',
    quoteAsset: 'USDT',
    createdAt: '2026-06-20T00:00:00.000Z',
    updatedAt: '2026-06-20T00:00:00.000Z',
  };

  // Every read path parses this schema, and only a config save ever sets the
  // field. If it stopped being optional, every profile read would throw.
  it('omits the field when the response carries none', () => {
    const parsed = ProfileResponse.parse(base);
    expect(parsed).not.toHaveProperty('diagnostics');
  });

  it('round-trips the findings a save attaches', () => {
    const diagnostics = [
      { level: 'warn' as const, code: 'filters-unavailable', message: 'BTCUSDT: not loaded.' },
    ];
    expect(ProfileResponse.parse({ ...base, diagnostics }).diagnostics).toEqual(diagnostics);
  });
});
