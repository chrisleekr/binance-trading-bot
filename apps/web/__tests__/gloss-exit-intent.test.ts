import { TT_INTENTS } from '@app/strategy-trailing-trade';
import { describe, expect, it } from 'vitest';
import { exitIntentLabel, glossExitIntent } from '@/shared/lib/gloss-exit-intent';

// TT's two entry intents can never be a cycle's exit reason, so they are the only members of TT_INTENTS this file exempts. A new ENTRY intent added to the union therefore fails the sweep below until it is listed here, which is the safe direction: a human decides whether it is an entry or an exit rather than the guard quietly shrinking.
const TT_ENTRY_INTENTS: readonly string[] = ['grid-buy', 'bull-pyramid'];

// Iterated at RUNTIME, not asserted with `satisfies`: vitest strips types without checking them, so a type-level guard in this file would never be evaluated, and apps/web's `tsc -b` covers `src/` only. Reading the exported array is what makes an added intent fail a real assertion.
const TT_EXIT_INTENTS = TT_INTENTS.filter((i) => !TT_ENTRY_INTENTS.includes(i));

// Momentum and rebalance pin no intent union, so their sell reasons are listed literally, read off their `reason:` emission sites in `packages/strategy/{momentum,rebalance}/src/`.
const OTHER_STRATEGY_EXIT_INTENTS = ['exit', 'rotate-exit', 'rebalance'];

const ALL_EXIT_INTENTS = [...TT_EXIT_INTENTS, ...OTHER_STRATEGY_EXIT_INTENTS];

describe('exit-intent gloss coverage', () => {
  it('leaves exactly the two entry intents out of the exit sweep', () => {
    // Guards the filter above against a silent shrink: if TT_INTENTS were emptied or the entry list widened, every `it.each` below would pass vacuously over an empty array.
    expect(TT_EXIT_INTENTS).toHaveLength(TT_INTENTS.length - 2);
    expect(TT_EXIT_INTENTS.length).toBeGreaterThanOrEqual(9);
  });

  it.each(ALL_EXIT_INTENTS)('glosses %s rather than echoing the raw code', (intent) => {
    const glossed = glossExitIntent(intent);
    expect(glossed).not.toBe(intent);
    expect(glossed.length).toBeGreaterThan(intent.length);
  });

  it.each(ALL_EXIT_INTENTS)('returns a non-empty badge label for %s', (intent) => {
    expect(exitIntentLabel(intent).length).toBeGreaterThan(0);
  });
});

describe('glossExitIntent', () => {
  it('glosses the recovered-history codes honestly instead of blank', () => {
    expect(glossExitIntent('unknown')).toBe('unknown — recovered history without an exit reason');
    expect(glossExitIntent('backfill')).toBe('unknown — recovered history without an exit reason');
  });

  it('echoes an unrecognised code rather than rendering blank', () => {
    // A strategy added tomorrow must still show the operator something.
    expect(glossExitIntent('some-future-exit')).toBe('some-future-exit');
  });
});

describe('exitIntentLabel', () => {
  it('collapses both time-based exits onto one badge', () => {
    // Deliberate: they do not fit side by side at badge width, and the full gloss separates them.
    expect(exitIntentLabel('time-stop')).toBe('time-stop');
    expect(exitIntentLabel('discovery-time-stop')).toBe('time-stop');
    expect(glossExitIntent('time-stop')).not.toBe(glossExitIntent('discovery-time-stop'));
  });

  it('reports recovered history as unknown, not as its storage code', () => {
    expect(exitIntentLabel('backfill')).toBe('unknown');
    expect(exitIntentLabel('unknown')).toBe('unknown');
  });

  it('echoes an unrecognised code', () => {
    expect(exitIntentLabel('some-future-exit')).toBe('some-future-exit');
  });

  it('leaves the entry intents alone — they are never a cycle exit', () => {
    for (const intent of TT_ENTRY_INTENTS) expect(exitIntentLabel(intent)).toBe(intent);
  });
});
