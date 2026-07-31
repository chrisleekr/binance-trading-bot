// Vendored indicator streaming-API coverage (#441).
//
// computeTechnicalsRating only ever calls `updates(arr, false)` then
// `getResult()`, so the vendored classes' full streaming surface — the
// `replace=true` correction path, `getResultOrThrow` throwing before warm-up,
// `getRequiredInputs`, `isStable`, the trend-signal helpers, and the static
// batch helpers — is never exercised by the rating tests. These drive each
// class through that surface directly. The math is the upstream
// trading-signals (MIT) implementation; the assertions check the documented
// behaviour, not snapshots.

import { describe, expect, it } from 'vitest';

import { EMA } from '../../src/rating/vendored/trend/EMA/EMA.js';
import { SMA } from '../../src/rating/vendored/trend/SMA/SMA.js';
import { WMA } from '../../src/rating/vendored/trend/WMA/WMA.js';
import { WSMA } from '../../src/rating/vendored/trend/WSMA/WSMA.js';
import { RMA } from '../../src/rating/vendored/trend/RMA/RMA.js';
import { DEMA } from '../../src/rating/vendored/trend/DEMA/DEMA.js';
import { DX } from '../../src/rating/vendored/trend/DX/DX.js';
import { ADX } from '../../src/rating/vendored/trend/ADX/ADX.js';
import { MACD } from '../../src/rating/vendored/momentum/MACD/MACD.js';
import { RSI } from '../../src/rating/vendored/momentum/RSI/RSI.js';
import { MOM } from '../../src/rating/vendored/momentum/MOM/MOM.js';
import { AO } from '../../src/rating/vendored/momentum/AO/AO.js';
import { CCI } from '../../src/rating/vendored/momentum/CCI/CCI.js';
import { WilliamsR } from '../../src/rating/vendored/momentum/WILLR/WilliamsR.js';
import { StochasticOscillator } from '../../src/rating/vendored/momentum/STOCH/StochasticOscillator.js';
import { StochasticRSI } from '../../src/rating/vendored/momentum/STOCHRSI/StochasticRSI.js';
import { ATR } from '../../src/rating/vendored/volatility/ATR/ATR.js';
import { TR } from '../../src/rating/vendored/volatility/TR/TR.js';
import { MAD } from '../../src/rating/vendored/volatility/MAD/MAD.js';
import { VWMA } from '../../src/rating/vendored/volume/VWMA/VWMA.js';
import { Period } from '../../src/rating/vendored/types/Period.js';
import { getAverage } from '../../src/rating/vendored/util/getAverage.js';
import { pushUpdate } from '../../src/rating/vendored/util/pushUpdate.js';
import { NotEnoughDataError } from '../../src/rating/vendored/error/NotEnoughDataError.js';

interface HLC {
  high: number;
  low: number;
  close: number;
}
interface HLCV extends HLC {
  volume: number;
}

const hlc = (high: number, low: number, close: number): HLC => ({ high, low, close });

describe('vendored util', () => {
  it('getAverage returns 0 for an empty array and the mean otherwise', () => {
    expect(getAverage([])).toBe(0);
    expect(getAverage([2, 4, 6])).toBe(4);
  });

  it('pushUpdate replaces the last element when replace=true, else appends + trims', () => {
    const arr: number[] = [];
    expect(pushUpdate(arr, false, 1, 2)).toBeNull();
    pushUpdate(arr, false, 2, 2);
    // replace overwrites the last slot rather than growing the array
    pushUpdate(arr, true, 9, 2);
    expect(arr).toEqual([1, 9]);
    // appending past maxLength returns the shifted-out element
    expect(pushUpdate(arr, false, 3, 2)).toBe(1);
    expect(arr).toEqual([9, 3]);
  });
});

describe('vendored base TechnicalIndicator API', () => {
  it('add() and replace() delegate to update() with the right replace flag', () => {
    const sma = new SMA(2);
    // add == update(x, false)
    expect(sma.add(2)).toBeNull();
    sma.add(4);
    expect(sma.getResultOrThrow()).toBe(3);
    // replace == update(x, true): corrects the last input (4 → 8) → avg 5
    sma.replace(8);
    expect(sma.getResultOrThrow()).toBe(5);
  });

  it('a TrendIndicatorSeries replace as the FIRST update skips both signal-cache arms', () => {
    // First update is a replace → `replace && previousResult !== undefined` is
    // false (previousResult undefined) AND `!replace` is false, so neither
    // signal-state cache arm runs. Drive VWMA to a committed result first by
    // warming with a single bar via replace.
    const vwma = new VWMA(1);
    const bar = { high: 101, low: 99, close: 100, volume: 10 };
    expect(vwma.update(bar, true)).not.toBeNull();
    expect(typeof vwma.getSignal().state).toBe('string');
  });

  it('a TrendIndicatorSeries caches the previous signal state across a replace', () => {
    // RSI extends TrendIndicatorSeries; driving it past warm-up and then
    // replacing the last input exercises the replace branch of setResult that
    // recomputes the previous signal state from previousResult.
    const rsi = new RSI(3);
    rsi.updates([1, 2, 3, 4, 5], false);
    rsi.update(2, true);
    const sig = rsi.getSignal();
    expect(typeof sig.state).toBe('string');
    expect(typeof sig.hasChanged).toBe('boolean');
  });
});

