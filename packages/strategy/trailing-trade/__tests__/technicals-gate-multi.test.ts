// Multi-interval technicals-gate aggregation: the buy gate ANDs across every
// participating interval (one with a non-empty allow-buy set). The
// per-interval tests in `technicals-freshness.test.ts` exercise the
// single-row path through the strategy's `tick()`; this file pins the
// new aggregation rules directly against `evaluateTechnicalsGate`.

import { describe, expect, it } from 'vitest';
import { evaluateTechnicalsGate } from '../src/technicals-gate.js';
import { TechnicalsIntervalConfigSchema, type TechnicalsBundle } from '@app/contracts';
import type { TTForceBuyOverride } from '../src/schema.js';

const NOW_MS = 1_700_000_000_000;

const intervalRow = (
  interval: string,
  overrides?: Partial<{
    whenStrongBuy: boolean;
    whenBuy: boolean;
    whenSell: boolean;
    whenStrongSell: boolean;
    whenNeutral: boolean;
    mode: 'block' | 'advisory';
  }>,
) => ({
  interval,
  whenStrongBuy: true,
  whenBuy: true,
  whenSell: false,
  whenStrongSell: false,
  whenNeutral: false,
  mode: 'block' as const,
  ...overrides,
});

const override: TTForceBuyOverride = { checkTechnicals: true };

const tv = (
  rows: ReturnType<typeof intervalRow>[],
  signals: { interval: string; signal: TechnicalsBundle['signals'][number]['signal'] }[],
  useOnlyWithinMin = 2,
  ifExpires: 'do-not-buy' | 'allow-anyway' = 'do-not-buy',
): TechnicalsBundle => ({
  config: { useOnlyWithinMin, ifExpires, intervals: rows },
  signals,
});

const sig = (
  recommendation: 'BUY' | 'SELL' | 'STRONG_SELL' | 'NEUTRAL' | 'STRONG_BUY',
  ageMs = 0,
) => ({
  symbol: 'BTCUSDT',
  recommendation,
  maRecommendation: null,
  oscRecommendation: null,
  receivedAtMs: NOW_MS - ageMs,
  indicators: null,
});

