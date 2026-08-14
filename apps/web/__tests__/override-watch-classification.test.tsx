// A watch that ends without a word is only correct when the row it followed was
// replaced by something that owns the operator's next notice — a cancel, or an
// override that superseded it. When the read-back is instead a row that landed
// AFTER the watched one, the watched row's fate is genuinely unknown: it left
// the outcome window unsettled and nothing else will speak for it. Clearing
// silently there leaves an optimistic "scheduled" banner standing over money
// that may or may not have moved.
//
// Older / newer is decided against the server's own ordering — `createdAt`
// descending, `id` descending — so a same-millisecond sibling is classified the
// same way the endpoint picked it.

import type { ReactNode } from 'react';
import { QueryClientProvider } from '@tanstack/react-query';
import { act, renderHook } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';

import { createQueryClient } from '../src/shared/lib/query-client.js';
import {
  useOverrideOutcome,
  WATCH_TIMEOUT_MS,
  type OverrideOutcomeWatch,
} from '../src/features/symbol/lib/use-override-outcome.js';

const PROFILE_ID = '00000000-0000-4000-8000-000000000001';
const SYMBOL = 'BTCUSDT';

const WATCHED_ID = '11111111-1111-4111-8111-111111111111';
const HIGHER_ID = '22222222-2222-4222-8222-222222222222';
const LOWER_ID = '00000000-0000-4000-8000-000000000000';

const WATCHED_AT = '2026-07-11T00:00:00.000Z';
const LATER_AT = '2026-07-11T00:00:01.000Z';
const EARLIER_AT = '2026-07-10T23:59:59.000Z';

/** One beat past the give-up deadline, derived so a TTL change cannot leave it short. */
const PAST_DEADLINE_MS = WATCH_TIMEOUT_MS + 1_000;

const row = (id: string, createdAt: string): unknown => ({
  id,
  symbol: SYMBOL,
  action: 'sell',
  actionAt: createdAt,
  payload: {},
  triggeredBy: 'user',
  processingAt: null,
  consumedAt: createdAt,
  outcome: { status: 'applied', at: createdAt },
  createdAt,
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

const fetchCalls = (): number => (fetch as unknown as ReturnType<typeof vi.fn>).mock.calls.length;

afterEach(() => {
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

describe('override watch classification', () => {
  const runWatch = async (readBack: unknown): Promise<OverrideOutcomeWatch> => {
    const wrapper = setUp(() => json(readBack));
    const { result } = renderHook(() => useOverrideOutcome(PROFILE_ID, SYMBOL), { wrapper });
    act(() => result.current.watch(WATCHED_ID, WATCHED_AT));
    await act(async () => {
      await vi.advanceTimersByTimeAsync(2_500);
    });
    return result.current;
  };

  it('reports that it could not confirm when a newer row displaced the watched one', async () => {
    vi.useFakeTimers();
    try {
      const watch = await runWatch(row(HIGHER_ID, LATER_AT));
      // Terminal immediately, not at the deadline: nothing else can answer.
      expect(watch.unresolved).toBe('replaced');
      expect(watch.outcome).toBeNull();
      expect(fetchCalls()).toBe(1);
    } finally {
      vi.useRealTimers();
    }
  });

  it('breaks a same-instant tie on id the way the server orders rows', async () => {
    // Two rows stamped in the same millisecond are ordered by id descending on
    // the server, so the higher id is the newer row and the watched one is gone.
    vi.useFakeTimers();
    try {
      const watch = await runWatch(row(HIGHER_ID, WATCHED_AT));
      expect(watch.unresolved).toBe('replaced');
      expect(fetchCalls()).toBe(1);
    } finally {
      vi.useRealTimers();
    }
  });

  it('stays silent when the read-back is empty', async () => {
    // No row in the window at all: the watched row was cancelled and whatever
    // did that already told the operator.
    vi.useFakeTimers();
    try {
      const wrapper = setUp(() => json(null));
      const { result } = renderHook(() => useOverrideOutcome(PROFILE_ID, SYMBOL), { wrapper });
      act(() => result.current.watch(WATCHED_ID, WATCHED_AT));
      await act(async () => {
        await vi.advanceTimersByTimeAsync(2_500);
      });
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

  it('stays silent when an older row is the newest thing left in the window', async () => {
    // The watched row was deleted and an earlier settled row is now the newest.
    vi.useFakeTimers();
    try {
      const wrapper = setUp(() => json(row(LOWER_ID, EARLIER_AT)));
      const { result } = renderHook(() => useOverrideOutcome(PROFILE_ID, SYMBOL), { wrapper });
      act(() => result.current.watch(WATCHED_ID, WATCHED_AT));
      await act(async () => {
        await vi.advanceTimersByTimeAsync(2_500);
      });
      await act(async () => {
        await vi.advanceTimersByTimeAsync(PAST_DEADLINE_MS);
      });
      expect(result.current.unresolved).toBeNull();
      expect(fetchCalls()).toBe(1);
    } finally {
      vi.useRealTimers();
    }
  });

  it('stays silent for a same-instant sibling whose id sorts below the watched row', async () => {
    vi.useFakeTimers();
    try {
      const wrapper = setUp(() => json(row(LOWER_ID, WATCHED_AT)));
      const { result } = renderHook(() => useOverrideOutcome(PROFILE_ID, SYMBOL), { wrapper });
      act(() => result.current.watch(WATCHED_ID, WATCHED_AT));
      await act(async () => {
        await vi.advanceTimersByTimeAsync(2_500);
      });
      await act(async () => {
        await vi.advanceTimersByTimeAsync(PAST_DEADLINE_MS);
      });
      expect(result.current.unresolved).toBeNull();
      expect(fetchCalls()).toBe(1);
    } finally {
      vi.useRealTimers();
    }
  });
});
