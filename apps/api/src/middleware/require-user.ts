import type { MiddlewareHandler } from 'hono';
import { HttpError } from './error.js';
import type { Env } from 'types.js';

export const requireUser = (): MiddlewareHandler<Env> => async (c, next) => {
  if (!c.get('userId')) throw new HttpError('UNAUTHENTICATED', 'authentication required');
  await next();
};
