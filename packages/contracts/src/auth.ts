import { z } from 'zod';

/**
 * Response for `GET /auth/onboarding-status`. Drives the SPA's first-run
 * branch. The master account is created exactly once and `/onboarding`
 * disappears thereafter.
 */
export const OnboardingStatus = z.object({
  masterExists: z.boolean(),
  /**
   * True on a public "Live demo" deployment (`LIVE_DEMO=1`): no login is required; credential, notifier, backup/restore, account-creation, account-rename/delete, retention-change, diagnosis-start, fee-reconciliation, and archive-backfill routes are locked; and trading stays interactive on testnet. Drives the persistent banner and hidden 403 links.
   *
   * Defaults false so a client predating the field keeps today's behaviour.
   */
  demoMode: z.boolean().default(false),
  /** Whether the email and password form is accepted. False when the server runs with password sign-in switched off. */
  passwordSignIn: z.boolean().default(true),
  /** The configured single sign-on provider, or null when single sign-on is not configured. `available` is false while the identity provider cannot be reached, so the button can say why it will not work. */
  singleSignOn: z
    .object({ buttonLabel: z.string(), available: z.boolean() })
    .nullable()
    .default(null),
  /** True when no configured method could reach the operator and the server forced password sign-in on so they are not locked out. */
  passwordSignInForced: z.boolean().default(false),
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
  /** Whether a password is set, so the SPA offers "change" or "set" and never a form that cannot work. */
  hasPassword: z.boolean(),
  /** Whether a single sign-on identity is linked to the operator. */
  singleSignOnLinked: z.boolean(),
  /** The email the identity provider reported for the linked identity, shown so the operator can tell which provider account it is. Null when none is linked, or until an identity linked before this was recorded signs in again. */
  singleSignOnEmail: z.string().nullable(),
});
/** TS type derived from {@link SessionResponse} so consumers don't re-run z.infer at every call site. */
export type SessionResponse = z.infer<typeof SessionResponse>;

/** One active session as the Security page shows it. The session token is never part of this shape. */
export const ActiveSession = z.object({
  id: z.string(),
  createdAt: z.string(),
  lastActiveAt: z.string(),
  expiresAt: z.string(),
  ipAddress: z.string().nullable(),
  userAgent: z.string().nullable(),
  /** True for the session making this request. */
  current: z.boolean(),
});
/** TS type derived from {@link ActiveSession}. */
export type ActiveSession = z.infer<typeof ActiveSession>;

/** Response for `GET /auth/sessions`. */
export const ActiveSessionList = z.object({ sessions: z.array(ActiveSession) });
/** TS type derived from {@link ActiveSessionList}. */
export type ActiveSessionList = z.infer<typeof ActiveSessionList>;

/** Body for `POST /auth/single-sign-on/start`. `returnTo` is where the browser lands after the identity provider; `pendingAuthorization` is the signed agent-authorization query the login page was opened with, if any; `reauthenticate` forces the identity provider to ask again rather than reuse its session. */
export const SingleSignOnStartRequest = z.object({
  returnTo: z.string().max(2048).optional(),
  pendingAuthorization: z.string().max(8192).optional(),
  reauthenticate: z.boolean().optional(),
});
/** TS type derived from {@link SingleSignOnStartRequest}. */
export type SingleSignOnStartRequest = z.infer<typeof SingleSignOnStartRequest>;

/** Response carrying the identity provider URL the browser must navigate to. */
export const SingleSignOnRedirect = z.object({ url: z.url() });
/** TS type derived from {@link SingleSignOnRedirect}. */
export type SingleSignOnRedirect = z.infer<typeof SingleSignOnRedirect>;

/** Body for `POST /auth/password`: sets a first password for an operator who signed up through single sign-on. */
export const SetPasswordRequest = z.object({ newPassword: z.string().min(12).max(256) });
/** TS type derived from {@link SetPasswordRequest}. */
export type SetPasswordRequest = z.infer<typeof SetPasswordRequest>;
