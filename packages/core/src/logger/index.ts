/**
 * The value a redacted bind list is replaced with, matching the `censor` both loggers already pass to pino's `redact` so one log line does not use two spellings for the same thing.
 */
const CENSOR = '[redacted]';

/**
 * The bind-value block drizzle appends to its error message, and therefore to the stack that message opens.
 *
 * It consumes to the next real boundary rather than to the end of the line, because a bind value can itself contain a newline and nothing forbids one: `api_keys.label` is free text bound in column order BEFORE the key and the secret, so a label carrying a line break pushes the live credential onto a line an end-of-line match would never reach. Only three things can legitimately follow the bind list — a V8 stack frame, the `\ncaused by: ` joint the serializer inserts between chained stacks, and the end of the string — so those are the terminators, and the match is lazy so it stops at the first of them.
 *
 * Global, because a stack that chains causes carries one such block per wrapped query.
 */
const PARAMS_LINE = /(\nparams:)[\s\S]*?(?=\n\s*at\s|\ncaused by: |$)/g;
const PARAMS_MESSAGE_TAIL = /(\nparams:)[\s\S]*$/;

/**
 * Replaces the Drizzle bind tail in one error message. An isolated message has no stack frames, so its end is the only boundary a parameter value cannot forge.
 *
 * @param value - One error message before it is joined to a cause or embedded in a stack.
 * @returns The message with its bind tail replaced by the shared censor value.
 */
export const redactDrizzleParamsMessage = (value: string): string =>
  value.replace(PARAMS_MESSAGE_TAIL, `$1 ${CENSOR}`);

/**
 * Replaces Drizzle bind lists in finalized stack or chained text while preserving the known V8 frame and chained-cause boundaries. Use {@link redactDrizzleParamsMessage} for an isolated `Error.message`, whose bind tail has no trustworthy intermediate boundary.
 *
 * @param value - Finalized stack or chained text whose structural boundaries must survive redaction.
 * @returns The text with each bind list replaced by the shared censor value.
 */
export const redactDrizzleParamsText = (value: string): string =>
  value.replace(PARAMS_LINE, `$1 ${CENSOR}`);

/** Walks one already-serialized value, redacting in place. `seen` makes a self-referential error terminate instead of recursing forever — a serialized record is not guaranteed acyclic, and a log call must never be the thing that kills the process. */
const scrub = (value: unknown, seen: WeakSet<object>): void => {
  if (typeof value !== 'object' || value === null) return;
  if (seen.has(value)) return;
  seen.add(value);

  if (Array.isArray(value)) {
    for (const item of value) scrub(item, seen);
    return;
  }

  const record = value as Record<string, unknown>;
  // A sibling string `query` is what identifies this level as a failed statement rather than some unrelated object that happens to carry a `params` key. Without that pairing the rule would blank any field named `params` anywhere in a log record, including ones an operator needs.
  if (typeof record['query'] === 'string' && 'params' in record) record['params'] = CENSOR;
  if (typeof record['message'] === 'string')
    record['message'] = redactDrizzleParamsMessage(record['message']);
  // The stack is the leak that survives every obvious fix: the serializer builds it from the message of this error AND of every cause behind it, so a wrapper whose own message is clean still carries the inner query's bind values verbatim.
  if (typeof record['stack'] === 'string')
    record['stack'] = redactDrizzleParamsText(record['stack']);

  for (const key of Object.keys(record)) scrub(record[key], seen);
};

/**
 * Strip drizzle's bound query parameters out of an already-serialized error record, in place.
 *
 * Every Binance credential and notifier secret in this app is stored plaintext by design, so the statement that writes one carries it as a bind value. When that statement fails, drizzle raises an error holding those bind values three times over — the `params` array, the message its template inlines them into, and the stack that opens with that message — and a logger's default error serializer copies all three verbatim. One failed insert then writes a live API secret into the log stream, where it outlives the request, the process, and any rotation.
 *
 * Takes the SERIALIZED record rather than the Error, so this package needs no logger dependency and stays pure: the caller runs its own serializer first and hands the plain object here. It mutates rather than rebuilds, which also preserves the non-enumerable handle to the original error that pino hangs off its result — that handle never serializes, and re-materialising the record onto a fresh object would promote it to enumerable and put the untouched original straight back into the line.
 *
 * @param record - The serialized error record to redact, at any nesting depth; arrays, `aggregateErrors` and object-valued own keys are all walked.
 * @returns The same object it was given, so the call can sit inline in a serializer.
 */
export function scrubDrizzleParams<T>(record: T): T {
  scrub(record, new WeakSet<object>());
  return record;
}
