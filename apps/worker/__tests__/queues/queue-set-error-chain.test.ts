import { describe, expect, it } from 'vitest';
import { flattenErrorMessage } from '../../src/queues/queue-set.js';

// The two production shapes the DLQ boundary must keep diagnosable: a governor
// backpressure wrapper hiding the real Redis fault, and a Drizzle query wrapper
// hiding the pg fault. Both carry the root on `.cause`.
class RedisUnavailableError extends Error {
  constructor(cause: unknown) {
    super('WeightGovernor: Redis unavailable — bulk read skipped');
    this.name = 'RedisUnavailableError';
    this.cause = cause;
  }
}

describe('flattenErrorMessage', () => {
  it('returns the bare message when there is no cause', () => {
    expect(flattenErrorMessage(new Error('plain failure'))).toBe('plain failure');
  });

  it('folds a governor eval-timeout cause into the message', () => {
    const err = new RedisUnavailableError(new Error('WeightGovernor: Redis eval timed out'));
    expect(flattenErrorMessage(err)).toBe(
      'WeightGovernor: Redis unavailable — bulk read skipped ← caused by: WeightGovernor: Redis eval timed out',
    );
  });

  it('distinguishes a real connection fault from a timeout (different alert groups)', () => {
    const timeout = flattenErrorMessage(
      new RedisUnavailableError(new Error('WeightGovernor: Redis eval timed out')),
    );
    const refused = flattenErrorMessage(
      new RedisUnavailableError(new Error('connect ECONNREFUSED 127.0.0.1:6379')),
    );
    expect(timeout).not.toBe(refused);
    expect(refused).toContain('ECONNREFUSED');
  });

  it('names a non-generic cause class', () => {
    const cause = new TypeError('boom');
    expect(flattenErrorMessage(new RedisUnavailableError(cause))).toContain(
      '← caused by: TypeError: boom',
    );
  });

  it('walks a multi-level chain (wrapper → app → driver)', () => {
    const driver = new Error('connection terminated unexpectedly');
    const app = new Error('query failed');
    (app as { cause?: unknown }).cause = driver;
    const wrapper = new RedisUnavailableError(app);
    expect(flattenErrorMessage(wrapper)).toBe(
      'WeightGovernor: Redis unavailable — bulk read skipped ← caused by: query failed ← caused by: connection terminated unexpectedly',
    );
  });

  it('terminates on a cyclic cause chain and bounds length', () => {
    const a = new Error('a');
    const b = new Error('b');
    (a as { cause?: unknown }).cause = b;
    (b as { cause?: unknown }).cause = a;
    const out = flattenErrorMessage(a);
    // Does not hang, and stays within the length bound.
    expect(out.length).toBeLessThanOrEqual(600);
    expect(out.startsWith('a ← caused by: b')).toBe(true);
  });

  it('truncates an oversized message to the 600-char cap with an ellipsis', () => {
    // Drives the true-branch of the length cap (the cyclic test stays short).
    const out = flattenErrorMessage(new Error('x'.repeat(1000)));
    expect(out.length).toBe(600);
    expect(out.endsWith('…')).toBe(true);
  });

  it('stringifies a non-Error (message-less) cause', () => {
    const e = new Error('wrap');
    (e as { cause?: unknown }).cause = 'raw string reason';
    expect(flattenErrorMessage(e)).toBe('wrap ← caused by: raw string reason');
  });

  it('redacts credentials embedded in a connection URI before egress', () => {
    // A driver error can echo its DSN; the password must not reach the persisted
    // record or the Slack alert, but the scheme/host stay for diagnosis.
    const e = new Error('pool error');
    (e as { cause?: unknown }).cause = new Error(
      'connect ECONNREFUSED at postgres://app:s3cr3tP4ss@db.internal:5432/trading',
    );
    const out = flattenErrorMessage(e);
    expect(out).not.toContain('s3cr3tP4ss');
    expect(out).toContain('[redacted]@');
    expect(out).toContain('db.internal:5432');
  });
});
