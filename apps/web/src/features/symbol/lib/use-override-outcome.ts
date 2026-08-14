import { useCallback, useEffect, useMemo, useState } from 'react';
import { useQuery, useQueryClient, type QueryState } from '@tanstack/react-query';
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
/**
 * Give up a little past the override's own window; after that no tick can settle
 * it. Exported so a test asserting on silence past the deadline cannot quietly
 * stop reaching it when the TTL moves.
 */
export const WATCH_TIMEOUT_MS = MANUAL_OVERRIDE_TTL_SECONDS * 1000 + 30_000;

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

/**
 * The other terminal shape: a newer override for this symbol displaced the one
 * being watched, so the endpoint — which serves only the newest row in the
 * window — can never report on it again.
 *
 * Deliberately NOT {@link WATCH_GAVE_UP_MESSAGE}. Arming an override settles the
 * row it displaces as `superseded` in the same transaction, so in the ordinary
 * case the displaced action's fate is known and benign: it never ran. Sending the
 * operator to the exchange for that is a false alarm, and false alarms are how a
 * real one gets ignored.
 *
 * The caveat is not padding. That supersede is bounded to rows that are neither
 * claimed nor picked up, precisely so a row a tick already took keeps its right
 * to end as `unknown`. Such a row is left pending, is displaced all the same, and
 * IS one to check the exchange for. Naming both keeps the sentence true for the
 * dominant case without failing open on the one that matters.
 */
export const WATCH_REPLACED_MESSAGE =
  'A newer action replaced this one before we could confirm it. Replacing normally cancels the older action before it runs, but if the bot had already started on it, check the exchange.';

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

/** Banner for a settled outcome. Only `applied` did what the operator asked. */
export const outcomeBanner = (outcome: OverrideOutcome): ActionBannerState => ({
  kind: outcome.status === 'applied' ? 'ok' : 'err',
  message: describeOutcome(outcome),
});

/** The row this watch follows, and the evidence bar a read must clear to speak for it. */
interface WatchedOverride {
  readonly id: string;
  /**
   * The watched row's own `created_at`, from the arm receipt — the server clock,
   * so a client skew cannot reorder it against a read-back. Required, because a
   * watch armed without it can only fall back to treating every displacement as
   * benign, which is the failure this baseline exists to end.
   */
  readonly createdAt: string;
  /** Drives the backoff threshold and the give-up deadline. Never used as read evidence. */
  readonly startedAt: number;
  /** See {@link firstPostArmUpdateCount}. */
  readonly minUpdateCount: number;
}

type OverrideQueryState = QueryState<OverrideAction | null>;

/**
 * The first `dataUpdateCount` whose data is guaranteed to describe the world
 * after this moment.
 *
 * A watch has to distinguish a read ISSUED after it was armed from one that
 * merely LANDED after it, and the query state carries no fetch-start timestamp:
 * `dataUpdatedAt` is stamped when a read resolves. So a poll issued for the
 * PREVIOUS watch, still in flight when the operator arms the next one, carries a
 * stamp newer than the arm and would otherwise be taken as proof about a row it
 * was never asking about.
 *
 * Counting reads instead of timing them removes the ambiguity, because a query
 * keeps at most one live retryer: a fetch already running when the arm lands can
 * produce at most ONE more data update, whether it resolves, or is superseded by
 * a fetch that dedupes onto it, or is silently cancelled. Reserve that one slot
 * and every later update necessarily came from a read issued after the arm.
 *
 * A reserved slot that never gets spent makes the bar conservative rather than
 * wrong. Two reads do that: a cancelled one, and a failed one. Failures land on
 * `errorUpdateCount`, a different counter. Either way the first post-arm read
 * comes up one short of the bar and the watch simply polls again, costing one
 * interval. Erring the other way silently kills a live watch.
 *
 * Counting errors toward the bar would close that gap and open a worse one: an
 * error leaves `data` untouched, so the read that crossed the bar would be
 * judged against whatever data predates the arm, which is exactly the stale
 * evidence this baseline exists to reject.
 *
 * The count comes from the client rather than the rendered result because
 * `fetchStatus` on an observer result can lag a fetch that started inside a
 * notify batch this render has not seen.
 *
 * A count only means anything against the query it was read from. Nothing here
 * enforces that, because nothing has to: the workspace keys its subtree by
 * profile and symbol, so changing either remounts this hook rather than swapping
 * the key underneath it.
 */
const firstPostArmUpdateCount = (state: OverrideQueryState | undefined): number => {
  const landedSoFar = state?.dataUpdateCount ?? 0;
  const reservedForInFlightRead = state && state.fetchStatus !== 'idle' ? 1 : 0;
  return landedSoFar + reservedForInFlightRead + 1;
};

