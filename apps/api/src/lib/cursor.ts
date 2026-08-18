import { isBindableTimestamp } from '@app/contracts';
import { z } from '@hono/zod-openapi';

/**
 * The row id a bare timestamp cursor stands in for: the highest uuid there is.
 *
 * The keyset predicate is `(ts, id) < (cursor.ts, cursor.id)`, so pairing a bare timestamp with the maximum id makes it mean "everything strictly before this instant, and every row at it" — which is what a cursor carrying no tie-breaker has to mean if it is not to drop a same-timestamp group.
 */
export const BARE_CURSOR_ID = 'ffffffff-ffff-ffff-ffff-ffffffffffff';

/**
 * Build the schema for a composite `<ISO timestamp><separator><row id>` pagination cursor.
 *
 * One factory rather than three hand-rolled refinements because the failure they all guard against is the same one, and it was previously caught in three different places by three different tests: an unvalidated cursor half reaches Postgres as an uncastable literal and surfaces as a 500 on a route whose declared failures are 4xx. The timestamp half is checked for bindability and the id half as a uuid, because it is compared against a `uuid` column.
 *
 * @param separator - The delimiter between the two halves, which differs per reader because each route's token is already in the wild: `__` for the archive, audit and backtest readers, `|` for the action log.
 * @param allowBareTimestamp - Whether a cursor carrying no id half is accepted. True for the readers whose documented wire contract still honours an older bare-iso token, where the missing id lets a same-timestamp group surface in full on the next page. False for the archive, which refuses one on purpose: its rows can share a timestamp down to the microsecond, so a cursor with no tie-breaker strands the rows below the boundary silently — the exact failure a 422 makes the client recover from by restarting the walk.
 * @returns A string schema accepting only cursors both halves of which the database can bind.
 */
export const compositeCursor = ({
  separator,
  allowBareTimestamp,
}: {
  separator: string;
  allowBareTimestamp: boolean;
}): z.ZodString =>
  z.string().refine(
    (v) => {
      const sep = v.indexOf(separator);
      if (sep <= 0) return allowBareTimestamp && isBindableTimestamp(v);
      return (
        isBindableTimestamp(v.slice(0, sep)) &&
        z.uuid().safeParse(v.slice(sep + separator.length)).success
      );
    },
    {
      message: allowBareTimestamp
        ? `cursor must be an ISO timestamp, optionally followed by \`${separator}<row id>\`, as returned by nextCursor`
        : `cursor must be \`<ISO timestamp>${separator}<row id>\`, as returned by nextCursor`,
    },
  );

/**
 * Split a cursor the matching {@link compositeCursor} schema has already accepted.
 *
 * The timestamp half is returned as the original string, never as a `Date`: the repo casts it back to `timestamptz`, so a `Date` round-trip would drop the microsecond fraction the token exists to preserve — which is what once made a row sharing a millisecond with the page boundary unreachable.
 *
 * @param cursor - A validated cursor; the schema has already proven both halves, so nothing here can fail.
 * @param separator - The same delimiter the schema was built with.
 * @returns The timestamp half, and the row id half or {@link BARE_CURSOR_ID} when the cursor carried none.
 */
export const splitCompositeCursor = (
  cursor: string,
  separator: string,
): { timestamp: string; id: string } => {
  const sep = cursor.indexOf(separator);
  if (sep <= 0) return { timestamp: cursor, id: BARE_CURSOR_ID };
  return { timestamp: cursor.slice(0, sep), id: cursor.slice(sep + separator.length) };
};
