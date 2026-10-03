import { createHmac } from 'node:crypto';
import type { SecurityEventReason } from '@app/contracts';
import type { AuthMetrics, LimitName } from '../metrics/auth.js';
import { addressLimitKey } from './client-address.js';
import type { Decision, Rate, RateLimiter } from './rate-limit.js';
import type { SecurityEventRecorder } from './security-events.js';
import type { SecuritySettingsStore } from './security-settings.js';

/** A request refused by a limit. `retryAfterMs` is what the client is told to wait. */
export interface Refusal {
  readonly limit: LimitName;
  readonly reason: SecurityEventReason;
  readonly retryAfterMs: number;
}

/** Who is attempting, as far as the limiter is concerned. */
export interface Attempt {
  /** Trusted client address. */
  readonly ipAddress: string;
  readonly userAgent: string | null;
  /** True when the browser carries a valid known-device mark for the operator. */
  readonly knownDevice: boolean;
}

/** The generic per-address limits outside password sign-in. */
export type AddressLimit =
  'other_auth_requests' | 'single_sign_on_starts' | 'agent_token' | 'agent_authorize';

/** Sign-in and auth-surface throttling built on the GCRA primitives. */
export interface SignInProtection {
  /** Decides whether a password attempt may proceed. Takes one unit from each allowance it passes; refuses without consuming further ones. */
  checkPasswordAttempt(attempt: Attempt, email: string): Promise<Refusal | null>;
  /** Records a wrong password, advancing the lockout and site-wide budgets and starting a lockout or backoff when one is exhausted. */
  recordPasswordFailure(attempt: Attempt, email: string): Promise<void>;
  /** Decides whether one other auth request may proceed. A `subject` (an agent's client id) gets its own allowance within a larger per-address total shared by every subject. */
  checkAddressLimit(
    limit: AddressLimit,
    attempt: Attempt,
    subject?: string,
  ): Promise<Refusal | null>;
  /** Decides whether one API request may proceed, before any session lookup. `signedIn` means a signed session cookie was presented. */
  checkApiFlood(ipAddress: string, signedIn: boolean): Promise<Refusal | null>;
  /** Lifts everything that can keep the operator out, for the recovery command: the lockout, failure budget and attempt budgets of one email, the site-wide backoff, and every address's block and attempt budget. */
  clearLockout(email: string): Promise<void>;
}

export interface SignInProtectionDeps {
  readonly limiter: RateLimiter;
  readonly settings: SecuritySettingsStore;
  readonly events: SecurityEventRecorder;
  readonly metrics: AuthMetrics;
  /** AUTH_SECRET, used to key email addresses so Redis never holds one in the clear. */
  readonly secret: string;
}

const SECOND = 1000;
const DAY_MS = 86_400_000;
/** How many subjects' worth of allowance one address gets across all of them. Without this cap a caller that rotates the subject (an agent's `client_id` is chosen by the caller) would mint a fresh per-subject allowance on every request. */
const SUBJECTS_PER_ADDRESS = 4;

/**
 * The GCRA rate that refuses exactly the `count`th event in a burst. GCRA admits `limit` events and refuses the next, but the settings mean "lock on the 5th failure", so the burst is one smaller while the refill rate stays the configured `count` per period.
 *
 * @param count - The event number that must be refused, from the settings; floored so the burst is never below one.
 * @param periodMs - The period `count` is measured over.
 * @returns A rate whose burst is `count - 1` and whose emission interval is `periodMs / count`.
 */
const refuseOnCount = (count: number, periodMs: number): Rate => {
  const burst = Math.max(1, count - 1);
  return { limit: burst, periodMs: (periodMs * burst) / Math.max(1, count) };
};

/**
 * Normalises an email for comparison and keying. NFKC folds compatibility look-alikes (full-width letters, ligatures) onto their plain form, so `Ｏperator@example.test` shares a budget with `operator@example.test` rather than getting a fresh one.
 *
 * @param email - As typed.
 * @returns The normalised address.
 */
export const normalizeEmail = (email: string): string =>
  email.normalize('NFKC').trim().toLowerCase();

/**
 * Builds the protection layer.
 *
 * Order in a password attempt, cheapest refusal first: an active IP block; the per-IP allowance (reduced to one per period while the site-wide backoff is active, unless this is a known device); the per-email lockout (skipped for a known device); the per-email allowance. The per-IP check runs before any per-email key is touched, which is what bounds how many email keys a flood can create. Every email is treated identically whether or not it exists, so a refusal says nothing about which address is real.
 *
 * @param deps - Limiter, settings, recorder, metrics and secret.
 * @returns The protection layer.
 */
