// ConfigDiagnostics — advisory config-lint banner above the config form.

import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { render, screen, waitFor } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { ConfigDiagnostics } from '@/features/profile/components/config-diagnostics';

import type { ConfigLintResponse } from '@app/contracts';

const json = (data: unknown, status = 200): Response =>
  new Response(JSON.stringify(data), { status, headers: { 'content-type': 'application/json' } });

const setUp = (response: ConfigLintResponse | { status: number }): void => {
  vi.stubGlobal(
    'fetch',
    vi.fn(async (input: RequestInfo | URL) => {
      const url =
        typeof input === 'string' ? input : input instanceof URL ? input.toString() : input.url;
      if (url.includes('/lint-config')) {
        return 'status' in response ? json({}, response.status) : json(response);
      }
      return new Response(null, { status: 404 });
    }),
  );
  const qc = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  render(
    <QueryClientProvider client={qc}>
      <ConfigDiagnostics profileId="p-1" config={{ buy: {} }} />
    </QueryClientProvider>,
  );
};

afterEach(() => {
  vi.unstubAllGlobals();
});

describe('<ConfigDiagnostics>', () => {
  // Silenced here so the duplicate-key case below can read React's warnings off
  // the spy; restored centrally, since a failing assertion would otherwise leave
  // console.error muted for the rest of the file.
  let errorSpy: ReturnType<typeof vi.spyOn<Console, 'error'>>;
  beforeEach(() => {
    errorSpy = vi.spyOn(console, 'error').mockImplementation(() => undefined);
  });
  afterEach(() => vi.restoreAllMocks());

  it('renders each diagnostic message when the lint returns findings', async () => {
    setUp({
      diagnostics: [
        {
          level: 'warn',
          code: 'entry-sizing-ignored-in-grid',
          message: 'Entry sizing is ignored because a grid ladder is configured.',
          path: ['buy', 'entrySizing'],
        },
      ],
    });
    expect(
      await screen.findByTestId('config-diagnostic-warn-entry-sizing-ignored-in-grid-0'),
    ).toHaveTextContent(/entry sizing is ignored/i);
  });

  it('renders two findings that share a code as separate entries', async () => {
    // Per-symbol findings repeat one code across a multi-symbol basket. Keying
    // the list by code alone collapses them in React's reconciler and hides all
    // but one unchecked symbol from the operator.
    setUp({
      diagnostics: [
        {
          level: 'warn',
          code: 'filters-unavailable',
          message: 'BTCUSDT: trading rules are not loaded, order sizing was not verified.',
        },
        {
          level: 'warn',
          code: 'filters-unavailable',
          message: 'ETHUSDT: trading rules are not loaded, order sizing was not verified.',
        },
      ],
    });
    await screen.findByTestId('config-diagnostics');
    expect(
      errorSpy.mock.calls.filter((args) => args.some((a) => /same key/i.test(String(a)))),
    ).toHaveLength(0);
    expect(screen.getByTestId('config-diagnostic-warn-filters-unavailable-0')).toHaveTextContent(
      /BTCUSDT/,
    );
    expect(screen.getByTestId('config-diagnostic-warn-filters-unavailable-1')).toHaveTextContent(
      /ETHUSDT/,
    );
  });

  it('renders a block-level finding in the danger banner', async () => {
    setUp({
      diagnostics: [
        {
          level: 'block',
          code: 'grid-underfunded',
          message: 'BTCUSDT: This grid needs 75 in total but the balance is 50.',
          path: ['buy', 'gridLevels'],
        },
      ],
    });
    expect(await screen.findByTestId('config-diagnostics-block')).toHaveTextContent(
      /grid needs 75/i,
    );
  });

  it('renders nothing when there are no diagnostics', async () => {
    setUp({ diagnostics: [] });
    // Give the query a tick to resolve, then assert the banner is absent.
    await waitFor(() => expect(screen.queryByTestId('config-diagnostics')).toBeNull());
  });

  it('renders nothing (no error surface) when the lint call fails', async () => {
    setUp({ status: 500 });
    await waitFor(() => expect(screen.queryByTestId('config-diagnostics')).toBeNull());
  });
});