describe('evaluateTechnicalsGate — multi-interval aggregation', () => {
  it('passes when every participating interval reports a recommendation in its allow-buy set', () => {
    const out = evaluateTechnicalsGate(
      tv(
        [intervalRow('5m'), intervalRow('1h')],
        [
          { interval: '5m', signal: sig('STRONG_BUY') },
          { interval: '1h', signal: sig('BUY') },
        ],
      ),
      override,
      NOW_MS,
    );
    expect(out.ok).toBe(true);
  });

  it('vetoes when any participating interval reports SELL', () => {
    const out = evaluateTechnicalsGate(
      tv(
        [intervalRow('5m'), intervalRow('1h')],
        [
          { interval: '5m', signal: sig('STRONG_BUY') },
          { interval: '1h', signal: sig('SELL') },
        ],
      ),
      override,
      NOW_MS,
    );
    expect(out).toMatchObject({ ok: false, reason: 'technicals-sell', interval: '1h' });
  });

  it('vetoes when any participating interval has no signal', () => {
    const out = evaluateTechnicalsGate(
      tv(
        [intervalRow('5m'), intervalRow('1h')],
        [
          { interval: '5m', signal: sig('STRONG_BUY') },
          { interval: '1h', signal: null },
        ],
      ),
      override,
      NOW_MS,
    );
    expect(out).toMatchObject({ ok: false, reason: 'technicals-no-signal', interval: '1h' });
  });

  it('vetoes when any participating interval has a stale signal under ifExpires=do-not-buy', () => {
    const out = evaluateTechnicalsGate(
      tv(
        [intervalRow('5m'), intervalRow('1h')],
        [
          { interval: '5m', signal: sig('STRONG_BUY') },
          { interval: '1h', signal: sig('BUY', 3 * 60_000) }, // 3 min old; window = 2 min
        ],
        2,
        'do-not-buy',
      ),
      override,
      NOW_MS,
    );
    expect(out).toMatchObject({ ok: false, reason: 'technicals-stale', interval: '1h' });
  });

  it('passes a stale signal under ifExpires=allow-anyway as long as the recommendation is in the allow set', () => {
    const out = evaluateTechnicalsGate(
      tv(
        [intervalRow('5m'), intervalRow('1h')],
        [
          { interval: '5m', signal: sig('STRONG_BUY') },
          { interval: '1h', signal: sig('BUY', 3 * 60_000) },
        ],
        2,
        'allow-anyway',
      ),
      override,
      NOW_MS,
    );
    expect(out.ok).toBe(true);
  });

  it('skips a non-participating interval (both whenStrongBuy and whenBuy off) even on SELL', () => {
    // Operator configured this row only for force-sell pressure — it must
    // not contribute to the buy gate.
    const out = evaluateTechnicalsGate(
      tv(
        [
          intervalRow('5m'),
          intervalRow('1h', { whenStrongBuy: false, whenBuy: false, whenStrongSell: true }),
        ],
        [
          { interval: '5m', signal: sig('BUY') },
          { interval: '1h', signal: sig('SELL') },
        ],
      ),
      override,
      NOW_MS,
    );
    expect(out.ok).toBe(true);
  });

  it('lets NEUTRAL pass even on a participating interval', () => {
    const out = evaluateTechnicalsGate(
      tv([intervalRow('5m')], [{ interval: '5m', signal: sig('NEUTRAL') }]),
      override,
      NOW_MS,
    );
    expect(out.ok).toBe(true);
  });

  it('vetoes BUY as technicals-disallowed (not -sell) when the operator only allows STRONG_BUY', () => {
    // A BUY is bullish, not a sell: the operator unchecked "Buy" on this row,
    // so the block is a config choice and must NOT read as a bearish veto.
    const out = evaluateTechnicalsGate(
      tv(
        [intervalRow('5m', { whenStrongBuy: true, whenBuy: false })],
        [{ interval: '5m', signal: sig('BUY') }],
      ),
      override,
      NOW_MS,
    );
    expect(out).toMatchObject({ ok: false, reason: 'technicals-disallowed', interval: '5m' });
  });

  it('vetoes STRONG_BUY as technicals-disallowed when "Strong Buy" is unchecked', () => {
    // The exact #534 trap: a 15m row with whenStrongBuy off blocks a STRONG_BUY
    // reading. The block is real but it is NOT a sell.
    const out = evaluateTechnicalsGate(
      tv(
        [intervalRow('15m', { whenStrongBuy: false, whenBuy: true })],
        [{ interval: '15m', signal: sig('STRONG_BUY') }],
      ),
      override,
      NOW_MS,
    );
    expect(out).toMatchObject({ ok: false, reason: 'technicals-disallowed', interval: '15m' });
  });

  it('prefers a SELL veto over a disallowed one when both rows block', () => {
    // technicals-sell (priority 4) outranks technicals-disallowed (priority 3),
    // so a genuinely bearish interval surfaces over a config-disallowed one.
    const out = evaluateTechnicalsGate(
      tv(
        [intervalRow('5m', { whenStrongBuy: false, whenBuy: true }), intervalRow('1h')],
        [
          { interval: '5m', signal: sig('STRONG_BUY') }, // disallowed (priority 3)
          { interval: '1h', signal: sig('SELL') }, // sell (priority 4) wins
        ],
      ),
      override,
      NOW_MS,
    );
    expect(out).toMatchObject({ ok: false, reason: 'technicals-sell', interval: '1h' });
  });

  it('keeps the highest-priority veto when a later row vetoes at lower priority', () => {
    // First row SELL → technicals-sell (priority 4); second row no-signal
    // (priority 1). The second veto does not displace the first because
    // 1 > 4 is false, so the reported reason stays technicals-sell on 5m.
    const out = evaluateTechnicalsGate(
      tv(
        [intervalRow('5m'), intervalRow('1h')],
        [
          { interval: '5m', signal: sig('SELL') },
          { interval: '1h', signal: null },
        ],
      ),
      override,
      NOW_MS,
    );
    expect(out).toMatchObject({ ok: false, reason: 'technicals-sell', interval: '5m' });
  });

  it('promotes a higher-priority later veto over an earlier lower-priority one', () => {
    // First row no-signal (priority 1); second row SELL (priority 3). The
    // second veto wins because 3 > 1, so the reported reason flips to 1h.
    const out = evaluateTechnicalsGate(
      tv(
        [intervalRow('5m'), intervalRow('1h')],
        [
          { interval: '5m', signal: null },
          { interval: '1h', signal: sig('SELL') },
        ],
      ),
      override,
      NOW_MS,
    );
    expect(out).toMatchObject({ ok: false, reason: 'technicals-sell', interval: '1h' });
  });

  it('opens fully when intervals[] is empty (operator opted out of Technicals)', () => {
    const out = evaluateTechnicalsGate(tv([], []), override, NOW_MS);
    expect(out.ok).toBe(true);
  });

  it('skips the gate when forceBuyOverride.checkTechnicals=false regardless of signals', () => {
    const out = evaluateTechnicalsGate(
      tv([intervalRow('5m')], [{ interval: '5m', signal: sig('STRONG_SELL') }]),
      { checkTechnicals: false },
      NOW_MS,
    );
    expect(out.ok).toBe(true);
  });
});

