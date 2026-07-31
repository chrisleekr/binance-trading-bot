import type { LogEntry, TickInput, TickOutput } from '@app/strategy-core';
import type { TTBundle, TTConfig, TTState } from './schema.js';
import type { TickScalars } from './scalars.js';

// Table-driven branch dispatcher contract for `computeTick`.
//
// The tick is a fixed-order chain of branches. Each branch inspects the
// running `state` + `preambleLogs` carry and either terminates the tick
// (emitting the final TickOutput) or hands an updated carry to the next
// branch. The order of the BRANCHES tuple in `tick.ts` IS the strategy's
// precedence chain — auto-trigger-buy before the disabled noop guard,
// lbp-clear before the sell gate, technicals-force-sell before the
// regular sell ladder — so reordering the tuple changes behaviour.

/**
 * Read-only inputs threaded into every branch: the raw tick `input`, the
 * once-computed cross-branch `scalars`, and the running carry (`state`
 * plus `preambleLogs` accumulated by earlier non-terminal branches).
 */
export interface BranchContext {
  readonly input: TickInput<TTConfig, TTState, TTBundle>;
  readonly scalars: TickScalars;
  readonly state: TTState;
  readonly preambleLogs: readonly LogEntry[];
}

/**
 * A branch either continues the chain or ends the tick.
 *   - `pass`: no state change; carry forwards unchanged.
 *   - `mutate`: state and/or preambleLogs updated; carry forwards.
 *   - `terminal`: the tick's final output; the dispatcher returns it.
 */
export type BranchOutcome =
  | { readonly kind: 'pass' }
  | { readonly kind: 'mutate'; readonly state: TTState; readonly preambleLogs: readonly LogEntry[] }
  | { readonly kind: 'terminal'; readonly output: TickOutput<TTState> };

export type BranchHandler = (ctx: BranchContext) => BranchOutcome;
