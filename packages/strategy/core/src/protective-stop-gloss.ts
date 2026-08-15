import { Decimal } from '@app/money';

import { decOrNull } from './balances.js';

// One refusal, one explanation, wherever the operator meets it. The push alert
// and the symbol screen used to word this independently and reached opposite
// advice on the same blocker, which is worse than either wording alone: the
// operator cannot tell which surface is lying. Sentences live here, in the
// package that owns the refusal, so a surface can only quote them.
//
// Deliberately consumes the sparse `detail` bag rather than a typed blocker: the
// SPA reads it back off a JSON projection, so every field is untrusted and a
// missing one must drop its clause rather than leak `undefined` into a sentence.

/** Percent for an operator: two places, never exponential, or null when the input is not a usable number. */
const asPercent = (raw: unknown): string | null => {
  if (typeof raw !== 'string' && typeof raw !== 'number') return null;
  try {
    const value = new Decimal(raw);
    return value.isFinite() ? `${value.mul(100).toDecimalPlaces(2).toString()}%` : null;
  } catch {
    return null;
  }
};

/** The refusal explained, split so each surface can lay it out its own way without rewording it. */
export interface ProtectiveStopBandExplanation {
  /** The stop is priced too HIGH, not too low. Waiting is the only fix, and tightening makes it worse. */
  readonly ceiling: boolean;
  /** Widest stop this symbol accepts right now, pre-formatted, or null when the band did not publish enough to derive it. */
  readonly maxStopDistance: string | null;
  /** Stop distance this profile is asking for, pre-formatted, or null when it could not be derived. */
  readonly requiredStopDistance: string | null;
  /** What Binance is refusing and whether waiting clears it. One self-contained sentence pair. */
  readonly situation: string;
  /**
   * How exposed the position is right now. Separate from {@link situation}
   * because the two answers are opposites and the refusal alone does not pick
   * between them: a re-price the band refused leaves the OLD stop resting, so
   * the position is still covered, while a first arm the band refused leaves
   * nothing at all. The push alert used to assert the uncovered sentence
   * unconditionally and the symbol screen picked correctly, which put the two
   * surfaces in direct contradiction on one block.
   */
  readonly exposure: string;
  /** The settings that actually resolve it. Empty on the ceiling case, where no setting is at fault. */
  readonly remedy: string;
}

const STOP = 'protective stop (the automatic sell that caps a loss)';

const UNGUARDED = 'Until it is placed, this position has no safety net.';
const STILL_GUARDED =
  'An earlier protective stop is still resting on Binance and was deliberately left there, so the position is not unguarded — the bot just cannot move the stop up to its new level yet.';

// Named with the words the settings form uses, so the operator can find the knob
// on the screen rather than in a config file. Both stop-resting strategies are
// named because the refusal record carries no strategy identity, and quoting the
// wrong one would send an operator hunting for a field their profile lacks.
const KNOBS =
  'Two settings fix it. Either make the stop distance smaller — that is "trailingStopPct" on a momentum profile, or "sell.stopLossPercentage" on a trailing-trade one — or change "onBandBlock", the profile\'s "If Binance rejects the backup stop" setting: "clamp" rests the stop at the deepest level Binance does accept, closer to the market than you asked for, and "native-trail" hands Binance a trailing stop that this price band does not apply to, which sells at the market price when it triggers rather than at a limit — provided the symbol accepts a trail at your stop distance, which the settings screen warns you about when it does not.';

// The terminal case inverts the ordinary advice, so it gets its own sentences.
// No stop distance is placeable there, which rules out tightening; and the clamp
// escape returns the level untouched rather than rest a trigger that fires on
// contact, so offering it would promise a fallback that does nothing. What is
// left is the offset itself — the one input the operator can move that lifts the
// maximum at all — and the trail, which the band does not govern.
const TERMINAL_KNOBS =
  'Tightening the stop cannot fix this, and "clamp" has no level to clamp to. Raise "limitOffsetPercentage" instead, the fraction of the trigger the stop sells down to, so the two prices fit inside the band together; or set "onBandBlock", the profile\'s "If Binance rejects the backup stop" setting, to "native-trail", which hands Binance a trailing stop that this price band does not apply to and sells at the market price when it triggers rather than at a limit — provided the symbol accepts a trail at your stop distance, which the settings screen warns you about when it does not.';

