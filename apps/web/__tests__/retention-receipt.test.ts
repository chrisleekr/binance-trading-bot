// The retention footer's sentence.
//
// This line is the only operator-visible answer to "is retention still running?"
// — a failing prune cron throws into the dead-letter queue, which no screen in
// the app reads. The cases below pin the two ways that line could lie: a failed
// sweep rendering as a healthy one, and a sweep that discarded whole hypertable
// chunks rendering as "0 pruned" because chunk drops never touch rows.

import { describe, expect, it } from 'vitest';

import { RetentionReceiptSchema, type RetentionStatusResponse } from '@app/contracts';

import { describeReceipt } from '../src/features/profile/lib/retention-receipt';

const NOW = 1_715_000_000_000;

// Parsed rather than cast, so a test fixture can never claim a shape the API
// would reject — and so the schema's own defaults are what these assertions see.
const receipt = (over: Record<string, unknown>): RetentionStatusResponse['auditPrune'] =>
  RetentionReceiptSchema.parse({
    kind: 'action-log-prune',
    ranAtMs: NOW - 3 * 3_600_000,
    deleted: 0,
    retentionDays: 7,
    ...over,
  });

describe('describeReceipt', () => {
  it('says never run when the cron has not reported since the worker started', () => {
    expect(describeReceipt('Action log', null, NOW)).toBe('Action log: never run');
  });

  it('reports a healthy sweep with its count, age, and the horizon it applied', () => {
    expect(describeReceipt('Action log', receipt({ deleted: 42 }), NOW)).toBe(
      'Action log: 42 pruned 3h ago (retain 7d)',
    );
  });

  it('names the failure instead of the counts, so a dead cron cannot read as healthy', () => {
    const line = describeReceipt(
      'Action log',
      receipt({ ok: false, error: 'statement timeout', deleted: 40 }),
      NOW,
    );
    expect(line).toContain('FAILED');
    expect(line).toContain('statement timeout');
    // The partial count is deliberately not shown: "40 pruned" beside a failure
    // reads as a completed sweep of 40 rows.
    expect(line).not.toContain('40 pruned');
  });

  it('refuses an unbounded failure text, so the public route cannot echo a driver dump', () => {
    // `GET /retention-status` is readable without a login under LIVE_DEMO. The
    // producer writes a short classification; the bound is what keeps that a
    // property of the contract rather than a habit of one writer.
    expect(() => receipt({ ok: false, error: 'x'.repeat(121) })).toThrow();
  });

  it('falls back to a placeholder when a failure receipt carries no message', () => {
    expect(describeReceipt('Action log', receipt({ ok: false }), NOW)).toContain(
      'reason not recorded',
    );
  });

  it('counts dropped chunks beside rows, so the biggest sweep is not shown as nothing', () => {
    // The age rule unlinks whole expired chunks without reading their rows. A
    // line built from `deleted` alone would report a night that discarded a
    // month of history as "4 pruned".
    expect(
      describeReceipt(
        'Action log',
        receipt({ deleted: 4, byRule: { age: 4, ageChunks: 31, rowCap: 0 } }),
        NOW,
      ),
    ).toBe('Action log: 4 rows + 31 chunks 3h ago (retain 7d)');
  });

  it('omits the horizon when the run died before it could read one', () => {
    const line = describeReceipt('Action log', receipt({ retentionDays: null }), NOW);
    expect(line).not.toContain('retain');
  });

  it('reports sub-minute and sub-hour ages in their own units', () => {
    expect(describeReceipt('Audit', receipt({ ranAtMs: NOW - 5_000 }), NOW)).toContain('5s ago');
    expect(describeReceipt('Audit', receipt({ ranAtMs: NOW - 300_000 }), NOW)).toContain('5m ago');
  });

  it('clamps a receipt stamped in the future rather than showing a negative age', () => {
    expect(describeReceipt('Audit', receipt({ ranAtMs: NOW + 60_000 }), NOW)).toContain('0s ago');
  });
});
