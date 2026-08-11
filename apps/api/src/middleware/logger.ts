import type { MiddlewareHandler } from 'hono';
import pino, { type DestinationStream, type Logger } from 'pino';
import type { Env } from 'types.js';

export const createLogger = (opts: {
  level: pino.Level;
  destination?: DestinationStream;
}): Logger =>
  pino(
    {
      level: opts.level,
      serializers: { err: pino.stdSerializers.err },
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
