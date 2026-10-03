import { z } from 'zod';

/**
 * A whole-number setting with a hard range. The range is the security boundary, not a UI hint: the server re-validates every write against it, so a stolen session can tighten protection but never switch it off.
 *
 * @param min - The smallest value the server accepts.
 * @param max - The largest value the server accepts.
 * @param fallback - The value used when the stored document omits the field.
 * @returns A zod integer schema bounded to `[min, max]` that defaults to `fallback`.
 */
const bounded = (min: number, max: number, fallback: number) =>
  z.number().int().min(min).max(max).default(fallback);

/**
 * Operator-tunable sign-in protection, stored as one row and edited from Settings > Security.
 *
 * Defaults are strict because exactly one person signs in. Each range stops at the point where the protection would stop meaning anything, so loosening is possible but disabling is not. Login methods and the identity provider secret are deliberately NOT here: they live in the environment so a stolen session cannot turn a login method on, and so the secret never becomes a new plaintext database column.
 */
export const AuthSecuritySettings = z
  .object({
    /** Password attempts one IP address may make per period, counted whether they succeed or fail. */
    signInAttemptsPerIpAddress: z
      .object({
        maximumAttempts: bounded(1, 10, 3),
        periodSeconds: bounded(60, 3600, 300),
      })
      .prefault({}),
    /** How long an IP address that exceeded its attempts is refused. Each repeat within a day doubles the block, up to the maximum. */
    ipAddressBlock: z
      .object({
        initialBlockSeconds: bounded(300, 86_400, 900),
        maximumBlockSeconds: bounded(3600, 604_800, 86_400),
      })
      .prefault({})
      .refine((v) => v.initialBlockSeconds <= v.maximumBlockSeconds, {
        message: 'The first block must not be longer than the longest block.',
      }),
    /** Password attempts against one email address per period, from any IP address. */
    signInAttemptsPerEmail: z
      .object({
        maximumAttempts: bounded(1, 20, 5),
        periodSeconds: bounded(60, 3600, 300),
      })
      .prefault({}),
    /** Failed passwords for one email address that lock password sign-in for it. A browser that signed in before (a known device) is exempt, so a stranger cannot lock the operator out. */
    accountLockout: z
      .object({
        failedAttemptsBeforeLockout: bounded(3, 20, 5),
        failurePeriodSeconds: bounded(300, 86_400, 3600),
        lockoutSeconds: bounded(300, 86_400, 3600),
      })
      .prefault({}),
    /** Failed passwords across all addresses. Above this, every IP address is slowed to one attempt per period until failures fall back. */
    siteWideFailedSignIns: z
      .object({
        maximumFailures: bounded(5, 200, 20),
        periodSeconds: bounded(600, 86_400, 3600),
      })
      .prefault({}),
    /** Every other sign-in related request one IP address may make per period (single sign-on callback, agent authorization, session management). */
    otherAuthRequestsPerIpAddress: z
      .object({
        maximumRequests: bounded(5, 120, 20),
        periodSeconds: bounded(60, 3600, 60),
      })
      .prefault({}),
    /** Single sign-on redirects started per minute across all addresses. Each start writes a database row, so this bounds that table under a flood. */
    singleSignOnStartsPerMinute: bounded(2, 60, 10),
    /** API requests per minute from one IP address that carries no signed session cookie. Checked before any database work. */
    anonymousApiRequestsPerIpAddressPerMinute: bounded(10, 600, 60),
    /** API requests per minute from one IP address that carries a signed session cookie. */
    apiRequestsPerIpAddressPerMinute: bounded(120, 3000, 600),
    /** Password hashes computed at once. Hashing is deliberately expensive, so this keeps a sign-in flood from exhausting CPU and memory. */
    concurrentPasswordChecks: bounded(1, 8, 2),
    /** Hours without activity after which a session ends. */
    sessionIdleTimeoutHours: bounded(1, 24, 8),
    /** Hours after sign-in at which a session ends however active it is. */
    sessionAbsoluteLifetimeHours: bounded(1, 168, 24),
    /** Days a browser stays recognised as a known device after signing in. */
    knownDeviceLifetimeDays: bounded(1, 90, 30),
    /** Days security events are kept. Longer than general audit retention on purpose, so evidence outlives a compromise that lowers it. */
    securityEventRetentionDays: bounded(365, 1825, 365),
  })
  .refine((v) => v.sessionIdleTimeoutHours <= v.sessionAbsoluteLifetimeHours, {
    message: 'Sign-out after inactivity must not be longer than sign-out after sign-in.',
    path: ['sessionIdleTimeoutHours'],
  });
/** TS type derived from {@link AuthSecuritySettings} so consumers don't re-run z.infer at every call site. */
export type AuthSecuritySettings = z.infer<typeof AuthSecuritySettings>;

/** The strict defaults, used when no row exists and whenever the stored row cannot be read. */
export const DEFAULT_AUTH_SECURITY_SETTINGS: AuthSecuritySettings = AuthSecuritySettings.parse({});

/**
 * Proof that the person at the keyboard is the operator, required before any change that weakens or moves a credential.
 *
 * `password` is checked against the stored hash. `singleSignOn` means "I just signed in again through the identity provider"; the server accepts it only when the current session was created by a single sign-on login within the last five minutes that the identity provider performed interactively.
 */
export const Reauthentication = z.discriminatedUnion('method', [
  z.object({ method: z.literal('password'), password: z.string().min(1).max(256) }),
  z.object({ method: z.literal('singleSignOn') }),
]);
/** TS type derived from {@link Reauthentication}. */
export type Reauthentication = z.infer<typeof Reauthentication>;

/**
 * Rebuilds a settings object with every field required and unknown fields refused, one level of nesting deep, from the same leaves {@link AuthSecuritySettings} uses. The defaults exist so a stored row written before a field was added still reads; on a write they would turn a missing or misspelled field into a silent reset to the default, which for the retention setting shortens how long evidence is kept.
 *
 * @param schema - An object whose fields are each wrapped in `.default()` or `.prefault()`.
 * @returns A strict object with the same ranges and no defaults.
 */
const everyFieldRequired = (schema: z.ZodObject): z.ZodObject =>
  z.strictObject(
    Object.fromEntries(
      Object.entries(schema.shape).map(([key, field]) => {
        const inner = (field as unknown as { unwrap: () => z.ZodType }).unwrap();
        return [key, inner instanceof z.ZodObject ? everyFieldRequired(inner) : inner];
      }),
    ),
  );

/** Body for `PATCH /auth/security-settings`: the full document plus proof the operator is present. The document is checked for completeness first, then parsed by {@link AuthSecuritySettings} so the ranges and cross-field rules have one source. */
export const UpdateAuthSecuritySettingsRequest = z.object({
  settings: everyFieldRequired(AuthSecuritySettings).pipe(AuthSecuritySettings),
  reauthentication: Reauthentication,
});
/** TS type derived from {@link UpdateAuthSecuritySettingsRequest}. */
export type UpdateAuthSecuritySettingsRequest = z.infer<typeof UpdateAuthSecuritySettingsRequest>;