describe('vendored moving averages', () => {
  it('SMA: getRequiredInputs, throws before stable, stabilises, and replace corrects the last value', () => {
    const sma = new SMA(3);
    expect(sma.getRequiredInputs()).toBe(3);
    expect(() => sma.getResultOrThrow()).toThrow(NotEnoughDataError);
    expect(sma.isStable).toBe(false);
    sma.updates([1, 2, 3], false);
    expect(sma.isStable).toBe(true);
    expect(sma.getResultOrThrow()).toBe(2);
    // Replace the last input (3 → 6): average of [1,2,6] = 3.
    sma.update(6, true);
    expect(sma.getResultOrThrow()).toBe(3);
  });

  it('EMA: getRequiredInputs, NotEnoughData before warm-up, replace path, isStable', () => {
    const ema = new EMA(3);
    expect(ema.getRequiredInputs()).toBe(3);
    expect(ema.isStable).toBe(false);
    expect(() => ema.getResultOrThrow()).toThrow(NotEnoughDataError);
    ema.updates([1, 2, 3], false);
    expect(ema.isStable).toBe(true);
    const before = ema.getResultOrThrow();
    ema.update(10, true); // replace the last value
    expect(ema.getResultOrThrow()).not.toBe(before);
    // replace as the very first input exercises the pricesCounter===0 branch
    const ema2 = new EMA(2);
    ema2.update(5, true);
    expect(ema2.isStable).toBe(false);
  });

  it('WMA: getRequiredInputs and weighted result', () => {
    const wma = new WMA(3);
    expect(wma.getRequiredInputs()).toBe(3);
    wma.updates([1, 2, 3], false);
    // WMA(3) of [1,2,3] = (1*1 + 2*2 + 3*3)/(1+2+3) = 14/6
    expect(wma.getResultOrThrow()).toBeCloseTo(14 / 6, 10);
  });

  it('WSMA: getRequiredInputs, seed from SMA, then the smoothing + replace branches', () => {
    const wsma = new WSMA(3);
    expect(wsma.getRequiredInputs()).toBe(3);
    wsma.updates([1, 2, 3], false); // seeds result from SMA
    const seeded = wsma.getResultOrThrow();
    wsma.update(4, false); // the `!replace && result !== undefined` smoothing arm
    expect(wsma.getResultOrThrow()).not.toBe(seeded);
    wsma.update(8, true); // the `replace && previousResult !== undefined` arm
    expect(typeof wsma.getResultOrThrow()).toBe('number');
  });

  it('RMA: getRequiredInputs, NotEnoughData guard, isStable, value, and replace path', () => {
    const rma = new RMA(3);
    expect(rma.getRequiredInputs()).toBe(3);
    expect(rma.isStable).toBe(false);
    expect(() => rma.getResultOrThrow()).toThrow(NotEnoughDataError);
    rma.updates([1, 2, 3, 4, 5], false);
    expect(rma.isStable).toBe(true);
    const before = rma.getResultOrThrow();
    rma.update(10, true); // replace && previousResult !== undefined branch
    expect(rma.getResultOrThrow()).not.toBe(before);
    // replace as the very first input → pricesCounter===0 branch
    const rma2 = new RMA(2);
    rma2.update(7, true);
    expect(rma2.isStable).toBe(false);
  });

  it('DEMA: getRequiredInputs, isStable, value, and replace path', () => {
    const dema = new DEMA(3);
    expect(dema.getRequiredInputs()).toBe(3);
    expect(dema.isStable).toBe(false);
    dema.updates([1, 2, 3, 4, 5, 6, 7], false);
    expect(dema.isStable).toBe(true);
    const before = dema.getResultOrThrow();
    dema.update(20, true); // replace branch
    expect(dema.getResultOrThrow()).not.toBe(before);
  });
});

