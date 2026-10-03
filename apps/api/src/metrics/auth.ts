import { Counter, Gauge, type Registry } from '@app/observability';
import type { SecurityEvent, SecurityEventReason, SignInMethod } from '@app/contracts';

/** Which limiter refused a request. A closed set so the label cannot grow. */
export const LIMIT_NAMES = [
  'sign_in_ip_address',
  'sign_in_ip_address_block',
  'sign_in_email',
  'account_lockout',
  'site_wide_backoff',
  'other_auth_requests',
  'single_sign_on_starts',
  'agent_token',
  'agent_authorize',
  'anonymous_api',
  'signed_in_api',
  'password_check_capacity',
  'websocket_connections',
] as const;
export type LimitName = (typeof LIMIT_NAMES)[number];

/** Where a security event failed to be recorded. */
export const SECURITY_EVENT_SINKS = ['audit', 'notify', 'operator_lookup', 'aggregate'] as const;
export type SecurityEventSink = (typeof SECURITY_EVENT_SINKS)[number];

/** Prometheus surface for sign-in and security. Created once per registry at boot; every label value comes from a closed union. */
export interface AuthMetrics {
  readonly events: Counter<'event' | 'method' | 'outcome' | 'reason'>;
  readonly limited: Counter<'limit'>;
  readonly lockouts: Counter<never>;
  readonly rateLimitBackendErrors: Counter<never>;
  readonly singleSignOnAvailable: Gauge<'provider'>;
  readonly sinkFailures: Counter<'sink'>;
  readonly passwordChecksInFlight: Gauge<never>;
  readonly websocketClosed: Counter<'reason'>;
  /** Records one security event occurrence. */
  recordEvent(event: SecurityEvent, method: SignInMethod, reason: SecurityEventReason): void;
}

/**
 * Registers the auth metrics on the api registry.
 *
 * @param registry - The api's Prometheus registry; each metric registers exactly once.
 * @returns Handles the security code increments.
 */
export const createAuthMetrics = (registry: Registry): AuthMetrics => {
  const events = new Counter({
    name: 'auth_events_total',
    help: 'Security events recorded, by event, sign-in method, outcome and reason. Counts every occurrence, including aggregated ones folded into a single audit row.',
    labelNames: ['event', 'method', 'outcome', 'reason'],
    registers: [registry],
  });
  const limited = new Counter({
    name: 'auth_rate_limited_total',
    help: 'Requests refused by a sign-in or API flood limit, by which limit refused them.',
    labelNames: ['limit'],
    registers: [registry],
  });
  const lockouts = new Counter({
    name: 'auth_lockouts_total',
    help: 'Password sign-in lockouts started for an email address.',
    registers: [registry],
  });
  const rateLimitBackendErrors = new Counter({
    name: 'auth_rate_limit_backend_errors_total',
    help: 'Rate limit decisions that could not reach Redis and fell back to the stricter in-process limiter.',
    registers: [registry],
  });
  const singleSignOnAvailable = new Gauge({
    name: 'auth_single_sign_on_available',
    help: '1 when single sign-on is configured and its identity provider was reachable at the last check, 0 when configured but unavailable. Absent when single sign-on is not configured.',
    // Labelled so the series is absent until it is set: prom-client exports an unlabelled gauge as 0 from construction, which would fire SingleSignOnUnavailable on every deployment without single sign-on.
    labelNames: ['provider'],
    registers: [registry],
  });
  const sinkFailures = new Counter({
    name: 'auth_event_sink_failures_total',
    help: 'Security events that could not be written to one of their destinations (audit row, notification, operator lookup, aggregate counter).',
    labelNames: ['sink'],
    registers: [registry],
  });
  const passwordChecksInFlight = new Gauge({
    name: 'auth_password_checks_in_flight',
    help: 'Password hashes being computed right now. Pinned at the configured capacity means sign-in requests are queueing or being refused.',
    registers: [registry],
  });
  const websocketClosed = new Counter({
    name: 'auth_websocket_closed_total',
    help: 'Live connections closed by the server for a security reason.',
    labelNames: ['reason'],
    registers: [registry],
  });
  const FAILURE_EVENTS: ReadonlySet<SecurityEvent> = new Set<SecurityEvent>([
    'sign-in-failed',
    'reauthentication-failed',
    'agent-authentication-failed',
    'cross-site-request-blocked',
    'auth-endpoint-denied',
    'rate-limited',
    'ip-address-blocked',
    'api-request-limited',
    'password-check-overloaded',
    'websocket-connection-limited',
  ]);
  // A labelled child does not exist until its first write and is born holding it, so `increase()` reads a first-ever refusal as zero. Every child an alert reads is created at zero here, so the first one is an observable rise.
  for (const limit of LIMIT_NAMES) limited.inc({ limit }, 0);
  for (const sink of SECURITY_EVENT_SINKS) sinkFailures.inc({ sink }, 0);
  return {
    events,
    limited,
    lockouts,
    rateLimitBackendErrors,
    singleSignOnAvailable,
    sinkFailures,
    passwordChecksInFlight,
    websocketClosed,
    recordEvent(event, method, reason) {
      events.inc({
        event,
        method,
        outcome: FAILURE_EVENTS.has(event) ? 'failure' : 'success',
        reason,
      });
    },
  };
};
