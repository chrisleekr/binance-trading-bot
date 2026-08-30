import { z } from 'zod';

/**
 * Closed set of API error codes. Closed (not free-text) so the SPA can render
 * code-specific UI affordances (re-auth on `UNAUTHENTICATED`, retry banner on
 * `RATE_LIMITED`) without parsing prose.
 */
export const ErrorCode = z.enum([
  'VALIDATION_FAILED',
  'UNAUTHENTICATED',
  'FORBIDDEN',
  'NOT_FOUND',
  'CONFLICT',
  'RATE_LIMITED',
  'PAYLOAD_TOO_LARGE',
  'UPSTREAM_FAILED',
  'SERVICE_UNAVAILABLE',
  'INTERNAL',
  'INVALID_PASSWORD',
  'ONBOARDING_CLOSED',
  // The profile's strategy does not support the operator action requested
  // (e.g. a force-buy on a strategy that honors no overrides). Distinct from
  // VALIDATION_FAILED so the SPA can phrase "this strategy can't do that".
  'ACTION_UNSUPPORTED',
  // The profile references a strategy name/version not in the registry.
  'STRATEGY_NOT_REGISTERED',
]);
/** TS type derived from {@link ErrorCode} so consumers don't re-run z.infer at every call site. */
export type ErrorCode = z.infer<typeof ErrorCode>;

/**
 * Wire envelope for every non-2xx response. `details` is `unknown` so each
 * endpoint can attach validation issue lists or upstream payloads without
 * widening the shared schema.
 */
export const ErrorEnvelope = z.object({
  error: z.object({
    code: ErrorCode,
    message: z.string(),
    details: z.unknown().optional(),
  }),
});
/** TS type derived from {@link ErrorEnvelope} so consumers don't re-run z.infer at every call site. */
export type ErrorEnvelope = z.infer<typeof ErrorEnvelope>;

const STATUS: Record<ErrorCode, number> = {
  VALIDATION_FAILED: 422,
  UNAUTHENTICATED: 401,
  FORBIDDEN: 403,
  NOT_FOUND: 404,
  CONFLICT: 409,
  RATE_LIMITED: 429,
  PAYLOAD_TOO_LARGE: 413,
  UPSTREAM_FAILED: 502,
  SERVICE_UNAVAILABLE: 503,
  INTERNAL: 500,
  INVALID_PASSWORD: 401,
  ONBOARDING_CLOSED: 403,
  ACTION_UNSUPPORTED: 422,
  STRATEGY_NOT_REGISTERED: 404,
};

/**
 * Maps an {@link ErrorCode} to its canonical HTTP status. Centralised so the
 * API layer never has to encode the mapping inline (where it would drift).
 */
export const errorCodeToStatus = (code: ErrorCode): number => STATUS[code];