export const createSignInProtection = (deps: SignInProtectionDeps): SignInProtection => {
  const emailKey = (email: string): string =>
    createHmac('sha256', deps.secret)
      .update(`sign-in-email/v1:${normalizeEmail(email)}`)
      .digest('hex')
      .slice(0, 32);

  const refuse = async (
    refusal: Refusal,
    attempt: Attempt,
    event: 'rate-limited' | 'api-request-limited' = 'rate-limited',
  ): Promise<Refusal> => {
    deps.metrics.limited.inc({ limit: refusal.limit });
    await deps.events.record({
      event,
      reason: refusal.reason,
      ipAddress: attempt.ipAddress,
      userAgent: attempt.userAgent,
      detail: { limit: refusal.limit, retryAfterSeconds: Math.ceil(refusal.retryAfterMs / SECOND) },
    });
    return refusal;
  };

  return {
    async checkPasswordAttempt(attempt, email) {
      const { settings } = await deps.settings.get();
      const address = addressLimitKey(attempt.ipAddress);
      const blockKey = `auth:block:ip:${address.key}`;
      const blocked = await deps.limiter.flagRemainingMs(blockKey);
      if (blocked > 0) {
        deps.metrics.limited.inc({ limit: 'sign_in_ip_address_block' });
        return { limit: 'sign_in_ip_address_block', reason: 'ip_address', retryAfterMs: blocked };
      }

      const perIp = settings.signInAttemptsPerIpAddress;
      const backoff =
        !attempt.knownDevice && (await deps.limiter.flagRemainingMs('auth:backoff:site')) > 0;
      const ipRate = {
        limit: backoff ? 1 : perIp.maximumAttempts,
        periodMs: perIp.periodSeconds * SECOND,
      };
      const ipDecision = await deps.limiter.consume(`auth:gcra:sign-in:ip:${address.key}`, ipRate);
      const wideDecision =
        address.wideKey === null
          ? { allowed: true, retryAfterMs: 0 }
          : await deps.limiter.consume(`auth:gcra:sign-in:ip:${address.wideKey}`, {
              limit: ipRate.limit * 8,
              periodMs: ipRate.periodMs,
            });
      if (!ipDecision.allowed || !wideDecision.allowed) {
        if (backoff) {
          return refuse(
            {
              limit: 'site_wide_backoff',
              reason: 'site_wide',
              retryAfterMs: Math.max(ipDecision.retryAfterMs, wideDecision.retryAfterMs),
            },
            attempt,
          );
        }
        const { initialBlockSeconds, maximumBlockSeconds } = settings.ipAddressBlock;
        const initialBlockMs = initialBlockSeconds * SECOND;
        // Concurrent refusals from one address race here. Only the request that sets the block counts the trip and records the event; the others report the block the winner set, so one trip is never counted or recorded twice.
        if (!(await deps.limiter.setFlag(blockKey, initialBlockMs))) {
          deps.metrics.limited.inc({ limit: 'sign_in_ip_address_block' });
          return {
            limit: 'sign_in_ip_address_block',
            reason: 'ip_address',
            retryAfterMs: await deps.limiter.flagRemainingMs(blockKey),
          };
        }
        const trips = await deps.limiter.countWithin(`auth:block:trips:${address.key}`, DAY_MS);
        const blockMs =
          Math.min(initialBlockSeconds * 2 ** Math.min(trips - 1, 20), maximumBlockSeconds) *
          SECOND;
        if (blockMs !== initialBlockMs) await deps.limiter.extendFlag(blockKey, blockMs);
        const refusal: Refusal = {
          limit: 'sign_in_ip_address',
          reason: 'ip_address',
          retryAfterMs: blockMs,
        };
        deps.metrics.limited.inc({ limit: refusal.limit });
        await deps.events.record({
          event: 'ip-address-blocked',
          reason: 'ip_address',
          ipAddress: attempt.ipAddress,
          userAgent: attempt.userAgent,
          detail: { blockSeconds: blockMs / SECOND, repeatWithinDay: trips },
        });
        return refusal;
      }

      const key = emailKey(email);
      if (!attempt.knownDevice) {
        const locked = await deps.limiter.flagRemainingMs(`auth:lock:email:${key}`);
        if (locked > 0) {
          deps.metrics.limited.inc({ limit: 'account_lockout' });
          return { limit: 'account_lockout', reason: 'locked', retryAfterMs: locked };
        }
      }
      const perEmail = settings.signInAttemptsPerEmail;
      // A known device draws on its own allowance. Shared with strangers, anyone spraying the operator's email would keep the operator's own browser refused, which is the lockout the known-device exemption exists to prevent.
      const emailBucket = attempt.knownDevice
        ? `auth:gcra:sign-in:email:${key}:known-device`
        : `auth:gcra:sign-in:email:${key}`;
      const emailDecision = await deps.limiter.consume(emailBucket, {
        limit: perEmail.maximumAttempts,
        periodMs: perEmail.periodSeconds * SECOND,
      });
      if (!emailDecision.allowed) {
        return refuse(
          { limit: 'sign_in_email', reason: 'email', retryAfterMs: emailDecision.retryAfterMs },
          attempt,
        );
      }
      return null;
    },

    async recordPasswordFailure(attempt, email) {
      const { settings } = await deps.settings.get();
      const key = emailKey(email);
      const lockout = settings.accountLockout;
      const budget = await deps.limiter.consume(
        `auth:gcra:failures:email:${key}`,
        refuseOnCount(lockout.failedAttemptsBeforeLockout, lockout.failurePeriodSeconds * SECOND),
      );
      if (
        !budget.allowed &&
        (await deps.limiter.setFlag(`auth:lock:email:${key}`, lockout.lockoutSeconds * SECOND))
      ) {
        deps.metrics.lockouts.inc();
        await deps.events.record({
          event: 'account-locked',
          reason: 'locked',
          ipAddress: attempt.ipAddress,
          userAgent: attempt.userAgent,
          detail: { lockoutSeconds: lockout.lockoutSeconds },
        });
      }
      const siteWide = settings.siteWideFailedSignIns;
      const site = await deps.limiter.consume(
        'auth:gcra:failures:site',
        refuseOnCount(siteWide.maximumFailures, siteWide.periodSeconds * SECOND),
      );
      if (
        !site.allowed &&
        (await deps.limiter.setFlag('auth:backoff:site', siteWide.periodSeconds * SECOND))
      ) {
        await deps.events.record({
          event: 'site-wide-backoff-started',
          reason: 'site_wide',
          detail: { backoffSeconds: siteWide.periodSeconds },
        });
      }
    },

    async checkAddressLimit(limit, attempt, subject) {
      const { settings } = await deps.settings.get();
      if (limit === 'single_sign_on_starts') {
        // Site-wide, not per address: each start writes a database row, and an attacker with many addresses would otherwise multiply the allowance.
        const decision = await deps.limiter.consume('auth:gcra:sso-start:site', {
          limit: settings.singleSignOnStartsPerMinute,
          periodMs: 60 * SECOND,
        });
        if (decision.allowed) return null;
        return refuse(
          { limit, reason: 'single_sign_on_starts', retryAfterMs: decision.retryAfterMs },
          attempt,
        );
      }
      const other = settings.otherAuthRequestsPerIpAddress;
      const address = addressLimitKey(attempt.ipAddress);
      const rate = { limit: other.maximumRequests, periodMs: other.periodSeconds * SECOND };
      const addressBucket = `auth:gcra:${limit}:${address.key}`;
      let decision: Decision;
      if (subject === undefined) {
        decision = await deps.limiter.consume(addressBucket, rate);
      } else {
        // Every subject from one address also draws on one shared allowance, so rotating the subject cannot multiply the budget; each subject then gets its own share of it.
        decision = await deps.limiter.consume(`${addressBucket}:all-subjects`, {
          limit: rate.limit * SUBJECTS_PER_ADDRESS,
          periodMs: rate.periodMs,
        });
        if (decision.allowed) {
          const subjectKey = createHmac('sha256', deps.secret)
            .update(subject)
            .digest('hex')
            .slice(0, 16);
          decision = await deps.limiter.consume(`${addressBucket}:subject:${subjectKey}`, rate);
        }
      }
      if (decision.allowed) return null;
      // Each remaining limit name is also its own event reason.
      return refuse({ limit, reason: limit, retryAfterMs: decision.retryAfterMs }, attempt);
    },

    async checkApiFlood(ipAddress, signedIn) {
      const { settings } = await deps.settings.get();
      const address = addressLimitKey(ipAddress);
      const perMinute = signedIn
        ? settings.apiRequestsPerIpAddressPerMinute
        : settings.anonymousApiRequestsPerIpAddressPerMinute;
      const decision = await deps.limiter.consume(
        `auth:gcra:api:${signedIn ? 'signed-in' : 'anonymous'}:${address.key}`,
        { limit: perMinute, periodMs: 60 * SECOND },
      );
      if (decision.allowed) return null;
      const limit = signedIn ? 'signed_in_api' : 'anonymous_api';
      return refuse(
        { limit, reason: limit, retryAfterMs: decision.retryAfterMs },
        { ipAddress, userAgent: null, knownDevice: false },
        'api-request-limited',
      );
    },

    async clearLockout(email) {
      const key = emailKey(email);
      await deps.limiter.clear([
        `auth:lock:email:${key}`,
        `auth:gcra:failures:email:${key}`,
        `auth:gcra:sign-in:email:${key}`,
        `auth:gcra:sign-in:email:${key}:known-device`,
        'auth:backoff:site',
        'auth:gcra:failures:site',
      ]);
      // Every address, not only the operator's: the command runs on the host, which does not know the address the operator was blocked from. A block doubles on each repeat within a day, up to a day, so leaving it would make this recovery step useless for exactly the operator who needs it. The trip counter goes too, or the next block would start at the doubled length.
      for (const prefix of ['auth:block:ip:', 'auth:block:trips:', 'auth:gcra:sign-in:ip:'])
        await deps.limiter.clearPrefix(prefix);
    },
  };
};