/**
 * What a post-arm read says about the watched row.
 *
 * - `resolvable` — keep polling; this read cannot speak for the watched row yet.
 * - `gone` — the watched row was removed and something else already told the
 *   operator. End the watch without a word.
 * - `replaced` — a row that landed AFTER the watched one is now the newest, so
 *   the watched row left the outcome window unsettled and nothing left will
 *   speak for it. End the watch with {@link WATCH_REPLACED_MESSAGE}.
 */
type WatchVerdict = 'resolvable' | 'replaced' | 'gone';

/**
 * Classify a read against the row this watch follows.
 *
 * The endpoint returns the NEWEST override in `OVERRIDE_OUTCOME_WINDOW_MS`,
 * settled or not — not "the row you asked about, or null". So a read that comes
 * back as some OTHER row proves the watched one can never surface, but it does
 * NOT say why, and the two reasons owe the operator opposite things. An OLDER
 * row (or none at all) means the watched row was deleted and an earlier one is
 * now the newest: a cancel succeeded, and whoever did it owns the notice. A
 * NEWER row means the watched one aged out of the window still unsettled, and
 * its money may or may not have moved — staying silent there leaves the
 * optimistic "scheduled" banner standing over an unknown.
 *
 * Older/newer is decided the server's way, `created_at desc, id desc`, but only
 * to millisecond resolution: `created_at` is stored to the microsecond, and a JS
 * `Date` cannot carry those digits, so two rows under a millisecond apart reach
 * here with identical stamps. Those fall to the id tie-break, which orders
 * canonical UUID text exactly as Postgres orders `uuid`, though not necessarily
 * the way the sub-millisecond stamps would have. Arming twice inside one
 * millisecond on a single symbol is what that would take, and the panels' in-flight
 * guards already prevent it. The baseline is the server clock from the arm receipt,
 * never a client `Date.now()`, which would misorder both rows under any skew.
 *
 * `minUpdateCount` is what makes a verdict safe to act on, and it must be judged
 * against the SAME state snapshot the data came from. A cleared watch leaves its
 * query disabled but still observed, so nothing evicts the row it read, and a
 * poll it issued can still be in flight. Without the bar, the operator's next
 * override on the same symbol is killed by one of those before its first poll,
 * leaving the arm panel's optimistic banner uncorrected.
 *
 * `undefined` data is excluded by construction: it means "not fetched yet", and
 * treating it as terminal would kill every watch on its first render.
 */
const classifyWatch = (
  state: OverrideQueryState | undefined,
  watched: WatchedOverride,
): WatchVerdict => {
  if (state?.data === undefined || state.dataUpdateCount < watched.minUpdateCount) {
    return 'resolvable';
  }
  const row = state.data;
  if (row === null) return 'gone';
  if (row.id === watched.id) return 'resolvable';
  // Both stamps cross a `z.iso.datetime()` boundary before reaching here — the
  // read through the override response, the watched row through the arm receipt —
  // so neither can parse to NaN and no guard against one is warranted.
  const readAt = Date.parse(row.createdAt);
  const watchedAt = Date.parse(watched.createdAt);
  if (readAt !== watchedAt) return readAt > watchedAt ? 'replaced' : 'gone';
  // Equal to the millisecond: break the tie on id exactly as the server orders
  // rows, so the two agree on which of them is newer.
  return row.id > watched.id ? 'replaced' : 'gone';
};

/**
 * Why a watch ended with no outcome to report. Two reasons, not one flag: they
 * differ in what the operator should do next, and collapsing them sends every
 * displaced override to the exchange for a check it does not need.
 */
export type WatchUnresolved = 'timed-out' | 'replaced';

export interface OverrideOutcomeWatch {
  /** Settled outcome of the watched override, or null while it is still pending. */
  readonly outcome: OverrideOutcome | null;
  /**
   * Why the watch ended without an answer, or null while it can still get one.
   * `timed-out`: the window closed with the row un-settled — see
   * {@link WATCH_GAVE_UP_MESSAGE}. `replaced`: a newer override displaced it — see
   * {@link WATCH_REPLACED_MESSAGE}.
   */
  readonly unresolved: WatchUnresolved | null;
  /**
   * Start watching the override the API just accepted. `createdAt` is the arm
   * receipt's own server-clock stamp; it is required because a watch without one
   * cannot tell a cancel from an unsettled row and must call every displacement
   * benign.
   */
  readonly watch: (overrideActionId: string, createdAt: string) => void;
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
 * terminal state for the operator (`unresolved`), because the row can stay pending
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
  const [watched, setWatched] = useState<WatchedOverride | null>(null);
  const [unresolved, setUnresolved] = useState<WatchUnresolved | null>(null);

