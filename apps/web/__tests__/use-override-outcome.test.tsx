// The override-outcome watch is what turns the api's optimistic 202 ("recorded")
// into the truth ("filled" / "the exchange refused it" / "nobody knows").
//
// Every arm of it is operator-facing safety copy, and one of them — `unknown` —
// is the sentence a human reads before going to Binance to find out whether their
// force-sell actually sold. It was previously exercised only indirectly, through
// the one `rejected` path a component test happened to take.
//
// Three things are pinned here:
//   1. `describeOutcome` for all five statuses (it is pure; table-test it).
//   2. The id-mismatch guard: an operator who fires a SECOND override while the
//      first is in flight must never be shown the first one's outcome. A watch
//      arms with the watched row's own server-clock `createdAt`, which splits
//      "some other row came back" in two: an OLDER row means the watched one was
//      deleted and its canceller owns the notice, so the watch ends in silence;
//      a NEWER one means the watched row was displaced and nothing will ever
//      report on it again, which is the `replaced` path pinned in
//      override-watch-classification.test.tsx.
//   3. The two terminal notices, and that they stay distinct. The window closing
//      leaves a row whose fate is genuinely unknown, so it sends the operator to
//      the exchange; a displacement settles the old row as `superseded` in the
//      same transaction, so it must not. Either way the optimistic "scheduled"
//      banner must not be left standing.

import type { ReactNode } from 'react';
import { QueryClientProvider } from '@tanstack/react-query';
import { act, renderHook, waitFor } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { OverrideOutcome } from '@app/contracts';

import { deferredResponder } from './_deferred-responder.js';
import { createQueryClient } from '../src/shared/lib/query-client.js';
import {
  describeOutcome,
  useOutcomeBanner,
  useOverrideOutcome,
  WATCH_GAVE_UP_MESSAGE,
  WATCH_REPLACED_MESSAGE,
  WATCH_TIMEOUT_MS,
} from '../src/features/symbol/lib/use-override-outcome.js';
import type { ActionBannerState } from '../src/shared/components/action-banner.js';

const PROFILE_ID = '00000000-0000-4000-8000-000000000001';
const SYMBOL = 'BTCUSDT';
const FIRST_ID = '11111111-1111-4111-8111-111111111111';
const SECOND_ID = '22222222-2222-4222-8222-222222222222';

const AT = '2026-07-11T00:00:00.000Z';
/** A row stamped before {@link AT}, i.e. one the watched row outlived. */
const EARLIER_AT = '2026-07-10T23:59:59.000Z';
/** A watch armed after {@link AT}, i.e. one that outlives the row read back. */
const LATER_AT = '2026-07-11T00:00:01.000Z';

/**
 * One beat past the give-up deadline. Derived, not a literal: a longer TTL would
 * otherwise leave every assertion below the deadline still passing, and passing
 * for a reason none of them are testing.
 */
const PAST_DEADLINE_MS = WATCH_TIMEOUT_MS + 1_000;

const row = (id: string, outcome: OverrideOutcome | null, createdAt: string = AT): unknown => ({
  id,
  symbol: SYMBOL,
  action: 'sell',
  actionAt: createdAt,
  payload: {},
  triggeredBy: 'user',
  processingAt: null,
  consumedAt: outcome ? createdAt : null,
  outcome,
  createdAt,
});

const json = (body: unknown): Response =>
  new Response(JSON.stringify(body), {
    status: 200,
    headers: { 'content-type': 'application/json' },
  });

const setUp = (responder: () => Response | Promise<Response>) => {
  vi.stubGlobal(
    'fetch',
    vi.fn(async () => responder()),
  );
  const queryClient = createQueryClient();
  return ({ children }: { children: ReactNode }): React.JSX.Element => (
    <QueryClientProvider client={queryClient}>{children}</QueryClientProvider>
  );
};

/** Reads the stub installed by {@link setUp}, so it must be called inside a test. */
const fetchCalls = (): number => (fetch as unknown as ReturnType<typeof vi.fn>).mock.calls.length;

