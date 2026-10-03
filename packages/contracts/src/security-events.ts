import { z } from 'zod';

/**
 * How loudly an event reaches the operator.
 * - `none`: recorded in the audit trail, logs and metrics only.
 * - `activity`: also a routine notification the operator may mute (a normal sign-in).
 * - `alert`: also a notification that cannot be muted, because it means a credential, a session, or a protection changed.
 */
export type SecurityEventNotify = 'none' | 'activity' | 'alert';

/** One row of the security event catalogue. */
export interface SecurityEventMeta {
  readonly notify: SecurityEventNotify;
  /** True for events an attacker can generate for free. They are folded into one audit row per event and reason per five minutes, so a flood cannot fill the table; metrics still count every occurrence. */
  readonly aggregated: boolean;
  /** Plain-language sentence shown on the Security page and in notifications. */
  readonly description: string;
}

/**
 * Every security-relevant thing the system records, with how it is surfaced. A test binds this table to its emitters in both directions, so an event cannot be declared and never raised, or raised without being declared.
 *
 * `onboarding-complete`, `change-password` and `reset-password-cli` keep the names they already had in the audit trail so older rows stay readable.
 */
export const SECURITY_EVENT_CATALOG = {
  'onboarding-complete': {
    notify: 'alert',
    aggregated: false,
    description: 'The operator account was created.',
  },
  'sign-in-succeeded': { notify: 'activity', aggregated: false, description: 'Signed in.' },
  'sign-in-failed': {
    notify: 'none',
    aggregated: true,
    description: 'A sign-in attempt was refused.',
  },
  'single-sign-on-started': {
    notify: 'none',
    aggregated: true,
    description: 'A single sign-on redirect to the identity provider began.',
  },
  'sign-out': { notify: 'none', aggregated: false, description: 'A session signed out.' },
  'session-revoked': {
    notify: 'alert',
    aggregated: false,
    description: 'One session was signed out from the Security page.',
  },
  'sessions-revoked-others': {
    notify: 'alert',
    aggregated: false,
    description: 'Every other session was signed out.',
  },
  'signed-out-everywhere': {
    notify: 'alert',
    aggregated: false,
    description: 'Every session, known device and open connection was signed out.',
  },
  'session-expired-absolute': {
    notify: 'none',
    aggregated: false,
    description: 'A session reached its maximum lifetime and was ended.',
  },
  'session-expired-idle': {
    notify: 'none',
    aggregated: false,
    description: 'A session was used after its idle timeout and was ended.',
  },
  'session-invalidated': {
    notify: 'none',
    aggregated: false,
    description: 'A session from before a sign-out-everywhere was used and refused.',
  },
  'websocket-closed-session-invalid': {
    notify: 'none',
    aggregated: true,
    description: 'A live connection was closed because its session ended.',
  },
  'rate-limited': {
    notify: 'alert',
    aggregated: true,
    description: 'Requests were refused for exceeding a limit.',
  },
  'ip-address-blocked': {
    notify: 'alert',
    aggregated: true,
    description: 'An IP address was blocked after exceeding its sign-in attempts.',
  },
  'account-locked': {
    notify: 'alert',
    aggregated: false,
    description: 'Password sign-in was locked for an email address after repeated failures.',
  },
  'account-lockout-cleared': {
    notify: 'alert',
    aggregated: false,
    description: 'A password sign-in lockout was cleared.',
  },
  'site-wide-backoff-started': {
    notify: 'alert',
    aggregated: false,
    description:
      'Failed sign-ins across all addresses crossed the limit; every address is now slowed.',
  },
  'rate-limit-backend-unavailable': {
    notify: 'alert',
    aggregated: true,
    description:
      'The shared rate limiter could not be reached; a stricter local limiter took over.',
  },
  'api-request-limited': {
    notify: 'alert',
    aggregated: true,
    description: 'API requests from one address were refused for exceeding the flood limit.',
  },
  'password-check-overloaded': {
    notify: 'alert',
    aggregated: true,
    description: 'Too many password checks arrived at once; the extra ones were refused.',
  },
  'websocket-connection-limited': {
    notify: 'none',
    aggregated: true,
    description: 'A live connection was refused or closed for exceeding the connection limit.',
  },
  'change-password': {
    notify: 'alert',
    aggregated: false,
    description: 'The password was changed.',
  },
  'password-set': {
    notify: 'alert',
    aggregated: false,
    description: 'A password was added to an account that had none.',
  },
  'reset-password-cli': {
    notify: 'alert',
    aggregated: false,
    description: 'The password was reset from the server command line.',
  },
  'reauthentication-failed': {
    notify: 'alert',
    aggregated: true,
    description:
      'A sensitive change was refused because the password or fresh sign-in check failed.',
  },
  'single-sign-on-linked': {
    notify: 'alert',
    aggregated: false,
    description: 'A single sign-on identity was linked to the operator.',
  },
  'single-sign-on-unlinked': {
    notify: 'alert',
    aggregated: false,
    description: 'The single sign-on identity was unlinked.',
  },
  'single-sign-on-unlinked-by-cli': {
    notify: 'alert',
    aggregated: false,
    description: 'The single sign-on identity was unlinked from the server command line.',
  },
  'single-sign-on-unavailable': {
    notify: 'alert',
    aggregated: false,
    description:
      'The identity provider could not be reached or is misconfigured; single sign-on is off until it recovers.',
  },
  'single-sign-on-recovered': {
    notify: 'alert',
    aggregated: false,
    description:
      'The identity provider is reachable again; the server is restarting to turn single sign-on back on.',
  },
  'sign-in-method-fallback': {
    notify: 'alert',
    aggregated: false,
    description:
      'No configured sign-in method could reach the operator, so password sign-in was forced on.',
  },
  'agent-consent-granted': {
    notify: 'alert',
    aggregated: false,
    description: 'An AI agent was allowed to access the bot.',
  },
  'agent-consent-denied': {
    notify: 'activity',
    aggregated: false,
    description: 'An AI agent request for access was declined.',
  },
  'agent-token-issued': {
    notify: 'none',
    aggregated: true,
    description: 'An AI agent received or refreshed an access token.',
  },
  'agent-access-revoked': {
    notify: 'alert',
    aggregated: false,
    description: 'Every AI agent token was revoked.',
  },
  'agent-authentication-failed': {
    notify: 'none',
    aggregated: true,
    description:
      'An AI agent presented an expired or invalid token. Routine token expiry looks the same, so this is recorded and counted but not notified; a sustained spike raises the metrics alert instead.',
  },
  'security-settings-changed': {
    notify: 'alert',
    aggregated: false,
    description: 'A sign-in protection setting was changed.',
  },
  'backup-downloaded': {
    notify: 'alert',
    aggregated: false,
    description: 'A database backup was downloaded. It contains every stored secret.',
  },
  'restore-performed': {
    notify: 'alert',
    aggregated: false,
    description: 'The database was restored from a backup; every session was signed out.',
  },
  'api-key-changed': {
    notify: 'alert',
    aggregated: false,
    description: 'A Binance API key was added, replaced or removed.',
  },
  'notifier-changed': {
    notify: 'alert',
    aggregated: false,
    description: 'A notification channel was added, changed or removed.',
  },
  'ops-notify-settings-changed': {
    notify: 'alert',
    aggregated: false,
    description: 'Which operational notifications are sent was changed.',
  },
  'retention-settings-changed': {
    notify: 'alert',
    aggregated: false,
    description: 'How long logs and audit records are kept was changed.',
  },
  'ai-provider-changed': {
    notify: 'alert',
    aggregated: false,
    description: 'The AI provider credential was changed.',
  },
  'auth-endpoint-denied': {
    notify: 'none',
    aggregated: true,
    description: 'A request reached a sign-in endpoint that is not exposed.',
  },
  'cross-site-request-blocked': {
    notify: 'none',
    aggregated: true,
    description: 'A request from another website was refused.',
  },
} as const satisfies Record<string, SecurityEventMeta>;

