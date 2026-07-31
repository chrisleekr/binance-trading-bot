import { coerceDec, coerceInt } from './config-coerce.js';

/**
 * Extension-guard config coercion, shared by the tick gate, the required-window
 * calc, and the preview projection so the three can never disagree on what the
 * guard reads. The live worker stores config unparsed, so every field arrives as
 * a raw value and is coerced to a safe default here rather than trusted.
 */

/** Baseline lookback as a finite int >= 2, else the 50 default. */
export const extensionPeriod = (raw: unknown): number => coerceInt(raw, { min: 2, fallback: 50 });

/** Stretch ceiling fraction as a positive Decimal, else the 0.4 default. */
export const extensionMaxPercent = (raw: unknown) => coerceDec(raw, { fallback: '0.4' });
