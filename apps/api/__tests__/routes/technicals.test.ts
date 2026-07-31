import { describe, expect, it } from 'vitest';

import {
  resolveTechnicalsConfig,
  resolveTechnicalsGateActive,
} from '../../src/routes/technicals.js';

/**
 * `resolveTechnicalsConfig` is the API-side companion to the worker's
 * tick-context extract: the route must publish the same per-profile
 * `useOnlyWithinMin` + `ifExpires` + `intervals[]` the worker's technicals-gate
 * uses, so the web panel's stale-pill threshold matches the worker's
 * veto threshold and the panel tabs render exactly the operator's
 * configured intervals.
 *
 * Falling back to the schema defaults when the field is missing keeps
 * a profile that has never opted in rendering the same UX as before
 * the multi-interval refactor.
 */
const defaultBlock = {
  useOnlyWithinMin: 5,
  ifExpires: 'do-not-buy' as const,
  entryConfirmReads: 1,
  intervals: [
    {
      interval: '1m',
      whenStrongBuy: true,
      whenBuy: true,
      whenSell: false,
      whenStrongSell: false,
      whenNeutral: false,
      mode: 'block' as const,
    },
  ],
};

describe('resolveTechnicalsConfig', () => {
  it("returns the profile's technicals block when present", () => {
    const tradingView = {
      useOnlyWithinMin: 5,
      ifExpires: 'allow-anyway' as const,
      entryConfirmReads: 1,
      intervals: [
        {
          interval: '15m',
          whenStrongBuy: true,
          whenBuy: false,
          whenSell: false,
          whenStrongSell: true,
          whenNeutral: false,
          mode: 'block' as const,
        },
      ],
    };
    expect(resolveTechnicalsConfig({ technicals: tradingView })).toEqual(tradingView);
  });

  it('falls back to the built-in defaults when the field is missing', () => {
    expect(resolveTechnicalsConfig({})).toEqual(defaultBlock);
  });

  it('falls back when the config is not a plain object', () => {
    expect(resolveTechnicalsConfig(null)).toEqual(defaultBlock);
    expect(resolveTechnicalsConfig(undefined)).toEqual(defaultBlock);
  });

  it('falls back when technicals is the wrong shape', () => {
    expect(resolveTechnicalsConfig({ technicals: { useOnlyWithinMin: 0 } })).toEqual(defaultBlock);
    expect(resolveTechnicalsConfig({ technicals: 'oops' })).toEqual(defaultBlock);
  });

  it('preserves operator-configured interval order', () => {
    const intervals = [
      {
        interval: '5m',
        whenStrongBuy: true,
        whenBuy: true,
        whenSell: false,
        whenStrongSell: false,
        whenNeutral: false,
      },
      {
        interval: '1h',
        whenStrongBuy: true,
        whenBuy: false,
        whenSell: false,
        whenStrongSell: true,
        whenNeutral: false,
      },
    ];
    const out = resolveTechnicalsConfig({
      technicals: { useOnlyWithinMin: 2, ifExpires: 'do-not-buy', intervals },
    });
    expect(out.intervals.map((r) => r.interval)).toEqual(['5m', '1h']);
  });
});

describe('resolveTechnicalsGateActive', () => {
  it('defaults to true when forceBuyOverride is absent', () => {
    expect(resolveTechnicalsGateActive({})).toBe(true);
    expect(resolveTechnicalsGateActive({ technicals: {} })).toBe(true);
  });

  it("returns the operator's checkTechnicals flag when present", () => {
    expect(resolveTechnicalsGateActive({ forceBuyOverride: { checkTechnicals: false } })).toBe(
      false,
    );
    expect(resolveTechnicalsGateActive({ forceBuyOverride: { checkTechnicals: true } })).toBe(true);
  });

  it('treats a malformed config as gate-active (safety stance)', () => {
    expect(resolveTechnicalsGateActive(null)).toBe(true);
    expect(resolveTechnicalsGateActive('not-an-object')).toBe(true);
  });
});
