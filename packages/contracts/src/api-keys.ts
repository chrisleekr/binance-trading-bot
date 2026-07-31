import { z } from 'zod';

/**
 * Response for `GET /api-keys/:profileId`. Returns the last-4 of the secret
 * (never the full value) so the operator can confirm which key is bound
 * without re-exposing material that's stored plaintext per the v1.0 threat
 * model.
 */
/**
 * Outcome of the worker's verify-key job (Binance `getAccount`): `pending`
 * until it runs (and after a key rotation), `ok`, or `failed`. Surfaced so the
 * operator can tell a working key from a non-working one (bad secret, missing
 * permission, non-allowlisted IP) instead of both looking identically bound.
 */
export const ApiKeyVerificationStatus = z.enum(['pending', 'ok', 'failed']);
export type ApiKeyVerificationStatus = z.infer<typeof ApiKeyVerificationStatus>;

export const ApiKeyResponse = z.object({
  label: z.string().nullable(),
  last4: z.string().length(4),
  createdAt: z.iso.datetime(),
  verificationStatus: ApiKeyVerificationStatus,
  /** When the verify-key job last attempted (set on `ok` and `failed` alike); null while `pending`. */
  verifiedAt: z.iso.datetime().nullable(),
  /** Binance failure message when `failed`; null otherwise. */
  verificationError: z.string().nullable(),
});
/** TS type derived from {@link ApiKeyResponse} so consumers don't re-run z.infer at every call site. */
export type ApiKeyResponse = z.infer<typeof ApiKeyResponse>;

/**
 * Body for `PUT /api-keys/:profileId`. PUT (not POST) because at most one key
 * pair exists per profile; operator replaces in place when rotating.
 */
export const ApiKeyPut = z.object({
  key: z.string().min(1).max(256),
  secret: z.string().min(4).max(256),
  label: z.string().min(1).max(128).optional(),
});
/** TS type derived from {@link ApiKeyPut} so consumers don't re-run z.infer at every call site. */
export type ApiKeyPut = z.infer<typeof ApiKeyPut>;
