import type { Database } from '@app/db';
import type { Registry } from '@app/observability';
import type { Queue } from 'bullmq';
import { Redis } from 'ioredis';
import type { Logger } from 'pino';
import { createAuthMetrics, type AuthMetrics } from '../metrics/auth.js';
import { createPasswordCheckGate, type PasswordCheckGate } from './password-check-gate.js';
import { createRedisRateLimiter, type RateLimiter } from './rate-limit.js';
import { createSecurityEventRecorder, type SecurityEventRecorder } from './security-events.js';
import { createSecuritySettingsStore, type SecuritySettingsStore } from './security-settings.js';
import { createSignInProtection, type SignInProtection } from './sign-in-protection.js';
import type { SingleSignOnConfig } from './single-sign-on.js';

/** Everything the sign-in system needs at request time, built once per process. */
export interface SecurityServices {
  readonly metrics: AuthMetrics;
  readonly settings: SecuritySettingsStore;
  readonly protection: SignInProtection;
  readonly events: SecurityEventRecorder;
  readonly passwordChecks: PasswordCheckGate;
  /** The configured provider, or null when single sign-on is not enabled. */
  readonly singleSignOn: SingleSignOnConfig | null;
  /** Whether the provider passed the boot check and is registered. Mutable only by the boot sequence. */
  singleSignOnAvailable: boolean;
  /** Whether password sign-in is accepted after the boot guard, which can force it on (see the boot sequence). */
  passwordSignIn: boolean;
  /** True when the boot guard forced password sign-in on because no configured method could reach the operator. */
  passwordSignInForced: boolean;
}

export interface SecurityServicesDeps {
  readonly db: Database;
  /** The limiter and recorder only issue short non-blocking commands on it. Production passes {@link createSecurityRedis}, whose commands fail fast while Redis is unreachable. */
  readonly redis: Redis;
  readonly queue: Pick<Queue, 'add'>;
  readonly logger: Logger;
  readonly registry: Registry;
  /** AUTH_SECRET. */
  readonly secret: string;
  readonly singleSignOn: SingleSignOnConfig | null;
  readonly passwordSignIn: boolean;
  /** Replaces the Redis limiter. Tests that are not about limits pass an always-allow limiter; production never sets it. */
  readonly limiter?: RateLimiter;
}

/** How long one limiter or recorder command may wait for Redis before it fails over. A healthy Redis answers these short commands in milliseconds, so this fires only when Redis is unreachable or stalled. */
export const SECURITY_REDIS_COMMAND_TIMEOUT_MS = 500;

/**
 * Opens the Redis connection the sign-in system uses, separate from the shared one.
 *
 * The shared connection keeps ioredis's defaults, which queue a command while disconnected and retry it across 20 reconnects (over a minute with the default backoff) before failing. The API flood limit runs on every request, so on that connection a Redis outage would stall the whole API for that long before the limiter's in-process fallback took over. Here a command fails at once while the connection is down (no offline queue), a stalled reply times out so the fallback answers within the timeout, and a command caught in flight by a disconnect is dropped after one reconnect attempt rather than twenty, so a request that already fell back is not replayed into Redis much later.
 *
 * Accepted trade-off: with no offline queue, a command sent before the first connect completes also fails over, raising one throttled backend-unavailable alert. Boot awaits several database round trips between opening this connection and accepting requests, which in practice covers the connect.
 *
 * @param url - REDIS_URL.
 * @returns A connection the caller owns and must close.
 */
export const createSecurityRedis = (url: string): Redis =>
  new Redis(url, {
    enableOfflineQueue: false,
    maxRetriesPerRequest: 1,
    commandTimeout: SECURITY_REDIS_COMMAND_TIMEOUT_MS,
  });

/**
 * Builds the sign-in system's services.
 *
 * @param deps - Shared infrastructure and the environment's sign-in choices.
 * @returns The services, wired to one another.
 */
export const createSecurityServices = (deps: SecurityServicesDeps): SecurityServices => {
  const metrics = createAuthMetrics(deps.registry);
  const settings = createSecuritySettingsStore(deps.db, deps.logger);
  const events = createSecurityEventRecorder({
    db: deps.db,
    redis: deps.redis,
    queue: deps.queue,
    logger: deps.logger,
    metrics,
  });
  // The backend-unavailable event is itself throttled by the recorder, so a Redis outage produces one alert per ten minutes rather than one per request.
  const limiter =
    deps.limiter ??
    createRedisRateLimiter(
      deps.redis,
      () => {
        metrics.rateLimitBackendErrors.inc();
        void events.record({ event: 'rate-limit-backend-unavailable', reason: 'other' });
      },
      deps.logger,
    );
  const protection = createSignInProtection({
    limiter,
    settings,
    events,
    metrics,
    secret: deps.secret,
  });
  const passwordChecks = createPasswordCheckGate(
    async () => (await settings.get()).settings.concurrentPasswordChecks,
    (n) => metrics.passwordChecksInFlight.set(n),
  );
  return {
    metrics,
    settings,
    protection,
    events,
    passwordChecks,
    singleSignOn: deps.singleSignOn,
    singleSignOnAvailable: false,
    passwordSignIn: deps.passwordSignIn,
    passwordSignInForced: false,
  };
};