describe('evaluateTechnicalsGate intervalsConsulted (iter49)', () => {
  const override: TTForceBuyOverride = { checkTechnicals: true };
  it('emits the full per-interval breakdown on a pass result', () => {
    const out = evaluateTechnicalsGate(
      tv(
        [intervalRow('5m'), intervalRow('1h')],
        [
          { interval: '5m', signal: sig('BUY') },
          { interval: '1h', signal: sig('STRONG_BUY') },
        ],
      ),
      override,
      NOW_MS,
    );
    expect(out.ok).toBe(true);
    expect(out.intervalsConsulted).toEqual([
      { interval: '5m', recommendation: 'BUY', verdict: 'pass', advisory: false },
      { interval: '1h', recommendation: 'STRONG_BUY', verdict: 'pass', advisory: false },
    ]);
  });

  it('emits the full per-interval breakdown on a veto result, identifying every offending row', () => {
    const out = evaluateTechnicalsGate(
      tv(
        [intervalRow('5m'), intervalRow('1h')],
        [
          { interval: '5m', signal: sig('BUY') },
          { interval: '1h', signal: sig('SELL') },
        ],
      ),
      override,
      NOW_MS,
    );
    expect(out.ok).toBe(false);
    expect(out.intervalsConsulted).toEqual([
      { interval: '5m', recommendation: 'BUY', verdict: 'pass', advisory: false },
      { interval: '1h', recommendation: 'SELL', verdict: 'technicals-sell', advisory: false },
    ]);
  });

  it('labels a bullish-but-not-allowed row verdict as technicals-disallowed in the breakdown', () => {
    const out = evaluateTechnicalsGate(
      tv(
        [intervalRow('15m', { whenStrongBuy: false, whenBuy: true })],
        [{ interval: '15m', signal: sig('STRONG_BUY') }],
      ),
      override,
      NOW_MS,
    );
    expect(out.ok).toBe(false);
    expect(out.intervalsConsulted).toEqual([
      {
        interval: '15m',
        recommendation: 'STRONG_BUY',
        verdict: 'technicals-disallowed',
        advisory: false,
      },
    ]);
  });

  it('records null recommendation when a participating row has no signal yet', () => {
    const out = evaluateTechnicalsGate(
      tv([intervalRow('5m')], [{ interval: '5m', signal: null }]),
      override,
      NOW_MS,
    );
    expect(out.ok).toBe(false);
    expect(out.intervalsConsulted).toEqual([
      { interval: '5m', recommendation: null, verdict: 'technicals-no-signal', advisory: false },
    ]);
  });

  it('returns an empty intervalsConsulted when the gate is short-circuited (no intervals or override off)', () => {
    expect(evaluateTechnicalsGate(tv([], []), override, NOW_MS).intervalsConsulted).toEqual([]);
    expect(
      evaluateTechnicalsGate(
        tv([intervalRow('5m')], [{ interval: '5m', signal: sig('BUY') }]),
        { checkTechnicals: false },
        NOW_MS,
      ).intervalsConsulted,
    ).toEqual([]);
  });
});

describe('evaluateTechnicalsGate — advisory mode (issue #258)', () => {
  it('does not veto when the only failing row is advisory (1h advisory STRONG_SELL + 4h block BUY)', () => {
    const out = evaluateTechnicalsGate(
      tv(
        [intervalRow('1h', { mode: 'advisory' }), intervalRow('4h')],
        [
          { interval: '1h', signal: sig('STRONG_SELL') },
          { interval: '4h', signal: sig('BUY') },
        ],
      ),
      override,
      NOW_MS,
    );
    expect(out.ok).toBe(true);
    expect(out.intervalsConsulted).toEqual([
      { interval: '1h', recommendation: 'STRONG_SELL', verdict: 'technicals-sell', advisory: true },
      { interval: '4h', recommendation: 'BUY', verdict: 'pass', advisory: false },
    ]);
  });

  it('still vetoes when a block row fails even if other rows are advisory', () => {
    const out = evaluateTechnicalsGate(
      tv(
        [intervalRow('1h', { mode: 'advisory' }), intervalRow('4h')],
        [
          { interval: '1h', signal: sig('BUY') },
          { interval: '4h', signal: sig('SELL') },
        ],
      ),
      override,
      NOW_MS,
    );
    expect(out).toMatchObject({ ok: false, reason: 'technicals-sell', interval: '4h' });
  });

  it('treats a stale advisory row as advisory rather than promoting to veto', () => {
    const out = evaluateTechnicalsGate(
      tv(
        [intervalRow('5m', { mode: 'advisory' }), intervalRow('1h')],
        [
          { interval: '5m', signal: sig('BUY', 5 * 60_000) },
          { interval: '1h', signal: sig('BUY') },
        ],
        2,
        'do-not-buy',
      ),
      override,
      NOW_MS,
    );
    expect(out.ok).toBe(true);
  });

  it('all rows advisory and all failing — gate passes (observability only)', () => {
    const out = evaluateTechnicalsGate(
      tv(
        [intervalRow('5m', { mode: 'advisory' }), intervalRow('1h', { mode: 'advisory' })],
        [
          { interval: '5m', signal: sig('STRONG_SELL') },
          { interval: '1h', signal: sig('SELL') },
        ],
      ),
      override,
      NOW_MS,
    );
    expect(out.ok).toBe(true);
    expect(out.intervalsConsulted.every((c) => c.advisory)).toBe(true);
  });

  it('defaults `mode` to `block` when the schema parses a row without it (back-compat)', () => {
    const parsed = TechnicalsIntervalConfigSchema.parse({
      interval: '5m',
      whenStrongBuy: true,
      whenBuy: true,
      whenSell: false,
      whenStrongSell: false,
      whenNeutral: false,
    });
    expect(parsed.mode).toBe('block');
  });
});
