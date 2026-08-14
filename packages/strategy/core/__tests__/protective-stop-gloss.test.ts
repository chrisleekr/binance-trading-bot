import { describe, expect, it } from 'vitest';

import { explainProtectiveStopBandRefusal } from '../src/protective-stop-gloss.js';
import { percentPriceBySideRefusal } from '../src/protective-stop.js';

const BAND = {
  bidMultiplierUp: '1.1',
  bidMultiplierDown: '0.5',
  askMultiplierUp: '2',
  askMultiplierDown: '0.9',
  avgPriceMins: 5,
};

describe('explainProtectiveStopBandRefusal', () => {
  it('quotes the refusal derived percentages instead of re-deriving them', () => {
    // Fed the REAL refusal record, not a hand-written bag: the whole point of the
    // derived fields is that no surface repeats the algebra, and a fixture typed
    // out by hand would let this pass while the two drifted apart.
    const blocker = percentPriceBySideRefusal({
      symbol: 'LINKUSDT',
      reference: '8.8320',
      band: BAND,
      desired: { stopPrice: '7.462', price: '7.312', quantity: '3.13' },
      guarded: false,
    });
    if (blocker === null) throw new Error('expected the band to refuse this stop');
    const copy = explainProtectiveStopBandRefusal(blocker.detail);

    expect(copy.maxStopDistance).toBe('8.15%');
    expect(copy.requiredStopDistance).toBe('15.51%');
    expect(copy.remedy).toContain('8.15%');
    expect(copy.remedy).toContain('15.51%');
    // 15.51% is past `1 - askMultiplierDown`, so no offset value reaches it.
    expect(copy.remedy).toContain('cannot rescue');
  });

  it('reads exposure off the refusal, so no surface has to decide it alone', () => {
    // The two surfaces disagreed here: the push alert asserted "no safety net"
    // on every refusal while the symbol screen picked by `guarded`, so a re-price
    // the band refused — which leaves the OLD stop resting — reached the operator
    // as both covered and uncovered. Fed the real refusal record, both ways.
    const refuse = (guarded: boolean): string => {
      const blocker = percentPriceBySideRefusal({
        symbol: 'LINKUSDT',
        reference: '8.8320',
        band: BAND,
        desired: { stopPrice: '7.462', price: '7.312', quantity: '3.13' },
        guarded,
      });
      if (blocker === null) throw new Error('expected the band to refuse this stop');
      return explainProtectiveStopBandRefusal(blocker.detail).exposure;
    };
    expect(refuse(true)).toContain('is not unguarded');
    expect(refuse(false)).toContain('no safety net');
    // A detail bag that lost the flag must over-warn, never under-warn.
    expect(explainProtectiveStopBandRefusal({}).exposure).toContain('no safety net');
  });

  it('names the stop-distance knob for either strategy, and the fallback setting', () => {
    // The refusal record carries no strategy identity, so both knobs are named:
    // quoting only one sends half the operators hunting for a field their profile
    // does not have.
    const copy = explainProtectiveStopBandRefusal({ bound: 'floor', terminal: false });
    expect(copy.remedy).toContain('trailingStopPct');
    expect(copy.remedy).toContain('sell.stopLossPercentage');
    expect(copy.remedy).toContain('onBandBlock');
    expect(copy.remedy).toContain('clamp');
    expect(copy.remedy).toContain('native-trail');
  });

  it('rules the limit offset out only once no offset value could reach the stop', () => {
    // The floor binds on the REFERENCE price, so `1 - askMultiplierDown` is the
    // deepest stop the pair can ever take. Past it the offset is spent; short of
    // it, saying so would be false.
    const spent = explainProtectiveStopBandRefusal({
      bound: 'floor',
      askMultiplierDown: '0.9',
      requiredStopDistancePct: '0.155',
    });
    expect(spent.remedy).toContain('cannot rescue');
    expect(spent.remedy).toContain('10%');

    const reachable = explainProtectiveStopBandRefusal({
      bound: 'floor',
      askMultiplierDown: '0.9',
      requiredStopDistancePct: '0.0876',
    });
    expect(reachable.remedy).not.toContain('limitOffsetPercentage');
  });

  it('never offers a negative maximum as a depth to aim at', () => {
    const copy = explainProtectiveStopBandRefusal({
      bound: 'floor',
      terminal: true,
      maxStopDistancePct: '-0.020408',
    });
    expect(copy.remedy).not.toContain('-2.04%');
    expect(copy.remedy).toContain('no resting stop at all');
    expect(copy.situation).toContain('no price move');
  });

  it('names only the remedies that can work once no stop distance is placeable', () => {
    // The terminal case is `limitOffset <= askMultiplierDown`, where the maximum
    // is non-positive: tightening reaches nothing, and the clamp escape returns
    // the level untouched. Offering either is the ordinary advice pointed the
    // wrong way, and "clamp" in particular claims a fallback that never fires.
    const copy = explainProtectiveStopBandRefusal({
      bound: 'floor',
      terminal: true,
      maxStopDistancePct: '-0.020408',
      askMultiplierDown: '0.9',
      requiredStopDistancePct: '0.05',
    });
    expect(copy.remedy).toContain('limitOffsetPercentage');
    expect(copy.remedy).toContain('native-trail');
    expect(copy.remedy).toContain('Tightening the stop cannot fix this');
    expect(copy.remedy).not.toContain('trailingStopPct');
    expect(copy.remedy).not.toContain('sell.stopLossPercentage');
    expect(copy.remedy).not.toContain('deepest level Binance does accept');
    // 5% is inside `1 - askMultiplierDown`, so raising the offset does reach it
    // and the "not enough on its own" qualifier must stay off.
    expect(copy.remedy).not.toContain('not be enough on its own');
  });

  it('qualifies the offset advice when raising it alone still cannot reach the stop', () => {
    const copy = explainProtectiveStopBandRefusal({
      bound: 'floor',
      terminal: true,
      maxStopDistancePct: '-0.020408',
      askMultiplierDown: '0.9',
      requiredStopDistancePct: '0.155',
    });
    expect(copy.remedy).toContain('limitOffsetPercentage');
    expect(copy.remedy).toContain('not be enough on its own');
    expect(copy.remedy).toContain('10%');
    // The ordinary branch's flat "cannot rescue" would contradict the sentence
    // that just told the operator to raise it.
    expect(copy.remedy).not.toContain('cannot rescue');
  });

  it('gives the ceiling case no floor number and no setting to change', () => {
    // A real ceiling refusal, not a hand-written bag: the trigger breaches the
    // ceiling while the limit stays inside, which is the only shape that reaches
    // this branch — and the shape whose `requiredStopDistancePct` goes negative.
    const blocker = percentPriceBySideRefusal({
      symbol: 'LINKUSDT',
      reference: '1',
      band: BAND,
      desired: { stopPrice: '2.5', price: '1.96', quantity: '3.13' },
      guarded: false,
    });
    if (blocker === null) throw new Error('expected the band to refuse this stop');
    expect(blocker.detail['bound']).toBe('ceiling');
    expect(String(blocker.detail['requiredStopDistancePct'])).toMatch(/^-/);

    const copy = explainProtectiveStopBandRefusal(blocker.detail);
    expect(copy.remedy).toBe('');
    expect(copy.maxStopDistance).toBeNull();
    // Negative on this branch by construction, so printing it would ask the
    // operator to act on "asking for -150%".
    expect(copy.requiredStopDistance).toBeNull();
    expect(copy.situation).toContain('priced too HIGH');
    expect(copy.situation).toContain('Do not tighten');
  });

  it('drops a clause rather than leaking a placeholder when the detail is sparse', () => {
    // The SPA reads this bag back off a JSON projection, so a legacy record can
    // arrive with none of the derived fields at all.
    for (const detail of [
      {},
      { maxStopDistancePct: null, requiredStopDistancePct: null },
      { maxStopDistancePct: 'not-a-number', askMultiplierDown: 'x' },
      // Parses, but is not a number to print. A division by a zero multiplier
      // stringifies to exactly this, and it must drop its clause the same way an
      // unparseable field does rather than render "Infinity%" as a stop distance.
      { maxStopDistancePct: 'Infinity', requiredStopDistancePct: '-Infinity' },
    ]) {
      const copy = explainProtectiveStopBandRefusal(detail);
      for (const line of [copy.situation, copy.remedy]) {
        expect(line).not.toMatch(/null|undefined|NaN/);
      }
      expect(copy.situation.length).toBeGreaterThan(0);
    }
  });
});
