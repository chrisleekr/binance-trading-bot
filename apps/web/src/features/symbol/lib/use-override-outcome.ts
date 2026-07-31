import { useCallback, useEffect, useState } from 'react';
import { useQuery } from '@tanstack/react-query';
import {
  MANUAL_OVERRIDE_TTL_SECONDS,
  type OverrideAction,
  type OverrideOutcome,
} from '@app/contracts';

import type { ActionBannerState } from '@/shared/components/action-banner';
import { getOverride, symbolOverrideActionQueryKey } from '../api/symbol';

/** Most overrides settle within a tick or two, so poll tightly at first… */
const POLL_FAST_MS = 2_000;
/** …then back off, because the long tail is a tick that is not coming. */
const POLL_SLOW_MS = 10_000;
const BACKOFF_AFTER_MS = 30_000;
/** Give up a little past the override's own window; after that no tick can settle it. */
const WATCH_TIMEOUT_MS = MANUAL_OVERRIDE_TTL_SECONDS * 1000 + 30_000;

/**
 * What the operator is told when the watch gives up.
 *
 * Giving up is NOT the same as "nothing happened". The row is still un-settled
 * at this point, and the server-side reaper only sweeps stranded rows on a
 * 5-minute beat past a 10-minute staleness bound — so the `expired` outcome can
 * land many minutes after this deadline, and the only paths that leave a row
 * pending this long are the ones where the tick died mid-flight and the order's
 * fate is genuinely unknown. Leaving the optimistic "scheduled" banner up would
 * assert a success nobody verified; polling for a quarter of an hour to maybe
 * learn "expired" is not worth the request volume. So state the truth: we do not
 * know, and the exchange does.
 */
export const WATCH_GAVE_UP_MESSAGE =
  'We could not confirm what happened to this action — check the exchange before retrying.';

/** Plain-language sentence for a settled outcome. Undefined while still pending. */
export const describeOutcome = (outcome: OverrideOutcome): string => {
  switch (outcome.status) {
    case 'applied':
      return 'Your action went through.';
    case 'unknown':
      return `Your action may or may not have run — check the exchange before retrying.${outcome.reason ? ` (${outcome.reason})` : ''}`;
    case 'superseded':
      return 'A newer action for this symbol replaced this one.';
    case 'expired':
      return 'Your action expired before the bot could run it. Try again.';
    case 'rejected':
      return outcome.reason
        ? `Your action did not run: ${outcome.reason}`
        : 'Your action did not run.';
  }
};

/**
 * Can this watch still learn its own outcome, or is it following a row that will
 * never answer?
 *
 * The endpoint returns the NEWEST override in `OVERRIDE_OUTCOME_WINDOW_MS`,
 * settled or not — not "the row you asked about, or null". That makes identity,
 * not nullness, the real signal. A read taken after the watch was armed that
 * comes back as some OTHER row proves this one can never surface: either it was
 * deleted (the operator cancelled it, and an older settled row is now the newest)
 * or a newer override superseded it. A bare `null` is just the case where the
 * window holds no row at all. Both are terminal, so both stop the poll — a
 * null-only test would miss the first and leave the watch running until it fired
 * a `gaveUp` error toast contradicting a cancel that in fact succeeded.
 *
 * The timestamp comparison is what makes this safe to act on. A cleared watch
 * leaves its query disabled but still observed, so nothing evicts the row it
 * read — and the operator's next override on the same symbol starts life looking
 * at that stale data. Judged without `dataUpdatedAt`, the new watch would be
 * killed before its first poll and the arm panel's optimistic banner would never
 * be corrected, by an outcome or by `gaveUp`. So only a read taken AFTER this
 * watch was armed counts.
 *
 * `undefined` is excluded by construction: it means "not fetched yet", and
 * treating it as terminal would kill every watch on its first render.
 *
 * `>=`, not `>`: a warm read can complete inside the same millisecond the watch
 * was armed, and `Date.now()` cannot tell those apart. The stale-read case is
 * never that close — it needs a round-trip and a human click between the old read
 * and the new arm — so the inclusive bound costs nothing there and stops the
 * strict one from discarding every fast first read.
 */
const isWatchUnresolvable = (
  row: OverrideAction | null | undefined,
  dataUpdatedAt: number,
  startedAt: number,
  watchedId: string,
): boolean =>
  row !== undefined && dataUpdatedAt >= startedAt && (row === null || row.id !== watchedId);

export interface OverrideOutcomeWatch {
  /** Settled outcome of the watched override, or null while it is still pending. */
  readonly outcome: OverrideOutcome | null;
  /** The watch window closed with the row still un-settled. See {@link WATCH_GAVE_UP_MESSAGE}. */
  readonly gaveUp: boolean;
  /** Start watching the override the API just accepted. */
  readonly watch: (overrideActionId: string) => void;
  /** Stop watching (the caller has shown the outcome). */
  readonly clear: () => void;
}

