import { Writable } from 'node:stream';
import { OpenAPIHono } from '@hono/zod-openapi';
import type { DestinationStream } from 'pino';
import { describe, expect, it } from 'vitest';

import { errorHandler } from '../src/middleware/error.js';
import { createLogger } from '../src/middleware/logger.js';
import type { Env } from '../src/types.js';

/**
 * How a database that is momentarily unable to serve a request is reported — on the wire AND in the log.
 *
 * Two faults reach the error handler as ordinary `Error`s and are today indistinguishable from a bug: a checkout that never got a pooled connection, and a statement the server cancelled for outrunning its budget. Both mean "this request could not be served right now", which is a 503 the caller can retry, not the 500 that says the code is broken. Answering 500 also costs the operator the diagnosis: an `unhandled` error line for a saturated pool reads exactly like a null dereference, so the log level and the log message are part of the contract, not decoration — asserting only the status would leave `logger.error(…, 'unhandled')` free to come back.
 *
 * Hermetic on purpose — no Postgres. The handler is a pure function of the error shape, so gating it behind infra would leave the classification unproven everywhere but one lane, which is precisely where a regression would hide.
 */

class CaptureStream extends Writable implements DestinationStream {
  public buffer = '';
  override _write(chunk: Buffer | string, _enc: BufferEncoding, cb: (err?: Error) => void): void {
    this.buffer += typeof chunk === 'string' ? chunk : chunk.toString('utf8');
    cb();
  }
  override write(chunk: Buffer | string): boolean {
    this.buffer += typeof chunk === 'string' ? chunk : chunk.toString('utf8');
    return true;
  }
}

/** One emitted pino record, reduced to the three fields this suite makes claims about. */
interface LoggedLine {
  readonly level: number;
  readonly msg: string;
  readonly path: string;
}

/** pino's numeric levels; the handler's choice between them is the operator-facing difference between "load" and "defect". */
const WARN = 40;
const ERROR = 50;

/** Drives the production wiring (`app.onError`, not the legacy middleware form) with one error and reports both halves of what it produced. */
const respondTo = async (
  err: unknown,
): Promise<{ status: number; code: string; message: string; logs: LoggedLine[] }> => {
  const out = new CaptureStream();
  const app = new OpenAPIHono<Env>();
  app.get('/boom', () => {
    throw err;
  });
  app.onError(errorHandler(createLogger({ level: 'debug', destination: out })));

  const res = await app.request('/boom', { method: 'GET' });
  const body = (await res.json()) as { error: { code: string; message: string } };
  const logs = out.buffer
    .split('\n')
    .filter((line) => line.trim() !== '')
    .map((line) => JSON.parse(line) as LoggedLine);
  return { status: res.status, code: body.error.code, message: body.error.message, logs };
};

describe('error handler: a database that cannot serve the request answers 503', () => {
  it('classifies a checkout that waited past the pool deadline', async () => {
    // pg-pool's queue-wait error verbatim. It carries no SQLSTATE and no error class, so the message is the only thing there is to classify on.
    const res = await respondTo(new Error('timeout exceeded when trying to connect'));

    expect(res.status).toBe(503);
    expect(res.code).toBe('SERVICE_UNAVAILABLE');
    // Capacity, in the operator's words: this one is answered by adding connections or shedding load.
    expect(res.message).toBe('database connections exhausted, retry shortly');
    expect(res.logs).toEqual([
      expect.objectContaining({ level: WARN, msg: 'db_pool_checkout_timeout', path: '/boom' }),
    ]);
  });

  it('classifies a connection attempt that outlasted the pool deadline, and does not call it exhaustion', async () => {
    // pg-pool's cold-connect error verbatim, including the `cause` it attaches. Distinct from the queue-wait message, so a classifier matching only one of them would still hang half the failures out as 500s.
    const res = await respondTo(
      new Error('Connection terminated due to connection timeout', {
        cause: new Error('Connection terminated unexpectedly'),
      }),
    );

    expect(res.status).toBe(503);
    expect(res.code).toBe('SERVICE_UNAVAILABLE');
    // The pool was NOT full on this path — pg-pool only dials when it has room — so reporting it as exhaustion points the operator at the pool size, and raising that aims more concurrent attempts at a database already failing to complete a handshake. The separate log name is what keeps the `API_DB_POOL_MAX` guidance ("raise this when you see db_pool_checkout_timeout") true.
    expect(res.message).toBe('database did not accept a connection, retry shortly');
    expect(res.logs).toEqual([
      expect.objectContaining({ level: WARN, msg: 'db_connect_timeout', path: '/boom' }),
    ]);
  });

  it('classifies a statement the server cancelled for exceeding its budget', async () => {
    // The shape drizzle throws: the driver error carrying SQLSTATE 57014 travels on `cause`, never on the outermost object.
    const res = await respondTo(
      new Error('Failed query', {
        cause: Object.assign(new Error('canceling statement due to statement timeout'), {
          code: '57014',
        }),
      }),
    );

    expect(res.status).toBe(503);
    expect(res.code).toBe('SERVICE_UNAVAILABLE');
    // A different sentence from the checkout case, and deliberately so: one slow query is not a pool at capacity, and the response is the only place the operator learns which bound was hit.
    expect(res.message).toBe('database query exceeded its time budget');
    expect(res.logs).toEqual([
      expect.objectContaining({ level: WARN, msg: 'db_statement_timeout', path: '/boom' }),
    ]);
  });

  it('still reports an unrelated failure as an internal error', async () => {
    // The negative that keeps the two new branches from swallowing real bugs. A 503 tells the operator to wait for capacity; answering it for a genuine defect buries the defect and invites a retry that fails identically forever.
    const res = await respondTo(
      new TypeError("Cannot read properties of undefined (reading 'id')"),
    );

    expect(res.status).toBe(500);
    expect(res.code).toBe('INTERNAL');
    expect(res.logs).toEqual([
      expect.objectContaining({ level: ERROR, msg: 'unhandled', path: '/boom' }),
    ]);
  });
});
