import type { Clock } from './contract.js';
import type { Decision } from './decision.js';

export interface ExecutorContext {
  readonly userId: string;
  readonly profileId: string;
  readonly clock: Clock;
  /**
   * Name of the strategy that produced the decisions being applied. Used
   * by the executor's `emit-event` handler to look up the emitting
   * strategy's `events` schema map and runtime-validate the payload
   * before publish. Optional on the base type because non-tick callers
   * (pipeline handlers that emit only `cancel-order`) have no emitting
   * strategy. The tick apply path uses {@link TickExecutorContext}, which
   * makes it required-by-type, and `emit-event` is dispatched only there,
   * so the handler can never receive one without a name.
   */
  readonly strategyName?: string;
}

/**
 * `ExecutorContext` narrowed to the tick apply path, where an emitting strategy
 * always exists. Making `strategyName` required-by-type here lets the
 * `emit-event` handler resolve the strategy's `events` map without a runtime
 * `strategyName === undefined` guard: the no-strategy pipeline callers dispatch
 * only non-`emit-event` decisions, so an `emit-event` can never reach the
 * handler without one.
 */
export interface TickExecutorContext extends ExecutorContext {
  readonly strategyName: string;
}

/**
 * How far a failed decision got before it failed. Orthogonal to `retryable`:
 * `phase` answers "is it SAFE to retry?" (did the side effect happen?) while
 * `retryable` answers "is it WORTH retrying?" (is the cause transient?). A
 * caller that wants to re-issue the decision needs both.
 *
 * - `pre-call`  — refused inside the process; the exchange never saw it.
 * - `rejected`  — the exchange parsed the request and refused it. Nothing
 *   executed, so a retry cannot duplicate anything.
 * - `ambiguous` — the request may have executed and we cannot tell (transport
 *   error, HTTP 5xx, an error body we could not parse into a code). Retrying
 *   risks a duplicate order; this is the one phase that is never safe to retry.
 * - `accepted`  — the exchange accepted it and the failure came afterwards
 *   (local bookkeeping). The side effect is live.
 */
export type DecisionFailurePhase = 'pre-call' | 'rejected' | 'ambiguous' | 'accepted';

export type DecisionResult =
  | { readonly ok: true }
  | {
      readonly ok: false;
      readonly retryable: boolean;
      readonly phase: DecisionFailurePhase;
      readonly reason: string;
      readonly cause?: unknown;
      /**
       * The decision was withheld BY POLICY, not attempted and failed. Separate
       * from `phase: 'pre-call'`, which also covers genuine refusals: both leave
       * state un-advanced so the strategy re-emits, but only a real failure is
       * worth waking the operator for. A caller that alerts on failure must skip
       * these, or a routine admission-control decision reads as an outage.
       */
      readonly deferred?: true;
    };

export interface Executor {
  apply(ctx: ExecutorContext, decision: Decision): Promise<DecisionResult>;
}
