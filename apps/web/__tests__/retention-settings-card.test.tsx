// The one control that can delete history. What matters here is not that the
// numbers round-trip but that a *reduction* cannot happen by accident: shortening
// a horizon deletes everything older on the next sweep and there is no undo. The
// confirmation therefore has to name which horizon shrank and by how much, and
// declining it must send nothing at all.

import { render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { RetentionSettingsCard } from '@/features/account/components/retention-settings-card';
import { Toaster } from '@/shared/components/ui/sonner';

type Json = Record<string, unknown>;

const json = (body: Json, status = 200): Response =>
  new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } });

const config = (over: Partial<Json> = {}): Json => ({
  actionLogDays: 7,
  actionLogMaxRows: 200_000,
  auditLogDays: 90,
  auditStreamMaxlen: 100_000,
  debugCapture: null,
  updatedAt: new Date('2026-08-01T00:00:00Z').toISOString(),
  ...over,
});

const setUp = (responder: (url: string, init?: RequestInit) => Response | Promise<Response>) => {
  const fetchMock = vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
    const url =
      typeof input === 'string' ? input : input instanceof URL ? input.toString() : input.url;
    return responder(url, init);
  });
  vi.stubGlobal('fetch', fetchMock);
  // Save results land in the global Sonner toaster, not inline, so mount one
  // here as the app shell does or the assertions have nothing to find.
  return {
    fetchMock,
    ...render(
      <>
        <RetentionSettingsCard />
        <Toaster />
      </>,
    ),
  };
};

/** The PATCH bodies sent, in order. Empty means nothing was sent. */
const patches = (fetchMock: ReturnType<typeof vi.fn>): Json[] =>
  fetchMock.mock.calls
    .filter(([, init]) => (init as RequestInit | undefined)?.method === 'PATCH')
    .map(([, init]) => JSON.parse(String((init as RequestInit).body)) as Json);

