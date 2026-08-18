/**
 * The value a redacted bind list is replaced with, matching the `censor` both loggers already pass to pino's `redact` so one log line does not use two spellings for the same thing.
 */
const CENSOR = '[redacted]';

const PARAMS_MESSAGE_TAIL = /(\nparams:)[\s\S]*$/;

/** A V8 stack frame, one of the two boundaries that can legitimately end a bind block. */
const STACK_FRAME = /^\s*at\s/;

/** The joint the serializer inserts between chained stacks, the other legitimate boundary. */
const CAUSE_JOINT = 'caused by: ';

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
export const redactDrizzleParamsText = (value: string): string => {
  if (!value.includes('\nparams:')) return value;
  // Walked line by line rather than matched with one lazy regex. A bind block has to run to the NEXT boundary, not to the end of its line, because a bind value may itself contain a newline: `api_keys.label` is free text bound in column order BEFORE the key and the secret, so a label carrying a line break pushes the live credential onto a later line. Expressing "shortest run up to a frame, a cause joint, or the end" as `[\s\S]*?` with a lookahead makes the engine re-scan that run once per candidate boundary, which is polynomial in the number of `params:` blocks — and the text here is partly attacker-influenced, so a crafted value could stall the logger on the error path. One pass over the lines is linear and says the same thing.
  const lines = value.split('\n');
  const out: string[] = [];
  let inBindBlock = false;
  for (let i = 0; i < lines.length; i += 1) {
    const line = lines[i] as string;
    if (inBindBlock) {
      // Only a frame or a cause joint ends the block; every other line is still bind text and is dropped.
      if (!STACK_FRAME.test(line) && !line.startsWith(CAUSE_JOINT)) continue;
      inBindBlock = false;
      out.push(line);
      continue;
    }
    // `i > 0` keeps this equivalent to the old `\nparams:`: a string that OPENS with `params:` has no preceding newline and was never a bind block.
    if (i > 0 && line.startsWith('params:')) {
      out.push(`params: ${CENSOR}`);
      inBindBlock = true;
      continue;
    }
    out.push(line);
  }
  return out.join('\n');
};

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
