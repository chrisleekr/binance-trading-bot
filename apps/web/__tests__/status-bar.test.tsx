import { afterEach, describe, expect, it, vi } from 'vitest';
import { render, screen } from '@testing-library/react';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';

import type { StatusResponse } from '@app/contracts';

import { StatusBar, classifyBuild } from '@/app/status-bar';
import { TooltipProvider } from '@/shared/components/ui/tooltip';

// The bar reads the operator's configured zone from context. Stubbing the hook
// (rather than mounting TimezoneProvider, which needs a router + settings query)
// keeps the zone a plain input we can flip per test.
const tzState = vi.hoisted(() => ({ tz: 'UTC' }));
vi.mock('../src/shared/context/timezone-context', () => ({
  useTimezone: () => tzState.tz,
}));

const base = (over: Partial<StatusResponse> = {}): StatusResponse => ({
  api: { sha: 'aaaaaaa1', bootedAt: '2026-06-12T10:00:00.000Z' },
  worker: { sha: 'aaaaaaa1', bootedAt: '2026-06-12T10:00:05.000Z' },
  study: { sha: 'aaaaaaa1', bootedAt: '2026-06-12T10:00:05.000Z' },
  db: { latestMigrationAppliedAt: '2026-06-12T09:00:00.000Z' },
  fleet: { total: 1, ready: 1 },
  ...over,
});

describe('classifyBuild', () => {
  it('flags skew (danger) when api and worker SHAs differ', () => {
    const v = classifyBuild(
      base({ worker: { sha: 'bbbbbbb2', bootedAt: '2026-06-12T10:00:05.000Z' } }),
    );
    expect(v.tone).toBe('skew');
    expect(v.sentences[0]).toContain('different code');
  });

  it('flags the worker as down (lag) when the heartbeat is absent', () => {
    const v = classifyBuild(base({ worker: null }));
    expect(v.tone).toBe('lag');
    expect(v.workerLabel).toBe('down');
    expect(v.sentences[0]).toContain('not running');
  });

  it('flags lag when the worker booted before the latest migration', () => {
    const v = classifyBuild(
      base({
        worker: { sha: 'aaaaaaa1', bootedAt: '2026-06-12T08:00:00.000Z' },
        db: { latestMigrationAppliedAt: '2026-06-12T09:00:00.000Z' },
      }),
    );
    expect(v.tone).toBe('lag');
    expect(v.sentences[0]).toContain('latest database change');
  });

  it('is ok when api and worker are aligned and post-migration', () => {
    const v = classifyBuild(base());
    expect(v.tone).toBe('ok');
    expect(v.sentences).toHaveLength(0);
  });

  it('does not warn on skew when either SHA is unknown', () => {
    const v = classifyBuild(
      base({
        api: { sha: 'unknown', bootedAt: '2026-06-12T10:00:00.000Z' },
        worker: { sha: 'aaaaaaa1', bootedAt: '2026-06-12T10:00:05.000Z' },
      }),
    );
    expect(v.tone).toBe('ok');
  });

  it('reports a down study worker without degrading the live-worker tone', () => {
    const v = classifyBuild(base({ study: null }));
    // Live worker is healthy, so the trading-health tone stays ok; study is
    // surfaced separately for the bottom build bar only.
    expect(v.tone).toBe('ok');
    expect(v.studyLabel).toBe('down');
    expect(v.studySentence).toContain('backtest worker');
  });

  it('keeps live-worker skew dominant while still reporting study down', () => {
    const v = classifyBuild(
      base({ worker: { sha: 'bbbbbbb2', bootedAt: '2026-06-12T10:00:05.000Z' }, study: null }),
    );
    expect(v.tone).toBe('skew');
    expect(v.studyLabel).toBe('down');
  });

  it('omits the study label and sentence when the study worker is healthy', () => {
    const v = classifyBuild(base());
    expect(v.studyLabel).toBeNull();
    expect(v.studySentence).toBeNull();
  });
});

