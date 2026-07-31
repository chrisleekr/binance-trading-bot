import { describe, expect, it } from 'vitest';

import { periodWindow } from '../../src/lib/period-window.js';

// June has no DST transition in any of the zones below, so the offsets are
// stable: UTC+0, Sydney UTC+10, New York UTC-4 (EDT).
const iso = (d: Date): string => d.toISOString();

describe('periodWindow', () => {
  it('returns the epoch as the lower bound for all-time', () => {
    const now = new Date('2026-06-20T14:30:00Z');
    const w = periodWindow('a', 'Australia/Sydney', now);
    expect(iso(w.from)).toBe('1970-01-01T00:00:00.000Z');
    expect(w.to).toBe(now);
  });

  it('always closes the window at `now`', () => {
    const now = new Date('2026-06-20T14:30:00Z');
    for (const period of ['d', 'w', 'm'] as const) {
      expect(periodWindow(period, 'UTC', now).to).toBe(now);
    }
  });

  describe('day', () => {
    it('cuts the day at the operator zone, not the server zone', () => {
      // 14:30Z is already the 21st in Sydney, still the 20th in UTC/New York.
      const now = new Date('2026-06-20T14:30:00Z');
      expect(iso(periodWindow('d', 'UTC', now).from)).toBe('2026-06-20T00:00:00.000Z');
      expect(iso(periodWindow('d', 'Australia/Sydney', now).from)).toBe('2026-06-21T00:00:00.000Z');
      expect(iso(periodWindow('d', 'America/New_York', now).from)).toBe('2026-06-20T00:00:00.000Z');
    });

    it('cuts to the previous day for a zone still behind midnight', () => {
      // 02:30Z is 22:30 the previous evening in New York.
      const now = new Date('2026-06-20T02:30:00Z');
      expect(iso(periodWindow('d', 'UTC', now).from)).toBe('2026-06-20T00:00:00.000Z');
      expect(iso(periodWindow('d', 'America/New_York', now).from)).toBe('2026-06-19T00:00:00.000Z');
    });
  });

  describe('week', () => {
    it('anchors on Monday of the operator-zone week', () => {
      // Saturday 2026-06-20 in UTC — the Monday before is 2026-06-15.
      const now = new Date('2026-06-20T14:30:00Z');
      expect(iso(periodWindow('w', 'UTC', now).from)).toBe('2026-06-15T00:00:00.000Z');
    });

    it('rolls to the next week when the operator zone has already crossed Monday', () => {
      // Sunday 14:30Z is Monday 2026-06-22 in Sydney: a new week there, the
      // tail of the 06-15 week in UTC.
      const now = new Date('2026-06-21T14:30:00Z');
      expect(iso(periodWindow('w', 'UTC', now).from)).toBe('2026-06-15T00:00:00.000Z');
      expect(iso(periodWindow('w', 'Australia/Sydney', now).from)).toBe('2026-06-22T00:00:00.000Z');
    });

    it('stays in the previous week when the operator zone has not reached Monday', () => {
      // Monday 02:30Z is still Sunday 2026-06-21 in New York.
      const now = new Date('2026-06-22T02:30:00Z');
      expect(iso(periodWindow('w', 'UTC', now).from)).toBe('2026-06-22T00:00:00.000Z');
      expect(iso(periodWindow('w', 'America/New_York', now).from)).toBe('2026-06-15T00:00:00.000Z');
    });
  });

  describe('month', () => {
    it('starts at the 1st of the operator-zone month', () => {
      const now = new Date('2026-06-20T14:30:00Z');
      expect(iso(periodWindow('m', 'UTC', now).from)).toBe('2026-06-01T00:00:00.000Z');
      expect(iso(periodWindow('m', 'Australia/Sydney', now).from)).toBe('2026-06-01T00:00:00.000Z');
    });

    it('stays in the previous month when the operator zone has not rolled over', () => {
      // 2026-07-01 02:30Z is still 2026-06-30 in New York.
      const now = new Date('2026-07-01T02:30:00Z');
      expect(iso(periodWindow('m', 'UTC', now).from)).toBe('2026-07-01T00:00:00.000Z');
      expect(iso(periodWindow('m', 'America/New_York', now).from)).toBe('2026-06-01T00:00:00.000Z');
    });
  });
});
