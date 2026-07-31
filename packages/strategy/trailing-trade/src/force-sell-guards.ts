/**
 * Sub-1h candle intervals and their period in whole minutes. A force-sell armed
 * on one of these reacts to a single intraday print, so it needs a confirm
 * window and a rebuy cooldown by default; 1h and above are slow enough that a
 * single closed candle is already a deliberate signal. The map is the only
 * interval-to-minutes lookup this helper needs, so it lives here rather than as
 * a shared util with one consumer.
 */
const SUB_HOUR_INTERVAL_MINUTES: Readonly<Record<string, number>> = {
  '1m': 1,
  '5m': 5,
  '15m': 15,
  '30m': 30,
};

/**
 * Minimal shape {@link resolveForceSellGuards} reads off the parsed technicals
 * bundle. Buy-side interval toggles are irrelevant to force-sell resolution, so
 * only the three sell toggles are required; the two guard fields are optional so
 * a raw stored config that predates them resolves to the safe default.
 */
export interface ForceSellGuardInput {
  intervals: readonly {
    // `string | undefined` so a loose form-value row (web nudge) with an
    // unselected interval still satisfies the shape; an undefined interval
    // simply misses the sub-1h minute map and contributes nothing.
    interval?: string | undefined;
    whenSell?: boolean | undefined;
    whenStrongSell?: boolean | undefined;
    whenNeutral?: boolean | undefined;
  }[];
  // `| undefined` (not bare `?:`) so a caller under exactOptionalPropertyTypes
  // may pass a `number | undefined` value, e.g. the parsed bundle's optional
  // field, without first narrowing it.
  forceSellConfirmMinutes?: number | undefined;
  forceSellReentryCooldownMinutes?: number | undefined;
}

/** Resolved force-sell guards: both already coerced to a concrete minute count. */
export interface ForceSellGuards {
  confirmMinutes: number;
  cooldownMinutes: number;
}

/**
 * Resolves the two force-sell guard defaults. A force-sell armed on a sub-1h
 * interval exits on a single intraday print and can rebuy on the next tick;
 * without a confirm window and a cooldown that whipsaws a position in chop. So
 * when neither field is set explicitly, derive a safe non-zero default from the
 * enabled triggers:
 *
 *   - confirmMinutes defaults to the SHORTEST enabled sub-1h force-sell
 *     interval's period in minutes, so a flicker must persist past a full candle
 *     of the fastest armed interval. The resolver cannot know which interval
 *     will fire, so the window is sized to the noisiest one; a slower armed
 *     interval's candle is longer than this window. 0 when no sub-1h trigger.
 *   - cooldownMinutes defaults to 60 when any sub-1h force-sell trigger is
 *     armed, else 0.
 *
 * An explicit number, including 0, is always returned verbatim so an informed
 * operator can opt out. Pure integer math; no Date / RNG / I/O.
 */
export const resolveForceSellGuards = (input: ForceSellGuardInput): ForceSellGuards => {
  // Period in minutes of each enabled sub-1h force-sell interval. A row counts
  // as a force-sell trigger when any of the three sell toggles is on, mirroring
  // `forceSellTriggers` in @app/contracts; checked inline so the param stays a
  // permissive literal shape rather than the full interval-config type.
  const subHourMinutes = input.intervals
    .filter(
      (row) => row.whenSell === true || row.whenStrongSell === true || row.whenNeutral === true,
    )
    .map((row) =>
      row.interval !== undefined ? SUB_HOUR_INTERVAL_MINUTES[row.interval] : undefined,
    )
    .filter((m): m is number => m !== undefined);

  const hasSubHourTrigger = subHourMinutes.length > 0;
  // `Math.min` is banned in strategy code (the purity rule forbids the `Math`
  // global wholesale to keep `Math.random` out), so fold the minimum by hand.
  // Empty ⇒ 0 (no sub-1h trigger); otherwise seed the fold with the first
  // element so a single-element list returns it rather than the 0 sentinel.
  const shortestSubHour = hasSubHourTrigger
    ? subHourMinutes.reduce((min, m) => (m < min ? m : min))
    : 0;

  const confirmMinutes =
    input.forceSellConfirmMinutes !== undefined ? input.forceSellConfirmMinutes : shortestSubHour;
  const cooldownMinutes =
    input.forceSellReentryCooldownMinutes !== undefined
      ? input.forceSellReentryCooldownMinutes
      : hasSubHourTrigger
        ? 60
        : 0;

  return { confirmMinutes, cooldownMinutes };
};
