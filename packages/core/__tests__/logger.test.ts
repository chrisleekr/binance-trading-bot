import { describe, expect, it } from 'vitest';
import { scrubDrizzleParams } from '../src/logger/index.js';

const SECRET = 'SECRET-BINANCE-KEY-DO-NOT-LOG';
const QUERY = 'insert into "api_keys" ("account_id", "api_key") values ($1, $2)';

/** The record a logger's error serializer produces for a failed drizzle statement: the bind values as an array, and the same values inlined into the message and the stack that opens with it. */
const serializedQueryError = (): Record<string, unknown> => ({
  type: 'Error',
  query: QUERY,
  params: ['acct-1', SECRET],
  message: `Failed query: ${QUERY}\nparams: acct-1,${SECRET}`,
  stack: `Error: Failed query: ${QUERY}\nparams: acct-1,${SECRET}\n    at Object.query`,
});

describe('scrubDrizzleParams', () => {
  it('redacts the bind array, the message and the stack of a failed statement', () => {
    const scrubbed = scrubDrizzleParams(serializedQueryError());
    expect(JSON.stringify(scrubbed)).not.toContain(SECRET);
    expect(scrubbed['params']).toBe('[redacted]');
    // The SQL names no value and is the only thing that makes the entry diagnosable, so it has to survive.
    expect(scrubbed['query']).toBe(QUERY);
    expect(scrubbed['stack']).toContain('at Object.query');
  });

  it('redacts a bind list a wrapper only carries in its chained stack', () => {
    // The serializer builds the stack from this error's message AND every cause behind it, so a wrapper whose own message is clean still reprints the inner query's bind values.
    const wrapped = {
      type: 'Error',
      message: 'could not save the api key',
      stack: `Error: could not save the api key\n    at save\ncaused by: Error: Failed query: ${QUERY}\nparams: acct-1,${SECRET}\n    at Object.query`,
    };
    expect(JSON.stringify(scrubDrizzleParams(wrapped))).not.toContain(SECRET);
  });

  it('walks aggregate members and nested object-valued keys', () => {
    const aggregate = {
      type: 'Error',
      message: 'two writes failed',
      aggregateErrors: [serializedQueryError()],
      context: { inner: serializedQueryError() },
    };
    expect(JSON.stringify(scrubDrizzleParams(aggregate))).not.toContain(SECRET);
  });

  it('walks a record whose own key names a failed statement it is not a sibling of', () => {
    // The censor fires on a `params` paired with a sibling `query`, so a wrapper that carries the driver's record under a key of its own has nothing to censor at its top level. Its subtree still has to be walked, or the value it wraps is never reached.
    const wrapper = { message: 'save failed', params: serializedQueryError() };
    expect(JSON.stringify(scrubDrizzleParams(wrapper))).not.toContain(SECRET);
  });

  it('redacts a bind list a newline inside an earlier value would otherwise split', () => {
    // Drizzle binds in column order and `api_keys.label` is free text declared before the key and the secret, so a label carrying a line break pushes the credential onto a line of its own. A redaction that stopped at the first newline would take the label and leave the key.
    const params = ['acct-1', 'my key\nfor trading', SECRET];
    const record = {
      type: 'Error',
      query: QUERY,
      params,
      message: `Failed query: ${QUERY}\nparams: ${params.join(',')}`,
      stack: `Error: Failed query: ${QUERY}\nparams: ${params.join(',')}\n    at Object.query`,
    };
    const scrubbed = scrubDrizzleParams(record);
    expect(JSON.stringify(scrubbed)).not.toContain(SECRET);
    // The frame after the bind block is a terminator, not part of it: redacting it away would take the only locator the entry has.
    expect(scrubbed.stack).toContain('at Object.query');
  });

  it('redacts a bind value that forges a stack frame to end the block early', () => {
    // `api_keys.label` is operator free text and is bound BEFORE the key, so a label carrying a newline plus `    at ` looks exactly like the V8 frame the boundary scan trusts. Matched on the bind array instead, which is the same substring drizzle interpolated and is not forgeable.
    const label = 'my key\n    at rotation';
    const record = {
      type: 'Error',
      query: 'insert into "api_keys" ("label", "api_key") values ($1, $2)',
      params: [label, SECRET],
      message: `Failed query: q\nparams: ${label},${SECRET}`,
      stack: `Error: Failed query: q\nparams: ${label},${SECRET}\n    at Object.query`,
    };

    const scrubbed = scrubDrizzleParams(record);

    expect(JSON.stringify(scrubbed)).not.toContain(SECRET);
    // The frames after the bind list survive the exact cut, unlike a scan that has to consume to the end of the string to stay safe.
    expect(scrubbed.stack).toContain('at Object.query');
  });

  it('keeps the driver cause the message carries after the bind list', () => {
    // `messageWithCauses` appends the cause with `: `, so the boundary-scan fallback destroys "duplicate key value violates…" along with the binds. The exact cut keeps it, and that line is the one an operator acts on.
    const record = {
      type: 'Error',
      query: QUERY,
      params: ['acct-1', SECRET],
      message: `Failed query: ${QUERY}\nparams: acct-1,${SECRET}: duplicate key value violates unique constraint`,
    };

    const scrubbed = scrubDrizzleParams(record);

    expect(JSON.stringify(scrubbed)).not.toContain(SECRET);
    expect(scrubbed.message).toContain('duplicate key value violates unique constraint');
  });

  it('leaves a params key that names no query alone', () => {
    // Blanking every field called `params` would take operator-facing job payloads with it, and those are what make a failed tick readable.
    const job = { message: 'tick failed', params: { symbol: 'BTCUSDT', limit: 25 } };
    expect(scrubDrizzleParams(job).params).toEqual({ symbol: 'BTCUSDT', limit: 25 });
  });

  it('returns a non-object value untouched', () => {
    expect(scrubDrizzleParams('boom')).toBe('boom');
    expect(scrubDrizzleParams(null)).toBeNull();
  });

  it('terminates on a self-referential record', () => {
    // A serialized record is not guaranteed acyclic, and a log call must never be the thing that kills the process.
    const cyclic = serializedQueryError();
    cyclic['self'] = cyclic;
    expect(JSON.stringify(scrubDrizzleParams(cyclic)['params'])).toBe('"[redacted]"');
  });
});