afterEach(() => {
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

describe('describeOutcome', () => {
  it.each([
    // `applied` is the ONLY success sentence. Everything else must read as
    // "your action did not do what you asked".
    [{ status: 'applied' } as const, /went through/i],
    // The one outcome no machine can resolve. It must send the operator to the
    // exchange, and it must carry the reason so they know what to look for.
    [{ status: 'unknown', reason: 'HTTP 503' } as const, /may or may not have run/i],
    [{ status: 'superseded' } as const, /newer action/i],
    [{ status: 'expired' } as const, /expired before the bot could run it/i],
    [{ status: 'rejected', reason: 'insufficient balance' } as const, /did not run/i],
  ])('describes %o for a human', (partial, matcher) => {
    expect(describeOutcome({ ...partial, at: AT })).toMatch(matcher);
  });

  it('folds the reason into the `unknown` sentence when one exists, and omits it when not', () => {
    expect(describeOutcome({ status: 'unknown', reason: 'HTTP 503', at: AT })).toContain(
      '(HTTP 503)',
    );
    expect(describeOutcome({ status: 'unknown', at: AT })).not.toContain('(');
  });

  it('falls back to a bare sentence for a `rejected` with no reason', () => {
    expect(describeOutcome({ status: 'rejected', at: AT })).toBe('Your action did not run.');
  });

  it('sends the operator to the exchange for a row the expiry sweep could not resolve', () => {
    // Verbatim from the server-side sweep, which settles a stranded row it can
    // prove a tick picked up before dying. That row's order may be live on the
    // exchange, so the sentence must not be the `expired` one: "Try again" would
    // have the operator re-issue a force-sell that already sold.
    const swept = {
      status: 'unknown',
      reason: 'a tick consumed this override and no outcome was recorded',
      at: AT,
    } as const;

    expect(describeOutcome(swept)).toMatch(/may or may not have run/i);
    expect(describeOutcome(swept)).not.toMatch(/try again/i);
  });
});

describe('useOverrideOutcome', () => {
  it('surfaces the settled outcome of the override it is watching', async () => {
    const wrapper = setUp(() => json(row(FIRST_ID, { status: 'applied', at: AT })));
    const { result } = renderHook(() => useOverrideOutcome(PROFILE_ID, SYMBOL), { wrapper });

    act(() => result.current.watch(FIRST_ID, AT));
    await waitFor(() => expect(result.current.outcome).not.toBeNull());
    expect(result.current.outcome?.status).toBe('applied');
  });

  it('does NOT show one override the outcome of another (id-mismatch guard)', async () => {
    // The operator fired a second override; the row the api returns is the newest
    // one, which is not the one this watch is following. Showing its outcome would
    // tell them their SECOND action settled when it may still be in flight — or,
    // worse, report the first one's success against the second.
    const wrapper = setUp(() => json(row(SECOND_ID, { status: 'applied', at: AT })));
    const { result } = renderHook(() => useOverrideOutcome(PROFILE_ID, SYMBOL), { wrapper });

    act(() => result.current.watch(FIRST_ID, AT));
    // Give the query a real chance to resolve before asserting the absence.
    await waitFor(() => expect(fetch).toHaveBeenCalled());
    await waitFor(() => expect(result.current.outcome).toBeNull());
  });

  it('does not fetch at all until an override is being watched', () => {
    const wrapper = setUp(() => json(null));
    renderHook(() => useOverrideOutcome(PROFILE_ID, SYMBOL), { wrapper });
    expect(fetch).not.toHaveBeenCalled();
  });

  it('stops watching when the row it follows reads back as an explicit null', async () => {
    // An explicit `null` means the row is GONE, not "settled and aged out": the
    // GET keeps returning settled rows for a 10-minute outcome window, which
    // outlives this watch. The only way to lose the row inside the window is a
    // delete — the operator cancelled it. Keeping the watch alive would then flip
    // it to an unresolved notice minutes later and contradict the cancel's own success
    // with an error toast from whichever sibling panel armed the override.
    vi.useFakeTimers();
    try {
      const wrapper = setUp(() => json(null));
      const { result } = renderHook(() => useOverrideOutcome(PROFILE_ID, SYMBOL), { wrapper });

      act(() => result.current.watch(FIRST_ID, AT));
      // Past one fast poll, so the null has been read back and acted on.
      await act(async () => {
        await vi.advanceTimersByTimeAsync(2_500);
      });
      expect(result.current.unresolved).toBeNull();

      // Well past the give-up deadline a live watch would have tripped.
      await act(async () => {
        await vi.advanceTimersByTimeAsync(PAST_DEADLINE_MS);
      });
      expect(result.current.unresolved).toBeNull();
      expect(fetchCalls()).toBe(1);
    } finally {
      vi.useRealTimers();
    }
  });

  it('stops watching when a post-arm read returns an OLDER row', async () => {
    // The endpoint answers with the NEWEST override in its window, settled or
    // not — never "the row you asked about, or null". So deleting the watched row
    // does not produce a `null`: an older settled row simply becomes the newest.
    // Identity is what survives that, and the read-back's age is what says the
    // watched row was deleted rather than left behind — without both the watch
    // polls on to an unresolved notice and fires an error toast about an override that was
    // cancelled successfully.
    vi.useFakeTimers();
    try {
      const wrapper = setUp(() => json(row(SECOND_ID, { status: 'applied', at: AT }, EARLIER_AT)));
      const { result } = renderHook(() => useOverrideOutcome(PROFILE_ID, SYMBOL), { wrapper });

      act(() => result.current.watch(FIRST_ID, AT));
      await act(async () => {
        await vi.advanceTimersByTimeAsync(2_500);
      });
      expect(fetchCalls()).toBe(1);

      // Well past the give-up deadline, and still silent: the row that replaced
      // this one owns the operator's next notice.
      await act(async () => {
        await vi.advanceTimersByTimeAsync(PAST_DEADLINE_MS);
      });
      expect(result.current.unresolved).toBeNull();
      expect(result.current.outcome).toBeNull();
      expect(fetchCalls()).toBe(1);
    } finally {
      vi.useRealTimers();
    }
  });

  it('survives a re-arm on a symbol whose previous watch ended on a null read-back', async () => {
    // arm → cancel → arm again is the ordinary sequence, and the cancel leaves a
    // `null` in the cache that outlives the watch that read it: a disabled query
    // keeps its observer, so nothing evicts it. If the new watch is judged
    // against that stale null it dies before its first poll, and the arm panel's
    // optimistic "waiting for the bot" banner is never replaced — not by an
    // outcome, and not by `unresolved`, which the clear resets. The operator would
    // watch a force-sell hang on "scheduled" forever.
    vi.useFakeTimers();
    try {
      let body: unknown = null;
      const wrapper = setUp(() => json(body));
      const { result } = renderHook(() => useOverrideOutcome(PROFILE_ID, SYMBOL), { wrapper });

      // The operator cancelled the first override, so its row reads back null and
      // the watch ends. One read, no interval — the state the re-arm starts from.
      act(() => result.current.watch(FIRST_ID, AT));
      await act(async () => {
        await vi.advanceTimersByTimeAsync(2_500);
      });
      expect(fetchCalls()).toBe(1);

      // Same symbol, brand-new override, and it settles.
      body = row(SECOND_ID, { status: 'applied', at: AT });
      act(() => result.current.watch(SECOND_ID, AT));
      await act(async () => {
        await vi.advanceTimersByTimeAsync(2_500);
      });

      expect(result.current.outcome?.status).toBe('applied');
      expect(result.current.unresolved).toBeNull();
    } finally {
      vi.useRealTimers();
    }
  });

  it('does not let a read issued before the arm terminate the watch that replaced it', async () => {
    // The operator's re-arm lands while the previous watch's poll is still in
    // flight, and that poll answers `null` a moment later. It is stale by the
    // time it arrives, but react-query stamps `dataUpdatedAt` when a read
    // RESOLVES, not when it was ISSUED, so its stamp is newer than the arm it
    // knows nothing about. Judged on that stamp the fresh watch is killed before
    // its first poll, and the clear also resets `unresolved`, so the operator gets
    // neither an outcome nor a give-up notice and a live force-sell hangs on the
    // optimistic "scheduled" banner forever.
    vi.useFakeTimers();
    try {
      const api = deferredResponder();
      const wrapper = setUp(api.responder);
      const { result } = renderHook(() => useOverrideOutcome(PROFILE_ID, SYMBOL), { wrapper });

      // First watch, first poll. Held open: this is the read that must not be
      // allowed to speak for the watch that replaces it.
      act(() => result.current.watch(FIRST_ID, AT));
      await act(async () => {
        await vi.advanceTimersByTimeAsync(500);
      });
      expect(api.issued()).toBe(1);

      // The arm POST for the second override lands, strictly after the read
      // above was issued and strictly before it resolved.
      act(() => result.current.watch(SECOND_ID, AT));
      await act(async () => {
        await vi.advanceTimersByTimeAsync(100);
        api.settle(0, null);
      });

      // The second watch is still live, so its own poll fires.
      await act(async () => {
        await vi.advanceTimersByTimeAsync(2_500);
      });
      expect(fetchCalls()).toBe(2);

      await act(async () => {
        api.settle(1, row(SECOND_ID, { status: 'applied', at: AT }));
        await vi.advanceTimersByTimeAsync(0);
      });
      expect(result.current.outcome?.status).toBe('applied');
      expect(result.current.unresolved).toBeNull();
    } finally {
      vi.useRealTimers();
    }
  });

  it("keeps a sibling watch alive when another panel's watch legitimately clears", async () => {
    // The symbol workspace co-mounts three of these hooks, and they share ONE
    // cache entry: the query key is (profile, symbol), not (profile, symbol,
    // override). So every read is judged by every mounted watch, and the read
    // that legitimately ends one of them, a different row meaning cancelled or
    // superseded, is the same read that carries another's outcome. Terminating
    // on shared data must stay a per-watch decision.
    vi.useFakeTimers();
    try {
      // Still pending, so the read that ends the first watch leaves the second
      // one with nothing to report yet: it has to keep polling to learn its own
      // outcome, which is the part a shared clear could destroy.
      let body: unknown = row(SECOND_ID, null);
      const wrapper = setUp(() => json(body));
      const { result } = renderHook(
        () => ({
          cancelled: useOverrideOutcome(PROFILE_ID, SYMBOL),
          live: useOverrideOutcome(PROFILE_ID, SYMBOL),
        }),
        { wrapper },
      );

      act(() => {
        // The cancelled panel's row is the newer of the two, so the read that
        // comes back carrying the older sibling is a deletion, not a
        // displacement — the silent case this test is about.
        result.current.cancelled.watch(FIRST_ID, LATER_AT);
        result.current.live.watch(SECOND_ID, AT);
      });
      await act(async () => {
        await vi.advanceTimersByTimeAsync(2_500);
      });

      // The row it followed is gone, so it goes silent rather than error later.
      expect(result.current.cancelled.outcome).toBeNull();
      expect(result.current.live.outcome).toBeNull();

      body = row(SECOND_ID, { status: 'applied', at: AT });
      await act(async () => {
        await vi.advanceTimersByTimeAsync(2_500);
      });
      expect(result.current.live.outcome?.status).toBe('applied');
      expect(result.current.live.unresolved).toBeNull();

      // Silence has to outlive the deadline to mean anything: a watch that had
      // merely stopped polling would still fire its own give-up timer here and
      // put an error banner up for a cancel that succeeded.
      await act(async () => {
        await vi.advanceTimersByTimeAsync(PAST_DEADLINE_MS);
      });
      expect(result.current.cancelled.unresolved).toBeNull();
    } finally {
      vi.useRealTimers();
    }
  });

  it('does not let a failed read stand in for the post-arm read it is still waiting on', async () => {
    // The bar counts landed DATA, and a failure lands on `errorUpdateCount`, so
    // the slot reserved for an in-flight read goes unspent and the watch simply
    // polls again. Widening the bar to count errors looks like it closes that
    // one-poll gap. It would instead let a read carrying no data at all promote
    // whatever data predates the arm into post-arm evidence, and here that is the
    // previous override's row, which reads as terminal.
    vi.useFakeTimers();
    try {
      let body: unknown = row(FIRST_ID, { status: 'applied', at: AT });
      let failNext = false;
      const wrapper = setUp(() => (failNext ? new Response('boom', { status: 500 }) : json(body)));
      const { result } = renderHook(() => useOverrideOutcome(PROFILE_ID, SYMBOL), { wrapper });

      // A settled watch leaves the row it read in the shared cache entry.
      act(() => result.current.watch(FIRST_ID, AT));
      await act(async () => {
        await vi.advanceTimersByTimeAsync(100);
      });
      expect(result.current.outcome?.status).toBe('applied');
      act(() => result.current.clear());

      failNext = true;
      act(() => result.current.watch(SECOND_ID, AT));
      await act(async () => {
        await vi.advanceTimersByTimeAsync(10_000);
      });
      expect(result.current.outcome).toBeNull();
      expect(result.current.unresolved).toBeNull();

      // Still armed, so the read that does land is the one it answers to.
      failNext = false;
      body = row(SECOND_ID, { status: 'applied', at: AT });
      await act(async () => {
        await vi.advanceTimersByTimeAsync(5_000);
      });
      expect(result.current.outcome?.status).toBe('applied');
    } finally {
      vi.useRealTimers();
    }
  });

  it("does not let a read that predates one panel's arm terminate that panel's watch", async () => {
    // Two co-mounted panels share ONE cache entry, and the second arms while the
    // first one's read is already in flight. That read comes back carrying a row
    // id the second watch does not recognise, which is the exact shape that reads
    // as terminal, yet it was issued before that watch existed. The slot each arm
    // reserves for an in-flight read is what stops it speaking for a watch it was
    // never asking about.
    vi.useFakeTimers();
    try {
      const api = deferredResponder();
      const wrapper = setUp(api.responder);
      const { result } = renderHook(
        () => ({
          early: useOverrideOutcome(PROFILE_ID, SYMBOL),
          late: useOverrideOutcome(PROFILE_ID, SYMBOL),
        }),
        { wrapper },
      );

      act(() => result.current.early.watch(FIRST_ID, AT));
      await act(async () => {
        await vi.advanceTimersByTimeAsync(500);
      });
      expect(api.issued()).toBe(1);

      act(() => result.current.late.watch(SECOND_ID, AT));
      await act(async () => {
        api.settle(0, row(FIRST_ID, { status: 'applied', at: AT }));
        await vi.advanceTimersByTimeAsync(0);
      });
      expect(result.current.early.outcome?.status).toBe('applied');
      expect(result.current.late.outcome).toBeNull();
      expect(result.current.late.unresolved).toBeNull();

      // Still polling, so it can still learn its own outcome.
      await act(async () => {
        await vi.advanceTimersByTimeAsync(2_500);
      });
      expect(api.issued()).toBe(2);
      await act(async () => {
        api.settle(1, row(SECOND_ID, { status: 'rejected', reason: 'min notional', at: AT }));
        await vi.advanceTimersByTimeAsync(0);
      });
      expect(result.current.late.outcome?.status).toBe('rejected');
    } finally {
      vi.useRealTimers();
    }
  });
});

describe('useOverrideOutcome — giving up', () => {
  beforeEach(() => {
    vi.useFakeTimers();
  });
  afterEach(() => {
    vi.useRealTimers();
  });

  it('flips to `unresolved=timed-out` when the watch window closes with the row still pending', async () => {
    // The row is still pending and the reaper cannot settle it for another ten
    // minutes. Leaving "scheduled" on screen would assert a success nobody
    // verified, so the watch must go terminal on its own.
    const wrapper = setUp(() => json(row(FIRST_ID, null)));
    const { result } = renderHook(() => useOverrideOutcome(PROFILE_ID, SYMBOL), { wrapper });

    act(() => result.current.watch(FIRST_ID, AT));
    expect(result.current.unresolved).toBeNull();

    // MANUAL_OVERRIDE_TTL_SECONDS (300s) + 30s of slack, plus a beat.
    await act(async () => {
      await vi.advanceTimersByTimeAsync(PAST_DEADLINE_MS);
    });
    expect(result.current.unresolved).toBe('timed-out');
    expect(result.current.outcome).toBeNull();
  });

  it('a fresh watch clears a previous give-up', async () => {
    const wrapper = setUp(() => json(row(FIRST_ID, null)));
    const { result } = renderHook(() => useOverrideOutcome(PROFILE_ID, SYMBOL), { wrapper });

    act(() => result.current.watch(FIRST_ID, AT));
    await act(async () => {
      await vi.advanceTimersByTimeAsync(PAST_DEADLINE_MS);
    });
    expect(result.current.unresolved).toBe('timed-out');

    act(() => result.current.watch(SECOND_ID, AT));
    expect(result.current.unresolved).toBeNull();
  });
});

describe('useOutcomeBanner', () => {
  it('replaces the optimistic banner with the settled outcome and stops watching', async () => {
    const wrapper = setUp(() =>
      json(row(FIRST_ID, { status: 'rejected', reason: 'no funds', at: AT })),
    );
    const banners: ActionBannerState[] = [];
    const { result } = renderHook(
      () => {
        const watch = useOverrideOutcome(PROFILE_ID, SYMBOL);
        useOutcomeBanner(watch, (b) => banners.push(b));
        return watch;
      },
      { wrapper },
    );

    act(() => result.current.watch(FIRST_ID, AT));
    await waitFor(() => expect(banners).toHaveLength(1));
    expect(banners[0]).toEqual({ kind: 'err', message: 'Your action did not run: no funds' });
    // Cleared, so a later unrelated row cannot re-fire the banner.
    expect(result.current.outcome).toBeNull();
  });

  it('marks an `applied` outcome as a success', async () => {
    const wrapper = setUp(() => json(row(FIRST_ID, { status: 'applied', at: AT })));
    const banners: ActionBannerState[] = [];
    const { result } = renderHook(
      () => {
        const watch = useOverrideOutcome(PROFILE_ID, SYMBOL);
        useOutcomeBanner(watch, (b) => banners.push(b));
        return watch;
      },
      { wrapper },
    );

    act(() => result.current.watch(FIRST_ID, AT));
    await waitFor(() => expect(banners).toHaveLength(1));
    expect(banners[0]?.kind).toBe('ok');
  });

  it('shows the explicit could-not-confirm message when the watch gives up', async () => {
    vi.useFakeTimers();
    try {
      const wrapper = setUp(() => json(row(FIRST_ID, null)));
      const banners: ActionBannerState[] = [];
      const { result } = renderHook(
        () => {
          const watch = useOverrideOutcome(PROFILE_ID, SYMBOL);
          useOutcomeBanner(watch, (b) => banners.push(b));
          return watch;
        },
        { wrapper },
      );

      act(() => result.current.watch(FIRST_ID, AT));
      await act(async () => {
        await vi.advanceTimersByTimeAsync(PAST_DEADLINE_MS);
      });

      expect(banners).toEqual([{ kind: 'err', message: WATCH_GAVE_UP_MESSAGE }]);
    } finally {
      vi.useRealTimers();
    }
  });

  it('tells a displaced watch it was replaced, not that the outcome is unknown', async () => {
    // Arming settles the row it displaces as `superseded` in the same
    // transaction, so this action almost certainly never ran. Sharing the
    // give-up sentence would send the operator to Binance to check on something
    // the database already knows the answer to, and an alarm that is usually
    // wrong is one they stop reading.
    vi.useFakeTimers();
    try {
      const wrapper = setUp(() => json(row(SECOND_ID, null, LATER_AT)));
      const banners: ActionBannerState[] = [];
      const { result } = renderHook(
        () => {
          const watch = useOverrideOutcome(PROFILE_ID, SYMBOL);
          useOutcomeBanner(watch, (b) => banners.push(b));
          return watch;
        },
        { wrapper },
      );

      act(() => result.current.watch(FIRST_ID, AT));
      // Well short of the deadline: this notice is owed the moment the newer row
      // is read, and asserting it after the timeout could not tell the two apart.
      await act(async () => {
        await vi.advanceTimersByTimeAsync(2_500);
      });

      // `info`, not `err`: the kind is the half of this notice the operator reads
      // first, and a red toast for the routine supersede is what teaches them to
      // dismiss the give-up too.
      expect(banners).toEqual([{ kind: 'info', message: WATCH_REPLACED_MESSAGE }]);
    } finally {
      vi.useRealTimers();
    }
  });
});
