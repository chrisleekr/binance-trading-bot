import { z } from 'zod';

/**
 * Operator override-action audit row. The strategy never reads `triggeredBy`
 * or `actionAt` directly. The worker consumes off the override stream and
 * marks `consumedAt` so we can prove every operator action was applied.
 * `processingAt` is the middle lifecycle state: set once a worker claims the
 * row and clear again on consume, so a reader can tell a queued override
 * (`processingAt` null) from one a worker is mid-side-effect on.
 */
/**
 * What the operator actually got, as opposed to what they asked for.
 *
 * - `applied`    — the order reached Binance and was accepted.
 * - `rejected`   — nothing executed and nothing will: the exchange refused it,
 *   a breaker suppressed it, or the strategy declined. `reason` says which.
 * - `unknown`    — the order may or may not have executed (a transport failure
 *   or an HTTP 5xx, where Binance's own docs say the execution status is
 *   unknown). The one status a human must resolve at the exchange.
 * - `superseded` — a newer override for the same symbol replaced this one
 *   before it ran.
 * - `expired`    — the override's window closed without any tick settling it.
 */
export const OverrideOutcomeStatus = z.enum([
  'applied',
  'rejected',
  'unknown',
  'superseded',
  'expired',
]);
export type OverrideOutcomeStatus = z.infer<typeof OverrideOutcomeStatus>;

export const OverrideOutcome = z.object({
  status: OverrideOutcomeStatus,
  /** Short operator-facing explanation. Absent when the status says it all. */
  reason: z.string().optional(),
  at: z.iso.datetime(),
});
/** TS type derived from {@link OverrideOutcome}. */
export type OverrideOutcome = z.infer<typeof OverrideOutcome>;

/**
 * The outcome as its producer knows it. `at` is stamped by the repository at
 * write time, so the worker's pure-ish tick path never needs a clock for it.
 */
export type OverrideOutcomeInput = Omit<OverrideOutcome, 'at'>;

/**
 * How far back the override read endpoint looks for a SETTLED row. Twice the
 * override TTL: long enough that an operator who submitted an override and
 * watched it run always sees its outcome, short enough that yesterday's
 * force-sell never resurfaces as if it were the current one.
 */
export const OVERRIDE_OUTCOME_WINDOW_MS = 600_000;

/**
 * How old a `processing_at` has to be before the claim is treated as abandoned
 * by a worker that died holding it. The cancel route and the stale-claim reaper
 * MUST read this same value: if the API's horizon were the shorter of the two it
 * would call a claim dead while the reaper still considers it live, and the
 * operator would be told "cancelled" while a dispatch is still running. So the
 * API's horizon may never be shorter than the reaper's. The comparison also
 * crosses process clocks (the worker stamps it, the API reads it), which is the
 * other reason it is deliberately generous.
 */
export const OVERRIDE_CLAIM_STALE_MS = 10 * 60 * 1000;

export const OverrideAction = z.object({
  id: z.uuid(),
  symbol: z.string().nullable(),
  action: z.string(),
  actionAt: z.iso.datetime(),
  payload: z.unknown(),
  triggeredBy: z.string(),
  processingAt: z.iso.datetime().nullable(),
  consumedAt: z.iso.datetime().nullable(),
  /**
   * The settled outcome, or null while the override is still pending. Its own
   * column, not the row's `result`: `result` is the side-effect payload (the
   * dust flow stores Binance's convertDust response there), so sharing one
   * column would make `null` mean both "still pending" and "settled, but the
   * payload isn't an outcome".
   */
  outcome: OverrideOutcome.nullable(),
  createdAt: z.iso.datetime(),
});
/** TS type derived from {@link OverrideAction} so consumers don't re-run z.infer at every call site. */
export type OverrideAction = z.infer<typeof OverrideAction>;

/**
 * Response wrapper that allows `null`. The override read endpoints return
 * the latest active (pending or processing) action or `null` when none, so
 * the SPA's "no override pending" branch lights up without a separate error
 * code.
 */
export const OverrideActionResponse = OverrideAction.nullable();
/** TS type derived from {@link OverrideActionResponse} so consumers don't re-run z.infer at every call site. */
export type OverrideActionResponse = z.infer<typeof OverrideActionResponse>;