describe('RetentionSettingsCard', () => {
  beforeEach(() => {
    vi.spyOn(console, 'error').mockImplementation(() => undefined);
  });
  afterEach(() => {
    vi.unstubAllGlobals();
    vi.restoreAllMocks();
  });

  it('loads the stored horizons into the form', async () => {
    setUp(() => json(config()));
    expect(await screen.findByLabelText(/keep action logs \(days\)/i)).toHaveValue(7);
    expect(screen.getByLabelText(/keep action logs \(rows per profile\)/i)).toHaveValue(200_000);
    expect(screen.getByLabelText(/keep audit logs/i)).toHaveValue(90);
    expect(screen.getByLabelText(/trace buffer/i)).toHaveValue(100_000);
  });

  it('surfaces a failed load instead of rendering defaults as if they were stored', async () => {
    // Showing 7/90 from a failed read would tell the operator their configured
    // horizon is something it is not.
    setUp(() => json({ error: { code: 'INTERNAL', message: 'db unreachable' } }, 500));
    expect(await screen.findByText(/could not load retention settings/i)).toBeInTheDocument();
    expect(screen.queryByLabelText(/keep action logs \(days\)/i)).not.toBeInTheDocument();
  });

  it('saves an increase without asking for confirmation', async () => {
    const confirm = vi.fn(() => true);
    vi.stubGlobal('confirm', confirm);
    const { fetchMock } = setUp((_url, init) =>
      json(init?.method === 'PATCH' ? config({ actionLogDays: 30 }) : config()),
    );
    const user = userEvent.setup();
    const field = await screen.findByLabelText(/keep action logs \(days\)/i);
    await user.clear(field);
    await user.type(field, '30');
    await user.click(screen.getByTestId('retention-save'));

    await waitFor(() => expect(patches(fetchMock)).toHaveLength(1));
    // Growing a horizon deletes nothing, so a prompt would be pure friction.
    expect(confirm).not.toHaveBeenCalled();
    expect(patches(fetchMock)[0]).toEqual({
      actionLogDays: 30,
      actionLogMaxRows: 200_000,
      auditLogDays: 90,
      auditStreamMaxlen: 100_000,
    });
    expect(await screen.findByText(/retention settings saved/i)).toBeInTheDocument();
  });

  it('names the specific loss when a horizon is shortened', async () => {
    const confirm = vi.fn(() => true);
    vi.stubGlobal('confirm', confirm);
    const { fetchMock } = setUp((_url, init) =>
      json(init?.method === 'PATCH' ? config({ actionLogDays: 3 }) : config()),
    );
    const user = userEvent.setup();
    const field = await screen.findByLabelText(/keep action logs \(days\)/i);
    await user.clear(field);
    await user.type(field, '3');
    await user.click(screen.getByTestId('retention-save'));

    await waitFor(() => expect(confirm).toHaveBeenCalled());
    const prompt = String(confirm.mock.calls[0]?.[0]);
    // A generic "are you sure" is the thing operators click through. The old and
    // new value both have to be in the prompt for it to carry information.
    expect(prompt).toContain('action logs 7d → 3d');
    expect(prompt).toMatch(/permanently/i);
    // The untouched horizon must not be listed as a loss.
    expect(prompt).not.toContain('audit logs');
    await waitFor(() => expect(patches(fetchMock)).toHaveLength(1));
  });

  it('treats a tightened row cap as a loss too, not just a shortened horizon', async () => {
    // The cap deletes rows on the same sweep as the age horizon, so confirming
    // only day changes would let the more destructive of the two edits — one
    // that can drop most of a busy profile's history at once — go through
    // unremarked.
    const confirm = vi.fn(() => true);
    vi.stubGlobal('confirm', confirm);
    setUp(() => json(config()));
    const user = userEvent.setup();
    const rows = await screen.findByLabelText(/keep action logs \(rows per profile\)/i);
    await user.clear(rows);
    await user.type(rows, '5000');
    await user.click(screen.getByTestId('retention-save'));

    await waitFor(() => expect(confirm).toHaveBeenCalled());
    const prompt = String(confirm.mock.calls[0]?.[0]);
    expect(prompt).toContain('action-log rows per profile 200,000 → 5,000');
    // The day horizon was not touched, so it is not a loss.
    expect(prompt).not.toContain('action logs 7d');
  });

  it('lists every horizon that shrank, not just the first', async () => {
    const confirm = vi.fn(() => true);
    vi.stubGlobal('confirm', confirm);
    setUp((_url, init) => json(init?.method === 'PATCH' ? config() : config()));
    const user = userEvent.setup();
    const action = await screen.findByLabelText(/keep action logs \(days\)/i);
    await user.clear(action);
    await user.type(action, '3');
    const audit = screen.getByLabelText(/keep audit logs/i);
    await user.clear(audit);
    await user.type(audit, '30');
    await user.click(screen.getByTestId('retention-save'));

    await waitFor(() => expect(confirm).toHaveBeenCalled());
    const prompt = String(confirm.mock.calls[0]?.[0]);
    expect(prompt).toContain('action logs 7d → 3d');
    expect(prompt).toContain('audit logs 90d → 30d');
  });

  it('sends nothing when the confirmation is declined', async () => {
    vi.stubGlobal(
      'confirm',
      vi.fn(() => false),
    );
    const { fetchMock } = setUp(() => json(config()));
    const user = userEvent.setup();
    const field = await screen.findByLabelText(/keep action logs \(days\)/i);
    await user.clear(field);
    await user.type(field, '1');
    await user.click(screen.getByTestId('retention-save'));

    // Nothing sent, and the typed value is left alone so the operator can
    // reconsider rather than retype.
    expect(patches(fetchMock)).toEqual([]);
    expect(screen.getByLabelText(/keep action logs \(days\)/i)).toHaveValue(1);
  });

  it.each([
    ['keep action logs \\(days\\)', '0', /between 1 and 365/i],
    ['keep action logs \\(days\\)', '366', /between 1 and 365/i],
    ['keep action logs \\(rows per profile\\)', '999', /between 1,000 and 10,000,000/i],
    ['keep action logs \\(rows per profile\\)', '10000001', /between 1,000 and 10,000,000/i],
    ['keep audit logs', '0', /between 1 and 365/i],
    ['trace buffer', '999', /between 1,000 and 5,000,000/i],
  ])('blocks Save on an out-of-range %s = %s', async (label, value, help) => {
    const { fetchMock } = setUp(() => json(config()));
    const user = userEvent.setup();
    const field = await screen.findByLabelText(new RegExp(label, 'i'));
    await user.clear(field);
    await user.type(field, value);

    expect(await screen.findByText(help)).toBeInTheDocument();
    expect(screen.getByTestId('retention-save')).toBeDisabled();
    expect(patches(fetchMock)).toEqual([]);
  });

  it('surfaces a server rejection without discarding what was typed', async () => {
    vi.stubGlobal(
      'confirm',
      vi.fn(() => true),
    );
    const { fetchMock } = setUp((_url, init) =>
      init?.method === 'PATCH'
        ? json({ error: { code: 'VALIDATION_FAILED', message: 'actionLogDays out of range' } }, 422)
        : json(config()),
    );
    const user = userEvent.setup();
    const field = await screen.findByLabelText(/keep action logs \(days\)/i);
    await user.clear(field);
    await user.type(field, '30');
    await user.click(screen.getByTestId('retention-save'));

    await waitFor(() => expect(patches(fetchMock)).toHaveLength(1));
    expect(await screen.findByText(/actionLogDays out of range/i)).toBeInTheDocument();
    expect(screen.getByLabelText(/keep action logs \(days\)/i)).toHaveValue(30);
  });
});
