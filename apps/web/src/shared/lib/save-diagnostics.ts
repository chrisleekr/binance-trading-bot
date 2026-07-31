import type { SaveDiagnostics } from '@app/contracts';
import { toast } from 'sonner';

/**
 * Surface the advisories a successful mutation carried back, so a save the
 * server could not fully check stops looking like one it did.
 *
 * A toast rather than an inline notice because two of the call sites leave the
 * screen on success (add-symbol returns to the overview, a backtest launch swaps
 * to the run view), and anything rendered in place would unmount before it was
 * read. The field is absent whenever there is nothing to report, so the common
 * path calls this and shows nothing.
 *
 * Findings arrive one per symbol, and a config save checks every bound symbol, so
 * an unloaded filter cache on a 50-symbol profile would otherwise queue 50 toasts
 * three at a time. One toast per distinct cause, carrying the count, says the
 * same thing in the space a phone actually has.
 */
export const notifySaveDiagnostics = (diagnostics: SaveDiagnostics): void => {
  // Keyed by cause, holding the first message plus how many symbols hit it. A
  // running count rather than a list of messages, because only the first is ever
  // shown and an accumulated array would need an emptiness check the shape
  // cannot actually produce.
  const byCause = new Map<string, { first: string; count: number }>();
  for (const d of diagnostics ?? []) {
    const seen = byCause.get(d.code);
    if (seen) seen.count += 1;
    else byCause.set(d.code, { first: d.message, count: 1 });
  }
  for (const { first, count } of byCause.values()) {
    // The server copy already names the first affected symbol, so the count only
    // has to say how far the same problem spreads.
    toast.warning(count === 1 ? first : `${first} ${count} symbols affected.`);
  }
};
