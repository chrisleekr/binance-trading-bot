// SymbolDisableBanner — TTL countdown, Resume mutation, error handling.

import { QueryClientProvider } from '@tanstack/react-query';
import { act, render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { afterEach, describe, expect, it, vi } from 'vitest';

import {
  formatTtl,
  SymbolDisableBanner,
} from '../src/features/symbol/components/symbol-disable-banner.js';
import { createQueryClient } from '../src/shared/lib/query-client.js';

const PROFILE_ID = '4d2f9f4a-1c9c-4e5f-9a1d-3b6f7c8e0a2c';
const SYMBOL = 'BTCUSDT';

const baseDisable = {
  ttlSeconds: 600,
  since: '2026-05-10T12:00:00.000Z',
  reason: 'manual pause',
};

const setUp = (responder: (url: string) => Response): { fetchMock: ReturnType<typeof vi.fn> } => {
  const fetchMock = vi.fn(async (input: RequestInfo | URL) => {
    const url =
      typeof input === 'string' ? input : input instanceof URL ? input.toString() : input.url;
    return responder(url);
  });
  vi.stubGlobal('fetch', fetchMock);
  const queryClient = createQueryClient();
  const now = 1_000_000;
  render(
    <QueryClientProvider client={queryClient}>
      <SymbolDisableBanner
        profileId={PROFILE_ID}
        symbol={SYMBOL}
        disable={baseDisable}
        clock={() => now}
      />
    </QueryClientProvider>,
  );
  return { fetchMock };
};

afterEach(() => {
  vi.unstubAllGlobals();
  vi.useRealTimers();
});

describe('formatTtl (pure)', () => {
  it('formats sub-hour as M:SS', () => {
    expect(formatTtl(125)).toBe('2:05');
  });
  it('formats over-hour as H:MM:SS', () => {
    expect(formatTtl(3661)).toBe('1:01:01');
  });
  it('clamps negative to 0:00', () => {
    expect(formatTtl(-5)).toBe('0:00');
  });
});

describe('SymbolDisableBanner', () => {
  it('renders the reason and the initial TTL', () => {
    setUp(() => new Response(null, { status: 204 }));
    expect(screen.getByText(/manual pause/)).toBeInTheDocument();
    expect(screen.getByTestId('symbol-disable-ttl')).toHaveTextContent('10:00');
  });

  it('Resume stays enabled when ttlSeconds is 0 (no-TTL recovery path)', () => {
    const queryClient = createQueryClient();
    vi.stubGlobal(
      'fetch',
      vi.fn(async () => new Response(null, { status: 204 })),
    );
    render(
      <QueryClientProvider client={queryClient}>
        <SymbolDisableBanner
          profileId={PROFILE_ID}
          symbol={SYMBOL}
          disable={{ ...baseDisable, ttlSeconds: 0 }}
          clock={() => 1_000_000}
        />
      </QueryClientProvider>,
    );
    expect(screen.getByTestId('symbol-disable-resume')).not.toBeDisabled();
  });

  it('Resume click POSTs DELETE /disable', async () => {
    const { fetchMock } = setUp((url) => {
      if (url.includes('/disable')) return new Response(null, { status: 204 });
      throw new Error(`unexpected ${url}`);
    });
    await userEvent.click(screen.getByTestId('symbol-disable-resume'));
    await waitFor(() => {
      const call = fetchMock.mock.calls.find(([input]) => String(input).includes('/disable'));
      expect(call).toBeTruthy();
      const init = call?.[1] as RequestInit;
      expect(init.method).toBe('DELETE');
    });
  });

  it('keeps the Resume mutation gated when a refreshed TTL resets the countdown', async () => {
    let finishRelease: ((response: Response) => void) | undefined;
    vi.stubGlobal(
      'fetch',
      vi.fn(
        () =>
          new Promise<Response>((resolve) => {
            finishRelease = resolve;
          }),
      ),
    );
    const queryClient = createQueryClient();
    const view = (ttlSeconds: number): React.JSX.Element => (
      <QueryClientProvider client={queryClient}>
        <SymbolDisableBanner
          profileId={PROFILE_ID}
          symbol={SYMBOL}
          disable={{ ...baseDisable, ttlSeconds }}
          clock={() => 1_000_000}
        />
      </QueryClientProvider>
    );
    const { rerender } = render(view(600));

    await userEvent.click(screen.getByTestId('symbol-disable-resume'));
    await waitFor(() => expect(screen.getByTestId('symbol-disable-resume')).toBeDisabled());

    rerender(view(595));
    expect(screen.getByTestId('symbol-disable-resume')).toBeDisabled();
    expect(screen.getByTestId('symbol-disable-resume')).toHaveTextContent('Resuming');
    expect(screen.getByTestId('symbol-disable-ttl')).toHaveTextContent('9:55');

    finishRelease?.(new Response(null, { status: 204 }));
    await waitFor(() => expect(screen.getByTestId('symbol-disable-resume')).not.toBeDisabled());
  });

  it('restarts the countdown when the disable identity changes with the same TTL', () => {
    vi.useFakeTimers();
    let now = 1_000_000;
    const clock = (): number => now;
    const queryClient = createQueryClient();
    const view = (since: string): React.JSX.Element => (
      <QueryClientProvider client={queryClient}>
        <SymbolDisableBanner
          profileId={PROFILE_ID}
          symbol={SYMBOL}
          disable={{ ...baseDisable, since }}
          clock={clock}
        />
      </QueryClientProvider>
    );
    const { rerender } = render(view(baseDisable.since));

    now += 5_000;
    act(() => vi.advanceTimersByTime(5_000));
    expect(screen.getByTestId('symbol-disable-ttl')).toHaveTextContent('9:55');

    rerender(view('2026-05-10T12:01:00.000Z'));
    expect(screen.getByTestId('symbol-disable-ttl')).toHaveTextContent('10:00');
  });
});
