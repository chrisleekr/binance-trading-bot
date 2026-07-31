import { describe, expect, it } from 'vitest';

import { formatClock, formatDate, formatInstant, humaniseAge } from '@/shared/lib/format-time';

// A fixed instant so the rendered fields are deterministic regardless of the
// host clock or browser locale. Sydney has no DST in June, so the local offset
// is a stable UTC+10 (GMT+10).
const INSTANT = '2026-06-20T14:30:00Z';

describe('formatInstant', () => {
  it('renders a UTC-only string when the zone is UTC', () => {
    const out = formatInstant(INSTANT, 'UTC');
    expect(out).toContain('14:30');
    expect(out).toContain('UTC');
    // Single zone only — no dual-zone separator.
    expect(out).not.toContain('·');
  });

  it('renders only the configured zone, never UTC, when the zone is not UTC', () => {
    const out = formatInstant(INSTANT, 'Australia/Sydney');
    // Configured-zone only: Sydney is UTC+10 in June, so 14:30Z → 2026-06-21 00:30.
    expect(out).toBe('2026-06-21 00:30 GMT+10');
    expect(out).not.toContain('UTC'); // no UTC anchor
    expect(out).not.toContain('·'); // no dual-zone separator
    expect(out).not.toContain('14:30'); // the UTC wall-clock must not appear
  });

  it('accepts an epoch-ms number as input', () => {
    const out = formatInstant(Date.parse(INSTANT), 'UTC');
    expect(out).toContain('14:30');
  });

  it('renders a fixed YYYY-MM-DD HH:mm order regardless of locale', () => {
    expect(formatInstant(INSTANT, 'UTC')).toBe('2026-06-20 14:30 UTC');
  });

  it('returns an em-dash for unparseable input', () => {
    expect(formatInstant('not-a-date', 'UTC')).toBe('—');
    expect(formatInstant(NaN, 'Australia/Sydney')).toBe('—');
  });

  it('renders midnight as 00:00, not 24:00', () => {
    // hourCycle h23 must pin midnight to 00, in UTC and in a shifted zone
    // (Sydney midnight = 14:00 UTC the day before).
    expect(formatInstant('2026-06-20T00:00:00Z', 'UTC')).toBe('2026-06-20 00:00 UTC');
    expect(formatInstant('2026-06-19T14:00:00Z', 'Australia/Sydney')).toBe(
      '2026-06-20 00:00 GMT+10',
    );
  });
});

describe('formatClock', () => {
  it('renders HH:mm:ss with the zone label in UTC', () => {
    expect(formatClock('2026-06-20T14:03:22Z', 'UTC')).toBe('14:03:22 UTC');
  });

  it('shifts the wall clock into the configured zone', () => {
    // Sydney is UTC+10 in June (no DST), so 14:03:22Z is 00:03:22 the next day.
    expect(formatClock('2026-06-20T14:03:22Z', 'Australia/Sydney')).toBe('00:03:22 GMT+10');
    expect(formatClock('2026-06-20T14:03:22Z', 'America/New_York')).toBe('10:03:22 GMT-4');
  });

  it('renders midnight as 00:00:00, not 24:00:00', () => {
    expect(formatClock('2026-06-20T00:00:00Z', 'UTC')).toBe('00:00:00 UTC');
  });

  it('accepts an epoch-ms number and a Date', () => {
    const ms = Date.parse('2026-06-20T14:03:22Z');
    expect(formatClock(ms, 'UTC')).toBe('14:03:22 UTC');
    expect(formatClock(new Date(ms), 'UTC')).toBe('14:03:22 UTC');
  });

  it('returns an em-dash for unparseable input', () => {
    expect(formatClock('not-a-date', 'UTC')).toBe('—');
    expect(formatClock(NaN, 'Australia/Sydney')).toBe('—');
  });
});

describe('formatDate', () => {
  it('renders a date-only string in the configured zone', () => {
    // 14:30 UTC is the next calendar day in Sydney (UTC+10).
    expect(formatDate(INSTANT, 'UTC')).toBe('2026-06-20');
    expect(formatDate(INSTANT, 'Australia/Sydney')).toBe('2026-06-21');
  });

  it('returns an em-dash for unparseable input', () => {
    expect(formatDate('nope', 'UTC')).toBe('—');
  });
});

describe('humaniseAge', () => {
  const S = 1_000;

  // Tier boundaries: the last value in a unit and the first value of the next,
  // proving the s→m→h→d thresholds land exactly where the old per-surface
  // ladders did (whole precision floors each unit).
  it.each([
    [59 * S, '59s'],
    [60 * S, '1m'],
    [3_599 * S, '59m'],
    [3_600 * S, '1h'],
    [86_399 * S, '23h'],
    [86_400 * S, '1d'],
    [0, '0s'],
  ])('whole precision: %ims → %s', (ms, expected) => {
    expect(humaniseAge(ms)).toBe(expected);
  });

  it('appends the suffix verbatim (folds formatStaleness: " ago" baked in)', () => {
    expect(humaniseAge(30 * S, { suffix: ' ago' })).toBe('30s ago');
    expect(humaniseAge(5 * 60 * S, { suffix: ' ago' })).toBe('5m ago');
    expect(humaniseAge(2 * 3_600 * S, { suffix: ' ago' })).toBe('2h ago');
  });

  it('folds formatFreshAge tiers (no suffix)', () => {
    expect(humaniseAge(12 * S)).toBe('12s');
    expect(humaniseAge(5 * 60 * S)).toBe('5m');
    expect(humaniseAge(3 * 3_600 * S)).toBe('3h');
    expect(humaniseAge(2 * 86_400 * S)).toBe('2d');
  });

  it('tenths precision folds formatDuration (rounds sub-hour, one decimal above)', () => {
    expect(humaniseAge(45 * S, { precision: 'tenths' })).toBe('45s');
    expect(humaniseAge(12 * 60 * S, { precision: 'tenths' })).toBe('12m');
    expect(humaniseAge(3.2 * 3_600 * S, { precision: 'tenths' })).toBe('3.2h');
    expect(humaniseAge(4.1 * 86_400 * S, { precision: 'tenths' })).toBe('4.1d');
  });

  it('clamps negative input (clock skew) to 0s', () => {
    expect(humaniseAge(-5_000)).toBe('0s');
    expect(humaniseAge(-5_000, { suffix: ' ago' })).toBe('0s ago');
  });
});
