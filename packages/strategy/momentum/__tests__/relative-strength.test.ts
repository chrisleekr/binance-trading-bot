import { describe, expect, it } from 'vitest';
import type { Candle } from '@app/strategy-core';

import {
  RELATIVE_STRENGTH_KV_PREFIX,
  relativeStrengthGate,
  relativeStrengthNeed,
  relativeStrengthPublish,
  relativeStrengthScore,
  relativeStrengthSettings,
} from '../src/relative-strength.js';

const HOUR = 3_600_000;
const mk = (closes: readonly string[]): Candle[] =>
  closes.map((c, i) => ({
    openTimeMs: i * HOUR,
    closeTimeMs: (i + 1) * HOUR,
    open: c,
    high: c,
    low: c,
    close: c,
    volume: '1',
    isClosed: true,
  }));

// Returns +0.1, -0.1, +0.1: mean 1/30, standard deviation sqrt(0.08/9), score 1/(2*sqrt(2)).
const ZIGZAG = ['10', '11', '9.9', '10.89'];
const ON = { enabled: true, lookbackBars: 3, topK: 2 };
const key = (s: string): string => `${RELATIVE_STRENGTH_KV_PREFIX}${s}`;
const pub = (score: string, candleCloseMs = 4 * HOUR, lookbackBars = 3) => ({
  score,
  candleCloseMs,
  lookbackBars,
});

describe('relativeStrengthSettings', () => {
  it('is off unless enabled is literally true, and falls back to 720 / 3 on malformed leaves', () => {
    expect(relativeStrengthSettings(undefined)).toEqual({
      enabled: false,
      lookbackBars: 720,
      topK: 3,
    });
    expect(relativeStrengthSettings({ enabled: 'true', lookbackBars: 1, topK: 0 })).toEqual({
      enabled: false,
      lookbackBars: 720,
      topK: 3,
    });
    expect(relativeStrengthSettings(ON)).toEqual(ON);
  });
});

describe('relativeStrengthNeed', () => {
  it('needs nothing when off and lookbackBars + 1 closes when on', () => {
    expect(relativeStrengthNeed({ lookbackBars: 720 })).toBe(0);
    expect(relativeStrengthNeed({ enabled: true })).toBe(721);
  });
});

describe('relativeStrengthScore', () => {
  it('is the mean return over its standard deviation across the last lookbackBars returns only', () => {
    expect(relativeStrengthScore(mk(ZIGZAG), 3)?.toFixed(6)).toBe('0.353553');
    // An earlier crash outside the window must not move the score.
    expect(relativeStrengthScore(mk(['1', '100', ...ZIGZAG]), 3)?.toFixed(6)).toBe('0.353553');
  });

  it('is null until the window holds lookbackBars + 1 closes', () => {
    expect(relativeStrengthScore(mk(ZIGZAG.slice(1)), 3)).toBeNull();
  });

  it('is null on a non-positive close it would divide by', () => {
    expect(relativeStrengthScore(mk(['0', '11', '9.9', '10.89']), 3)).toBeNull();
  });

  it('scores a flat price 0 and a perfectly steady riser above any noisy coin', () => {
    expect(relativeStrengthScore(mk(['5', '5', '5', '5']), 3)?.toFixed()).toBe('0');
    // 1% a candle with no noise: a small mean over a zero spread must still outrank the zigzag's 0.35.
    const steady = relativeStrengthScore(mk(['100', '101', '102.01', '103.0301']), 3)!;
    expect(steady.gt(relativeStrengthScore(mk(ZIGZAG), 3)!)).toBe(true);
  });
});

