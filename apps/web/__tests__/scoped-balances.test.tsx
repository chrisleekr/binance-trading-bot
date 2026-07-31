// ScopedBalances — the per-profile wallet readout in the scoped overview (moved
// here from the deleted BALANCES dock). Asserts the error branch never sits on
// an endless "Loading…" — the same safety the deleted dock-balances test held.

import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { render, screen } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { ScopedBalances } from '@/features/dashboard/components/scoped-balances';

const PID = '00000000-0000-4000-8000-0000000000c1';

afterEach(() => {
  vi.unstubAllGlobals();
});

beforeEach(() => {
  vi.spyOn(console, 'error').mockImplementation(() => undefined);
});

describe('<ScopedBalances>', () => {
  it('surfaces an error instead of an endless loading state when the read fails', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn(async () => new Response(null, { status: 500 })),
    );
    const qc = new QueryClient({ defaultOptions: { queries: { retry: false } } });
    render(
      <QueryClientProvider client={qc}>
        <ScopedBalances profileId={PID} />
      </QueryClientProvider>,
    );
    expect(await screen.findByTestId('scoped-balances-error')).toBeInTheDocument();
  });
});
