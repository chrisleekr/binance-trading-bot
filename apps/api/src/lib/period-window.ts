/**
 * Locale-aware period boundary helper. `'a'` = all time, `'d'` = day,
 * `'w'` = week (Mon-anchored), `'m'` = month. Computes a `{from, to}`
 * window in the target timezone so the closed-trades widget and the
 * archive page surface day/week/month totals that match the operator's
 * wall clock rather than UTC.
 *
 * Boundaries are derived from a UTC-formatted YYYY-MM-DD parts split in
 * the target tz, which DST-transition-edges may misalign by one hour;
 * acceptable for the cardinality these views care about (per-day P&L
 * summaries, not minute-precision audits).
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
  const startOfDayUtc = new Date(Date.UTC(year, month - 1, day));
  if (period === 'd') {
    return { from: startOfDayUtc, to: now };
  }
  if (period === 'w') {
    const dow = startOfDayUtc.getUTCDay();
    const monday = new Date(startOfDayUtc);
    monday.setUTCDate(startOfDayUtc.getUTCDate() - ((dow + 6) % 7));
    return { from: monday, to: now };
  }
  const monthStart = new Date(Date.UTC(year, month - 1, 1));
  return { from: monthStart, to: now };
};
