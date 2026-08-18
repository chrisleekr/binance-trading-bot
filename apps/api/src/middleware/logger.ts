import type { MiddlewareHandler } from 'hono';
import pino, { type DestinationStream, type Logger } from 'pino';
import { scrubDrizzleParams } from '@app/core/logger';
import type { Env } from 'types.js';

/**
 * The `err` serializer both this logger and the worker's install: pino's own, followed by a pass that strips drizzle's bound query parameters out of the result.
 *
 * The identity check is what keeps the passthrough intact. pino's serializer returns the SAME reference when handed something that is not error-like — a plain `{ code: -1013 }` from the Binance client, say — and that value belongs to the caller, so scrubbing it would mutate a live object the request is still using. Only a value the serializer actually built is ours to edit.
 *
 * @param e - Whatever was logged under the `err` key, error-like or not.
 * @returns The serialized record with any bind values redacted, or the original value untouched when pino declined to serialize it.
 */
const errSerializer = (e: unknown): unknown => {
  const serialized: unknown = pino.stdSerializers.err(e as Error);
  return serialized === e ? serialized : scrubDrizzleParams(serialized);
};

export const createLogger = (opts: {
  level: pino.Level;
  destination?: DestinationStream;
}): Logger =>
  pino(
    {
      level: opts.level,
      serializers: { err: errSerializer },
      redact: {
        paths: [
          'key',
          'secret',
          'apiKey',
          'apiSecret',
          'password',
          'token',
          'Authorization',
          'authorization',
          '*.password',
          '*.oldPassword',
          '*.newPassword',
          '*.secret',
          '*.key',
          '*.apiKey',
          '*.apiSecret',
          '*.token',
          '*.authorization',
          'req.headers.cookie',
          'req.headers.authorization',
        ],
        censor: '[redacted]',
      },
    },
    opts.destination,
  );

const newRequestId = (): string =>
  `req_${Date.now().toString(36)}_${Math.random().toString(36).slice(2, 10)}`;

export const requestLogger =
  (logger: Logger): MiddlewareHandler<Env> =>
  async (c, next) => {
    const requestId = c.req.header('x-request-id') ?? newRequestId();
    c.set('requestId', requestId);
    c.header('x-request-id', requestId);
    const child = logger.child({ requestId });
    const start = performance.now();
    try {
      await next();
      child.info(
        {
          method: c.req.method,
          path: c.req.path,
          status: c.res.status,
          durMs: performance.now() - start,
        },
        'request',
      );
    } catch (err) {
      child.error(
        { method: c.req.method, path: c.req.path, durMs: performance.now() - start, err },
        'request_error',
      );
      throw err;
    }
  };
