import { describe, expect, it } from 'vitest';
import { render, screen } from '@testing-library/react';

import { SymbolProtectiveStopBlocker } from '@/features/symbol/components/symbol-protective-stop-blocker';
import { glossProtectiveStopBlocker } from '@/shared/lib/gloss-protective-stop-blocker';

describe('<SymbolProtectiveStopBlocker>', () => {
  it('renders nothing when the stop is armed', () => {
    const { container } = render(<SymbolProtectiveStopBlocker protectiveStopBlocker={null} />);
    expect(container).toBeEmptyDOMElement();
  });

  it('names the shortfall and tells the operator what to do about it', () => {
    render(
      <SymbolProtectiveStopBlocker
        protectiveStopBlocker={{
          reason: 'base-locked-by-foreign-order',
          detail: { required: '189.87', free: '0' },
        }}
      />,
    );
    const panel = screen.getByTestId('symbol-protective-stop-blocker');
    expect(panel).toHaveTextContent(/protective stop not in place/i);
    // The operator is a solo non-expert: the term is glossed and the fix is named.
    expect(panel).toHaveTextContent(/automatic sell that caps a loss/i);
    expect(panel).toHaveTextContent(/189\.87/);
    expect(panel).toHaveTextContent(/cancel that order on Binance/i);
  });

  it('softens the alert when a stop is resting but stuck at an older level', () => {
    // Danger red is reserved for a position with nothing standing behind it. A
    // stop that merely cannot move up yet is a warning, or the red stops meaning
    // anything.
    render(
      <SymbolProtectiveStopBlocker
        protectiveStopBlocker={{
          reason: 'price-outside-exchange-band',
          detail: { price: '7.312', floor: '7.9488', avgPriceMins: 5, guarded: true },
        }}
      />,
    );
    const panel = screen.getByTestId('symbol-protective-stop-blocker');
    expect(panel).toHaveTextContent(/stuck at an older level/i);
    expect(panel).not.toHaveTextContent(/not in place/i);
    expect(panel.className).toMatch(/warning/);
    expect(panel.className).not.toMatch(/danger/);
  });
});

