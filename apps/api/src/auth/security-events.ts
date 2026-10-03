import {
  SECURITY_EVENT_CATALOG,
  SIGN_IN_METHOD_LABEL,
  type AuthSecurityNotifyJob,
  type SecurityEvent,
  type SecurityEventReason,
  type SignInMethod,
  type UserId,
} from '@app/contracts';
import { repo, type Database } from '@app/db';
import { isIP } from 'node:net';
import type { Queue } from 'bullmq';
import type { Redis } from 'ioredis';
import type { Logger } from 'pino';
import type { AuthMetrics } from '../metrics/auth.js';

/** One security event occurrence. Only `event` is required; everything else refines it. */
export interface SecurityEventInput {
  readonly event: SecurityEvent;
  readonly method?: SignInMethod;
  readonly reason?: SecurityEventReason;
  readonly ipAddress?: string | null;
  readonly userAgent?: string | null;
  /** Event-specific facts. Must never carry a secret, a token, a password, or an email address someone typed. `account` is the one email allowed: the identity provider's verified address on single sign-on events, shown on the Security page and in the notification, and redacted from the log. */
  readonly detail?: Readonly<Record<string, string | number | boolean | null>>;
  /** For a failed sign-in: whether the typed email was the operator's. A failure against the real address is always recorded individually; guesses at other addresses are aggregated. */
  readonly emailMatched?: boolean;
  /** Who acted, for the audit row's actor column. */
  readonly actor?: 'user' | 'anonymous' | 'agent' | 'cli' | 'system';
}

/** Records security events. `record` never throws and never delays the caller on a slow sink beyond one database write. */
export interface SecurityEventRecorder {
  record(input: SecurityEventInput): Promise<void>;
}

export interface SecurityEventRecorderDeps {
  readonly db: Database;
  /** Dedicated to aggregation and notification throttling. */
  readonly redis: Redis;
  readonly queue: Pick<Queue, 'add'>;
  readonly logger: Logger;
  readonly metrics: AuthMetrics;
  /** Clock, injectable for tests. */
  readonly now?: () => number;
  /** Runs a callback once after a delay; injectable so a test can fire the end-of-window count without waiting five minutes. Defaults to an unref'd `setTimeout`, so a pending count never holds the process open. */
  readonly schedule?: (run: () => void, delayMs: number) => void;
}

/** Window an aggregated event folds into one audit row. */
export const AGGREGATE_WINDOW_MS: number = 5 * 60_000;
/** Minimum gap between two notifications for the same throttled event and reason. */
export const NOTIFY_THROTTLE_MS: number = 10 * 60_000;
/** How long a request waits for the notification job to be queued. The queue's connection retries forever while Redis is down (BullMQ requires `maxRetriesPerRequest: null`), so an unbounded wait would hang every request that records an event; past this bound the notification counts as a failed sink and the request carries on. */
export const NOTIFY_ENQUEUE_TIMEOUT_MS: number = 2000;

const MAX_TEXT = 256;
/** Delay past the window's end before its final count is written, so an event recorded in the last instant of the window has landed in the counter first. */
const FINAL_COUNT_GRACE_MS = 1000;

/**
 * Whether a code point is a C0 or C1 control character or the Unicode line or paragraph separator, any of which could forge extra lines in a notification. A comparison rather than a character-class regex, which would have to spell control characters out.
 *
 * @param code - A UTF-16 code unit.
 * @returns True when it must not reach a notification.
 */
const isControlCharacter = (code: number): boolean =>
  code <= 0x1f || (code >= 0x7f && code <= 0x9f) || code === 0x2028 || code === 0x2029;

/**
 * Replaces every control character with a space rather than deleting it, so two words a forged newline separated stay two words once whitespace is collapsed.
 *
 * @param value - Untrusted text.
 * @returns The text with every control character turned into a space.
 */
const withoutControlCharacters = (value: string): string =>
  Array.from(value, (ch) => (isControlCharacter(ch.charCodeAt(0)) ? ' ' : ch)).join('');

/**
 * Makes attacker-controlled text safe to show in a notification or on a page.
 *
 * Providers already escape their own markup (`&`, `<`, `>`), which makes `<!channel>` and link syntax inert. What is left is shaping: control characters and newlines could forge extra lines that look like the app's own fields, and chat clients turn bare URLs and domains into links. So control characters are stripped, whitespace collapsed, `://` broken and dots replaced with a look-alike that does not link, then the text is capped.
 *
 * @param value - Text from a request (a browser user agent, an identity provider error).
 * @returns Inert text of at most 256 characters.
 */
