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
  // A sensitive change needs fresh proof the operator is present: a password, or a single sign-on login completed in the last few minutes.
  'REAUTHENTICATION_REQUIRED',
  // The profile's strategy does not support what was requested — an operator action it honors no override for (e.g. a force-buy on momentum), or a setting it cannot read (arming `enterOnAdd` on a strategy that declares no `entry-hint` bundle). Distinct from VALIDATION_FAILED because the payload is well-formed and would be valid on another strategy, which is exactly the difference the SPA phrases as "this strategy can't do that".
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
  // 403, not 401: the caller IS signed in and only mistyped a confirmation password. The web client treats every 401 as an ended session and sends the operator to the sign-in page, so a typo would sign them out of the screen they were on.
  INVALID_PASSWORD: 403,
  ONBOARDING_CLOSED: 403,
  REAUTHENTICATION_REQUIRED: 403,
  ACTION_UNSUPPORTED: 422,
  STRATEGY_NOT_REGISTERED: 404,
};

/**
 * Maps an {@link ErrorCode} to its canonical HTTP status. Centralised so the
 * API layer never has to encode the mapping inline (where it would drift).
 */
export const errorCodeToStatus = (code: ErrorCode): number => STATUS[code];
