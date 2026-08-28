import { errorCodeToStatus, type ErrorCode } from '@app/contracts';
import {
  AccountNotOwnedError,
  poolCheckoutTimeoutKind,
  isStatementTimeout,
  ProfileNotOwnedError,
  SiblingQuoteConflictError,
  SymbolOwnershipConflictError,
} from '@app/db';
import type { ErrorHandler, MiddlewareHandler } from 'hono';
import { ZodError } from 'zod';
import type { Logger } from 'di.js';
import type { Env } from 'types.js';

export class HttpError extends Error {
  constructor(
    public readonly code: ErrorCode,
    message: string,
    public readonly details?: unknown,
  ) {
    super(message);
    this.name = 'HttpError';
  }
}

// Duck-typed checks. `instanceof HttpError`/`instanceof ZodError` flakes
// when the same logical module loads under two different specifiers
// (bare path vs relative path with `tsconfig.paths`) and yields two class
// identities. The shape is stable across copies; the identity isn't.
// Probe whether `code` is a known ErrorCode by asking the mapping
// directly. `errorCodeToStatus` returns `undefined` for unknown codes
// (the STATUS map has no entry), so this also guards against a
// caller throwing an HttpError with a typo / stale code.
const isKnownErrorCode = (code: unknown): code is ErrorCode =>
  typeof code === 'string' && errorCodeToStatus(code as ErrorCode) !== undefined;

const isHttpErrorShape = (
  err: unknown,
): err is { code: ErrorCode; message: string; details?: unknown } =>
  typeof err === 'object' &&
  err !== null &&
  (err as { name?: unknown }).name === 'HttpError' &&
  isKnownErrorCode((err as { code?: unknown }).code) &&
  typeof (err as { message?: unknown }).message === 'string';

const isZodErrorShape = (err: unknown): err is ZodError =>
  typeof err === 'object' &&
  err !== null &&
  (err as { name?: unknown }).name === 'ZodError' &&
  Array.isArray((err as { issues?: unknown }).issues);

const isProfileNotOwnedShape = (err: unknown): boolean =>
  typeof err === 'object' &&
  err !== null &&
  (err as { name?: unknown }).name === 'ProfileNotOwnedError';

const isAccountNotOwnedShape = (err: unknown): boolean =>
  typeof err === 'object' &&
  err !== null &&
  (err as { name?: unknown }).name === 'AccountNotOwnedError';

// Both cross-profile exclusivity errors — a base asset already traded by a
// sibling, or a base asset a sibling settles in — surface as CONFLICT with the
// error's own operator-facing message. One predicate covers both names (see the
// duck-typed rationale above; instanceof is unreliable across module copies).
const isConflictErrorShape = (err: unknown): err is { message: string } =>
  typeof err === 'object' &&
  err !== null &&
  ((err as { name?: unknown }).name === 'SymbolOwnershipConflictError' ||
    (err as { name?: unknown }).name === 'SiblingQuoteConflictError') &&
  typeof (err as { message?: unknown }).message === 'string';

/**
 * The one producer of the project error envelope. Exported so a middleware that must ANSWER rather than throw — the body cap, which rejects before any handler exists to throw from — emits the same `{error:{code,message}}` shape and the same status mapping as every other error, instead of a second envelope that drifts.
 *
 * @param code - The closed-set error code, which also decides the HTTP status.
 * @param message - Operator-facing prose; the SPA branches on `code`, not on this.
 * @param details - Optional payload attached under `error.details`; omitted entirely when undefined so the field is absent rather than null.
 * @returns The JSON response, ready to return from a handler or an `onError`.
 */
export const errorResponse = (code: ErrorCode, message: string, details: unknown): Response => {
  const body: Record<string, unknown> = { error: { code, message } };
  if (details !== undefined) (body['error'] as Record<string, unknown>)['details'] = details;
  return new Response(JSON.stringify(body), {
    status: errorCodeToStatus(code),
    headers: { 'content-type': 'application/json' },
  });
};

const buildResponse = (err: unknown, logger: Logger, path: string): Response => {
  if (isHttpErrorShape(err)) return errorResponse(err.code, err.message, err.details);
  if (isZodErrorShape(err))
    return errorResponse('VALIDATION_FAILED', 'invalid request', err.issues);
  if (err instanceof ProfileNotOwnedError || isProfileNotOwnedShape(err)) {
    return errorResponse('NOT_FOUND', 'profile', undefined);
  }
  if (err instanceof AccountNotOwnedError || isAccountNotOwnedShape(err)) {
    return errorResponse('NOT_FOUND', 'account', undefined);
  }
  if (
    err instanceof SymbolOwnershipConflictError ||
    err instanceof SiblingQuoteConflictError ||
    isConflictErrorShape(err)
  ) {
    return errorResponse('CONFLICT', (err as { message: string }).message, undefined);
  }
  // Two database faults that mean "not right now" rather than "this code is broken", so they answer 503 and are logged at warn: an `unhandled` error line for a saturated pool reads as a defect and sends whoever is on call looking for one. Both classifiers are duck-typed predicates over the error shape (same rationale as above — the driver error crosses a package boundary and instanceof cannot be trusted), and both walk the `cause` chain because drizzle wraps what the driver threw.
  // Every message differs so the operator can tell the bounds apart from the response alone, and the checkout case is split rather than collapsed: a pool that stayed full is capacity and is answered by more connections, while a handshake the database never completed is answered by fixing the database — raising the pool max there aims more concurrent attempts at a server already failing to answer. One sentence for both would send the operator the wrong way in exactly the half where it costs most.
  const checkoutKind = poolCheckoutTimeoutKind(err);
  if (checkoutKind !== null) {
    const queueWait = checkoutKind === 'queue-wait';
    logger.warn({ err, path }, queueWait ? 'db_pool_checkout_timeout' : 'db_connect_timeout');
    return errorResponse(
      'SERVICE_UNAVAILABLE',
      queueWait
        ? 'database connections exhausted, retry shortly'
        : 'database did not accept a connection, retry shortly',
      undefined,
    );
  }
  if (isStatementTimeout(err)) {
    logger.warn({ err, path }, 'db_statement_timeout');
    return errorResponse(
      'SERVICE_UNAVAILABLE',
      'database query exceeded its time budget',
      undefined,
    );
  }
  logger.error({ err, path }, 'unhandled');
  return errorResponse('INTERNAL', 'internal server error', undefined);
};

// Hono onError handler. Registered via `app.onError(...)` and reliably
// fires for errors thrown anywhere in the middleware/route chain —
// including from inside `@hono/zod-openapi` validator wrappers, which
// can swallow rejections before an outer `try/await next()` middleware
// would see them.
export const errorHandler =
  (logger: Logger): ErrorHandler<Env> =>
  (err, c) =>
    buildResponse(err, logger, c.req.path);

// Legacy middleware form. Retained so existing test harnesses that mount
// `app.use('*', errorEnvelope(...))` keep working. New code should rely
// on `app.onError(errorHandler(...))` instead.
export const errorEnvelope =
  (logger: Logger): MiddlewareHandler<Env> =>
  async (c, next) => {
    try {
      await next();
    } catch (err) {
      return buildResponse(err, logger, c.req.path);
    }
    return undefined;
  };