describe('relativeStrengthPublish', () => {
  it('writes nothing while the gate is off', () => {
    expect(relativeStrengthPublish(mk(ZIGZAG), { lookbackBars: 3 }, 'ADAUSDT', {})).toBeNull();
  });

  it('publishes the score stamped with the last close when nothing current is stored', () => {
    const expected = {
      type: 'set-kv',
      key: key('ADAUSDT'),
      value: {
        score: relativeStrengthScore(mk(ZIGZAG), 3)!.toFixed(),
        candleCloseMs: 4 * HOUR,
        lookbackBars: 3,
      },
    };
    expect(relativeStrengthPublish(mk(ZIGZAG), ON, 'ADAUSDT', undefined)).toEqual(expected);
    // An older candle's value, or one that does not parse, is replaced.
    expect(
      relativeStrengthPublish(mk(ZIGZAG), ON, 'ADAUSDT', { [key('ADAUSDT')]: pub('1', 3 * HOUR) }),
    ).toEqual(expected);
    expect(
      relativeStrengthPublish(mk(ZIGZAG), ON, 'ADAUSDT', { [key('ADAUSDT')]: { score: 1 } }),
    ).toEqual(expected);
    // A value scored over another lookback is not this config's score, so it is replaced too.
    expect(
      relativeStrengthPublish(mk(ZIGZAG), ON, 'ADAUSDT', {
        [key('ADAUSDT')]: pub('0.1', 4 * HOUR, 720),
      }),
    ).toEqual(expected);
  });

  // The ticks between candle closes must not rewrite the store every second.
  it('writes nothing when this candle is already published', () => {
    expect(
      relativeStrengthPublish(mk(ZIGZAG), ON, 'ADAUSDT', { [key('ADAUSDT')]: pub('0.1') }),
    ).toBeNull();
  });

  it('drops a stored score once the window can no longer score, and writes nothing if none is stored', () => {
    const short = mk(ZIGZAG.slice(1));
    expect(relativeStrengthPublish(short, ON, 'ADAUSDT', { [key('ADAUSDT')]: pub('0.1') })).toEqual(
      { type: 'delete-kv', key: key('ADAUSDT') },
    );
    expect(relativeStrengthPublish(short, ON, 'ADAUSDT', {})).toBeNull();
  });

  it('writes nothing on an empty window', () => {
    expect(relativeStrengthPublish([], ON, 'ADAUSDT', {})).toBeNull();
  });
});

describe('relativeStrengthGate', () => {
  it('passes without reading anything while off', () => {
    expect(relativeStrengthGate([], { topK: 1 }, 'ADAUSDT', undefined)).toEqual({
      gate: 'pass',
      score: null,
      rank: 0,
      siblings: 0,
    });
  });

  it('refuses when this coin cannot be scored yet', () => {
    expect(relativeStrengthGate(mk(ZIGZAG.slice(1)), ON, 'ADAUSDT', {}).gate).toBe(
      'relative-strength-insufficient-history',
    );
  });

  it('ranks against current siblings only: higher scores count, ties, stale, other-lookback, malformed and own entries do not', () => {
    const own = relativeStrengthScore(mk(ZIGZAG), 3)!.toFixed();
    const kv = {
      // Its own previous-candle value: not a sibling, and not current enough to reuse.
      [key('ADAUSDT')]: pub('99', 3 * HOUR),
      [key('AVAXUSDT')]: pub('5'),
      [key('DOTUSDT')]: pub('5', 3 * HOUR),
      [key('LINKUSDT')]: pub(own),
      [key('LTCUSDT')]: pub('-1'),
      [key('SUIUSDT')]: pub('9', 2 * HOUR),
      [key('TRXUSDT')]: 'garbage',
      [key('PEPEUSDT')]: pub('not-a-number'),
      [key('SHIBUSDT')]: pub('Infinity'),
      [key('XRPUSDT')]: pub('9', 4 * HOUR, 720),
      'other:key': pub('9'),
    };
    const r = relativeStrengthGate(mk(ZIGZAG), ON, 'ADAUSDT', kv);
    expect(r.rank).toBe(2);
    expect(r.siblings).toBe(4);
    expect(r.score?.toFixed()).toBe(own);
    expect(r.gate).toBe('relative-strength');
    expect(relativeStrengthGate(mk(ZIGZAG), { ...ON, topK: 3 }, 'ADAUSDT', kv).gate).toBe('pass');
  });

  // A refused symbol keeps its entry signal and reaches the gate every tick; its stored score for this candle stands in for a rescore.
  it("reuses this symbol's stored score for the current candle and lookback, and rescores otherwise", () => {
    const kv = { [key('AVAXUSDT')]: pub('5') };
    const reused = relativeStrengthGate(mk(ZIGZAG), ON, 'ADAUSDT', {
      ...kv,
      [key('ADAUSDT')]: pub('9'),
    });
    expect(reused.score?.toFixed()).toBe('9');
    expect(reused.rank).toBe(0);
    const own = relativeStrengthScore(mk(ZIGZAG), 3)!;
    expect(
      relativeStrengthGate(mk(ZIGZAG), ON, 'ADAUSDT', {
        ...kv,
        [key('ADAUSDT')]: pub('9', 4 * HOUR, 720),
      }).score?.eq(own),
    ).toBe(true);
  });

  it('passes while no sibling has published', () => {
    expect(
      relativeStrengthGate(mk(ZIGZAG), { ...ON, topK: 1 }, 'ADAUSDT', undefined),
    ).toMatchObject({
      gate: 'pass',
      rank: 0,
      siblings: 0,
    });
  });
});