/** Every recordable security event name. */
export type SecurityEvent = keyof typeof SECURITY_EVENT_CATALOG;

/** The names as a zod enum, for the reader's filter and for tests. */
export const SecurityEventName = z.enum(
  Object.keys(SECURITY_EVENT_CATALOG) as [SecurityEvent, ...SecurityEvent[]],
);

/** How the person proved who they were, when that is known. */
export const SignInMethod = z.enum([
  'password',
  'singleSignOn',
  'onboarding',
  'cli',
  'agent',
  'none',
]);
export type SignInMethod = z.infer<typeof SignInMethod>;

/** Plain name of each sign-in method, shared by the Security activity list and the notifications so both say the same thing. */
export const SIGN_IN_METHOD_LABEL: Readonly<Record<SignInMethod, string>> = {
  password: 'password',
  singleSignOn: 'single sign-on',
  onboarding: 'account creation',
  cli: 'server command line',
  agent: 'AI agent',
  none: 'not applicable',
};

/**
 * Closed set of reasons. Values an attacker controls (the OAuth callback's `error` parameter) map onto this set with `other` as the catch-all, so neither metric labels nor audit rows can be grown without bound.
 */
export const SecurityEventReason = z.enum([
  'none',
  'invalid_credentials',
  'account_not_linked',
  'sign_up_refused',
  'issuer_mismatch',
  'missing_id_token',
  'state_mismatch',
  'access_denied',
  'invalid_code',
  'email_not_verified',
  'provider_unavailable',
  'locked',
  'session_refused',
  'method_disabled',
  'ip_address',
  'email',
  'site_wide',
  'other_auth_requests',
  'single_sign_on_starts',
  'agent_token',
  'agent_authorize',
  'anonymous_api',
  'signed_in_api',
  'lifetime',
  'idle',
  'epoch',
  'origin',
  'not_exposed',
  'other',
]);
export type SecurityEventReason = z.infer<typeof SecurityEventReason>;

