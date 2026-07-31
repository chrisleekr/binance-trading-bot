// Unit tests for the two hooks extracted from SymbolTechnicalsPanel:
// useNearExpiryTick (1s countdown tick) and useRefreshAnnouncement
// (manual-refresh aria-live + cooldown). Tested through each hook's
// observable return, not internal state.

import type { ReactNode } from 'react';
import { QueryClientProvider } from '@tanstack/react-query';
import type { UseQueryResult } from '@tanstack/react-query';
import { act, renderHook } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';

import type {
  TechnicalsHealthResponse,
  TechnicalsRecommendationItem,
  TechnicalsResponse,
} from '@app/contracts';

import { useNearExpiryTick } from '../src/features/symbol/components/use-near-expiry-tick.js';
import { useRefreshAnnouncement } from '../src/features/symbol/components/use-refresh-announcement.js';
import { friendlyErrorLabel } from '../src/features/technicals/lib/friendly-error-label.js';
import { humaniseAge } from '../src/shared/lib/format-time.js';
import { createQueryClient } from '../src/shared/lib/query-client.js';

const NOW = 1_700_000_000_000;
// useOnlyWithinMin = 2 → a 120s freshness window.
const WITHIN_MIN = 2;

// Minimal item carrying a single signal at `receivedAtMs`; the hook only
// reads `signals[].signal?.receivedAtMs`, so the rest is cast away.
const itemAt = (receivedAtMs: number): TechnicalsRecommendationItem =>
  ({
    symbol: 'BTCUSDT',
    signals: [{ interval: '1m', signal: { receivedAtMs } }],
  }) as unknown as TechnicalsRecommendationItem;

describe('useNearExpiryTick', () => {
  afterEach(() => {
    vi.restoreAllMocks();
  });

  it('returns false when no item is present', () => {
    const { result } = renderHook(() => useNearExpiryTick(undefined, WITHIN_MIN, () => NOW));
    expect(result.current).toBe(false);
  });

  it('returns false for a fresh signal far from expiry', () => {
    // received now → 120s remaining, well above the 60s near-expiry band.
    const { result } = renderHook(() => useNearExpiryTick(itemAt(NOW), WITHIN_MIN, () => NOW));
    expect(result.current).toBe(false);
  });

  it('returns true once a signal is within 60s of expiry', () => {
    // received 70s ago → 50s remaining, inside the (0, 60] band.
    const { result } = renderHook(() =>
      useNearExpiryTick(itemAt(NOW - 70_000), WITHIN_MIN, () => NOW),
    );
    expect(result.current).toBe(true);
  });

  it('flips false → true as the clock crosses into the near-expiry band', () => {
    let now = NOW;
    const clock = (): number => now;
    // received 50s ago → 70s remaining (false). Advance 15s → 55s remaining (true).
    const { result, rerender } = renderHook(() =>
      useNearExpiryTick(itemAt(NOW - 50_000), WITHIN_MIN, clock),
    );
    expect(result.current).toBe(false);
    now = NOW + 15_000;
    rerender();
    expect(result.current).toBe(true);
  });

  it('arms a 1s interval while near expiry and clears it on unmount', () => {
    const setSpy = vi.spyOn(globalThis, 'setInterval');
    const clearSpy = vi.spyOn(globalThis, 'clearInterval');
    const { unmount } = renderHook(() =>
      useNearExpiryTick(itemAt(NOW - 70_000), WITHIN_MIN, () => NOW),
    );
    expect(setSpy).toHaveBeenCalledTimes(1);
    unmount();
    expect(clearSpy).toHaveBeenCalledTimes(1);
  });
});

const recsResult = (
  over: Partial<UseQueryResult<TechnicalsResponse>>,
): UseQueryResult<TechnicalsResponse> =>
  ({
    isFetching: false,
    error: null,
    data: undefined,
    ...over,
  }) as unknown as UseQueryResult<TechnicalsResponse>;

const healthResult = (
  over: Partial<UseQueryResult<TechnicalsHealthResponse>>,
): UseQueryResult<TechnicalsHealthResponse> =>
  ({
    isFetching: false,
    error: null,
    data: undefined,
    ...over,
  }) as unknown as UseQueryResult<TechnicalsHealthResponse>;

