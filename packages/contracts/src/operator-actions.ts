import { z } from 'zod';

/**
 * Closed vocabulary of operator actions a strategy may support. A superset of
 * `ManualOverrideKind`: the first three write a Redis override the tick
 * consumes; the last three are grid/position maintenance the operator runs
 * from the symbol screen. A strategy declares the subset it honors on its
 * `capabilities.operatorActions`; the api gates each override-writing route on
 * it, the worker drops a stale enqueue for an unsupported action, and the web
 * omits the panel — so an action that would be silently dropped never renders.
 * Aligned 1:1 with the manual-order route set so panel, allowed-override-kind,
 * and endpoint stay one list.
 *
 * Lives in its own module (not next to `ManualOverrideKind` in
 * `manual-orders.ts`) because `manual-orders.ts` imports `orders.ts`, and
 * `orders.ts` needs this set for `SymbolStateResponse` — a shared low-level
 * module keeps both off an import cycle.
 */
export const OPERATOR_ACTIONS = [
  'manual-order',
  'trigger-buy',
  'trigger-sell',
  'avg-entry-price',
  'archive-grid',
  'reset-grid',
] as const;
/** Zod enum over {@link OPERATOR_ACTIONS} for wire validation at the api boundary. */
export const OperatorAction = z.enum(OPERATOR_ACTIONS);
/** TS type derived from {@link OPERATOR_ACTIONS} so consumers don't re-run the index lookup. */
export type OperatorAction = (typeof OPERATOR_ACTIONS)[number];