describe('glossProtectiveStopBlocker', () => {
  it('drops the numbers when the detail is absent, and still reads as a sentence', () => {
    const line = glossProtectiveStopBlocker({ reason: 'base-locked-by-foreign-order' });
    expect(line).toMatch(/locked by another sell order/i);
    expect(line).not.toMatch(/undefined/);
  });

  it('tells the operator to sit tight when the price band will move back on its own', () => {
    const line = glossProtectiveStopBlocker({
      reason: 'price-outside-exchange-band',
      detail: { price: '7.312', floor: '7.9488', avgPriceMins: 5, terminal: false },
    });
    expect(line).toMatch(/automatic sell that caps a loss/i);
    expect(line).toMatch(/last 5 minutes/);
    expect(line).toMatch(/7\.9488/);
    expect(line).toMatch(/moves back into range/i);
    // Raising the offset is not the remedy for a recoverable block, and naming a
    // knob at all invites an operator to change one while nothing is wrong.
    expect(line).not.toMatch(/limitOffsetPercentage/);
  });

  it('quotes the widest stop the symbol takes and names the settings that fix it', () => {
    const line = glossProtectiveStopBlocker({
      reason: 'price-outside-exchange-band',
      detail: {
        price: '7.312',
        floor: '7.9488',
        avgPriceMins: 5,
        askMultiplierDown: '0.9',
        maxStopDistancePct: '0.081633',
        requiredStopDistancePct: '0.0876',
        terminal: false,
      },
    });
    // The number the operator has to compare their setting against, quoted from
    // the refusal rather than re-derived on this screen.
    expect(line).toMatch(/8\.16%/);
    expect(line).toMatch(/8\.76%/);
    // The knob that actually controls stop distance, for either strategy, plus
    // the escape that keeps the operator's distance intact.
    expect(line).toMatch(/trailingStopPct/);
    expect(line).toMatch(/sell\.stopLossPercentage/);
    expect(line).toMatch(/onBandBlock/);
    expect(line).toMatch(/native-trail/);
  });

  it('offers only the remedies that work once the pair accepts no stop at all', () => {
    // Terminal means the maximum placeable stop distance is already <= 0, so the
    // ordinary advice inverts: tightening reaches nothing, and "clamp" returns the
    // level untouched rather than rest a trigger that fires on contact, so
    // offering it would promise a fallback that does nothing. Raising the offset
    // is what lifts the maximum off zero — but 1 - askMultiplierDown = 10% is the
    // deepest stop this pair can EVER take, reached only with the limit price
    // sitting at the trigger, and 15.5% is past it. So the offset is named as
    // necessary AND as insufficient on its own; saying either half alone costs the
    // operator an afternoon.
    const line = glossProtectiveStopBlocker({
      reason: 'price-outside-exchange-band',
      detail: {
        price: '6.715',
        floor: '7.9488',
        avgPriceMins: 5,
        askMultiplierDown: '0.9',
        maxStopDistancePct: '-0.020408',
        requiredStopDistancePct: '0.155',
        terminal: true,
      },
    });
    expect(line).toMatch(/limitOffsetPercentage/);
    expect(line).toMatch(/not be enough on its own/i);
    expect(line).toMatch(/no more than 10%/);
    // Terminal means no price ever arms it, so the recoverable copy must not leak
    // in and promise that waiting helps.
    expect(line).toMatch(/no price move/i);
    expect(line).not.toMatch(/moves back into range/i);
    // A negative maximum is not a target to aim at.
    expect(line).not.toMatch(/-2\.04%/);
    // The escape the band does not govern is still offered; the two that cannot
    // work here are not. Clamp in particular is inert at a non-positive maximum,
    // so naming it would tell the operator a fallback is covering them.
    expect(line).toMatch(/native-trail/);
    expect(line).toMatch(/no level to clamp to/);
    expect(line).not.toMatch(/trailingStopPct/);
    expect(line).not.toMatch(/deepest level Binance does accept/);
  });

  it('says the last trade price, not a 0-minute average, when avgPriceMins is 0', () => {
    const line = glossProtectiveStopBlocker({
      reason: 'price-outside-exchange-band',
      detail: { avgPriceMins: 0, terminal: false },
    });
    expect(line).toMatch(/last trade/i);
    expect(line).not.toMatch(/0 minutes/);
    expect(line).not.toMatch(/undefined/);
  });

  it('drops the no-safety-net line when a stop is still resting on Binance', () => {
    // The refusal only stopped the stop from MOVING. Telling the operator the
    // position is naked would be false, and false alarms are how the real one
    // gets ignored.
    const stale = glossProtectiveStopBlocker({
      reason: 'price-outside-exchange-band',
      detail: { price: '7.312', floor: '7.9488', avgPriceMins: 5, guarded: true },
    });
    expect(stale).toMatch(/still resting on Binance/i);
    expect(stale).not.toMatch(/no safety net/i);
    // Absent flag is unknown coverage, and unknown reads as uncovered — the
    // louder default. Over-warning costs a glance, under-warning the position.
    const naked = glossProtectiveStopBlocker({
      reason: 'price-outside-exchange-band',
      detail: { price: '7.312', floor: '7.9488', avgPriceMins: 5 },
    });
    expect(naked).toMatch(/no safety net/i);
  });

  it('quotes the ceiling, not the floor, when the stop sits above the band', () => {
    // Printing "lowest allowed sell of 6" at an operator whose stop is priced at
    // 7.312 is a self-contradicting sentence, and the number to act on is the one
    // that was actually breached.
    const line = glossProtectiveStopBlocker({
      reason: 'price-outside-exchange-band',
      detail: {
        price: '7.312',
        floor: '2.7',
        ceiling: '6',
        bound: 'ceiling',
        avgPriceMins: 5,
        maxStopDistancePct: '0.081633',
        requiredStopDistancePct: '0.0876',
      },
    });
    expect(line).toMatch(/highest allowed sell of 6/i);
    expect(line).not.toMatch(/2\.7/);
    // A stop priced too HIGH is not fixed by any setting, and every remedy on the
    // floor side makes it worse: a smaller stop distance sits higher still.
    expect(line).toMatch(/priced too HIGH/);
    expect(line).not.toMatch(/trailingStopPct/);
    expect(line).not.toMatch(/onBandBlock/);
    expect(line).not.toMatch(/8\.16%/);
  });

  it('does not present the estimated floor as the exact rejection point', () => {
    // The bot bands against the current price, not the window Binance averages
    // over, so an operator comparing the two must not be told they are the same.
    const line = glossProtectiveStopBlocker({
      reason: 'price-outside-exchange-band',
      detail: { price: '7.312', floor: '7.9488', avgPriceMins: 5 },
    });
    expect(line).toMatch(/estimate/i);
  });

  it('names no averaging window at all when avgPriceMins is missing', () => {
    // A legacy cache entry carries the band without the window; the sentence must
    // still read as English rather than leaking `null`.
    const line = glossProtectiveStopBlocker({
      reason: 'price-outside-exchange-band',
      detail: { price: '7.312' },
    });
    expect(line).toMatch(/works it out itself|works out itself/i);
    expect(line).not.toMatch(/null|undefined|NaN/);
  });

  it('never renders blank for a reason code it does not know', () => {
    // A future strategy's code must degrade to a sentence, not an empty panel.
    const line = glossProtectiveStopBlocker({ reason: 'some-future-strategy-reason' });
    expect(line.length).toBeGreaterThan(0);
    expect(line).toMatch(/protective stop/i);
  });
});
