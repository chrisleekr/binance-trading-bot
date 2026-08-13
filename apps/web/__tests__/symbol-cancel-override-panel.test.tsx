// SymbolCancelOverridePanel — the operator-facing revoke for a queued manual
// override. Arming an override and watching its outcome already have surfaces;
// revoking one had an API route and no caller, so an operator who armed by
// mistake could only wait it out.
//
// The three answers the route gives are three different sentences, and getting
// them wrong is worse than having no button at all:
//   204 — the row is gone, OR there never was one. The copy must not claim an
//         override existed, and it must be a success, not an error.
//   409 — a live claim holds the row. The cancel did not "break"; the bot is
//         mid-dispatch. That is information, not failure, and the outcome of the
//         claim being acted on is worth watching.
//   404 — wrong/unowned profile. That IS a failure, and it must never read as
//         "cancelled".

import { QueryClientProvider } from '@tanstack/react-query';
import { act, fireEvent, render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { SymbolCancelOverridePanel } from '../src/features/symbol/components/symbol-cancel-override-panel.js';
import { symbolOverrideActionQueryKey } from '../src/features/symbol/api/symbol.js';
import { setActiveAccountId } from '../src/shared/lib/account-scope.js';
import { createQueryClient } from '../src/shared/lib/query-client.js';

const success = vi.fn();
const error = vi.fn();
const info = vi.fn();
vi.mock('sonner', () => ({
  toast: {
    success: (m: string) => success(m),
    error: (m: string) => error(m),
    info: (m: string) => info(m),
  },
  Toaster: () => null,
}));

const ACCOUNT_ID = '00000000-0000-4000-8000-0000000000ac';
const PROFILE_ID = '4d2f9f4a-1c9c-4e5f-9a1d-3b6f7c8e0a2c';
const OVERRIDE_ID = '7c1e9b52-3a44-4d0f-b8c1-9e2f5a6d3b70';
/** The override the bot claimed — what a fresh read-back after a 409 returns. */
const CLAIMED_ID = '2b8d40f1-6c57-4a92-9f03-1d7e8c4b5a69';
/** Left on the query key by a sibling panel's poll before the cancel ran. */
const STALE_ID = 'f3a71c08-9d24-4e6b-8a51-0c9b2e7d4f36';
const SYMBOL = 'BTCUSDT';

// Spelled out, not composed from the helper under test: a hand-built URL in the
// component (one that skips `symbolPath`/`accountPath`) has to fail here.
const OVERRIDE_URL = `/api/accounts/${ACCOUNT_ID}/profiles/${PROFILE_ID}/symbols/${SYMBOL}/override`;

const CONFLICT_MESSAGE =
  'cancelled the queued override, but the bot is already acting on an earlier one for this symbol; wait for its outcome before re-issuing';

const AT = '2026-07-30T00:00:00.000Z';

/** A pending override row, shaped for `OverrideActionResponse`. */
const pendingRow = (id: string): unknown => ({
  id,
  symbol: SYMBOL,
  action: 'sell',
  actionAt: AT,
  payload: {},
  triggeredBy: 'user',
  processingAt: AT,
  consumedAt: null,
  outcome: null,
  createdAt: AT,
});

/** The same row after a tick settled it — no longer "active", so the route 204s. */
const settledRow = (id: string): unknown => ({
  ...(pendingRow(id) as Record<string, unknown>),
  processingAt: AT,
  consumedAt: AT,
  outcome: { status: 'applied', at: AT },
});

const json = (body: unknown, status = 200): Response =>
  new Response(JSON.stringify(body), {
    status,
    headers: { 'content-type': 'application/json' },
  });

const envelope = (status: number, code: string, message: string): Response =>
  json({ error: { code, message } }, status);

type Responder = (url: string, init?: RequestInit) => Response | Promise<Response>;

const setUp = (responder: Responder) => {
  const fetchMock = vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
    const url =
      typeof input === 'string' ? input : input instanceof URL ? input.toString() : input.url;
    return await responder(url, init);
  });
  vi.stubGlobal('fetch', fetchMock);
  const queryClient = createQueryClient();
  render(
    <QueryClientProvider client={queryClient}>
      <SymbolCancelOverridePanel profileId={PROFILE_ID} symbol={SYMBOL} />
    </QueryClientProvider>,
  );
  return { fetchMock, queryClient };
};