const dataWithSignal = (receivedAtMs: number): TechnicalsResponse =>
  ({
    items: [{ symbol: 'BTCUSDT', signals: [{ interval: '1m', signal: { receivedAtMs } }] }],
  }) as unknown as TechnicalsResponse;

describe('useRefreshAnnouncement', () => {
  const wrapperWith = (qc = createQueryClient()) => {
    const Wrapper = ({ children }: { children: ReactNode }): React.JSX.Element => (
      <QueryClientProvider client={qc}>{children}</QueryClientProvider>
    );
    return { Wrapper, qc };
  };

  it('stays silent for a background poll (no manual refresh)', () => {
    const { Wrapper } = wrapperWith();
    const { result } = renderHook(
      () =>
        useRefreshAnnouncement(
          'p1',
          recsResult({ data: dataWithSignal(NOW) }),
          healthResult({}),
          () => NOW,
        ),
      { wrapper: Wrapper },
    );
    expect(result.current.announcement).toBe('');
  });

  // The announcement fires when both polls settle (isFetching true → false)
  // after a manual refresh — mirror that fetching→idle transition by
  // re-rendering with the settled query results.
  interface Props {
    recs: UseQueryResult<TechnicalsResponse>;
    health: UseQueryResult<TechnicalsHealthResponse>;
  }

  it('announces the freshest signal staleness after a manual refresh', () => {
    const { Wrapper } = wrapperWith();
    const { result, rerender } = renderHook(
      ({ recs, health }: Props) => useRefreshAnnouncement('p1', recs, health, () => NOW),
      {
        wrapper: Wrapper,
        initialProps: {
          recs: recsResult({ isFetching: true, data: dataWithSignal(NOW - 5_000) }),
          health: healthResult({ isFetching: true }),
        },
      },
    );
    act(() => {
      result.current.refresh();
    });
    rerender({ recs: recsResult({ data: dataWithSignal(NOW - 5_000) }), health: healthResult({}) });
    expect(result.current.announcement).toBe(
      `Technicals refreshed; signal ${humaniseAge(NOW - (NOW - 5_000), { suffix: ' ago' })}.`,
    );
  });

  it('announces no-signal-yet when a manual refresh returns an empty result', () => {
    const { Wrapper } = wrapperWith();
    const { result, rerender } = renderHook(
      ({ recs, health }: Props) => useRefreshAnnouncement('p1', recs, health, () => NOW),
      {
        wrapper: Wrapper,
        initialProps: {
          recs: recsResult({ isFetching: true }),
          health: healthResult({ isFetching: true }),
        },
      },
    );
    act(() => {
      result.current.refresh();
    });
    rerender({
      recs: recsResult({ data: { items: [] } as unknown as TechnicalsResponse }),
      health: healthResult({}),
    });
    expect(result.current.announcement).toBe('Technicals refreshed; no signal available yet.');
  });

  it('announces the friendly error label when a query errored', () => {
    const { Wrapper } = wrapperWith();
    const { result, rerender } = renderHook(
      ({ recs, health }: Props) => useRefreshAnnouncement('p1', recs, health, () => NOW),
      {
        wrapper: Wrapper,
        initialProps: {
          recs: recsResult({ isFetching: true }),
          health: healthResult({ isFetching: true }),
        },
      },
    );
    act(() => {
      result.current.refresh();
    });
    rerender({ recs: recsResult({ error: new Error('boom') }), health: healthResult({}) });
    expect(result.current.announcement).toBe(
      `Technicals refresh failed: ${friendlyErrorLabel('boom')}`,
    );
  });

  it('holds the cooldown so a second click does not re-fire the refetch', () => {
    const { Wrapper, qc } = wrapperWith();
    const refetchSpy = vi.spyOn(qc, 'refetchQueries').mockResolvedValue(undefined);
    const { result } = renderHook(
      () =>
        useRefreshAnnouncement(
          'p1',
          recsResult({ data: dataWithSignal(NOW) }),
          healthResult({}),
          () => NOW,
        ),
      { wrapper: Wrapper },
    );
    act(() => {
      result.current.refresh();
    });
    expect(result.current.refreshing).toBe(true);
    // Two refetches from the first click (recommendations + health).
    expect(refetchSpy).toHaveBeenCalledTimes(2);
    act(() => {
      result.current.refresh();
    });
    // Cooldown guard blocks the second click — still only the first two.
    expect(refetchSpy).toHaveBeenCalledTimes(2);
  });
});