export const sanitizeUntrusted = (value: string): string =>
  withoutControlCharacters(value)
    .replace(/\s+/g, ' ')
    .trim()
    .replace(/:\/\//g, ':⁄⁄')
    .replace(/\./g, '․')
    .slice(0, MAX_TEXT);

/**
 * The address as a notification shows it. A valid IP address holds only hex digits, dots and colons, so it carries no markup and is passed through exactly: the look-alike dots the sanitiser uses would make it impossible to paste into a firewall rule or a log search, which is what the operator does with it. Anything else in that field came from a forwarding header a client can set, so it is sanitised like any other untrusted text.
 *
 * @param address - The client address the request was attributed to.
 * @returns The address unchanged when it is a valid IP, otherwise inert text.
 */
const notificationAddress = (address: string): string =>
  isIP(address) !== 0 ? address : sanitizeUntrusted(address);

/**
 * Whether a count is a power of two. The aggregate row is rewritten only at these counts, so a flood of n events costs O(log n) database writes instead of n.
 *
 * @param count - Occurrences so far in the window, including the one that claimed it.
 * @returns True when the row's count should be rewritten now.
 */
const isPowerOfTwo = (count: number): boolean => count > 0 && (count & (count - 1)) === 0;

/** A failure in the Redis bookkeeping that folds repeats into one row. Kept apart from a failed audit write so the sink failure metric says which store broke. */
class AggregationFailure extends Error {
  constructor(cause: unknown) {
    super('security event aggregation failed', { cause });
  }
}

/**
 * Runs one Redis step of the aggregation and relabels its failure, so it is counted under the `aggregate` sink rather than `audit`.
 *
 * @param step - The Redis call.
 * @returns Whatever the step returns.
 */
const aggregationStep = async <T>(step: () => Promise<T>): Promise<T> => {
  try {
    return await step();
  } catch (err) {
    throw new AggregationFailure(err);
  }
};

/**
 * Builds the recorder. Each occurrence goes to four independent destinations: a structured log line, the metrics, an audit row (category `security`, attributed to the sole operator) and, when the catalogue says so, a notification job the worker delivers. A failure in one never stops the others and is itself counted and logged.
 *
 * @param deps - Database, Redis, queue, logger and metrics.
 * @returns The recorder.
 */
export const createSecurityEventRecorder = (
  deps: SecurityEventRecorderDeps,
): SecurityEventRecorder => {
  const now = deps.now ?? Date.now;
  const schedule =
    deps.schedule ??
    ((run: () => void, delayMs: number): void => {
      setTimeout(run, delayMs).unref();
    });
  let operatorId: UserId | null = null;

  const resolveOperator = async (): Promise<UserId | null> => {
    if (operatorId !== null) return operatorId;
    try {
      operatorId = await repo.users.findSingleId(deps.db);
      return operatorId;
    } catch (err) {
      deps.metrics.sinkFailures.inc({ sink: 'operator_lookup' });
      deps.logger.error({ err }, 'security_event_operator_lookup_failed');
      return null;
    }
  };

  /**
   * Writes a closed window's total onto its row. The count only ever rises (the repo keeps the greater value), so a late or repeated write cannot lower it. Never throws: it runs from a timer, where a rejection would be unhandled.
   *
   * @param counterKey - The Redis counter of repeats after the first.
   * @param rowId - The audit row the window's first occurrence wrote.
   * @param event - The event, for the failure log.
   */
  const writeFinalCount = async (
    counterKey: string,
    rowId: string,
    event: SecurityEventInput['event'],
  ): Promise<void> => {
    try {
      const extra = await deps.redis.get(counterKey);
      if (extra === null) return;
      await repo.auditLogs.raiseSecurityCount(deps.db, rowId, Number(extra) + 1);
    } catch (err) {
      deps.metrics.sinkFailures.inc({ sink: 'aggregate' });
      deps.logger.error({ err, securityEvent: event }, 'security_event_final_count_failed');
    }
  };

  const writeAudit = async (
    input: SecurityEventInput,
    reason: SecurityEventReason,
    method: SignInMethod,
  ): Promise<void> => {
    const operator = await resolveOperator();
    // Before onboarding there is no operator row to attribute to; the log line and metric above are the whole record then.
    if (operator === null) return;
    const meta = SECURITY_EVENT_CATALOG[input.event];
    const individual =
      !meta.aggregated || (input.event === 'sign-in-failed' && input.emailMatched === true);
    const payload = {
      method,
      reason,
      count: 1,
      ...(input.emailMatched !== undefined ? { emailMatched: input.emailMatched } : {}),
      detail: input.detail ?? {},
    };
    const row = {
      actor: input.actor ?? 'anonymous',
      event: input.event,
      ip: input.ipAddress ?? null,
      userAgent: input.userAgent ? input.userAgent.slice(0, MAX_TEXT) : null,
      category: 'security' as const,
      payload,
    };
    if (individual) {
      await repo.auditLogs.append(deps.db, operator, row);
      return;
    }
    const windowKey = `auth:agg:${input.event}:${reason}:${Math.floor(now() / AGGREGATE_WINDOW_MS)}`;
    const id = crypto.randomUUID();
    const claimed = await aggregationStep(() =>
      deps.redis.set(windowKey, id, 'PX', AGGREGATE_WINDOW_MS, 'NX'),
    );
    if (claimed === 'OK') {
      try {
        await repo.auditLogs.append(deps.db, operator, { ...row, id } as typeof row);
      } catch (err) {
        // The key would otherwise point every later event in this window at a row that does not exist, dropping all of them from the audit trail; releasing it lets the next event claim the window and write a row.
        await deps.redis.del(windowKey).catch((releaseErr: unknown) => {
          deps.metrics.sinkFailures.inc({ sink: 'aggregate' });
          deps.logger.error(
            { err: releaseErr, securityEvent: input.event },
            'security_event_window_release_failed',
          );
        });
        throw err;
      }
      // Rewriting only at powers of two leaves the row short of the real total, by up to half, once the window closes: twenty failures would read as sixteen for good. The process that opened the window writes the final count once it closes, from the shared counter, so repeats other replicas recorded are included. If this process stops first, the power-of-two count stays as a lower bound.
      const windowEnd = (Math.floor(now() / AGGREGATE_WINDOW_MS) + 1) * AGGREGATE_WINDOW_MS;
      schedule(
        () => {
          void writeFinalCount(`${windowKey}:n`, id, input.event);
        },
        windowEnd - now() + FINAL_COUNT_GRACE_MS,
      );
      return;
    }
    const [existingId, extra] = await aggregationStep(() =>
      Promise.all([
        deps.redis.get(windowKey),
        deps.redis.incr(`${windowKey}:n`).then(async (n) => {
          // Two windows, not one: the final count is read just after this window closes, and a counter first raised at the window's start would otherwise already be gone.
          if (n === 1) await deps.redis.pexpire(`${windowKey}:n`, 2 * AGGREGATE_WINDOW_MS);
          return n;
        }),
      ]),
    );
    const total = extra + 1;
    if (existingId !== null && isPowerOfTwo(total))
      await repo.auditLogs.raiseSecurityCount(deps.db, existingId, total);
  };

  const enqueueNotification = async (
    input: SecurityEventInput,
    reason: SecurityEventReason,
    method: SignInMethod,
  ): Promise<void> => {
    const meta = SECURITY_EVENT_CATALOG[input.event];
    if (meta.notify === 'none') return;
    if (meta.aggregated || input.event === 'reauthentication-failed') {
      const gate = await deps.redis.set(
        `auth:notify:${input.event}:${reason}`,
        '1',
        'PX',
        NOTIFY_THROTTLE_MS,
        'NX',
      );
      if (gate !== 'OK') return;
    }
    const fields: { label: string; value: string }[] = [];
    if (method !== 'none') fields.push({ label: 'Method', value: SIGN_IN_METHOD_LABEL[method] });
    if (reason !== 'none') fields.push({ label: 'Reason', value: reason.replace(/_/g, ' ') });
    if (input.ipAddress)
      fields.push({ label: 'IP address', value: notificationAddress(input.ipAddress) });
    if (input.userAgent)
      fields.push({ label: 'Browser', value: sanitizeUntrusted(input.userAgent) });
    for (const [label, value] of Object.entries(input.detail ?? {}).slice(0, 4)) {
      if (value !== null)
        fields.push({
          label: sanitizeUntrusted(label).slice(0, 64),
          value: sanitizeUntrusted(String(value)),
        });
    }
    const suffix = meta.aggregated
      ? ' Repeats in the next 10 minutes are recorded but not notified.'
      : '';
    const job: AuthSecurityNotifyJob = {
      category: meta.notify === 'alert' ? 'auth-alert' : 'auth-activity',
      event: input.event,
      body: `${meta.description}${suffix}`,
      fields: fields.slice(0, 8),
    };
    let timer: ReturnType<typeof setTimeout> | undefined;
    try {
      await Promise.race([
        deps.queue.add('notify-auth-security', job),
        new Promise((_, reject) => {
          timer = setTimeout(
            () => reject(new Error('notification enqueue timed out')),
            NOTIFY_ENQUEUE_TIMEOUT_MS,
          );
        }),
      ]);
    } finally {
      if (timer !== undefined) clearTimeout(timer);
    }
  };

  return {
    async record(input) {
      const reason = input.reason ?? 'none';
      const method = input.method ?? 'none';
      const meta = SECURITY_EVENT_CATALOG[input.event];
      try {
        deps.metrics.recordEvent(input.event, method, reason);
        const line = {
          securityEvent: input.event,
          method,
          reason,
          ip: input.ipAddress ?? null,
          detail: input.detail ?? {},
        };
        if (meta.notify === 'alert' || reason !== 'none') deps.logger.warn(line, 'security_event');
        else deps.logger.info(line, 'security_event');
      } catch {
        // Metrics and logging are in-process and cannot meaningfully fail; nothing to report through if they did.
      }
      const results = await Promise.allSettled([
        writeAudit(input, reason, method),
        enqueueNotification(input, reason, method),
      ]);
      const sinks = ['audit', 'notify'] as const;
      results.forEach((result, i) => {
        if (result.status === 'rejected') {
          const sink =
            result.reason instanceof AggregationFailure ? 'aggregate' : (sinks[i] ?? 'audit');
          deps.metrics.sinkFailures.inc({ sink });
          deps.logger.error(
            { err: result.reason, securityEvent: input.event, sink },
            'security_event_sink_failed',
          );
        }
      });
    },
  };
};
