// Turn an archived cycle's exit intent, the intent of the SELL that closed the cycle, into plain language for a non-finance operator (invariant #3). Shared so the archive band and the per-row badge gloss the same code identically. Glosses the trading term inline the first time it appears; an unrecognised code falls back to an honest "unknown" line so a future strategy's intent never renders blank.

/** Short badge label per exit-intent code (per-row, terse). */
export function exitIntentLabel(intent: string): string {
  switch (intent) {
    case 'grid-stop-loss':
      return 'stop-loss';
    case 'technicals-force-sell':
      return 'force-sell';
    case 'grid-sell':
      return 'profit-taking';
    case 'break-even-stop':
      return 'break-even';
    // Both time-based exits read the same at badge width; `glossExitIntent` and the row's tooltip separate them. `protective-stop`, `regime-exit` and `time-stop` need no arm: `default` already returns them verbatim, which is exactly the label wanted.
    case 'discovery-time-stop':
      return 'time-stop';
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
    case 'protective-stop':
      return 'protective stop — a resting stop order that caps the loss';
    case 'regime-exit':
      return 'regime exit — the market turned against the trend that justified the entry';
    case 'break-even-stop':
      return 'break-even stop — exited at cost once the trade stopped working';
    case 'time-stop':
      return 'time stop — closed for going nowhere for too long';
    case 'discovery-time-stop':
      return 'time stop — an auto-discovered coin closed for going nowhere for too long';
    case 'exit':
      return 'exit — the momentum signal that justified the entry faded';
    case 'rotate-exit':
      return 'rotation exit — sold to fund a higher-ranked coin';
    case 'rebalance':
      return 'rebalance — trimmed back to the target weight';
    case 'manual':
      return 'manual sell';
    case 'unknown':
    case 'backfill':
      return 'unknown — recovered history without an exit reason';
    default:
      return intent;
  }
}
