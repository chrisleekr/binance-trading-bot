import { describe, expect, it } from 'vitest';
import { render, screen } from '@testing-library/react';

import { SymbolProtectiveStopBlocker } from '@/features/symbol/components/symbol-protective-stop-blocker';
import {
  blockerPositionGuarded,
  glossProtectiveStopBlocker,
} from '@/shared/lib/gloss-protective-stop-blocker';

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

  it('uses a warning when a minimum-size blocker leaves the whole position covered', () => {
    render(
      <SymbolProtectiveStopBlocker
        protectiveStopBlocker={{
          reason: 'base-below-exchange-minimum',
          detail: { resting: '0.020', held: '0.020', guarded: true },
        }}
      />,
    );
    const panel = screen.getByTestId('symbol-protective-stop-blocker');
    expect(panel.className).toMatch(/warning/);
    expect(panel.className).not.toMatch(/danger/);
  });

  it('uses danger when a minimum-size blocker has no coverage flag', () => {
    render(
      <SymbolProtectiveStopBlocker
        protectiveStopBlocker={{
          reason: 'base-below-exchange-minimum',
          detail: { resting: '0.020', held: '0.020' },
        }}
      />,
    );
    const panel = screen.getByTestId('symbol-protective-stop-blocker');
    expect(panel.className).toMatch(/danger/);
    expect(panel.className).not.toMatch(/warning/);
  });
});

