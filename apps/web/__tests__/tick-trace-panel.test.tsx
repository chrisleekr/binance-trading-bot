// The raw tick trace's pager, which is the one part of this panel that can
// strand the operator.
//
// The two controls answer different questions — "is there anything older" and
// "am I looking at an older window" — and sharing one gate between them means
// walking back to the end of the stream removes the way back to newest. That is
// a dead end reachable by clicking the panel's own button, so it is pinned here.

import { QueryClientProvider } from '@tanstack/react-query';
import { render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { afterEach, describe, expect, it, vi } from 'vitest';

import { createQueryClient } from '@/shared/lib/query-client';
import { TickTracePanel } from '@/features/profile/components/tick-trace-panel';

const PROFILE_ID = '00000000-0000-4000-8000-0000000000a1';
const OLDEST_ID = '1754000000000-0';

type Json = Record<string, unknown>;

const json = (body: Json): Response =>
  new Response(JSON.stringify(body), {
    status: 200,
    headers: { 'content-type': 'application/json' },
  });

const entry = (streamId: string): Json => ({
  streamId,
  ts: '2026-08-01T10:00:00.000Z',
  symbol: 'BTCUSDT',
  event: 'tick',
  decisionTypes: [],
  latencyMs: 4,
});

/** Renders the panel already expanded (the pager only exists past "Load trace"). */
const setUp = async (responder: (url: string) => Response) => {
  const fetchMock = vi.fn(async (input: RequestInfo | URL) =>
    responder(
      typeof input === 'string' ? input : input instanceof URL ? input.toString() : input.url,
    ),
  );
  vi.stubGlobal('fetch', fetchMock);
  render(
    <QueryClientProvider client={createQueryClient()}>
      <TickTracePanel profileId={PROFILE_ID} symbol={null} />
    </QueryClientProvider>,
  );
  await userEvent.click(screen.getByTestId('tick-trace-load'));
};

describe('TickTracePanel pager', () => {
  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it('offers only the walk back while showing the newest window', async () => {
    await setUp(() =>
      json({ items: [entry(OLDEST_ID)], oldestStreamId: OLDEST_ID, truncated: false }),
    );
    expect(await screen.findByTestId('tick-trace-older')).toBeInTheDocument();
    // Nothing to return to: this IS the newest window.
    expect(screen.queryByTestId('tick-trace-newest')).not.toBeInTheDocument();
  });

  it('keeps the way back to newest at the end of the stream', async () => {
    // The regression: the last window has nothing older, so a shared
    // `oldest !== null` gate drops the whole control block and the operator is
    // stuck on a window with no way forward.
    await setUp((url) =>
      url.includes('before=')
        ? json({ items: [entry('1753000000000-0')], oldestStreamId: null, truncated: false })
        : json({ items: [entry(OLDEST_ID)], oldestStreamId: OLDEST_ID, truncated: false }),
    );
    await userEvent.click(await screen.findByTestId('tick-trace-older'));

    await waitFor(() => expect(screen.getByTestId('tick-trace-newest')).toBeInTheDocument());
    expect(screen.queryByTestId('tick-trace-older')).not.toBeInTheDocument();
  });

  it('draws no control row when neither direction is available', async () => {
    await setUp(() => json({ items: [], oldestStreamId: null, truncated: false }));
    expect(await screen.findByText('No trace entries in the stream.')).toBeInTheDocument();
    expect(screen.queryByTestId('tick-trace-older')).not.toBeInTheDocument();
    expect(screen.queryByTestId('tick-trace-newest')).not.toBeInTheDocument();
  });
});
