import { z } from 'zod';

/**
 * Longest timestamp half worth binding.
 *
 * The cursor tokens this app emits are 27 characters (`YYYY-MM-DDTHH:MM:SS.ffffffZ`); the slack covers a shorter or slightly longer fraction without admitting the pathological case below.
 */
const MAX_TIMESTAMP_LEN = 32;

/**
 * The first year Postgres can represent, and the reason this is a range test rather than a blocklist.
 *
 * AD/BC notation has no year zero, so `0000-…` is the one four-digit year that raises SQLSTATE 22008. A `startsWith('0000-')` check would pass today and keep passing if a future input ever reached here with a signed or five-digit year, because a blocklist only refuses what it was told about. Asserting the year is in range instead refuses everything outside it by construction.
 */
const MIN_YEAR = 1;

/**
 * Whether an ISO instant is something Postgres will actually accept as a `timestamptz`.
 *
 * `z.iso.datetime()` on its own is not that check. It is calendar-aware — month 13, day 32, `2023-02-29`, `24:00` and `:60` are all rejected — but it leaves exactly two gaps, and both land as an unhandled 500 on routes whose declared failures are 4xx. Its year is four digits of anything, and Postgres has no year zero. And its fractional-second part is unbounded (`\.\d+`), while Postgres parses datetime input through a fixed work buffer and refuses outright once the literal overruns it, rather than rounding the excess away as it does for a merely over-precise fraction. Neither error is a statement timeout or a checkout timeout, so both fall through the api's error classifier to `INTERNAL`.
 *
 * @param v - An ISO instant, already separated from any cursor id half that accompanied it.
 * @returns True only when the value is an instant Postgres can bind, so the boundary rejects it as a 422 rather than the database rejecting it as a 500.
 */
export const isBindableTimestamp = (v: string): boolean =>
  v.length <= MAX_TIMESTAMP_LEN &&
  z.iso.datetime().safeParse(v).success &&
  Number(v.slice(0, 4)) >= MIN_YEAR;