describe('vendored momentum', () => {
  it('RSI: getRequiredInputs, saturates at 100 on a strictly rising series, and getSignal', () => {
    const rsi = new RSI(3);
    expect(rsi.getRequiredInputs()).toBeGreaterThan(0);
    rsi.updates([1, 2, 3, 4, 5, 6], false); // only gains → avgLoss 0 → 100
    expect(rsi.getResultOrThrow()).toBe(100);
    // result >= 70 → BULLISH signal arm
    expect(rsi.getSignal().state).toBe('BULLISH');
  });

  it('MOM: getRequiredInputs and momentum value', () => {
    const mom = new MOM(3);
    expect(mom.getRequiredInputs()).toBeGreaterThan(0);
    mom.updates([10, 11, 12, 13], false);
    expect(typeof mom.getResultOrThrow()).toBe('number');
  });

  it('AO: getRequiredInputs and a stable value over enough bars', () => {
    const ao = new AO(5, 34);
    expect(ao.getRequiredInputs()).toBe(34);
    const bars = Array.from({ length: 40 }, (_, i) => ({ high: 100 + i, low: 99 + i }));
    ao.updates(bars, false);
    expect(typeof ao.getResultOrThrow()).toBe('number');
  });

  it('CCI: getRequiredInputs and a stable value', () => {
    const cci = new CCI(5);
    expect(cci.getRequiredInputs()).toBe(5);
    const bars = Array.from({ length: 10 }, (_, i) => hlc(100 + i, 98 + i, 99 + i));
    cci.updates(bars, false);
    expect(typeof cci.getResultOrThrow()).toBe('number');
  });

  it('WilliamsR: getRequiredInputs and a value in [-100, 0]', () => {
    const wr = new WilliamsR(5);
    expect(wr.getRequiredInputs()).toBe(5);
    const bars = Array.from({ length: 8 }, (_, i) => hlc(100 + i, 98 + i, 99 + i));
    wr.updates(bars, false);
    const v = wr.getResultOrThrow();
    expect(v).toBeLessThanOrEqual(0);
    expect(v).toBeGreaterThanOrEqual(-100);
  });

  it('StochasticOscillator: getRequiredInputs, replace path, and getSignal arms', () => {
    const stoch = new StochasticOscillator(5, 3, 3);
    expect(stoch.getRequiredInputs()).toBe(5 + 3 + 1);
    const bars = Array.from({ length: 14 }, (_, i) => hlc(100 + i, 90 + i, 95 + i));
    stoch.updates(bars, false);
    expect(stoch.getResultOrThrow().stochK).toBeGreaterThanOrEqual(0);
    // replace the last candle — exercises the `replace` correction branch
    stoch.update(hlc(120, 110, 119), true);
    expect(typeof stoch.getSignal().state).toBe('string');
  });

  it('Stochastic getSignal returns every signal state across regimes', () => {
    // UNKNOWN: no result yet.
    expect(new StochasticOscillator(5, 3, 3).getSignal().state).toBe('UNKNOWN');
    // Overbought: close pinned at the top of the range → %K high → BULLISH.
    const up = new StochasticOscillator(5, 3, 3);
    up.updates(
      Array.from({ length: 14 }, (_, i) => hlc(100 + i, 90 + i, 100 + i)),
      false,
    );
    expect(up.getSignal().state).toBe('BULLISH');
    // Oversold: close pinned at the bottom of the range → %K low → BEARISH.
    const down = new StochasticOscillator(5, 3, 3);
    down.updates(
      Array.from({ length: 14 }, (_, i) => hlc(100 - i, 90 - i, 90 - i)),
      false,
    );
    expect(down.getSignal().state).toBe('BEARISH');
  });

  it('StochasticRSI: getRequiredInputs and saturation behaviour', () => {
    const srsi = new StochasticRSI(3);
    expect(srsi.getRequiredInputs()).toBeGreaterThan(0);
    // Strictly rising closes drive the RSI/stoch toward the 100 saturation arm.
    srsi.updates(
      Array.from({ length: 20 }, (_, i) => 100 + i),
      false,
    );
    expect(typeof srsi.getResultOrThrow()).toBe('number');
  });

  it('MACD: getRequiredInputs, replace path, and getSignal', () => {
    const macd = new MACD(new EMA(3), new EMA(6), new EMA(3));
    expect(macd.getRequiredInputs()).toBe(6);
    macd.updates(
      Array.from({ length: 12 }, (_, i) => 100 + Math.sin(i) * 5),
      false,
    );
    expect(macd.getResultOrThrow()).toHaveProperty('macd');
    macd.update(130, true); // replace branch
    expect(typeof macd.getSignal().state).toBe('string');
    // UNKNOWN: getSignal on a fresh MACD (no result) takes the !hasResult arm.
    expect(new MACD(new EMA(3), new EMA(6), new EMA(3)).getSignal().state).toBe('UNKNOWN');
  });
});