describe('glossProtectiveStopBlocker', () => {
  it('explains that a resting stop stays at its old trigger', () => {
    const blocker = {
      reason: 'base-below-exchange-minimum',
      detail: { resting: '0.020', held: '0.020', guarded: true },
    };
    const gloss = glossProtectiveStopBlocker(blocker);

    expect(gloss).toMatch(/stays in place/);
    expect(gloss).not.toMatch(/no safety net/);
    expect(blockerPositionGuarded(blocker)).toBe(true);
  });

  it('describes the uncovered remainder when a resting stop covers only part of the position', () => {
    const blocker = {
      reason: 'base-below-exchange-minimum',
      detail: { resting: '0.010', held: '0.020' },
    };
    const gloss = glossProtectiveStopBlocker(blocker);

    expect(gloss).toMatch(/covers only 0\.010 of the 0\.020/);
    expect(gloss).toMatch(/no safety net/);
    expect(blockerPositionGuarded(blocker)).toBe(false);
  });

  it('keeps the no-safety-net warning when no stop is resting', () => {
    const blocker = { reason: 'base-below-exchange-minimum' };
    const gloss = glossProtectiveStopBlocker(blocker);

    expect(gloss).toMatch(/no safety net/);
    expect(blockerPositionGuarded(blocker)).toBe(false);
  });

  it('tells the operator to top up or sell by hand for a naked full-size refusal', () => {
    const gloss = glossProtectiveStopBlocker({
      reason: 'base-below-exchange-minimum',
      detail: {
        held: '0.00999',
        required: '0.010',
        free: '0.00999',
        available: '0.00999',
        skip: 'min-notional',
        resting: null,
        guarded: false,
      },
    });

    expect(gloss).not.toMatch(/cancel other sell orders/);
    expect(gloss).toMatch(/sell it by hand/);
    expect(gloss).toMatch(/no safety net/);
  });

  it('keeps the foreign-lock remedy for a naked foreign-lock refusal', () => {
    const gloss = glossProtectiveStopBlocker({
      reason: 'base-below-exchange-minimum',
      detail: { free: '0.00999', resting: null, guarded: false },
    });

    expect(gloss).toMatch(/cancel other sell orders/);
  });

  it('names the price the minimum was actually checked at', () => {
    // `required` is derived from the limit leg, so quoting the trigger instead would leave the operator dividing the exchange minimum by the wrong number and concluding the bot miscounted their coins.
    const gloss = glossProtectiveStopBlocker({
      reason: 'base-below-exchange-minimum',
      detail: {
        held: '0.106',
        required: '0.107',
        stop: '95',
        checkedAt: '94',
        skip: 'min-notional',
        resting: null,
        guarded: false,
      },
    });

    expect(gloss).toMatch(/at the price it would sell at \(94\)/);
    expect(gloss).not.toMatch(/at the stop price/);
    // A blocker persisted before the leg field existed was a priced stop; it must still read as the limit sentence rather than leaking a hole where the leg goes.
    expect(gloss).not.toMatch(/undefined|null/i);
  });

  it('names the market price, not a sale price, when a native trailing stop is what would rest', () => {
    // A native trailing STOP_LOSS carries only a quantity and a delta and sells at market, so "the price it would sell at" would name the one price that order will not sell at.
    const gloss = glossProtectiveStopBlocker({
      reason: 'base-below-exchange-minimum',
      detail: {
        held: '0.106',
        required: '0.107',
        stop: '95',
        checkedAt: '100',
        checkedAtLeg: 'market',
        skip: 'min-notional',
        resting: null,
        guarded: false,
      },
    });

    expect(gloss).toMatch(/at the current market price \(100\)/);
    expect(gloss).toMatch(/sells at whatever the market pays/);
    // Binance does not judge a market-type order at a price of the bot's choosing: it values one at an average of recent trade prices, and only when `applyMinToMarket` is set. Which price the bot sized at is the bot's decision, so the copy has to attribute it there. Naming the exchange as the one that measured sends the operator to divide the minimum by a price Binance never looked at.
    expect(gloss).toMatch(/the bot sizes it against the market price/);
    expect(gloss).not.toMatch(/Binance measures it/);
    expect(gloss).not.toMatch(/price it would sell at/);
    expect(gloss).not.toMatch(/at the stop price/);
  });

  it('says it fell back to the trigger, and which way that errs, when no market price was readable', () => {
    // The trigger is the degraded native case, not the normal one. It has to read as a fallback with a stated direction, or the operator cannot tell whether the required figure is too high or too low.
    const gloss = glossProtectiveStopBlocker({
      reason: 'base-below-exchange-minimum',
      detail: {
        held: '0.106',
        required: '0.107',
        stop: '95',
        checkedAt: '95',
        checkedAtLeg: 'trigger',
        skip: 'min-notional',
        resting: null,
        guarded: false,
      },
    });

    expect(gloss).toMatch(/at its trigger price \(95\)/);
    expect(gloss).toMatch(/could not read a usable market price/);
    expect(gloss).toMatch(/more coins than it strictly needs/);
    expect(gloss).not.toMatch(/Binance measures it/);
    expect(gloss).not.toMatch(/price it would sell at/);
  });

  it('falls back to the old wording for a blocker persisted before checkedAt existed', () => {
    // Blockers already sitting on strategy state carry no `checkedAt`, and the sentence has to degrade to the previous phrasing rather than printing a hole where the price goes.
    const gloss = glossProtectiveStopBlocker({
      reason: 'base-below-exchange-minimum',
      detail: {
        held: '0.106',
        required: '0.107',
        skip: 'min-notional',
        resting: null,
        guarded: false,
      },
    });

    expect(gloss).toMatch(/at the stop price/);
    expect(gloss).not.toMatch(/undefined/);
  });

  it('treats a resting stop larger than the holding as fully covered', () => {
    const gloss = glossProtectiveStopBlocker({
      reason: 'base-below-exchange-minimum',
      detail: { resting: '2', held: '0.0001', guarded: true, skip: 'min-qty' },
    });

    expect(gloss).not.toMatch(/covers only/);
    expect(gloss).toMatch(/stays in place/);
  });

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

  it('says which part of the position the resting native trail covers, and why it is not replaced', () => {
    // The operator's obvious move here is to cancel the stop and let the bot re-arm, which is the one action that makes it worse: it hands back the trigger the resting order has already trailed up to. The copy has to name the high-water mark for that reason, not just the shortfall.
    const line = glossProtectiveStopBlocker({
      reason: 'resting-stop-short-of-position',
      detail: { resting: '0.5', held: '1.2' },
    });
    expect(line).toContain('0.5');
    expect(line).toContain('1.2');
    expect(line).toMatch(/highest price|high-water/i);
    expect(line).toMatch(/new high/i);
    expect(line).not.toMatch(/null|undefined|NaN/);
  });

  it('still reads as a sentence when the coverage numbers are missing', () => {
    const line = glossProtectiveStopBlocker({ reason: 'resting-stop-short-of-position' });
    expect(line).toMatch(/covers only part/i);
    expect(line).not.toMatch(/null|undefined|NaN/);
  });

  it('never renders blank for a reason code it does not know', () => {
    // A future strategy's code must degrade to a sentence, not an empty panel.
    const line = glossProtectiveStopBlocker({ reason: 'some-future-strategy-reason' });
    expect(line.length).toBeGreaterThan(0);
    expect(line).toMatch(/protective stop/i);
  });
});
