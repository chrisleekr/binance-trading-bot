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
//      first is in flight must never be shown the first one's outcome.
//   3. The give-up transition: the watch window closes long before the server-side
//      reaper can settle a stranded row, so it must state that it does not know
//      rather than leave the optimistic "scheduled" banner standing.

import type { ReactNode } from 'react';
import { QueryClientProvider } from '@tanstack/react-query';
import { act, renderHook, waitFor } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { OverrideOutcome } from '@app/contracts';

import { createQueryClient } from '../src/shared/lib/query-client.js';
import {
  describeOutcome,
  useOutcomeBanner,
  useOverrideOutcome,
  WATCH_GAVE_UP_MESSAGE,
} from '../src/features/symbol/lib/use-override-outcome.js';
import type { ActionBannerState } from '../src/shared/components/action-banner.js';

const PROFILE_ID = '00000000-0000-4000-8000-000000000001';
const SYMBOL = 'BTCUSDT';
const FIRST_ID = '11111111-1111-4111-8111-111111111111';
const SECOND_ID = '22222222-2222-4222-8222-222222222222';

const AT = '2026-07-11T00:00:00.000Z';

const row = (id: string, outcome: OverrideOutcome | null): unknown => ({
  id,
  symbol: SYMBOL,
  action: 'sell',
  actionAt: AT,
  payload: {},
  triggeredBy: 'user',
  processingAt: null,
  consumedAt: outcome ? AT : null,
  outcome,
  createdAt: AT,
});

const json = (body: unknown): Response =>
  new Response(JSON.stringify(body), {
    status: 200,
    headers: { 'content-type': 'application/json' },
  });

const setUp = (responder: () => Response) => {
  vi.stubGlobal(
    'fetch',
    vi.fn(async () => responder()),
  );
  const queryClient = createQueryClient();
  return ({ children }: { children: ReactNode }): React.JSX.Element => (
    <QueryClientProvider client={queryClient}>{children}</QueryClientProvider>
  );
};

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

    act(() => result.current.watch(FIRST_ID));
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

    act(() => result.current.watch(FIRST_ID));
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
    // it to `gaveUp` minutes later and contradict the cancel's own success notice
    // with an error toast from whichever sibling panel armed the override.
    vi.useFakeTimers();
    try {
      const wrapper = setUp(() => json(null));
      const fetchCalls = (): number =>
        (fetch as unknown as ReturnType<typeof vi.fn>).mock.calls.length;
      const { result } = renderHook(() => useOverrideOutcome(PROFILE_ID, SYMBOL), { wrapper });

      act(() => result.current.watch(FIRST_ID));
      // Past one fast poll, so the null has been read back and acted on.
      await act(async () => {
        await vi.advanceTimersByTimeAsync(2_500);
      });
      expect(result.current.gaveUp).toBe(false);

      // Well past the give-up deadline a live watch would have tripped.
      await act(async () => {
        await vi.advanceTimersByTimeAsync(331_000);
      });
      expect(result.current.gaveUp).toBe(false);
      expect(fetchCalls()).toBe(1);
    } finally {
      vi.useRealTimers();
    }
  });

  it('stops watching when a post-arm read returns a DIFFERENT row', async () => {
    // The endpoint answers with the NEWEST override in its window, settled or
    // not — never "the row you asked about, or null". So deleting the watched row
    // does not produce a `null`: an older settled row simply becomes the newest.
    // Identity is the only signal that survives that, and without it the watch
    // polls on to `gaveUp` and fires an error toast about an override that was
    // cancelled successfully.
    vi.useFakeTimers();
    try {
      const wrapper = setUp(() => json(row(SECOND_ID, { status: 'applied', at: AT })));
      const fetchCalls = (): number =>
        (fetch as unknown as ReturnType<typeof vi.fn>).mock.calls.length;
      const { result } = renderHook(() => useOverrideOutcome(PROFILE_ID, SYMBOL), { wrapper });

      act(() => result.current.watch(FIRST_ID));
      await act(async () => {
        await vi.advanceTimersByTimeAsync(2_500);
      });
      expect(fetchCalls()).toBe(1);

      // Well past the give-up deadline, and still silent: the row that replaced
      // this one owns the operator's next notice.
      await act(async () => {
        await vi.advanceTimersByTimeAsync(331_000);
      });
      expect(result.current.gaveUp).toBe(false);
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
    // outcome, and not by `gaveUp`, which the clear resets. The operator would
    // watch a force-sell hang on "scheduled" forever.
    vi.useFakeTimers();
    try {
      let body: unknown = null;
      const wrapper = setUp(() => json(body));
      const fetchCalls = (): number =>
        (fetch as unknown as ReturnType<typeof vi.fn>).mock.calls.length;
      const { result } = renderHook(() => useOverrideOutcome(PROFILE_ID, SYMBOL), { wrapper });

      // The operator cancelled the first override, so its row reads back null and
      // the watch ends. One read, no interval — the state the re-arm starts from.
      act(() => result.current.watch(FIRST_ID));
      await act(async () => {
        await vi.advanceTimersByTimeAsync(2_500);
      });
      expect(fetchCalls()).toBe(1);

      // Same symbol, brand-new override, and it settles.
      body = row(SECOND_ID, { status: 'applied', at: AT });
      act(() => result.current.watch(SECOND_ID));
      await act(async () => {
        await vi.advanceTimersByTimeAsync(2_500);
      });

      expect(result.current.outcome?.status).toBe('applied');
      expect(result.current.gaveUp).toBe(false);
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

  it('flips to `gaveUp` when the watch window closes with the row still pending', async () => {
    // The row is still pending and the reaper cannot settle it for another ten
    // minutes. Leaving "scheduled" on screen would assert a success nobody
    // verified, so the watch must go terminal on its own.
    const wrapper = setUp(() => json(row(FIRST_ID, null)));
    const { result } = renderHook(() => useOverrideOutcome(PROFILE_ID, SYMBOL), { wrapper });

    act(() => result.current.watch(FIRST_ID));
    expect(result.current.gaveUp).toBe(false);

    // MANUAL_OVERRIDE_TTL_SECONDS (300s) + 30s of slack, plus a beat.
    await act(async () => {
      await vi.advanceTimersByTimeAsync(331_000);
    });
    expect(result.current.gaveUp).toBe(true);
    expect(result.current.outcome).toBeNull();
  });

  it('a fresh watch clears a previous give-up', async () => {
    const wrapper = setUp(() => json(row(FIRST_ID, null)));
    const { result } = renderHook(() => useOverrideOutcome(PROFILE_ID, SYMBOL), { wrapper });

    act(() => result.current.watch(FIRST_ID));
    await act(async () => {
      await vi.advanceTimersByTimeAsync(331_000);
    });
    expect(result.current.gaveUp).toBe(true);

    act(() => result.current.watch(SECOND_ID));
    expect(result.current.gaveUp).toBe(false);
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

    act(() => result.current.watch(FIRST_ID));
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

    act(() => result.current.watch(FIRST_ID));
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

      act(() => result.current.watch(FIRST_ID));
      await act(async () => {
        await vi.advanceTimersByTimeAsync(331_000);
      });

      expect(banners).toEqual([{ kind: 'err', message: WATCH_GAVE_UP_MESSAGE }]);
    } finally {
      vi.useRealTimers();
    }
  });
});
