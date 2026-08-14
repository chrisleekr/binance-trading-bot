import { z } from 'zod';

/**
 * Response for `GET /auth/onboarding-status`. Drives the SPA's first-run
 * branch. The master account is created exactly once and `/onboarding`
 * disappears thereafter.
 */
export const OnboardingStatus = z.object({
  masterExists: z.boolean(),
  /**
   * True on a public "Live demo" deployment (`LIVE_DEMO=1`): no login is
   * required; credential, notifier, backup/restore, account-creation,
   * retention-change, and diagnosis-start routes are locked; and trading stays
   * interactive on testnet. Drives the persistent banner and hidden 403 links.
   * Defaults false so a client predating the field keeps today's behaviour.
   */
  demoMode: z.boolean().default(false),
});
/** TS type derived from {@link OnboardingStatus} so consumers don't re-run z.infer at every call site. */
export type OnboardingStatus = z.infer<typeof OnboardingStatus>;

/**
 * Body for `POST /auth/sign-up`. Only valid while no master exists; min-12
 * password enforces the minimum-strength rule from the auth plan.
 */
export const SignUpRequest = z.object({
  email: z.email(),
  password: z.string().min(12).max(256),
  displayName: z.string().min(1).max(128).optional(),
});
/** TS type derived from {@link SignUpRequest} so consumers don't re-run z.infer at every call site. */
export type SignUpRequest = z.infer<typeof SignUpRequest>;

/** Body for `POST /auth/sign-in`. Min-1 (not 12) on password; old shorter passwords stay logged in. */
export const SignInRequest = z.object({
  email: z.email(),
  password: z.string().min(1).max(256),
});
/** TS type derived from {@link SignInRequest} so consumers don't re-run z.infer at every call site. */
export type SignInRequest = z.infer<typeof SignInRequest>;

/** Body for `POST /auth/change-password`. Server verifies `oldPassword` to defend against an unattended session. */
export const ChangePasswordRequest = z.object({
  oldPassword: z.string().min(1).max(256),
  newPassword: z.string().min(12).max(256),
});
/** TS type derived from {@link ChangePasswordRequest} so consumers don't re-run z.infer at every call site. */
export type ChangePasswordRequest = z.infer<typeof ChangePasswordRequest>;

/** Response for `GET /auth/session`. Identifies the operator the SPA is rendering for. */
export const SessionResponse = z.object({
  userId: z.uuid(),
  email: z.email(),
  displayName: z.string().nullable(),
});
/** TS type derived from {@link SessionResponse} so consumers don't re-run z.infer at every call site. */
export type SessionResponse = z.infer<typeof SessionResponse>;
