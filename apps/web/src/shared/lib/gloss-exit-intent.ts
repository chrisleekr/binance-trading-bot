// Turn an archived cycle's exit intent (the intent of the last SELL order) into
// plain language for a non-finance operator (invariant #3). Shared so the
// archive band and the per-row badge gloss the same code identically. Glosses
// the trading term inline the first time it appears; an unrecognised code falls
// back to an honest "unknown" line so a future strategy's intent never renders
// blank.

/** Short badge label per exit-intent code (per-row, terse). */
export function exitIntentLabel(intent: string): string {
  switch (intent) {
    case 'grid-stop-loss':
      return 'stop-loss';
    case 'technicals-force-sell':
      return 'force-sell';
    case 'grid-sell':
      return 'profit-taking';
    case 'manual':
      return 'manual';
    case 'unknown':
    case 'backfill':
      return 'unknown';
    default:
      return intent;
  }
}

/** Full glossed sentence per exit-intent code (band caption, first appearance). */
export function glossExitIntent(intent: string): string {
  switch (intent) {
    case 'grid-stop-loss':
      return 'stop-loss — emergency sell after a drop';
    case 'technicals-force-sell':
      return 'force-sell — technical signal exit';
    case 'grid-sell':
      return 'trailing/grid sell — profit-taking exit';
    case 'manual':
      return 'manual sell';
    case 'unknown':
    case 'backfill':
      return 'unknown — recovered history without an exit reason';
    default:
      return intent;
  }
}
