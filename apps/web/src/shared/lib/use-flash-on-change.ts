// useFlashOnChange reports a short-lived tone
// whenever a numeric readout changes, so a live value can flash green or red
// on each update the way Binance's ticker does. Display-only — the flash is
// derived from a Number compare and never feeds an order.

import { useEffect, useRef, useState } from 'react';

/** `up` when the new value is larger, `down` when smaller, `null` when idle. */
export type FlashTone = 'up' | 'down' | null;

/** How long the flash tone stays set after a change. */
export const FLASH_MS = 600;

/**
 * Returns a flash tone for `value` that is set for {@link FLASH_MS} after each
 * change, then clears. A non-numeric value, the first render, and a no-op
 * change all yield `null` so the readout does not flash spuriously.
 *
 * Consecutive same-direction changes within {@link FLASH_MS} hold the tint
 * rather than re-pulsing — `setTone('up')` while already `'up'` is a no-op
 * re-render and the timer just resets, so a sustained uptrend reads as a
 * sustained tint, not a strobe.
 */
export function useFlashOnChange(value: string | number | null | undefined): FlashTone {
  const prevRef = useRef(value);
  const [tone, setTone] = useState<FlashTone>(null);

  useEffect(() => {
    // The effect is idempotent: under StrictMode's dev double-invocation the
    // second run sees `prev === value` and no-ops. Keep it that way — do not
    // add a statement here whose repeat would change behaviour.
    const prev = prevRef.current;
    prevRef.current = value;
    if (prev == null || value == null) return;
    const a = Number(prev);
    const b = Number(value);
    if (!Number.isFinite(a) || !Number.isFinite(b) || a === b) return;
    setTone(b > a ? 'up' : 'down');
    const handle = window.setTimeout(() => setTone(null), FLASH_MS);
    return (): void => window.clearTimeout(handle);
  }, [value]);

  return tone;
}