/**
 * Turn a `price-outside-exchange-band` refusal into the operator's explanation.
 *
 * Reads the derived percentages the refusal already carries instead of
 * re-deriving them from the raw band multipliers: two surfaces re-running that
 * algebra is two chances to quote a different maximum for one symbol.
 *
 * Three shapes, because the operator's next move differs in each. A CEILING
 * breach is priced too high, clears itself, and gets no remedy at all — quoting a
 * floor at that operator, or telling them to tighten, sends them the wrong way. A
 * TERMINAL floor breach can never arm at any price, so it must not promise that
 * waiting helps. An ordinary floor breach does clear on a price move, and still
 * names the settings, because an operator watching an unguarded position wants
 * more than "wait".
 *
 * `limitOffsetPercentage` reads as two opposite things and the branch decides
 * which. Ordinarily it is a distraction, named only to rule it out and only when
 * the numbers prove it: the band's floor binds on the reference price, so once
 * the stop is deeper than `1 − askMultiplierDown` no offset value reaches it. In
 * the terminal case it is the ONLY input that lifts the maximum off zero, so it
 * is named as the fix — qualified by that same arithmetic when it cannot get
 * there alone.
 */
export const explainProtectiveStopBandRefusal = (
  detail: Readonly<Record<string, unknown>>,
): ProtectiveStopBandExplanation => {
  const ceiling = detail['bound'] === 'ceiling';
  const terminal = detail['terminal'] === true;
  const maxStopDistance = asPercent(detail['maxStopDistancePct']);
  const requiredStopDistance = asPercent(detail['requiredStopDistancePct']);
  // Absence reads as unguarded, matching the blocker's own default: a detail bag
  // that lost the flag on the JSON round-trip must over-warn, never under-warn.
  const exposure = detail['guarded'] === true ? STILL_GUARDED : UNGUARDED;

  if (ceiling) {
    return {
      ceiling,
      maxStopDistance: null,
      // Both distances are floor-side readings. `requiredStopDistancePct` is
      // `1 − trigger ÷ reference`, which a trigger ABOVE the reference makes
      // negative — "stop distance asked for: -4.2%" is not a number the operator
      // can act on, and printing it invites them to hunt for a setting holding it.
      requiredStopDistance: null,
      situation: `The bot cannot place this position's ${STOP}: it is priced too HIGH for the range Binance accepts on this pair right now. The bot re-checks every cycle and places it once the market catches up. Do not tighten the stop to fix this — a tighter stop sits higher still, which pushes it further out of range.`,
      exposure,
      remedy: '',
    };
  }

  // `maxStopDistancePct` at or below zero IS the terminal case restated: it is
  // `1 − askMultiplierDown ÷ limitOffset`, non-positive exactly when the offset
  // has fallen to the band's floor multiplier. Quoting "no deeper than -0.5%"
  // would read as a target to aim at.
  const ceilingClause =
    maxStopDistance === null
      ? ''
      : new Decimal(String(detail['maxStopDistancePct'])).gt(0)
        ? ` The deepest stop Binance accepts on this pair right now is ${maxStopDistance} below the market.`
        : ' Binance accepts no resting stop at all on this pair while the limit price sits this far under the trigger.';
  const askingClause =
    requiredStopDistance === null ? '' : ` This profile is asking for ${requiredStopDistance}.`;

  // The absolute ceiling on stop depth for this symbol, reached only with the
  // limit price sitting at the trigger. Above it the offset is spent, which is
  // the one case where naming that knob at all would mislead.
  const floorMultiplier = decOrNull(detail['askMultiplierDown']);
  const required = decOrNull(detail['requiredStopDistancePct']);
  const absoluteMax = floorMultiplier === null ? null : new Decimal(1).minus(floorMultiplier);
  const offsetCeiling =
    absoluteMax !== null && required !== null && required.gt(absoluteMax)
      ? asPercent(absoluteMax.toString())
      : null;
  // The same fact lands as opposite advice in the two branches, so it cannot be
  // one sentence. Ordinarily the offset is a distraction and this rules it out.
  // In the terminal case the offset is the only knob that lifts the maximum at
  // all, so the same arithmetic instead qualifies the advice just given: raising
  // it is necessary here, and on its own still not sufficient.
  const offsetIsSpent =
    offsetCeiling === null
      ? ''
      : terminal
        ? ` Raising it will not be enough on its own: even with the limit price sitting right at the trigger, this pair's band would still allow no more than ${offsetCeiling}, so the stop distance has to come down as well — or use "native-trail", which the band does not govern.`
        : ` Widening "limitOffsetPercentage" cannot rescue a stop this deep: even with the limit price sitting right at the trigger, this pair's band would still allow no more than ${offsetCeiling}.`;

  const situation = terminal
    ? `The bot cannot place this position's ${STOP}: the gap between its trigger price and the limit price it sells down to is wider than the whole range Binance allows for a sell on this pair, so no price move will make it placeable.`
    : `The bot cannot place this position's ${STOP}: it sits further below the market than Binance accepts for a sell on this pair right now. The bot re-checks every cycle and places it as soon as the market moves back into range.`;

  return {
    ceiling,
    maxStopDistance,
    requiredStopDistance,
    situation,
    exposure,
    remedy:
      `${ceilingClause}${askingClause} ${terminal ? TERMINAL_KNOBS : KNOBS}${offsetIsSpent}`.trim(),
  };
};
