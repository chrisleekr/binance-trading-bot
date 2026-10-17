const DAY_MS = 86_400_000;

/**
 * Offset of `tz` from UTC at instant `t`, in ms: the zone's wall clock read as if it were UTC, minus the instant.
 * @param tz - IANA zone, already validated by the caller's query schema.
 * @param t - Epoch ms to read the offset at; DST makes the offset depend on it.
 * @returns Positive east of Greenwich (Sydney is +10h or +11h).
 */
const tzOffsetMs = (tz: string, t: number): number => {
  const parts = new Intl.DateTimeFormat('en-US', {
    timeZone: tz,
    hourCycle: 'h23',
    year: 'numeric',
    month: 'numeric',
    day: 'numeric',
    hour: 'numeric',
    minute: 'numeric',
    second: 'numeric',
  }).formatToParts(new Date(t));
  const n = (type: string): number => Number(parts.find((p) => p.type === type)?.value);
  return (
    Date.UTC(n('year'), n('month') - 1, n('day'), n('hour'), n('minute'), n('second')) -
    Math.floor(t / 1000) * 1000
  );
};

/**
 * The instant a `tz` calendar date starts. Midnight resolves against the offsets in force a day either side, since a DST switch on that date leaves at most those two.
 * @param tz - IANA zone.
 * @param y - Calendar year in `tz`.
 * @param m - Zero-based month in `tz`; out-of-range days roll over as `Date.UTC` does.
 * @param d - Day of month in `tz`.
 * @returns The first 00:00 local on that date as a UTC instant; when clocks fall back onto midnight (Gaza) the earlier one, and when DST skips midnight (Santiago, Havana) the first instant that exists.
 */
const localMidnight = (tz: string, y: number, m: number, d: number): Date => {
  const wall = Date.UTC(y, m, d);
  const candidates = [wall - tzOffsetMs(tz, wall - DAY_MS), wall - tzOffsetMs(tz, wall + DAY_MS)];
  const real = candidates.filter((t) => t + tzOffsetMs(tz, t) === wall);
  return new Date(real.length > 0 ? Math.min(...real) : Math.max(...candidates));
};

/**
 * Locale-aware period boundary helper. `'a'` = all time, `'d'` = day, `'w'` = week (Mon-anchored), `'m'` = month. Each window starts at local midnight in the target timezone, so the closed-trades widget and the archive page total the operator's own day, week and month rather than UTC's.
 * @param period - Which window: all time, day, week or month.
 * @param tz - IANA zone whose calendar and midnight define the window.
 * @param now - The window's end, and the instant whose local date picks the window.
 * @returns The `{from, to}` instants; `from` is the epoch for all time.
 */
export const periodWindow = (
  period: 'a' | 'd' | 'w' | 'm',
  tz: string,
  now: Date,
): { from: Date; to: Date } => {
  if (period === 'a') return { from: new Date(0), to: now };
  const fmt = new Intl.DateTimeFormat('en-CA', {
    timeZone: tz,
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
  });
  const parts = fmt.formatToParts(now);
  const year = Number(parts.find((p) => p.type === 'year')?.value);
  const month = Number(parts.find((p) => p.type === 'month')?.value);
  const day = Number(parts.find((p) => p.type === 'day')?.value);
  if (period === 'd') return { from: localMidnight(tz, year, month - 1, day), to: now };
  if (period === 'w') {
    const dow = new Date(Date.UTC(year, month - 1, day)).getUTCDay();
    return { from: localMidnight(tz, year, month - 1, day - ((dow + 6) % 7)), to: now };
  }
  return { from: localMidnight(tz, year, month - 1, 1), to: now };
};