/**
 * Turn the API's optimistic 202 into the truth.
 *
 * The 202 only says "recorded" — the order it schedules can still be refused by
 * a filter, killed by the daily-loss breaker, or rejected by Binance a few
 * seconds later. Telling the operator "scheduled" and never correcting it is how
 * a force-sell that never happened reads as a success. So once an override is
 * accepted, poll its row until a tick settles it, then hand the caller the real
 * outcome.
 *
 * Both poll-stop conditions live in the one `refetchInterval` predicate — the
 * row settled, or the watch window has passed. The window's expiry is ALSO a
 * terminal state for the operator (`gaveUp`), because the row can stay pending
 * well past it: the server-side reaper works on a 5-minute beat past a 10-minute
 * staleness bound, so an `expired` outcome may not be written for a quarter of an
 * hour. Waiting that long to correct the banner is worse than admitting we do not
 * know — see {@link WATCH_GAVE_UP_MESSAGE}.
 *
 * The interval backs off after {@link BACKOFF_AFTER_MS}: an override that has not
 * settled in half a minute is waiting on a tick that is not coming, and a flat
 * 2s poll for the full window would be ~165 requests, each costing the api two
 * Postgres reads, to learn nothing.
 */
export const useOverrideOutcome = (profileId: string, symbol: string): OverrideOutcomeWatch => {
  const [watched, setWatched] = useState<{ id: string; startedAt: number } | null>(null);
  const [gaveUp, setGaveUp] = useState(false);

  const query = useQuery({
    queryKey: symbolOverrideActionQueryKey(profileId, symbol),
    queryFn: () => getOverride(profileId, symbol),
    enabled: watched !== null,
    refetchInterval: (q) => {
      if (!watched) return false;
      const row = q.state.data;
      // Nothing left to poll for. Load-bearing, not a duplicate of the clear
      // effect below: react-query arms the next interval the moment the data
      // lands, before that effect can re-render, so without this stop a doomed
      // watch always costs a second read.
      if (isWatchUnresolvable(row, q.state.dataUpdatedAt, watched.startedAt, watched.id)) {
        return false;
      }
      if (row && row.id === watched.id && row.outcome !== null) return false;
      const elapsed = Date.now() - watched.startedAt;
      if (elapsed >= WATCH_TIMEOUT_MS) return false;
      return elapsed >= BACKOFF_AFTER_MS ? POLL_SLOW_MS : POLL_FAST_MS;
    },
    gcTime: 0,
  });

  // The poll predicate stops polling at the deadline but cannot re-render on it,
  // so the give-up transition needs its own timer. It is not a second source of
  // truth: the same `WATCH_TIMEOUT_MS` drives both, and a settled row clears the
  // watch before the timer can fire.
  useEffect(() => {
    if (!watched) return;
    const remaining = Math.max(0, WATCH_TIMEOUT_MS - (Date.now() - watched.startedAt));
    const timer = setTimeout(() => setGaveUp(true), remaining);
    return () => clearTimeout(timer);
  }, [watched]);

  const row = query.data;
  // Match on id: an operator who fires a second override while the first is
  // in flight must not be shown the wrong one's outcome.
  const settled = row && row.id === watched?.id ? row.outcome : null;

  const clear = useCallback(() => {
    setWatched(null);
    setGaveUp(false);
  }, []);
  const watch = useCallback((overrideActionId: string) => {
    setGaveUp(false);
    setWatched({ id: overrideActionId, startedAt: Date.now() });
  }, []);

  // This watch is following a row that can never answer — cancelled, or
  // superseded. Left watching, the poll would run to the deadline and then fire
  // the `gaveUp` error toast, contradicting a cancel that succeeded. Silence is
  // right here: whatever replaced this row owns the operator's next notice.
  useEffect(() => {
    if (
      watched &&
      isWatchUnresolvable(query.data, query.dataUpdatedAt, watched.startedAt, watched.id)
    ) {
      clear();
    }
  }, [watched, query.data, query.dataUpdatedAt, clear]);

  return { outcome: settled, gaveUp, watch, clear };
};

/**
 * Replace the optimistic "scheduled" message with the settled outcome the
 * moment it lands, and stop watching. Only `applied` is a success — everything
 * else means the operator's action did not do what they asked. A watch that ran
 * out gets its own terminal message rather than leaving "scheduled" on screen,
 * which would assert a success nobody verified.
 */
export const useOutcomeBanner = (
  watch: OverrideOutcomeWatch,
  setBanner: (banner: ActionBannerState) => void,
): void => {
  const { outcome, gaveUp, clear } = watch;
  useEffect(() => {
    if (outcome) {
      setBanner({
        kind: outcome.status === 'applied' ? 'ok' : 'err',
        message: describeOutcome(outcome),
      });
      clear();
      return;
    }
    if (gaveUp) {
      setBanner({ kind: 'err', message: WATCH_GAVE_UP_MESSAGE });
      clear();
    }
  }, [outcome, gaveUp, clear, setBanner]);
};
