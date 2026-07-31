// TechnicalsHealthPill — tier-aware label and tooltip.

import { QueryClientProvider } from '@tanstack/react-query';
import { render, screen, waitFor } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';

import { TechnicalsHealthPill } from '../src/features/technicals/components/technicals-health-pill.js';
import { createQueryClient } from '../src/shared/lib/query-client.js';

import type { TechnicalsFetchStatus } from '@app/contracts';

// Wall-clock epoch big enough that even a multi-hour `lastFreshAtMs` delta
// stays nonnegative (schema's `z.number().int().nonnegative()` rejects negatives).
const FROZEN_NOW = 1_700_000_000_000;

const baseRow = (override: Partial<TechnicalsFetchStatus>): TechnicalsFetchStatus => ({
  interval: '1m',
  fetchedAtMs: FROZEN_NOW,
  requested: 1,
  written: 1,
  skippedErrored: 0,
  skippedInvalid: 0,
  latencyMs: 5,
  lastFreshAtMs: null,
  error: null,
  ...override,
});

const renderPill = (intervals: TechnicalsFetchStatus[]): void => {
  vi.stubGlobal(
    'fetch',
    vi.fn(
      async () =>
        new Response(JSON.stringify({ intervals }), {
          status: 200,
          headers: { 'content-type': 'application/json' },
        }),
    ),
  );
  render(
    <QueryClientProvider client={createQueryClient()}>
      <TechnicalsHealthPill clock={() => FROZEN_NOW} />
    </QueryClientProvider>,
  );
};

afterEach(() => vi.unstubAllGlobals());

describe('TechnicalsHealthPill — tier-aware label', () => {
  it('labels a total outage as "technicals outage" with the danger tone class', async () => {
    renderPill([baseRow({ written: 0, skippedErrored: 1, error: 'all 1 rows failed: HTTP 429' })]);
    await waitFor(() => {
      const pill = screen.getByTestId('tv-technicals-health');
      expect(pill).toHaveTextContent(/technicals outage/);
      // Must reference the project's --danger red token, matching the
      // sibling warning/success branches' semantic text-* form; the
      // shadcn-default text-destructive is not the convention here.
      expect(pill.className).toMatch(/text-danger/);
    });
  });

  it('labels a partial degradation as "technicals degraded"', async () => {
    renderPill([
      baseRow({ written: 0, skippedErrored: 1, error: 'all 1 rows failed: HTTP 429' }),
      baseRow({ interval: '1h' }),
    ]);
    await waitFor(() =>
      expect(screen.getByTestId('tv-technicals-health')).toHaveTextContent(/technicals degraded\b/),
    );
  });

  it('keeps the bare "technicals" label when fully healthy', async () => {
    renderPill([baseRow({})]);
    await waitFor(() => {
      const pill = screen.getByTestId('tv-technicals-health');
      expect(pill).toHaveTextContent(/●\s+technicals\s+0s\s+ago/);
      expect(pill).not.toHaveTextContent(/outage|degraded/);
    });
  });

  it('appends "(last fresh Xm ago)" to the tooltip when an interval has both an error and a known lastFreshAtMs', async () => {
    renderPill([
      baseRow({
        written: 0,
        skippedErrored: 1,
        error: 'Binance klines: HTTP 429',
        lastFreshAtMs: FROZEN_NOW - 7 * 60_000,
      }),
    ]);
    await waitFor(() => {
      const pill = screen.getByTestId('tv-technicals-health');
      // `title` attribute carries the per-interval breakdown.
      expect(pill.getAttribute('title')).toMatch(/last fresh 7m ago/);
    });
  });

  it('renders "technicals silent" when no intervals are reported', async () => {
    renderPill([]);
    await waitFor(() =>
      expect(screen.getByTestId('tv-technicals-health')).toHaveTextContent(/technicals silent/),
    );
  });

  it('renders "· fresh Nm ago" inline on the headline for the degraded tier', async () => {
    renderPill([
      baseRow({
        written: 0,
        skippedErrored: 1,
        error: 'Binance klines: HTTP 429',
        lastFreshAtMs: FROZEN_NOW - 4 * 60_000,
      }),
    ]);
    await waitFor(() => {
      const pill = screen.getByTestId('tv-technicals-health');
      expect(pill).toHaveTextContent(/· fresh 4m ago/);
    });
  });

  it('flips to "· never fresh" on a cold-start outage with no recorded lastFreshAtMs', async () => {
    renderPill([
      baseRow({
        written: 0,
        skippedErrored: 1,
        error: 'Binance klines: HTTP 500',
        lastFreshAtMs: null,
      }),
    ]);
    await waitFor(() =>
      expect(screen.getByTestId('tv-technicals-health')).toHaveTextContent(/· never fresh/),
    );
  });
});

// The pure `formatFreshAge` assertions moved to format-time.test.ts (folded into
// the `humaniseAge` suite that replaced it). The pill's rendered "fresh N ago"
// suffix is still covered by the tier tests above.
