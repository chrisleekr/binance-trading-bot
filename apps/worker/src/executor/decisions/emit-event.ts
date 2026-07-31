import type { Decision, DecisionResult, TickExecutorContext } from '@app/strategy-core';
import { asProfileId, WsEvent } from '@app/contracts';
import { emitEvent } from 'executor/event-emitter.js';
import type { DecisionDeps } from './_types.js';

/**
 * `emit-event` is the pure publish/append path: no Binance, no DB. It bridges
 * a strategy's domain event to a WS `topic` and forwards the payload to the
 * per-profile event stream. Other handlers publish their own topics directly
 * (e.g. place-order emits on `orders`); this handler is the strategy-facing
 * entry point.
 *
 * The event→topic mapping is OWNED BY THE STRATEGY, not the worker: the
 * emitting strategy's `events[eventType]` entry carries both the WS `topic` and
 * the payload zod schema. Reading the topic from there (rather than a
 * worker-side table) keeps `apps/worker` from naming any strategy's event
 * vocabulary — adding an event is a strategy-package edit alone (core
 * invariant #1). A strategy event with no entry is a wiring bug, surfaced as a
 * failed decision rather than a silently dropped frame.
 *
 * Runtime payload validation: the entry's zod schema parses the payload before
 * publish. tsc enforces shape at every strategy call site; this second check
 * closes the residual gap where the generic `Decision` widens `payload` to
 * `unknown` at the executor boundary. A failed parse fails the decision with
 * `retryable: false` — the payload shape is deterministic per tick, so a retry
 * would carry the same bytes.
 */
export const emitEventHandler = async (
  deps: DecisionDeps,
  ctx: TickExecutorContext,
  decision: Extract<Decision, { type: 'emit-event' }>,
): Promise<DecisionResult> => {
  // The topic and payload schema both come from the strategy's `events` map, so
  // resolve the strategy first. `TickExecutorContext` makes `strategyName`
  // required-by-type — only the tick apply path (which always has an emitting
  // strategy) can dispatch `emit-event`, so a missing name is unrepresentable.
  const strategy = deps.strategies.get(ctx.strategyName);
  if (!strategy) {
    return {
      ok: false,
      retryable: false,
      phase: 'pre-call',
      reason: `emit-event: strategy "${ctx.strategyName}" not registered`,
    };
  }
  // Own-property check: a strategy eventType of `constructor` / `toString`
  // must not resolve to an inherited Object.prototype member.
  const entry = Object.prototype.hasOwnProperty.call(strategy.events, decision.eventType)
    ? strategy.events[decision.eventType]
    : undefined;
  if (!entry) {
    return {
      ok: false,
      retryable: false,
      phase: 'pre-call',
      reason: `emit-event: strategy "${strategy.name}" declares no event "${decision.eventType}"`,
    };
  }
  const topic = entry.topic;
  const parsed = entry.payload.safeParse(decision.payload);
  if (!parsed.success) {
    return {
      ok: false,
      retryable: false,
      phase: 'pre-call',
      reason: `emit-event: payload failed strategy "${strategy.name}" schema for "${decision.eventType}": ${parsed.error.message}`,
    };
  }

  // Second gate: the strategy schema above proves the domain-event shape;
  // this proves the (topic, payload) pair satisfies the WS contract, so the
  // dynamic emit is as type-safe as the static `emitEvent` call sites. `seq`
  // and `ts` are placeholders only — `emitEvent` stamps the real values; the
  // parse exists to validate the topic↔payload pairing and narrow `payload`
  // to the union member.
  const wsParsed = WsEvent.safeParse({
    seq: 0,
    topic,
    ts: new Date(0).toISOString(),
    payload: parsed.data,
  });
  if (!wsParsed.success) {
    return {
      ok: false,
      retryable: false,
      phase: 'pre-call',
      reason: `emit-event: payload failed WS contract for topic "${topic}": ${wsParsed.error.message}`,
    };
  }

  await emitEvent(deps, deps.accountId, asProfileId(ctx.profileId), topic, wsParsed.data.payload);
  return { ok: true };
};
