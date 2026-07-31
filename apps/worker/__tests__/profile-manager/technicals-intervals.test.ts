// Locks the worker-side Technicals interval extract against the same key
// the API + tick-context use (`profile.config.technicals`). A prior bug
// read `cfg.tradingView` (the pre-migration name), which silently dropped
// every operator-configured interval and replaced it with the schema
// default — the cron then cached signals at the wrong (symbol, interval)
// pair and the symbol panel never found a row for the operator's actual
// interval.

import { describe, expect, it } from 'vitest';

import { resolveTechnicalsIntervals } from '../../src/profile-manager/technicals-intervals.js';

const row = (interval: string) => ({
  interval,
  whenStrongBuy: true,
  whenBuy: true,
  whenSell: false,
  whenStrongSell: false,
  whenNeutral: false,
});

describe('resolveTechnicalsIntervals', () => {
  it("returns the operator's configured intervals from cfg.technicals", () => {
    const out = resolveTechnicalsIntervals({
      technicals: {
        useOnlyWithinMin: 2,
        ifExpires: 'do-not-buy',
        intervals: [row('5m'), row('1h')],
      },
    });
    expect(out).toEqual(['5m', '1h']);
  });

  it('preserves operator-entered order across rows', () => {
    const out = resolveTechnicalsIntervals({
      technicals: { intervals: [row('1h'), row('5m'), row('15m')] },
    });
    expect(out).toEqual(['1h', '5m', '15m']);
  });

  it('falls back to schema defaults when the technicals block is absent', () => {
    expect(resolveTechnicalsIntervals({})).toEqual(['1m']);
  });

  it("never reads the legacy 'tradingView' key (migration regression guard)", () => {
    // The pre-migration field name was `tradingView`. If the extractor ever
    // reads it again, this profile would yield `['5m']` instead of the
    // schema default `['1m']`. The assertion holds the new contract:
    // `tradingView` is ignored entirely, the schema default applies.
    const out = resolveTechnicalsIntervals({
      tradingView: { intervals: [row('5m')] },
    });
    expect(out).toEqual(['1m']);
  });

  it('handles null / undefined / non-object config gracefully', () => {
    expect(resolveTechnicalsIntervals(null)).toEqual(['1m']);
    expect(resolveTechnicalsIntervals(undefined)).toEqual(['1m']);
  });
});
