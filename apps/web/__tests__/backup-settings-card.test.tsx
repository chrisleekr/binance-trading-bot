import { render, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { BackupSettingsCard } from '@/features/account/components/backup-settings-card';
import { Toaster } from '@/shared/components/ui/sonner';

type Json = Record<string, unknown>;

const json = (body: Json, status = 200): Response =>
  new Response(JSON.stringify(body), {
    status,
    headers: { 'content-type': 'application/json' },
  });

const errorEnvelope = (message: string, details: unknown = undefined): Response =>
  json({ error: { code: 'VALIDATION_FAILED', message, details } }, 422);

const isoAgo = (ms: number): string => new Date(Date.now() - ms).toISOString();
const isoAhead = (ms: number): string => new Date(Date.now() + ms).toISOString();

const fullConfig = (over: Partial<Json> = {}): Json => ({
  enabled: true,
  intervalHours: 6,
  retentionCount: 5,
  lastBackupAt: isoAgo(60 * 60 * 1000),
  nextDueAt: isoAhead(5 * 60 * 60 * 1000),
  recentBackups: [
    { name: 'backup-2026-06-20.dump', sizeBytes: 1048576, modifiedAt: isoAgo(60 * 60 * 1000) },
  ],
  ...over,
});

const setUp = (responder: (url: string, init?: RequestInit) => Response | Promise<Response>) => {
  const fetchMock = vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
    const url =
      typeof input === 'string' ? input : input instanceof URL ? input.toString() : input.url;
    return responder(url, init);
  });
  vi.stubGlobal('fetch', fetchMock);
  // The card surfaces success/error via Sonner; mount a Toaster so those
  // toasts land in the DOM for the assertions, mirroring the app shell.
  const utils = render(
    <>
      <BackupSettingsCard />
      <Toaster />
    </>,
  );
  return { fetchMock, ...utils };
};

describe('BackupSettingsCard', () => {
  beforeEach(() => {
    vi.spyOn(console, 'error').mockImplementation(() => undefined);
  });
  afterEach(() => {
    vi.unstubAllGlobals();
    vi.restoreAllMocks();
  });

  it('loads and renders status, form values, and the backup file', async () => {
    setUp(() => json(fullConfig()));
    // Toggle reflects enabled:true.
    const toggle = await screen.findByRole('switch', { name: /make backups automatically/i });
    expect(toggle).toBeChecked();
    // Form values from the config.
    expect(screen.getByLabelText(/run every/i)).toHaveValue(6);
    expect(screen.getByLabelText(/keep/i)).toHaveValue(5);
    // Status line: last backup relative age. Scope to the row — the recent-
    // backup cell also reads "1h ago", so a global query would be ambiguous.
    const lastRow = screen.getByText(/last backup/i).closest('div');
    expect(lastRow).not.toBeNull();
    expect(within(lastRow as HTMLElement).getByText(/1h ago/)).toBeInTheDocument();
    // The on-disk dump appears in the recent list.
    expect(screen.getByText('backup-2026-06-20.dump')).toBeInTheDocument();
  });

  it('renders the empty + never states', async () => {
    setUp(() => json(fullConfig({ recentBackups: [], lastBackupAt: null, enabled: false })));
    await screen.findByText(/no backups yet/i);
    // Last backup "never".
    const lastRow = screen.getByText(/last backup/i).closest('div');
    expect(lastRow).not.toBeNull();
    expect(within(lastRow as HTMLElement).getByText(/never/i)).toBeInTheDocument();
  });

  it('saves an edited interval via PUT and surfaces success', async () => {
    let putBody: Json | undefined;
    const { fetchMock } = setUp((url, init) => {
      if (url.includes('/backup/config') && init?.method === 'PUT') {
        putBody = JSON.parse(String(init.body)) as Json;
        return json(fullConfig({ intervalHours: 12 }));
      }
      return json(fullConfig());
    });
    const user = userEvent.setup();
    const interval = await screen.findByLabelText(/run every/i);
    await user.clear(interval);
    await user.type(interval, '12');
    await user.click(screen.getByRole('button', { name: /save backup settings/i }));
    await waitFor(() => {
      expect(
        fetchMock.mock.calls.some(
          ([u, i]) => String(u).includes('/backup/config') && (i as RequestInit)?.method === 'PUT',
        ),
      ).toBe(true);
    });
    expect(putBody).toEqual({ enabled: true, intervalHours: 12, retentionCount: 5 });
    expect(await screen.findByText(/backup settings saved/i)).toBeInTheDocument();
  });

  it('disables Save on an out-of-range interval and shows inline help', async () => {
    const { fetchMock } = setUp(() => json(fullConfig()));
    const user = userEvent.setup();
    const interval = await screen.findByLabelText(/run every/i);
    await user.clear(interval);
    await user.type(interval, '0');
    expect(await screen.findByText(/between 1 and 8760/i)).toBeInTheDocument();
    const save = screen.getByRole('button', { name: /save backup settings/i });
    expect(save).toBeDisabled();
    // No PUT fired.
    expect(fetchMock.mock.calls.some(([, i]) => (i as RequestInit)?.method === 'PUT')).toBe(false);
  });

  it('surfaces a server 422 in the banner without clobbering form state', async () => {
    const { fetchMock } = setUp((url, init) => {
      if (url.includes('/backup/config') && init?.method === 'PUT') {
        return errorEnvelope('intervalHours out of range');
      }
      return json(fullConfig());
    });
    const user = userEvent.setup();
    // Valid-by-client value the server still rejects (e.g. a backend-only rule).
    const interval = await screen.findByLabelText(/run every/i);
    await user.clear(interval);
    await user.type(interval, '7');
    await user.click(screen.getByRole('button', { name: /save backup settings/i }));
    await waitFor(() => {
      expect(fetchMock.mock.calls.some(([, i]) => (i as RequestInit)?.method === 'PUT')).toBe(true);
    });
    expect(await screen.findByText(/intervalHours out of range/i)).toBeInTheDocument();
    // The field the operator typed is preserved, not silently reset.
    expect(screen.getByLabelText(/run every/i)).toHaveValue(7);
  });
});
