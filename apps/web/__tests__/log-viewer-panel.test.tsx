// The profile Logs tab — the surface an operator opens to answer "why did it do
// that".
//
// What is worth pinning is the agreement between what the screen SAYS it is
// showing and what it actually fetched. A filter chip that does not reach the
// query, an export link that carries a different filter from the list under it,
// or a cursor reused across filters all produce a plausible-looking screen that
// misleads the person reading it — which is worse than an obvious error.

import { QueryClientProvider } from '@tanstack/react-query';
import { render, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { createQueryClient } from '@/shared/lib/query-client';
import { LogViewerPanel } from '@/features/profile/components/log-viewer-panel';
import { Toaster } from '@/shared/components/ui/sonner';

const PROFILE_ID = '00000000-0000-4000-8000-0000000000a1';
const ROW_ID = '00000000-0000-4000-8000-00000000e001';
const OLDER_ID = '00000000-0000-4000-8000-00000000e002';
/** Shaped like the real thing: the contract rejects anything that is not `<isoMicros>|<uuid>`. */
const NEXT_CURSOR = `2026-08-01T10:00:00.000000Z|${ROW_ID}`;

type Json = Record<string, unknown>;

const json = (body: Json, status = 200): Response =>
  new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } });

const row = (over: Partial<Json> = {}): Json => ({
  time: '2026-08-01T10:00:00.000Z',
  id: ROW_ID,
  symbol: 'BTCUSDT',
  level: 'info',
  msg: 'entry evaluated',
  ctx: { source: 'tick', rsi: 71 },
  cursorToken: '2026-08-01T10:00:00.000000Z',
  ...over,
});

/** URLs the panel fetched, in order. */
const requested = (fetchMock: ReturnType<typeof vi.fn>): string[] =>
  fetchMock.mock.calls.map(([u]) => String(u));

const logsUrls = (fetchMock: ReturnType<typeof vi.fn>): string[] =>
  requested(fetchMock).filter((u) => u.includes('/logs?') || u.endsWith('/logs'));

const setUp = (
  responder: (url: string, init?: RequestInit) => Response | Promise<Response> = () =>
    json({ items: [row()], nextCursor: null }),
) => {
  const fetchMock = vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
    const url =
      typeof input === 'string' ? input : input instanceof URL ? input.toString() : input.url;
    if (url.includes('/logs/symbols')) return json({ symbols: ['BTCUSDT', 'ETHUSDT'] });
    if (url.includes('/retention-config')) {
      return json({
        actionLogDays: 7,
        actionLogMaxRows: 200_000,
        auditLogDays: 90,
        auditStreamMaxlen: 100_000,
        debugCapture: null,
        updatedAt: '2026-08-01T00:00:00.000Z',
      });
    }
    return responder(url, init);
  });
  vi.stubGlobal('fetch', fetchMock);
  return {
    fetchMock,
    ...render(
      <QueryClientProvider client={createQueryClient()}>
        <LogViewerPanel profileId={PROFILE_ID} />
        <Toaster />
      </QueryClientProvider>,
    ),
  };
};

