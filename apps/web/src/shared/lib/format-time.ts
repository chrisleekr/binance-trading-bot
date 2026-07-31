// Render timestamps in the operator's configured display timezone.
//
// Every persisted timestamp the API returns is UTC; these helpers shift it into
// the operator's chosen zone so every time on screen reads in that one zone, no
// mental offset math. The short zone label always travels with the value so a
// bare wall-clock is never ambiguous. When the configured zone is UTC the label
// reads "UTC".

type TimeInput = string | number | Date;

/** Placeholder for an instant we cannot parse, matching the app's em-dash idiom. */
const INVALID = '—';

export interface HumaniseAgeOptions {
  /** Appended verbatim, e.g. `' ago'`. Default: none. */
  suffix?: string;
  /**
   * `'whole'` (default) floors each unit (`59s`, `1m`, `2h`); `'tenths'` rounds
   * sub-hour to whole and shows one decimal for hours/days (`3.2h`, `4.1d`).
   */
  precision?: 'whole' | 'tenths';
}

const SEC = 1_000;
const MIN = 60_000;
const HOUR = 3_600_000;
const DAY = 86_400_000;

/**
 * Humanise an elapsed-milliseconds span as a compact `s → m → h → d` label.
 * Single source for the operator-facing age ladder (staleness pills, compute
 * health, backtest hold-times). Takes a single elapsed-ms arg — orthogonal to
 * past-age vs time-until-due, so a caller passes `now - then` or `then - now`.
 * Negative input clamps to `0s`.
 */
export function humaniseAge(elapsedMs: number, opts: HumaniseAgeOptions = {}): string {
  const { suffix = '', precision = 'whole' } = opts;
  const ms = Math.max(0, elapsedMs);
  const tenths = precision === 'tenths';
  let body: string;
  if (ms < MIN) body = `${tenths ? Math.round(ms / SEC) : Math.floor(ms / SEC)}s`;
  else if (ms < HOUR) body = `${tenths ? Math.round(ms / MIN) : Math.floor(ms / MIN)}m`;
  else if (ms < DAY) body = tenths ? `${(ms / HOUR).toFixed(1)}h` : `${Math.floor(ms / HOUR)}h`;
  else body = tenths ? `${(ms / DAY).toFixed(1)}d` : `${Math.floor(ms / DAY)}d`;
  return body + suffix;
}

/**
 * Format the wall-clock "YYYY-MM-DD HH:mm" of `date` in `timeZone`.
 *
 * Built from `formatToParts` rather than a format string so the output order is
 * fixed regardless of the host locale (e.g. en-US would otherwise emit
 * MM/DD/YYYY). `hourCycle: 'h23'` pins midnight to 00, not 24 — some ICU
 * builds render `hour12: false` as the h24 cycle, depending on locale.
 */
function wallClock(date: Date, timeZone: string): string {
  const parts = new Intl.DateTimeFormat('en-GB', {
    timeZone,
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
    hour: '2-digit',
    minute: '2-digit',
    hourCycle: 'h23',
  }).formatToParts(date);
  const get = (type: Intl.DateTimeFormatPartTypes): string =>
    parts.find((p) => p.type === type)?.value ?? '';
  return `${get('year')}-${get('month')}-${get('day')} ${get('hour')}:${get('minute')}`;
}

/** The short zone abbreviation for `timeZone` at `date` (e.g. "GMT+10", "AEST"). */
function zoneShortName(date: Date, timeZone: string): string {
  const parts = new Intl.DateTimeFormat('en-GB', {
    timeZone,
    timeZoneName: 'short',
  }).formatToParts(date);
  return parts.find((p) => p.type === 'timeZoneName')?.value ?? '';
}

/**
 * Format an instant in the operator's configured timezone, e.g.
 * `"2026-06-21 00:30 GMT+10"` (or `"2026-06-20 14:30 UTC"` when the zone is
 * UTC). The short zone label always travels with the value so a bare wall-clock
 * is never ambiguous. Unparseable input renders as "—".
 */
export function formatInstant(input: TimeInput, timeZone: string): string {
  const date = input instanceof Date ? input : new Date(input);
  if (Number.isNaN(date.getTime())) return INVALID;

  const local = wallClock(date, timeZone);
  const zone = zoneShortName(date, timeZone);
  return zone === '' ? local : `${local} ${zone}`;
}

/**
 * Wall-clock time-of-day with seconds and a zone label, e.g. `"14:03:22 AEST"`.
 *
 * Seconds precision is what a ticking clock and a trade tape need; the zone
 * label is mandatory because a bare `HH:mm:ss` is unreadable without knowing
 * which zone it is in — the whole failure mode this replaces. Unparseable input
 * renders as "—".
 */
export function formatClock(input: TimeInput, timeZone: string): string {
  const date = input instanceof Date ? input : new Date(input);
  if (Number.isNaN(date.getTime())) return INVALID;

  const parts = new Intl.DateTimeFormat('en-GB', {
    timeZone,
    hour: '2-digit',
    minute: '2-digit',
    second: '2-digit',
    hourCycle: 'h23',
  }).formatToParts(date);
  const get = (type: Intl.DateTimeFormatPartTypes): string =>
    parts.find((p) => p.type === type)?.value ?? '';
  const clock = `${get('hour')}:${get('minute')}:${get('second')}`;
  const zone = zoneShortName(date, timeZone);
  return zone === '' ? clock : `${clock} ${zone}`;
}

/**
 * Date-only "YYYY-MM-DD" in `timeZone`, for cramped contexts (chart axis ticks)
 * where the full timestamp will not fit. The zone label is dropped here because
 * every tick shares the one configured zone; {@link formatInstant} carries the
 * labelled time in the tooltip.
 */
export function formatDate(input: TimeInput, timeZone: string): string {
  const date = input instanceof Date ? input : new Date(input);
  if (Number.isNaN(date.getTime())) return INVALID;
  const parts = new Intl.DateTimeFormat('en-GB', {
    timeZone,
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
  }).formatToParts(date);
  const get = (type: Intl.DateTimeFormatPartTypes): string =>
    parts.find((p) => p.type === type)?.value ?? '';
  return `${get('year')}-${get('month')}-${get('day')}`;
}