/** One row as the Security page reads it. `detail` holds event-specific facts (for example the rate limit that tripped, or which settings changed) and never a secret or a typed email address. */
export const SecurityEventRow = z.object({
  id: z.string(),
  event: SecurityEventName,
  method: SignInMethod,
  reason: SecurityEventReason,
  ipAddress: z.string().nullable(),
  userAgent: z.string().nullable(),
  /** Occurrences folded into this row; 1 unless the event is aggregated. */
  count: z.number().int().min(1),
  detail: z.record(z.string(), z.unknown()),
  createdAt: z.string(),
});
export type SecurityEventRow = z.infer<typeof SecurityEventRow>;

/** Response for `GET /auth/security-events`. `nextBefore` is the cursor for the following page, null at the end. */
export const SecurityEventPage = z.object({
  events: z.array(SecurityEventRow),
  nextBefore: z.string().nullable(),
});
export type SecurityEventPage = z.infer<typeof SecurityEventPage>;

/**
 * Payload of the `notify-auth-security` pipeline job. The api composes a sanitised message because it knows the event; the worker only delivers. Declared here because producer and consumer are different packages and nothing else binds them.
 */
export const AuthSecurityNotifyJob = z.object({
  category: z.enum(['auth-activity', 'auth-alert']),
  event: SecurityEventName,
  /** Ready-to-send sentence, already stripped of control characters and provider markup. */
  body: z.string().min(1).max(1000),
  fields: z
    .array(z.object({ label: z.string().min(1).max(64), value: z.string().max(256) }))
    .max(8)
    .default([]),
});
export type AuthSecurityNotifyJob = z.infer<typeof AuthSecurityNotifyJob>;