describe('LogViewerPanel', () => {
  beforeEach(() => {
    vi.spyOn(console, 'error').mockImplementation(() => undefined);
  });
  afterEach(() => {
    vi.unstubAllGlobals();
    vi.restoreAllMocks();
  });

  it('renders a row with its full structured context, not a summary', async () => {
    setUp();
    expect(await screen.findByText('entry evaluated')).toBeInTheDocument();
    // The `ctx` the worker recorded is what the reader came for; a prettified
    // projection is where a missing field hides.
    const ctx = screen.getByTestId('log-row-ctx');
    expect(JSON.parse(ctx.textContent ?? '{}')).toEqual({ source: 'tick', rsi: 71 });
  });

  it('fetches the window the range selector claims to be showing', async () => {
    // The selector reads 24h from the first paint. A first query without the
    // matching `from` would show rows older than the window on screen.
    const { fetchMock } = setUp();
    await waitFor(() => expect(logsUrls(fetchMock).length).toBeGreaterThan(0));
    const first = new URL(logsUrls(fetchMock)[0] ?? '', 'http://localhost');
    expect(screen.getByTestId('log-range-filter')).toHaveValue('24');
    const from = Date.parse(first.searchParams.get('from') ?? '');
    expect(Date.now() - from).toBeGreaterThan(23 * 3_600_000);
    expect(Date.now() - from).toBeLessThan(25 * 3_600_000);
  });

  it('sends a level chip through to the query', async () => {
    const { fetchMock } = setUp();
    await screen.findByText('entry evaluated');
    const user = userEvent.setup();
    await user.click(screen.getByTestId('log-level-error'));
    await waitFor(() => {
      const last = logsUrls(fetchMock).at(-1) ?? '';
      expect(new URL(last, 'http://localhost').searchParams.get('levels')).toBe('error');
    });
    expect(screen.getByTestId('log-level-error')).toHaveAttribute('aria-pressed', 'true');
  });

  it('applies the search on submit rather than per keystroke', async () => {
    const { fetchMock } = setUp();
    await screen.findByText('entry evaluated');
    const before = logsUrls(fetchMock).length;
    const user = userEvent.setup();
    await user.type(screen.getByTestId('log-search'), 'rejected');
    // Eight characters typed; re-querying per character would hammer the reader
    // for results nobody reads.
    expect(logsUrls(fetchMock).length).toBe(before);

    await user.click(screen.getByRole('button', { name: /^search$/i }));
    await waitFor(() => {
      const last = logsUrls(fetchMock).at(-1) ?? '';
      expect(new URL(last, 'http://localhost').searchParams.get('q')).toBe('rejected');
    });
  });

  it('drops the search bound entirely when the box is cleared', async () => {
    const { fetchMock } = setUp();
    await screen.findByText('entry evaluated');
    const user = userEvent.setup();
    await user.type(screen.getByTestId('log-search'), 'rejected');
    await user.click(screen.getByRole('button', { name: /^search$/i }));
    await waitFor(() =>
      expect(
        new URL(logsUrls(fetchMock).at(-1) ?? '', 'http://localhost').searchParams.has('q'),
      ).toBe(true),
    );

    await user.clear(screen.getByTestId('log-search'));
    await user.click(screen.getByRole('button', { name: /^search$/i }));
    // Asserted on the export link rather than the last request: clearing
    // returns the filter to one already fetched, which React Query serves from
    // cache without a new URL. The link is rendered straight from filter state,
    // so it shows what the filter IS, not what was last requested.
    await waitFor(() => {
      const href = screen.getByTestId('log-export-link').getAttribute('href') ?? '';
      // An empty `q=` would ILIKE '%%' server-side rather than meaning "no
      // search", so the parameter has to be absent, not blank.
      expect(new URL(href, 'http://localhost').searchParams.has('q')).toBe(false);
    });
  });

  it('hands the export link the same filter as the list under it', async () => {
    const { fetchMock } = setUp();
    await screen.findByText('entry evaluated');
    const user = userEvent.setup();
    await user.click(screen.getByTestId('log-level-warn'));
    await user.selectOptions(screen.getByTestId('log-symbol-filter'), 'ETHUSDT');

    await waitFor(() => {
      const listUrl = new URL(logsUrls(fetchMock).at(-1) ?? '', 'http://localhost');
      expect(listUrl.searchParams.get('symbols')).toBe('ETHUSDT');
    });
    const href = screen.getByTestId('log-export-link').getAttribute('href') ?? '';
    const exportUrl = new URL(href, 'http://localhost');
    const listUrl = new URL(logsUrls(fetchMock).at(-1) ?? '', 'http://localhost');
    // A file that quietly widened or narrowed the filter is worse than no file:
    // the operator would draw conclusions from rows they never saw.
    for (const key of ['levels', 'symbols', 'from']) {
      expect(exportUrl.searchParams.get(key)).toBe(listUrl.searchParams.get(key));
    }
    expect(exportUrl.pathname).toMatch(/\/logs\/export$/);
  });

  it('pages forward with the served cursor and back without one', async () => {
    const { fetchMock } = setUp((url) =>
      new URL(url, 'http://localhost').searchParams.has('cursor')
        ? json({ items: [row({ msg: 'older row', id: OLDER_ID })], nextCursor: null })
        : json({ items: [row()], nextCursor: NEXT_CURSOR }),
    );
    await screen.findByText('entry evaluated');
    const user = userEvent.setup();
    await user.click(screen.getByRole('button', { name: /older/i }));

    expect(await screen.findByText('older row')).toBeInTheDocument();
    await waitFor(() => {
      const last = new URL(logsUrls(fetchMock).at(-1) ?? '', 'http://localhost');
      expect(last.searchParams.get('cursor')).toBe(NEXT_CURSOR);
    });
    expect(screen.getByText(/page 2/i)).toBeInTheDocument();

    await user.click(screen.getByRole('button', { name: /newer/i }));
    expect(await screen.findByText(/page 1/i)).toBeInTheDocument();
  });

  it('resets to page one when the filter changes, so a stale cursor is never reused', async () => {
    // A cursor is a position in one specific result set. Carrying it across a
    // filter change pages into rows the new filter never selected.
    const { fetchMock } = setUp((url) =>
      new URL(url, 'http://localhost').searchParams.has('cursor')
        ? json({ items: [row({ msg: 'older row', id: OLDER_ID })], nextCursor: null })
        : json({ items: [row()], nextCursor: NEXT_CURSOR }),
    );
    await screen.findByText('entry evaluated');
    const user = userEvent.setup();
    await user.click(screen.getByRole('button', { name: /older/i }));
    await screen.findByText('older row');

    await user.click(screen.getByTestId('log-level-error'));
    await waitFor(() => {
      const last = new URL(logsUrls(fetchMock).at(-1) ?? '', 'http://localhost');
      expect(last.searchParams.has('cursor')).toBe(false);
      expect(last.searchParams.get('levels')).toBe('error');
    });
  });

  it('explains an empty result instead of rendering a blank panel', async () => {
    setUp(() => json({ items: [], nextCursor: null }));
    expect(await screen.findByTestId('log-empty')).toHaveTextContent(/widen the time range/i);
  });

  it('surfaces a failed load rather than showing it as "no rows"', async () => {
    // These two look identical on a blank panel and mean opposite things.
    setUp(() => json({ error: { code: 'INTERNAL', message: 'reader unavailable' } }, 500));
    expect(await screen.findByText(/failed to load logs/i)).toBeInTheDocument();
    expect(screen.queryByTestId('log-empty')).not.toBeInTheDocument();
  });

  describe('deep capture', () => {
    it('arms with a duration and never a deadline', async () => {
      let body: Json | undefined;
      const { fetchMock } = setUp();
      const patched = vi.fn();
      fetchMock.mockImplementation(async (input: RequestInfo | URL, init?: RequestInit) => {
        const url = String(typeof input === 'string' ? input : (input as Request).url);
        if (url.includes('/logs/symbols')) return json({ symbols: [] });
        if (url.includes('/retention-config')) {
          if (init?.method === 'PATCH') {
            body = JSON.parse(String(init.body)) as Json;
            patched();
            return json({
              actionLogDays: 7,
              actionLogMaxRows: 200_000,
              auditLogDays: 90,
              auditStreamMaxlen: 100_000,
              debugCapture: { profileId: PROFILE_ID, until: '2026-08-01T11:00:00.000Z' },
              updatedAt: '2026-08-01T00:00:00.000Z',
            });
          }
          return json({
            actionLogDays: 7,
            actionLogMaxRows: 200_000,
            auditLogDays: 90,
            auditStreamMaxlen: 100_000,
            debugCapture: null,
            updatedAt: '2026-08-01T00:00:00.000Z',
          });
        }
        return json({ items: [row()], nextCursor: null });
      });

      const user = userEvent.setup();
      await user.click(await screen.findByTestId('deep-capture-arm'));
      await waitFor(() => expect(patched).toHaveBeenCalled());
      // The server owns the clock: sending a deadline from a skewed browser is
      // how an armed capture ends up never lapsing.
      expect(body).toEqual({ debugCapture: { profileId: PROFILE_ID, minutes: 60 } });
      expect(await screen.findByTestId('deep-capture-armed')).toBeInTheDocument();
    });

    it('says which profile is armed rather than silently overwriting it', async () => {
      // The worker reads a single armed profile id, so arming here would end
      // another investigation without saying so.
      setUp();
      const fetchMock = vi.fn(async (input: RequestInfo | URL) => {
        const url = String(typeof input === 'string' ? input : (input as Request).url);
        if (url.includes('/logs/symbols')) return json({ symbols: [] });
        if (url.includes('/retention-config')) {
          return json({
            actionLogDays: 7,
            actionLogMaxRows: 200_000,
            auditLogDays: 90,
            auditStreamMaxlen: 100_000,
            debugCapture: {
              profileId: '00000000-0000-4000-8000-0000000000b9',
              until: '2026-08-01T11:00:00.000Z',
            },
            updatedAt: '2026-08-01T00:00:00.000Z',
          });
        }
        return json({ items: [], nextCursor: null });
      });
      vi.stubGlobal('fetch', fetchMock);
      render(
        <QueryClientProvider client={createQueryClient()}>
          <LogViewerPanel profileId={PROFILE_ID} />
        </QueryClientProvider>,
      );
      const control = await screen.findAllByTestId('deep-capture-control');
      await waitFor(() =>
        expect(
          control.some((c) => within(c).queryByText(/another profile is being captured/i) !== null),
        ).toBe(true),
      );
    });
  });
});