describe('vendored trend (DX / ADX) and volatility', () => {
  it('DX: getRequiredInputs and a flat series drives the dmSum===0 zero-result arm', () => {
    const dx = new DX(3);
    expect(dx.getRequiredInputs()).toBeGreaterThan(0);
    // Constant high/low/close (range > 0 so ATR is non-zero, but no
    // directional movement) → pdi = mdi = 0 → dmSum 0 → result 0.
    const flat = Array.from({ length: 10 }, () => hlc(101, 99, 100));
    dx.updates(flat, false);
    expect(dx.getResultOrThrow()).toBe(0);
  });

  it('DX: replace path with prior candles restores the second-last candle', () => {
    const dx = new DX(3);
    const bars = Array.from({ length: 8 }, (_, i) => hlc(100 + i, 98 + i, 99 + i));
    dx.updates(bars, false);
    dx.update(hlc(120, 118, 119), true); // replace branch with #secondLastCandle set
    expect(typeof dx.getResultOrThrow()).toBe('number');
  });

  it('ADX: getRequiredInputs, mdi/pdi getters, and a stable value', () => {
    const adx = new ADX(3);
    expect(adx.getRequiredInputs()).toBe(3 * 2 - 1);
    const bars = Array.from({ length: 20 }, (_, i) => hlc(100 + i, 98 + i, 99 + i));
    adx.updates(bars, false);
    expect(typeof adx.getResultOrThrow()).toBe('number');
    expect(typeof adx.pdi).toBe('number');
    expect(typeof adx.mdi).toBe('number');
  });

  it('ATR: getRequiredInputs and a stable value', () => {
    const atr = new ATR(3);
    expect(atr.getRequiredInputs()).toBeGreaterThan(0);
    const bars = Array.from({ length: 8 }, (_, i) => hlc(100 + i, 98 + i, 99 + i));
    atr.updates(bars, false);
    expect(typeof atr.getResultOrThrow()).toBe('number');
  });

  it('TR: getRequiredInputs, first-bar high-low, subsequent true-range, and replace path', () => {
    const tr = new TR();
    expect(tr.getRequiredInputs()).toBe(2);
    expect(tr.update(hlc(10, 8, 9), false)).toBe(2); // first bar: high-low
    expect(tr.update(hlc(12, 9, 11), false)).toBeGreaterThan(0); // true range vs prev close
    // replace with a previous candle present → restores #twoPreviousCandle
    expect(tr.update(hlc(13, 10, 12), true)).toBeGreaterThan(0);
  });

  it('MAD: streaming update and the static getResultFromBatch (empty + populated)', () => {
    const mad = new MAD(3);
    expect(mad.getRequiredInputs()).toBe(3);
    mad.updates([2, 4, 6], false);
    expect(mad.getResultOrThrow()).toBeCloseTo((2 + 0 + 2) / 3, 10);
    expect(MAD.getResultFromBatch([])).toBe(0);
    expect(MAD.getResultFromBatch([2, 4, 6])).toBeCloseTo((2 + 0 + 2) / 3, 10);
    // explicit average argument path
    expect(MAD.getResultFromBatch([2, 4, 6], 4)).toBeCloseTo((2 + 0 + 2) / 3, 10);
  });
});

describe('vendored volume + types', () => {
  it('VWMA: getRequiredInputs, returns null before warm-up and on zero volume, then a value + signal', () => {
    const vwma = new VWMA(3);
    expect(vwma.getRequiredInputs()).toBe(3);
    const bar = (c: number, v: number): HLCV => ({ high: c + 1, low: c - 1, close: c, volume: v });
    expect(vwma.update(bar(100, 10), false)).toBeNull(); // < interval → null
    vwma.update(bar(101, 10), false);
    expect(vwma.update(bar(102, 10), false)).not.toBeNull(); // stable
    expect(typeof vwma.getSignal().state).toBe('string');
    // Zero-volume window → the sumVolume===0 null arm.
    const vwmaZ = new VWMA(2);
    vwmaZ.update(bar(100, 0), false);
    expect(vwmaZ.update(bar(101, 0), false)).toBeNull();
  });

  it('VWMA replace after two committed results restores the previous signal state', () => {
    const bar = (c: number, v: number): HLCV => ({ high: c + 1, low: c - 1, close: c, volume: v });
    const vwma = new VWMA(2);
    // Two committed results so previousResult is defined, then a replace —
    // exercises the TrendIndicatorSeries.setResult `replace && previousResult
    // !== undefined` branch.
    vwma.update(bar(100, 10), false);
    vwma.update(bar(102, 10), false);
    vwma.update(bar(104, 10), false);
    vwma.update(bar(106, 10), true);
    expect(typeof vwma.getSignal().state).toBe('string');
  });

  it('Period: getRequiredInputs and the highest/lowest getters', () => {
    const period = new Period(3);
    expect(period.getRequiredInputs()).toBe(3);
    expect(period.highest).toBeUndefined();
    period.updates([5, 1, 3], false);
    expect(period.highest).toBe(5);
    expect(period.lowest).toBe(1);
  });
});
