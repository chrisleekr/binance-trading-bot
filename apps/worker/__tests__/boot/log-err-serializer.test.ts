import { Writable } from 'node:stream';
import { describe, expect, it } from 'vitest';
import type { DestinationStream } from 'pino';

import { buildLogger } from '../../src/boot/boot-context.js';

class CaptureStream extends Writable implements DestinationStream {
  public buffer = '';
  override _write(chunk: Buffer | string, _enc: BufferEncoding, cb: (err?: Error) => void): void {
    this.buffer += typeof chunk === 'string' ? chunk : chunk.toString('utf8');
    cb();
  }
  write(chunk: Buffer | string): boolean {
    this.buffer += typeof chunk === 'string' ? chunk : chunk.toString('utf8');
    return true;
  }
}

const lastLine = (out: CaptureStream): Record<string, unknown> => {
  const lines = out.buffer.trim().split('\n');
  return JSON.parse(lines[lines.length - 1]!) as Record<string, unknown>;
};

/** The raw JSON line pino emitted, before parsing. A secret can survive a key-shaped assertion by riding inside a string value — `message`, `stack`, or a stringified param list — so the leak check has to read the bytes that actually reach the log. */
const lastRawLine = (out: CaptureStream): string => {
  const lines = out.buffer.trim().split('\n');
  return lines[lines.length - 1]!;
};

/** A `DrizzleQueryError` as the driver throws it: the failing SQL and its bind values as own enumerable properties, and a message whose template has already inlined those bind values. The stack inherits the same message, so the secret is present three times over in one object. */
const drizzleQueryError = (query: string, params: unknown[], cause?: Error): Error => {
  const err = new Error(`Failed query: ${query}\nparams: ${params.join(',')}`) as Error & {
    query: string;
    params: unknown[];
    cause?: Error;
  };
  err.query = query;
  err.params = params;
  if (cause !== undefined) err.cause = cause;
  return err;
};

/** A bind value that must never reach a log line. Distinctive enough that a substring search cannot match it by accident. */
const SECRET = 'SECRET-BINANCE-KEY-DO-NOT-LOG';

const API_KEY_INSERT =
  'insert into "api_keys" ("account_id", "api_key", "api_secret") values ($1, $2, $3)';

describe('worker logger err serializer', () => {
  it('serializes a raw Error under `err` into an object carrying the stack', () => {
    const out = new CaptureStream();
    const logger = buildLogger('debug', out);
    logger.error({ err: new Error('boom') }, 'x');
    const err = lastLine(out).err as { stack?: unknown; message?: unknown };
    expect(typeof err.stack).toBe('string');
    expect(err.stack as string).toContain('boom');
    expect(err.message).toBe('boom');
  });

  it('serializes a non-Error error-shaped object without throwing', () => {
    const out = new CaptureStream();
    const logger = buildLogger('debug', out);
    expect(() => logger.error({ err: { code: -1013 } }, 'x')).not.toThrow();
    expect(lastLine(out).err).toEqual({ code: -1013 });
  });

  it('logs a failed api-keys write without its bound secret', () => {
    // Every Binance credential in this app is stored plaintext by design, so the DB write that stores one carries it as a bind value. Drizzle wraps a failure into an error that puts those bind values in three places at once — the `params` array, the message template, and therefore the stack — and pino's default err serializer copies all three verbatim. A single failed insert then writes the operator's live API secret into the log stream, where it outlives the request, the process, and any rotation.
    const out = new CaptureStream();
    const logger = buildLogger('debug', out);
    logger.error({ err: drizzleQueryError(API_KEY_INSERT, ['acct-1', SECRET, 'sec']) }, 'x');

    const line = lastRawLine(out);
    expect(line).not.toContain(SECRET);
    // The SQL itself names no value, and it is the only thing that makes the entry diagnosable, so redaction must not take it with the params.
    expect(line).toContain('api_keys');
  });

  it('logs a wrapped api-keys failure without the secret its cause carried', () => {
    // The route rarely re-throws the driver error bare; it wraps it. The serializer walks into the wrapper's own properties, so a wrapped cause is not a narrower case than the bare one — it is the one that actually happens.
    const out = new CaptureStream();
    const logger = buildLogger('debug', out);
    const inner = drizzleQueryError(API_KEY_INSERT, ['acct-1', SECRET, 'sec']);
    const outer = new Error('could not save the api key');
    (outer as { cause?: unknown }).cause = inner;
    logger.error({ err: outer }, 'x');

    expect(lastRawLine(out)).not.toContain(SECRET);
  });

  it('logs an aggregate of failed writes without the secret any member carried', () => {
    // A fan-out that settles several writes reports them together as an AggregateError. The serializer reads `errors` and re-serialises each member under `aggregateErrors`, so this is the path that actually runs; building the output key by hand would instead take the generic own-property copy, which hands over the live member objects by reference and proves nothing about the real one.
    const out = new CaptureStream();
    const logger = buildLogger('debug', out);
    const member = drizzleQueryError(API_KEY_INSERT, ['acct-1', SECRET, 'sec']);
    const aggregate = new AggregateError(
      [member, drizzleQueryError('update "profiles" set "name" = $1', ['bot'])],
      'two writes failed',
    );
    logger.error({ err: aggregate }, 'x');

    expect(lastRawLine(out)).not.toContain(SECRET);
    // The caller's own error is untouched: redaction happens on the record the serializer built, so a value the request is still using cannot be edited out from under it.
    expect((member as unknown as { params: unknown[] }).params).toContain(SECRET);
  });

  it("never emits the serializer's non-enumerable `raw` handle", () => {
    // `raw` is the original Error object, hung off the serialized result behind a non-enumerable accessor so JSON.stringify skips it. Anything that re-materialises the error's properties onto a plain object — a redaction pass that rebuilds the value is exactly that — can promote it to enumerable and put the untouched original, secret and all, straight back into the line.
    const out = new CaptureStream();
    const logger = buildLogger('debug', out);
    logger.error({ err: drizzleQueryError(API_KEY_INSERT, ['acct-1', SECRET, 'sec']) }, 'x');

    expect(lastLine(out).err).not.toHaveProperty('raw');
    expect(lastRawLine(out)).not.toContain('"raw"');
  });
});
