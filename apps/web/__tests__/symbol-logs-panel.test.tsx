// SymbolLogsPanel — covers the four behaviours the issue calls out:
//  1. initial load via REST,
//  2. virtualisation only mounts visible rows,
//  3. WS frame appends to the head respecting the ring cap,
//  4. "Load older" widens the window backwards.

import { QueryClientProvider } from '@tanstack/react-query';
import { render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { afterEach, describe, expect, it, vi } from 'vitest';

import {
  appendLive,
  mergeAll,
  mergeOlder,
  SymbolLogsPanel,
} from '../src/features/symbol/components/symbol-logs-panel.js';
import { createQueryClient } from '../src/shared/lib/query-client.js';
import { SYMBOL_LOGS_RING_CAP } from '../src/features/symbol/api/symbol.js';

import type { SymbolLogEntry } from '@app/contracts';

const PROFILE_ID = '4d2f9f4a-1c9c-4e5f-9a1d-3b6f7c8e0a2c';
const SYMBOL = 'BTCUSDT';

const json = (body: unknown, status = 200): Response =>
  new Response(JSON.stringify(body), {
    status,
    headers: { 'content-type': 'application/json' },
  });

const makeRow = (idx: number, base: number): SymbolLogEntry => ({
  time: new Date(base - idx * 60_000).toISOString(),
  symbol: SYMBOL,
  level: 'info',
  msg: `entry ${idx}`,
});

afterEach(() => {
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

// happy-dom reports 0×0 for every element's bounding rect, which makes
// react-virtual short-circuit and render no items. Stub a 288px-tall scroll
// container (`h-72`) so the virtualiser thinks it has a viewport.
const stubViewport = (height = 288): void => {
  Object.defineProperty(HTMLElement.prototype, 'clientHeight', {
    configurable: true,
    get(): number {
      return this.dataset.testid === 'symbol-logs-scroll' ? height : 0;
    },
  });
  Object.defineProperty(HTMLElement.prototype, 'getBoundingClientRect', {
    configurable: true,
    value(): DOMRect {
      return {
        x: 0,
        y: 0,
        width: 0,
        height: this.dataset?.testid === 'symbol-logs-scroll' ? height : 0,
        top: 0,
        left: 0,
        right: 0,
        bottom: 0,
        toJSON: () => ({}),
      } as DOMRect;
    },
  });
};

describe('appendLive (pure)', () => {
  it('prepends new frame on top and respects the ring cap', () => {
    const base = new Date('2026-05-10T12:00:00Z').getTime();
    const rows: SymbolLogEntry[] = Array.from({ length: 5 }, (_, i) => makeRow(i, base));
    const fresh: SymbolLogEntry = {
      time: new Date(base + 1_000).toISOString(),
      symbol: SYMBOL,
      level: 'info',
      msg: 'fresh',
    };
    const next = appendLive(rows, fresh, 4);
    expect(next).toHaveLength(4);
    expect(next[0]?.msg).toBe('fresh');
  });

  it('returns the same reference when frame is a duplicate', () => {
    const row: SymbolLogEntry = {
      time: '2026-05-10T12:00:00.000Z',
      symbol: SYMBOL,
      level: 'info',
      msg: 'hello',
    };
    const original = [row];
    expect(appendLive(original, row)).toBe(original);
  });
});

describe('mergeAll (pure)', () => {
  it('folds REST rows into the live ring without overwriting', () => {
    const base = new Date('2026-05-10T12:00:00Z').getTime();
    const live: SymbolLogEntry[] = [
      { time: new Date(base + 1_000).toISOString(), symbol: SYMBOL, level: 'info', msg: 'live' },
    ];
    const rest = [makeRow(0, base), makeRow(1, base)];
    const merged = mergeAll(live, rest);
    expect(merged).toHaveLength(3);
    expect(merged[0]?.msg).toBe('live');
  });
});

describe('mergeOlder (pure)', () => {
  it('appends de-duplicated older rows and keeps newest-first ordering', () => {
    const base = new Date('2026-05-10T12:00:00Z').getTime();
    const head: SymbolLogEntry[] = [makeRow(0, base), makeRow(1, base)];
    const older: SymbolLogEntry[] = [
      // duplicate of head[1] — must be discarded
      makeRow(1, base),
      makeRow(2, base),
      makeRow(3, base),
    ];
    const merged = mergeOlder(head, older);
    expect(merged).toHaveLength(4);
    expect(merged[0]?.msg).toBe('entry 0');
    expect(merged[3]?.msg).toBe('entry 3');
  });
});

const setUp = (
  initial: SymbolLogEntry[],
  responder?: (url: string) => Response | Promise<Response>,
): {
  fetchMock: ReturnType<typeof vi.fn>;
  queryClient: ReturnType<typeof createQueryClient>;
  rerender: (liveFrame: SymbolLogEntry | null) => void;
  unmount: () => void;
} => {
  let liveCalls = 0;
  const fetchMock = vi.fn(async (input: RequestInfo | URL) => {
    const url =
      typeof input === 'string' ? input : input instanceof URL ? input.toString() : input.url;
    if (responder) return responder(url);
    if (url.includes('/symbols/')) {
      liveCalls += 1;
      // First call is initial; subsequent calls are load-older pages.
      return json(liveCalls === 1 ? initial : []);
    }
    return new Response('not found', { status: 404 });
  });
  vi.stubGlobal('fetch', fetchMock);

  const queryClient = createQueryClient();
  const result = render(
    <QueryClientProvider client={queryClient}>
      <SymbolLogsPanel profileId={PROFILE_ID} symbol={SYMBOL} liveFrame={null} />
    </QueryClientProvider>,
  );
  return {
    fetchMock,
    queryClient,
    rerender: (liveFrame): void => {
      result.rerender(
        <QueryClientProvider client={queryClient}>
          <SymbolLogsPanel profileId={PROFILE_ID} symbol={SYMBOL} liveFrame={liveFrame} />
        </QueryClientProvider>,
      );
    },
    unmount: result.unmount,
  };
};

describe('SymbolLogsPanel — render', () => {
  it('shows initial REST load and renders only a virtual slice', async () => {
    stubViewport();
    const base = new Date('2026-05-10T12:00:00Z').getTime();
    const rows = Array.from({ length: 200 }, (_, i) => makeRow(i, base));
    setUp(rows);

    await waitFor(() =>
      expect(screen.getByTestId('symbol-logs-count')).toHaveTextContent('200 rows'),
    );
    const list = screen.getByTestId('symbol-logs-list');
    // Virtualiser overscans by 6 over a 288px viewport (h-72 = 18rem) with
    // 56px estimated rows; mounting all 200 would be a regression.
    expect(list.children.length).toBeLessThan(40);
  });

  it('shows the empty state when REST returns nothing', async () => {
    setUp([]);
    await waitFor(() => expect(screen.getByTestId('symbol-logs-empty')).toBeInTheDocument());
    // Avoid the redundant "0 rows" chip next to the empty paragraph —
    // two empty signals for one state.
    expect(screen.queryByTestId('symbol-logs-count')).toBeNull();
  });

  it('pluralises the count chip — "1 row" for a single entry', async () => {
    const base = new Date('2026-05-10T12:00:00Z').getTime();
    setUp([makeRow(0, base)]);
    await waitFor(() => expect(screen.getByTestId('symbol-logs-count')).toHaveTextContent('1 row'));
    // Must not be the "1 rows" off-by-one — the regex anchors on word boundary.
    expect(screen.getByTestId('symbol-logs-count').textContent).toBe('1 row');
  });

  it('appends a live WS frame to the head', async () => {
    const base = new Date('2026-05-10T12:00:00Z').getTime();
    const rows = Array.from({ length: 3 }, (_, i) => makeRow(i, base));
    const { rerender } = setUp(rows);
    await waitFor(() =>
      expect(screen.getByTestId('symbol-logs-count')).toHaveTextContent('3 rows'),
    );

    const fresh: SymbolLogEntry = {
      time: new Date(base + 1_000).toISOString(),
      symbol: SYMBOL,
      level: 'warn',
      msg: 'fresh entry',
    };
    rerender(fresh);
    await waitFor(() =>
      expect(screen.getByTestId('symbol-logs-count')).toHaveTextContent('4 rows'),
    );
  });

  it('ignores live frames for a different symbol', async () => {
    const { rerender } = setUp([]);
    await waitFor(() => expect(screen.getByTestId('symbol-logs-empty')).toBeInTheDocument());
    rerender({
      time: new Date().toISOString(),
      symbol: 'ETHUSDT',
      level: 'info',
      msg: 'foreign',
    });
    // Empty state must remain — no append.
    expect(screen.getByTestId('symbol-logs-empty')).toBeInTheDocument();
  });

  it('load-older button issues a second fetch and merges results', async () => {
    const base = new Date('2026-05-10T12:00:00Z').getTime();
    const initial = [makeRow(0, base), makeRow(1, base)];
    const older = [makeRow(2, base), makeRow(3, base)];
    let call = 0;
    const responder = (): Response => {
      call += 1;
      return json(call === 1 ? initial : older);
    };
    setUp(initial, responder);

    await waitFor(() =>
      expect(screen.getByTestId('symbol-logs-count')).toHaveTextContent('2 rows'),
    );
    await userEvent.click(screen.getByTestId('symbol-logs-load-older'));
    await waitFor(() =>
      expect(screen.getByTestId('symbol-logs-count')).toHaveTextContent('4 rows'),
    );
  });

  it('disables load-older once the ring cap is reached', async () => {
    const base = new Date('2026-05-10T12:00:00Z').getTime();
    const rows = Array.from({ length: SYMBOL_LOGS_RING_CAP }, (_, i) => makeRow(i, base));
    setUp(rows);
    await waitFor(() =>
      expect(screen.getByTestId('symbol-logs-count')).toHaveTextContent(
        `${SYMBOL_LOGS_RING_CAP} rows`,
      ),
    );
    expect(screen.getByTestId('symbol-logs-load-older')).toBeDisabled();
  });
});
