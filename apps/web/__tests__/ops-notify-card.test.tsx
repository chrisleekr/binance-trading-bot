// OpsNotifyCard — the account-global ops alert toggles on the Account page.

import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { fireEvent, render, screen, waitFor } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';

import { OpsNotifyCard } from '@/features/account/components/ops-notify-card';

const json = (data: unknown): Response =>
  new Response(JSON.stringify(data), {
    status: 200,
    headers: { 'content-type': 'application/json' },
  });

const setUp = (responder: (url: string, init?: RequestInit) => Response): void => {
  vi.stubGlobal(
    'fetch',
    vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
      const url =
        typeof input === 'string' ? input : input instanceof URL ? input.toString() : input.url;
      return responder(url, init);
    }),
  );
  const qc = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  render(
    <QueryClientProvider client={qc}>
      <OpsNotifyCard />
    </QueryClientProvider>,
  );
};

afterEach(() => {
  vi.unstubAllGlobals();
});

describe('<OpsNotifyCard>', () => {
  it('renders the job-failed toggle and PATCHes the full map on toggle', async () => {
    const patches: unknown[] = [];
    setUp((url, init) => {
      if (url.endsWith('/account/ops-notify')) {
        if (init?.method === 'PATCH') {
          patches.push(JSON.parse(init.body as string));
          return json({ 'job-failed': false });
        }
        return json({ 'job-failed': true });
      }
      return new Response(null, { status: 404 });
    });

    const toggle = await screen.findByTestId('ops-event-job-failed');
    expect(screen.getByText(/Background job failed/i)).toBeInTheDocument();
    fireEvent.click(toggle);

    await waitFor(() => expect(patches).toHaveLength(1));
    expect(patches[0]).toMatchObject({ 'job-failed': false });
  });
});