const json = (data: unknown): Response =>
  new Response(JSON.stringify(data), {
    status: 200,
    headers: { 'Content-Type': 'application/json' },
  });

const renderBar = (status: StatusResponse | (() => Response)): void => {
  vi.stubGlobal(
    'fetch',
    vi.fn(async () => (typeof status === 'function' ? status() : json(status))),
  );
  const qc = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  render(
    <QueryClientProvider client={qc}>
      <TooltipProvider>
        <StatusBar />
      </TooltipProvider>
    </QueryClientProvider>,
  );
};

afterEach(() => {
  vi.unstubAllGlobals();
  tzState.tz = 'UTC';
});

describe('<StatusBar>', () => {
  it('renders a danger pill on api/worker skew', async () => {
    renderBar(base({ worker: { sha: 'bbbbbbb2', bootedAt: '2026-06-12T10:00:05.000Z' } }));
    const pill = await screen.findByTestId('build-status');
    expect(pill).toHaveTextContent('api aaaaaaa · worker bbbbbbb');
    expect(pill.className).toContain('var(--danger)');
  });

  it('renders a warning pill with "down" when the worker is absent', async () => {
    renderBar(base({ worker: null }));
    const pill = await screen.findByTestId('build-status');
    expect(pill).toHaveTextContent('worker down');
    expect(pill.className).toContain('var(--warning)');
  });

  it('renders a warning pill when the worker booted before the latest migration', async () => {
    renderBar(
      base({
        worker: { sha: 'aaaaaaa1', bootedAt: '2026-06-12T08:00:00.000Z' },
        db: { latestMigrationAppliedAt: '2026-06-12T09:00:00.000Z' },
      }),
    );
    const pill = await screen.findByTestId('build-status');
    expect(pill.className).toContain('var(--warning)');
  });

  it('renders a plain (non-badge) pill when aligned', async () => {
    renderBar(base());
    const pill = await screen.findByTestId('build-status');
    expect(pill).toHaveTextContent('api aaaaaaa · worker aaaaaaa');
    // Healthy study stays out of the pill to keep the bar uncluttered on mobile.
    expect(pill.textContent).not.toContain('study');
    expect(pill.className).not.toContain('var(--danger)');
    expect(pill.className).not.toContain('var(--warning)');
  });

  it('shows "study down" inline (warning) when the study worker is absent', async () => {
    renderBar(base({ study: null }));
    const pill = await screen.findByTestId('build-status');
    expect(pill).toHaveTextContent('api aaaaaaa · worker aaaaaaa · study down');
    expect(pill.className).toContain('var(--warning)');
  });

  it('renders nothing for the build segment when the status poll fails', async () => {
    renderBar(() => new Response('boom', { status: 500 }));
    // The clock still renders; the build pill never appears.
    expect(await screen.findByText(/UTC/)).toBeInTheDocument();
    expect(screen.queryByTestId('build-status')).not.toBeInTheDocument();
  });

  it('renders the clock as HH:mm:ss with the zone label', async () => {
    renderBar(base());
    await screen.findByTestId('build-status');
    expect(screen.getByTestId('status-clock').textContent).toMatch(/^\d{2}:\d{2}:\d{2} UTC$/);
  });

  it('renders the clock in the operator zone, not UTC and not the browser zone', () => {
    // Fake Date only: the render path must keep real setTimeout for react-query.
    // Fixed instant: 04:05:06Z is 14:05:06 in Sydney (UTC+10, no DST in June).
    vi.useFakeTimers({ toFake: ['Date'] });
    vi.setSystemTime(new Date('2026-06-20T04:05:06Z'));
    tzState.tz = 'Australia/Sydney';
    try {
      renderBar(base());
      // The clock paints on first render, so no query await is needed — and the
      // assertion stays free of the status poll.
      expect(screen.getByTestId('status-clock')).toHaveTextContent('14:05:06 GMT+10');
    } finally {
      vi.useRealTimers();
    }
  });
});