const deletesToOverride = (fetchMock: ReturnType<typeof vi.fn>): unknown[] =>
  fetchMock.mock.calls.filter(
    ([input, init]) =>
      String(input) === OVERRIDE_URL && (init as RequestInit | undefined)?.method === 'DELETE',
  );

const getsToOverride = (fetchMock: ReturnType<typeof vi.fn>): unknown[] =>
  fetchMock.mock.calls.filter(
    ([input, init]) =>
      String(input) === OVERRIDE_URL && (init as RequestInit | undefined)?.method !== 'DELETE',
  );

const openDialog = async (): Promise<HTMLElement> => {
  await userEvent.click(screen.getByTestId('symbol-cancel-override-open'));
  return await screen.findByTestId('symbol-cancel-override-confirm');
};

const openAndConfirm = async (): Promise<void> => {
  const confirm = await openDialog();
  await userEvent.click(confirm);
};

beforeEach(() => {
  success.mockClear();
  error.mockClear();
  info.mockClear();
  // Pins the account segment of OVERRIDE_URL rather than inheriting the suite default.
  setActiveAccountId(ACCOUNT_ID);
});

afterEach(() => {
  vi.unstubAllGlobals();
});

describe('SymbolCancelOverridePanel', () => {
  it('offers the cancel as a visible button, not an entry behind an overflow menu', () => {
    setUp(() => new Response(null, { status: 204 }));
    const open = screen.getByTestId('symbol-cancel-override-open');
    expect(open).toBeVisible();
    expect(open.tagName).toBe('BUTTON');
    // Nothing to expand first: an override the operator wants gone is an
    // emergency action, so it may not hide one interaction deeper.
    expect(screen.queryByRole('menu')).not.toBeInTheDocument();
    expect(screen.queryByRole('menuitem')).not.toBeInTheDocument();
  });

  it('renders the confirm inside the shared Dialog and FormActions primitives', async () => {
    setUp(() => new Response(null, { status: 204 }));
    const confirm = await openDialog();

    const dialog = screen.getByRole('dialog');
    expect(dialog).toContainElement(confirm);
    // Radix's AlertDialog would expose role=alertdialog; the repo convention is Dialog.
    expect(screen.queryByRole('alertdialog')).not.toBeInTheDocument();
    // FormActions owns exactly this footer row, so a bespoke layout fails here.
    expect(confirm.parentElement).toHaveClass('flex', 'flex-wrap', 'justify-end', 'gap-2');
  });

  it('confirm DELETEs the account-scoped override path exactly once', async () => {
    const { fetchMock } = setUp(() => new Response(null, { status: 204 }));
    await openAndConfirm();

    await waitFor(() => expect(success).toHaveBeenCalled());
    expect(deletesToOverride(fetchMock)).toHaveLength(1);
    expect(fetchMock).toHaveBeenCalledWith(
      OVERRIDE_URL,
      expect.objectContaining({ method: 'DELETE' }),
    );
  });

  it('reports a 204 without claiming an override existed', async () => {
    setUp(() => new Response(null, { status: 204 }));
    await openAndConfirm();

    await waitFor(() => expect(success).toHaveBeenCalledTimes(1));
    expect(success).toHaveBeenCalledWith(
      `Cancelled any override that was still waiting on ${SYMBOL}.`,
    );
    // 204 also means "there was nothing queued", so the copy may not assert a
    // deletion the operator never made…
    expect(String(success.mock.calls[0]?.[0])).not.toMatch(
      /cancelled the override|override cancelled/i,
    );
    // …and it may not assert the queue is empty either: the route also answers 204
    // when a NEWER unclaimed override landed after the delete, in which case
    // something IS waiting.
    expect(String(success.mock.calls[0]?.[0])).not.toMatch(/nothing is|no override is|is waiting/i);
  });

  it('parses an empty 204 body without a PARSE_FAILED error', async () => {
    setUp(() => new Response(null, { status: 204 }));
    await openAndConfirm();

    await waitFor(() => expect(success).toHaveBeenCalled());
    expect(error).not.toHaveBeenCalled();
    expect(info).not.toHaveBeenCalled();
    const shown = [...success.mock.calls, ...error.mock.calls, ...info.mock.calls].map(([m]) =>
      String(m),
    );
    expect(shown.some((m) => m.includes('PARSE_FAILED'))).toBe(false);
  });

  it('surfaces a 409 as the server sentence on a non-failure notice', async () => {
    setUp((_url, init) => {
      if (init?.method === 'DELETE') return envelope(409, 'CONFLICT', CONFLICT_MESSAGE);
      return json(null);
    });
    await openAndConfirm();

    await waitFor(() => expect(info).toHaveBeenCalledTimes(1));
    // Verbatim: the server's prose is the only place that knows whether a queued
    // row was deleted alongside the live claim. No `CONFLICT: ` code prefix.
    expect(info).toHaveBeenCalledWith(CONFLICT_MESSAGE);
    expect(error).not.toHaveBeenCalled();
  });

  it('starts watching the outcome of the override a 409 reads back', async () => {
    const { fetchMock } = setUp((_url, init) => {
      if (init?.method === 'DELETE') return envelope(409, 'CONFLICT', CONFLICT_MESSAGE);
      return json(pendingRow(OVERRIDE_ID));
    });
    await openAndConfirm();

    // One read-back to learn the id the 409 body does not carry…
    await waitFor(() => expect(getsToOverride(fetchMock).length).toBeGreaterThanOrEqual(1));
    // …then the outcome watch polls it, so the operator learns what the claim did.
    await waitFor(() => expect(getsToOverride(fetchMock).length).toBeGreaterThanOrEqual(2));
    expect(error).not.toHaveBeenCalled();
  });

  it('shows a 409 with no active row and starts no watch with a missing id', async () => {
    const { fetchMock } = setUp((_url, init) => {
      if (init?.method === 'DELETE') return envelope(409, 'CONFLICT', CONFLICT_MESSAGE);
      return json(null);
    });
    await openAndConfirm();

    await waitFor(() => expect(info).toHaveBeenCalledWith(CONFLICT_MESSAGE));
    // The watch polls every 2s, so a watch armed with a missing id would have
    // issued a second GET (or thrown) by now. Real time, not fake: the read-back
    // resolves asynchronously, so switching to fake timers here would race it and
    // could leave a real interval armed that no virtual advance ever fires,
    // making the assertion vacuous. A slow runner only lengthens the window,
    // which can expose a stray poll but never invent one.
    await new Promise((resolve) => setTimeout(resolve, 2_600));
    expect(getsToOverride(fetchMock)).toHaveLength(1);
    expect(error).not.toHaveBeenCalled();
  });

  it('reports a 404 as a failure and never as a cancellation', async () => {
    setUp(() => envelope(404, 'NOT_FOUND', 'profile not found'));
    await openAndConfirm();

    await waitFor(() => expect(error).toHaveBeenCalledTimes(1));
    const shown = String(error.mock.calls[0]?.[0]);
    expect(shown).toContain('NOT_FOUND');
    expect(shown).toContain('profile not found');
    expect(success).not.toHaveBeenCalled();
    expect(info).not.toHaveBeenCalled();
  });

  it('issues one DELETE when the operator double-clicks confirm', async () => {
    const { fetchMock } = setUp(() => new Response(null, { status: 204 }));
    const confirm = await openDialog();

    // Same tick, so `isPending` has not re-rendered yet — only a synchronous
    // guard can stop the second dispatch.
    await act(async () => {
      fireEvent.click(confirm);
      fireEvent.click(confirm);
    });

    await waitFor(() => expect(success).toHaveBeenCalled());
    expect(deletesToOverride(fetchMock)).toHaveLength(1);
  });

  it('disables and relabels the confirm while the DELETE is in flight', async () => {
    setUp(() => new Promise<Response>(() => undefined));
    const confirm = await openDialog();
    const idleLabel = confirm.textContent;

    await userEvent.click(confirm);

    await waitFor(() =>
      expect(screen.getByTestId('symbol-cancel-override-confirm')).toBeDisabled(),
    );
    expect(screen.getByTestId('symbol-cancel-override-confirm').textContent).not.toBe(idleLabel);
  });

  it('re-reads the override from the network after a 409 even when the cache is warm', async () => {
    const { fetchMock, queryClient } = setUp((_url, init) => {
      if (init?.method === 'DELETE') return envelope(409, 'CONFLICT', CONFLICT_MESSAGE);
      return json(pendingRow(CLAIMED_ID));
    });
    // A sibling panel's outcome poll left a row on this key. The app-wide
    // `staleTime: Infinity` would serve it back with no request — and it can be
    // the very row this cancel just deleted, which would arm a watch that never
    // matches and ends in a "could not confirm" toast about a successful cancel.
    queryClient.setQueryData(
      symbolOverrideActionQueryKey(PROFILE_ID, SYMBOL),
      pendingRow(STALE_ID),
    );
    await openAndConfirm();

    await waitFor(() => expect(info).toHaveBeenCalledWith(CONFLICT_MESSAGE));
    // The read-back went to the network despite the warm key.
    expect(getsToOverride(fetchMock).length).toBeGreaterThanOrEqual(1);
    // And the watch follows the FRESH row: it keeps polling. Had it armed on the
    // stale id, the identity check would have stopped it after one poll.
    await waitFor(() => expect(getsToOverride(fetchMock).length).toBeGreaterThanOrEqual(3));
    expect(error).not.toHaveBeenCalled();
  });

  it('keeps the outcome watch on a 204 so a row that just settled still reports', async () => {
    let latest: unknown = pendingRow(CLAIMED_ID);
    let raceLost = true;
    const { fetchMock } = setUp((_url, init) => {
      if (init?.method === 'DELETE') {
        return raceLost
          ? envelope(409, 'CONFLICT', CONFLICT_MESSAGE)
          : new Response(null, { status: 204 });
      }
      return json(latest);
    });

    // First cancel loses the race, so the claimed override gets watched.
    await openAndConfirm();
    await waitFor(() => expect(info).toHaveBeenCalledWith(CONFLICT_MESSAGE));

    // A tick settles it. A consumed row is not "active", so the route now answers
    // 204 — and dropping the watch here would bury the outcome the operator is
    // waiting for behind a "cancelled" notice.
    latest = settledRow(CLAIMED_ID);
    raceLost = false;
    await openAndConfirm();

    await waitFor(() => expect(success).toHaveBeenCalledWith('Your action went through.'));
    expect(fetchMock).toHaveBeenCalled();
  });

  it("keeps the server's 409 sentence as the last word and arms no watch when the read-back fails", async () => {
    // Scoped to what this can actually observe. The `.catch` on the read-back is
    // belt-and-braces: `useMutation` already swallows a rejection thrown from
    // `onError`, so removing it would not fail this test. What IS pinned is the
    // operator-visible contract — the 409 prose stands alone, nothing overwrites
    // it with a generic failure, and no watch starts polling on a row it never got.
    const { fetchMock } = setUp((_url, init) => {
      if (init?.method === 'DELETE') return envelope(409, 'CONFLICT', CONFLICT_MESSAGE);
      return envelope(500, 'INTERNAL', 'read-back exploded');
    });
    await openAndConfirm();

    await waitFor(() => expect(info).toHaveBeenCalledWith(CONFLICT_MESSAGE));
    // `retry: false` makes the read-back a single attempt, so one poll interval is
    // enough to prove nothing followed it.
    const attempted = getsToOverride(fetchMock).length;
    expect(attempted).toBe(1);
    await new Promise((resolve) => setTimeout(resolve, 2_600));
    expect(getsToOverride(fetchMock)).toHaveLength(attempted);
    expect(info).toHaveBeenCalledTimes(1);
    expect(error).not.toHaveBeenCalled();
    expect(success).not.toHaveBeenCalled();
  });

  it("invalidates the symbol's override-action query when the cancel lands", async () => {
    const { queryClient } = setUp(() => new Response(null, { status: 204 }));
    const invalidate = vi.spyOn(queryClient, 'invalidateQueries');
    await openAndConfirm();

    await waitFor(() =>
      expect(invalidate).toHaveBeenCalledWith(
        expect.objectContaining({
          queryKey: [...symbolOverrideActionQueryKey(PROFILE_ID, SYMBOL)],
        }),
      ),
    );
  });
});