  const queryClient = useQueryClient();
  const queryKey = useMemo(
    () => symbolOverrideActionQueryKey(profileId, symbol),
    [profileId, symbol],
  );
  const readState = useCallback(
    (): OverrideQueryState | undefined =>
      queryClient.getQueryState<OverrideAction | null>(queryKey),
    [queryClient, queryKey],
  );

  const query = useQuery({
    queryKey,
    queryFn: () => getOverride(profileId, symbol),
    enabled: watched !== null,
    refetchInterval: (q) => {
      if (!watched) return false;
      const row = q.state.data;
      // Nothing left to poll for. Load-bearing, not a duplicate of the clear
      // effect below: react-query arms the next interval the moment the data
      // lands, before that effect can re-render, so without this stop a doomed
      // watch always costs a second read.
      if (classifyWatch(q.state, watched) !== 'resolvable') {
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
    const timer = setTimeout(() => setUnresolved('timed-out'), remaining);
    return () => clearTimeout(timer);
  }, [watched]);

  const row = query.data;
  // Match on id: an operator who fires a second override while the first is
  // in flight must not be shown the wrong one's outcome.
  const settled = row && row.id === watched?.id ? row.outcome : null;

  const clear = useCallback(() => {
    setWatched(null);
    setUnresolved(null);
  }, []);
  const watch = useCallback(
    (overrideActionId: string, createdAt: string) => {
      setUnresolved(null);
      setWatched({
        id: overrideActionId,
        createdAt,
        startedAt: Date.now(),
        minUpdateCount: firstPostArmUpdateCount(readState()),
      });
    },
    [readState],
  );

  // This watch is following a row that can never answer, and the two ways that
  // happens owe the operator different things. `gone`: the row was cancelled and
  // whoever cancelled it already spoke, so ending silently is right — firing a
  // toast here would contradict a cancel that succeeded. `replaced`: a newer
  // override displaced it, and since the endpoint serves only the newest row in
  // the window, nothing will ever report on this one again. That is terminal but
  // it is NOT the deadline's story, so it carries its own reason rather than
  // borrowing the give-up sentence. It is raised WITHOUT clearing, since `clear()`
  // resets the reason and would put the watch back to
  // indistinguishable-from-never-armed.
  //
  // The verdict is read straight off the cache so the data and the update count
  // behind it come from one coherent snapshot. The observer result does not
  // expose the count, so `dataUpdatedAt` and `data` are deps purely to re-run
  // this on a landed read. They are what an observer can see move, not a proof
  // that it always moves: structural sharing keeps the same `data` reference
  // when a read repeats the previous body, so two reads resolving inside one
  // millisecond with equal bodies would re-run nothing. Polls are 2s apart, so
  // that pair cannot arise here; if it ever did, the poll predicate would stop
  // the poll and the give-up timer would be the only reader left.
  useEffect(() => {
    if (!watched) return;
    const verdict = classifyWatch(readState(), watched);
    if (verdict === 'gone') clear();
    else if (verdict === 'replaced') setUnresolved('replaced');
  }, [watched, query.dataUpdatedAt, query.data, readState, clear]);

  return { outcome: settled, unresolved, watch, clear };
};

/**
 * Replace the optimistic "scheduled" message with the settled outcome the
 * moment it lands, and stop watching. Which outcomes read as success is
 * `outcomeBanner`'s call, so the panels that report a row directly and this hook
 * cannot drift apart. A watch that ended without an answer gets its own terminal
 * message rather than leaving "scheduled" on screen, which would assert a success
 * nobody verified — and which message depends on WHY it ended, because a displaced
 * override and an un-settled one call for different actions from the operator.
 */
export const useOutcomeBanner = (
  watch: OverrideOutcomeWatch,
  setBanner: (banner: ActionBannerState) => void,
): void => {
  const { outcome, unresolved, clear } = watch;
  useEffect(() => {
    if (outcome) {
      setBanner(outcomeBanner(outcome));
      clear();
      return;
    }
    if (unresolved) {
      // `info` for a replacement, `err` only for the give-up. A displaced action
      // was almost certainly superseded before it ran, which is the case `info`
      // exists for: nothing broke and nothing the operator asked for happened.
      // Spending the loudest channel on the routine outcome is how the operator
      // learns to dismiss it, and the give-up — fate genuinely unknown — is what
      // they would then miss.
      setBanner(
        unresolved === 'replaced'
          ? { kind: 'info', message: WATCH_REPLACED_MESSAGE }
          : { kind: 'err', message: WATCH_GAVE_UP_MESSAGE },
      );
      clear();
    }
  }, [outcome, unresolved, clear, setBanner]);
};
