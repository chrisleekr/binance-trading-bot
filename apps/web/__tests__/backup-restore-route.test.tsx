import { QueryClientProvider } from '@tanstack/react-query';
import {
  createMemoryHistory,
  createRoute,
  createRouter,
  RouterProvider,
} from '@tanstack/react-router';
import { render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { createQueryClient } from '@/shared/lib/query-client';
import { rootRoute } from '@/app/__root';
import { backupRestoreRoute } from '@/features/account/routes/settings.backup-restore';

// Matches the global test-setup default active account; the aggregate cache is
// keyed by it, so LiveProfileProvider reads the same key it would at runtime.
const ACCOUNT_ID = '00000000-0000-4000-8000-0000000000ac';

interface TestProfile {
  readonly id: string;
  readonly name: string;
}

const json = (body: unknown, status = 200): Response =>
  new Response(JSON.stringify(body), {
    status,
    headers: { 'content-type': 'application/json' },
  });

const stub = (path: string) =>
  createRoute({ getParentRoute: () => rootRoute, path, component: () => null });

const setUp = (
  profiles: readonly TestProfile[],
  responder: (url: string, init?: RequestInit) => Response | Promise<Response>,
) => {
  const fetchMock = vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
    const url =
      typeof input === 'string' ? input : input instanceof URL ? input.toString() : input.url;
    return responder(url, init);
  });
  vi.stubGlobal('fetch', fetchMock);
  const queryClient = createQueryClient();
  queryClient.setQueryData(['auth', 'onboarding-status'], { masterExists: true });
  // Seed the dashboard-aggregate cache the LiveProfileProvider reads from so the
  // profile roster derives from the same source the runtime uses.
  queryClient.setQueryData(['dashboard-aggregate', ACCOUNT_ID], {
    profiles: profiles.map((p) => ({
      profileId: p.id,
      name: p.name,
    })),
  });
  const indexStub = stub('/');
  const onboardingStub = stub('/onboarding');
  const loginStub = stub('/login');
  const settingsStub = stub('/settings');
  const router = createRouter({
    routeTree: rootRoute.addChildren([
      indexStub,
      onboardingStub,
      loginStub,
      settingsStub,
      backupRestoreRoute,
    ]),
    context: { queryClient },
    history: createMemoryHistory({ initialEntries: ['/settings/backup-restore'] }),
  });
  const utils = render(
    <QueryClientProvider client={queryClient}>
      <RouterProvider
        router={router as unknown as Parameters<typeof RouterProvider>[0]['router']}
      />
    </QueryClientProvider>,
  );
  return { fetchMock, ...utils };
};

const liveOnly: readonly TestProfile[] = [{ id: 'p1', name: 'Live' }];

describe('BackupRestorePage', () => {
  beforeEach(() => {
    vi.spyOn(console, 'error').mockImplementation(() => undefined);
  });
  afterEach(() => {
    vi.unstubAllGlobals();
    vi.restoreAllMocks();
  });

  it('renders the plaintext-keys reminder banner', async () => {
    setUp(liveOnly, () => json({}));
    expect(await screen.findByText(/plaintext api keys/i)).toBeInTheDocument();
  });

  it('explains download and restore in plain language, not pg_dump jargon', async () => {
    setUp(liveOnly, () => json({}));
    await screen.findByRole('heading', { name: /backup & restore/i });
    const text = document.body.textContent ?? '';
    expect(text).not.toContain('pg_dump');
    // Download says what the file contains; restore warns it overwrites + is irreversible.
    expect(text).toMatch(/every profile, API key, strategy config, and trade history/i);
    expect(text).toMatch(/overwrites your current state and cannot be undone/i);
  });

  it('keeps the submit button disabled until a file is chosen and RESTORE is typed', async () => {
    setUp(liveOnly, () => json({}));
    await screen.findByRole('heading', { name: /backup & restore/i });
    const submit = screen.getByRole('button', { name: /^restore$/i });
    expect(submit).toBeDisabled();
    const user = userEvent.setup();
    const file = new File(['dump-bytes'], 'app.dump', { type: 'application/octet-stream' });
    await user.upload(screen.getByLabelText('Backup archive file') as HTMLInputElement, file);
    expect(submit).toBeDisabled();
    await user.type(screen.getByLabelText(/type restore to confirm/i), 'restore');
    // Lower-case input is upper-cased on change; submit should now enable.
    await waitFor(() => {
      expect(submit).not.toBeDisabled();
    });
  });

  it('on submit, posts the archive as multipart and shows the success banner', async () => {
    let captured: { method?: string; body?: unknown; url?: string } = {};
    const { fetchMock } = setUp(liveOnly, async (url, init) => {
      if (url.endsWith('/api/restore') && init?.method === 'POST') {
        captured = { method: init.method, body: init.body, url };
        return json({ tablesRestored: 12, durationMs: 1234 });
      }
      return json({}, 404);
    });
    await screen.findByRole('heading', { name: /backup & restore/i });
    const user = userEvent.setup();
    const file = new File(['dump-bytes'], 'app.dump', { type: 'application/octet-stream' });
    await user.upload(screen.getByLabelText('Backup archive file') as HTMLInputElement, file);
    await user.type(screen.getByLabelText(/type restore to confirm/i), 'restore');
    await user.click(screen.getByRole('button', { name: /^restore$/i }));
    await waitFor(() => {
      expect(fetchMock).toHaveBeenCalled();
    });
    expect(captured.method).toBe('POST');
    expect(captured.body).toBeInstanceOf(FormData);
    expect(await screen.findByText(/restore complete/i)).toBeInTheDocument();
  });
});
