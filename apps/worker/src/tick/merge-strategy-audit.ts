// Merge a strategy's own audit block into the tick's audit-log payload.
//
// The strategy narrows its `TickOutput.events` union via `Strategy.extractAudit`
// and returns the block it wants surfaced on the tick trace and, once the
// drainer keeps the tick, on that row's `action_logs` ctx. The worker
// stays strategy-agnostic: it never inspects the events, and it never learns
// what any strategy's event `kind` means. This module is the whole worker-side
// contribution — a guarded object merge.
//
// The guard matters because the strategy chooses the top-level keys. A plugin
// returning `{ results: ... }` would otherwise silently overwrite the worker's
// own per-decision results and corrupt the audit trail.

/**
 * Keys a strategy block may not set: the ones the worker owns on the audit
 * payload, plus the three that mutate an object instead of adding a property.
 *
 * `source` and `tickId` are on the list because the drainer copies them onto
 * every `action_logs` row's `ctx` envelope, where `source` drives the Logs
 * filter and `tickId` is the only join back to the Redis stream entry. A plugin
 * overwriting either would not corrupt an audit row so much as detach it.
 *
 * `__proto__` is not hypothetical. `Object.keys` skips it on an object literal,
 * but surfaces it as an own enumerable key on anything built by `JSON.parse`, and
 * `payload['__proto__'] = v` then rebinds the payload's prototype rather than
 * storing a field. Nothing downstream breaks today (`JSON.stringify` drops it,
 * and `Object.prototype` is untouched), but it would slip past the collision
 * report this guard exists to produce.
 */
export const RESERVED_AUDIT_KEYS: ReadonlySet<string> = new Set([
  'enqueuedAtMs',
  'eventPayload',
  'results',
  'input',
  'strategyLogs',
  'source',
  'tickId',
  '__proto__',
  'constructor',
  'prototype',
]);

/**
 * Copy `block`'s own enumerable keys onto `payload`, skipping any the worker
 * reserves. `onCollision` is called once per dropped key so the operator sees a
 * misbehaving plugin rather than a quietly mangled audit row.
 *
 * A `null` / `undefined` block (the common pure-path tick) is a no-op.
 */
export const mergeStrategyAudit = (
  payload: Record<string, unknown>,
  block: Readonly<Record<string, unknown>> | undefined,
  onCollision: (key: string) => void,
): void => {
  if (!block) return;
  for (const key of Object.keys(block)) {
    if (RESERVED_AUDIT_KEYS.has(key)) {
      onCollision(key);
      continue;
    }
    payload[key] = block[key];
  }
};
