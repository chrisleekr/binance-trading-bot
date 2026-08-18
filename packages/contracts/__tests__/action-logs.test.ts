import { describe, expect, it } from 'vitest';
import { ActionLogQuery } from '../src/action-logs.js';

const UUID = '00000000-0000-4000-8000-0000000000d1';

/**
 * The action-log cursor is the only validation a `timestamptz` bind gets on the profile-logs read path, so what it admits is what Postgres is asked to parse.
 *
 * It checks digit COUNTS, not calendar validity: every field is `\d{4}` or `\d{2}` of anything. That admits dates Postgres has no representation for — there is no year zero in AD/BC notation, and no month 99 — which reach `$n::timestamptz` and come back as SQLSTATE 22008. That is neither a statement timeout nor a checkout timeout, so it falls through the error classifier to an unhandled 500 on a route whose only declared failure is 422.
 */
describe('ActionLogQuery cursor', () => {
  it('accepts the cursor shape the log reader emits', () => {
    // The anchor for the two rejections below: they have to fail on the calendar, not because the whole shape stopped parsing.
    const ok = ActionLogQuery.safeParse({ cursor: `2026-01-01T00:00:00.000000Z|${UUID}` });
    expect(ok.success).toBe(true);
  });

  it('rejects a calendar date Postgres cannot represent', () => {
    for (const cursor of [
      `0000-01-01T00:00:00.000000Z|${UUID}`,
      `2026-99-01T00:00:00.000000Z|${UUID}`,
    ]) {
      expect(ActionLogQuery.safeParse({ cursor }).success).toBe(false);
    }
  });
});
