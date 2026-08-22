import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { afterEach, describe, expect, it, vi } from 'vitest';
import type { AdvisorResult } from '@app/contracts';

import { BacktestLlmAdvisor } from '@/features/backtest/components/backtest-llm-advisor';

// This suite drives the real api client + poll hook against a stubbed `fetch`
// (the same pattern as the route suite), so the advisor's durable-row contract —
// GET rehydrate, POST enqueue, poll running→done, manual persist — is exercised
// end to end rather than mocked away.

const SUGGESTION = {
  id: 'rsi',
  title: 'Relax the RSI ceiling',
  rationale: 'It blocked many entries.',
  changes: [{ path: 'buy.indicatorGate.rsiMaxBuy', value: '' }],
  expectedEffect: 'more entries clear the gate',
  overfitRisk: 'low' as const,
};

// The contract's `id` is `z.uuid()`, so fixtures must carry a valid UUID or the
// response fails schema validation at the api-client boundary.
const rowId = (): string => crypto.randomUUID();

const doneRow = (
  variant: AdvisorResult['variant'],
  over: Partial<AdvisorResult> = {},
): AdvisorResult => ({
  id: rowId(),
  variant,
  status: 'done',
  summary: `${variant} read of the run`,
  suggestions: [SUGGESTION],
  dropped: [],
  errorReason: null,
  updatedAt: '2026-07-04T00:00:00.000Z',
  ...over,
});

const runningRow = (variant: AdvisorResult['variant']): AdvisorResult => ({
  id: rowId(),
  variant,
  status: 'running',
  summary: null,
  suggestions: [],
  dropped: [],
  errorReason: null,
  updatedAt: '2026-07-04T00:00:00.000Z',
});

const errorRow = (
  variant: AdvisorResult['variant'],
  errorReason: AdvisorResult['errorReason'],
): AdvisorResult => ({
  id: rowId(),
  variant,
  status: 'error',
  summary: null,
  suggestions: [],
  dropped: [],
  errorReason,
  updatedAt: '2026-07-04T00:00:00.000Z',
});

const json = (body: unknown, status = 200): Response =>
  new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } });

const errorEnvelope = (code: string, message: string, status: number): Response =>
  json({ error: { code, message } }, status);

const method = (init?: RequestInit): string => init?.method ?? 'GET';
const isGetList = (url: string, init?: RequestInit): boolean =>
  url.endsWith('/advisor') && method(init) === 'GET';
const isManualPromptGet = (url: string, init?: RequestInit): boolean =>
  url.endsWith('/advisor/manual/prompt') && method(init) === 'GET';
const isManualPost = (url: string, init?: RequestInit): boolean =>
  url.endsWith('/advisor/manual') && method(init) === 'POST';
const variantPost = (url: string, init?: RequestInit): string | null => {
  const m = /\/advisor\/(safe|ride-trend|trade-more|aggressive|defensive)$/.exec(url);
  return m && method(init) === 'POST' ? (m[1] as string) : null;
};

type Responder = (url: string, init?: RequestInit) => Response | Promise<Response>;

const install = (responder: Responder): ReturnType<typeof vi.fn> => {
  const fetchMock = vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = typeof input === 'string' ? input : input.toString();
    return responder(url, init);
  });
  vi.stubGlobal('fetch', fetchMock);
  return fetchMock;
};

const renderAdvisor = (
  onApply: ReturnType<typeof vi.fn> = vi.fn(),
  config: Record<string, unknown> = { buy: { indicatorGate: { rsiMaxBuy: '30' } } },
): { onApply: ReturnType<typeof vi.fn> } => {
  const client = new QueryClient({
    defaultOptions: { mutations: { retry: false }, queries: { retry: false } },
  });
  render(
    <QueryClientProvider client={client}>
      <BacktestLlmAdvisor profileId="p1" runId="r1" config={config} onApply={onApply} />
    </QueryClientProvider>,
  );
  return { onApply };
};

const postCalls = (fetchMock: ReturnType<typeof vi.fn>): unknown[] =>
  fetchMock.mock.calls.filter((c) => method(c[1] as RequestInit) === 'POST');

afterEach(() => {
  vi.unstubAllGlobals();
  vi.clearAllMocks();
});

describe('BacktestLlmAdvisor', () => {
  it('rehydrates a saved variant from GET on mount, with no POST', async () => {
    const fetchMock = install((url, init) => {
      if (isGetList(url, init)) return json({ results: [doneRow('safe')] });
      return new Response('not found', { status: 404 });
    });
    renderAdvisor();

    // The saved row is displayed on mount — no button click, no generation call.
    expect(await screen.findByTestId('backtest-llm-summary')).toHaveTextContent('safe read');
    await waitFor(() => expect(fetchMock).toHaveBeenCalled());
    expect(postCalls(fetchMock)).toHaveLength(0);
  });

  it('clicking an ungenerated variant POSTs then polls running→done', async () => {
    let done = false;
    const fetchMock = install((url, init) => {
      if (variantPost(url, init) === 'safe') return json(runningRow('safe'), 202);
      if (isGetList(url, init)) return json({ results: done ? [doneRow('safe')] : [] });
      return new Response('not found', { status: 404 });
    });
    renderAdvisor();
    const user = userEvent.setup();

    await user.click(await screen.findByTestId('backtest-llm-ask-safe'));
    // The 202 seeds a running row; the spinner shows immediately.
    expect(await screen.findByTestId('backtest-llm-generating')).toBeInTheDocument();
    await waitFor(() => expect(postCalls(fetchMock)).toHaveLength(1));

    // Flip the server to done; the 1.5s poll picks it up.
    done = true;
    expect(
      await screen.findByTestId('backtest-llm-summary', undefined, { timeout: 4000 }),
    ).toHaveTextContent('safe read');
  }, 8000);

  it('clicking a variant with a saved done row shows it without a POST', async () => {
    const fetchMock = install((url, init) => {
      if (isGetList(url, init))
        return json({
          results: [
            doneRow('safe', { summary: 'the SAFE answer' }),
            // aggressive is newer, so it auto-selects on mount.
            doneRow('aggressive', {
              summary: 'the AGGRESSIVE answer',
              updatedAt: '2026-07-04T01:00:00.000Z',
            }),
          ],
        });
      return new Response('not found', { status: 404 });
    });
    renderAdvisor();
    const user = userEvent.setup();

    expect(await screen.findByTestId('backtest-llm-summary')).toHaveTextContent('AGGRESSIVE');
    await user.click(screen.getByTestId('backtest-llm-ask-safe'));
    expect(await screen.findByTestId('backtest-llm-summary')).toHaveTextContent('SAFE');
    // Both variants were already saved: showing them cost no generation call.
    expect(postCalls(fetchMock)).toHaveLength(0);
  });

  it('keeps the initially restored result selected when another variant finishes polling', async () => {
    let aggressiveDone = false;
    let listGets = 0;
    install((url, init) => {
      if (isGetList(url, init)) {
        listGets += 1;
        return json({
          results: [
            doneRow('safe', { summary: 'the SAFE answer' }),
            aggressiveDone
              ? doneRow('aggressive', {
                  summary: 'the AGGRESSIVE answer',
                  updatedAt: '2026-07-04T01:00:00.000Z',
                })
              : runningRow('aggressive'),
          ],
        });
      }
      return new Response('not found', { status: 404 });
    });
    renderAdvisor();

    expect(await screen.findByTestId('backtest-llm-summary')).toHaveTextContent('SAFE');
    aggressiveDone = true;
    await waitFor(() => expect(listGets).toBeGreaterThan(1), { timeout: 4000 });
    expect(screen.getByTestId('backtest-llm-summary')).toHaveTextContent('SAFE');
  }, 8000);

  it('clears selected suggestions when the operator changes variants', async () => {
    install((url, init) => {
      if (isGetList(url, init))
        return json({
          results: [
            doneRow('safe', { summary: 'the SAFE answer' }),
            doneRow('aggressive', {
              summary: 'the AGGRESSIVE answer',
              updatedAt: '2026-07-04T01:00:00.000Z',
            }),
          ],
        });
      return new Response('not found', { status: 404 });
    });
    renderAdvisor();
    const user = userEvent.setup();

    await screen.findByText('the AGGRESSIVE answer');
    await user.click(screen.getByTestId('backtest-llm-toggle-rsi'));
    expect(screen.getByTestId('backtest-llm-load-selected')).toBeEnabled();

    await user.click(screen.getByTestId('backtest-llm-ask-safe'));
    expect(screen.getByTestId('backtest-llm-load-selected')).toBeDisabled();

    await user.click(screen.getByTestId('backtest-llm-ask-aggressive'));
    expect(screen.getByTestId('backtest-llm-load-selected')).toBeDisabled();
  });

  it('Regenerate re-POSTs and is disabled while the row is running', async () => {
    const fetchMock = install((url, init) => {
      if (variantPost(url, init) === 'safe') return json(runningRow('safe'), 202);
      if (isGetList(url, init)) return json({ results: [doneRow('safe')] });
      return new Response('not found', { status: 404 });
    });
    renderAdvisor();
    const user = userEvent.setup();

    const regen = await screen.findByTestId('backtest-llm-regenerate-safe');
    await user.click(regen);
    // A fresh generation is enqueued and the button locks while running.
    await waitFor(() => expect(postCalls(fetchMock)).toHaveLength(1));
    await waitFor(() => expect(screen.getByTestId('backtest-llm-regenerate-safe')).toBeDisabled());
    expect(screen.getByTestId('backtest-llm-generating')).toBeInTheDocument();
  });

  it('shows the not-configured note when start returns 503', async () => {
    install((url, init) => {
      if (variantPost(url, init) === 'safe')
        return errorEnvelope('SERVICE_UNAVAILABLE', 'study worker offline', 503);
      if (isGetList(url, init)) return json({ results: [] });
      return new Response('not found', { status: 404 });
    });
    renderAdvisor();
    const user = userEvent.setup();

    await user.click(await screen.findByTestId('backtest-llm-ask-safe'));
    await waitFor(() =>
      expect(screen.getByTestId('backtest-llm-error')).toHaveTextContent('not configured'),
    );
  });

  it('shows an honest error note with a Regenerate affordance for an errored row', async () => {
    install((url, init) => {
      if (isGetList(url, init)) return json({ results: [errorRow('safe', 'failed')] });
      return new Response('not found', { status: 404 });
    });
    renderAdvisor();

    // The errored row rehydrates on mount and reads honestly, not as "no change".
    expect(await screen.findByTestId('backtest-llm-error')).toHaveTextContent('couldn’t generate');
    expect(screen.getByTestId('backtest-llm-regenerate-safe')).toBeInTheDocument();
    expect(screen.queryByText(/No config change suggested/)).not.toBeInTheDocument();
  });

  it('reports honestly when a saved done row suggested no change', async () => {
    install((url, init) => {
      if (isGetList(url, init))
        return json({
          results: [doneRow('safe', { summary: 'No change beats holding cash.', suggestions: [] })],
        });
      return new Response('not found', { status: 404 });
    });
    renderAdvisor();
    expect(await screen.findByText(/No config change suggested/)).toBeInTheDocument();
  });

  it('surfaces a returned-but-invalid suggestion as a skipped note, not "no suggestion"', async () => {
    install((url, init) => {
      if (isGetList(url, init))
        return json({
          results: [
            doneRow('safe', {
              summary: 'One idea did not fit the schema.',
              suggestions: [],
              dropped: [
                {
                  id: 'cap',
                  title: 'Restore account cap',
                  reason: 'buy.accountCap.percent: percent must be in (0, 1]',
                },
              ],
            }),
          ],
        });
      return new Response('not found', { status: 404 });
    });
    renderAdvisor();

    const card = await screen.findByTestId('backtest-llm-dropped-cap');
    expect(card).toHaveTextContent('Restore account cap');
    expect(card).toHaveTextContent('percent must be in (0, 1]');
    expect(screen.queryByText(/No config change suggested/)).not.toBeInTheDocument();
  });

  it('loads a selected suggestion from a saved row into Setup', async () => {
    install((url, init) => {
      if (isGetList(url, init)) return json({ results: [doneRow('safe')] });
      return new Response('not found', { status: 404 });
    });
    const { onApply } = renderAdvisor();
    const user = userEvent.setup();

    await screen.findByTestId('backtest-llm-summary');
    // Selecting stages but does not load; the load button applies the patches.
    await user.click(screen.getByTestId('backtest-llm-toggle-rsi'));
    expect(onApply).not.toHaveBeenCalled();
    await user.click(screen.getByTestId('backtest-llm-load-selected'));
    expect(onApply).toHaveBeenCalledTimes(1);
    const next = onApply.mock.calls[0]?.[0] as { buy: { indicatorGate: { rsiMaxBuy: string } } };
    expect(next.buy.indicatorGate.rsiMaxBuy).toBe('');
  });

  it('manual loop: copies the prompt, persists the pasted reply to the manual slot, loads into Setup', async () => {
    install((url, init) => {
      if (isManualPromptGet(url, init)) return json({ prompt: 'COPY-ME-PROMPT with schema' });
      if (isManualPost(url, init)) return json(doneRow('manual', { summary: 'Manual read.' }));
      if (isGetList(url, init)) return json({ results: [] });
      return new Response('not found', { status: 404 });
    });
    const writeText = vi.fn().mockResolvedValue(undefined);
    const { onApply } = renderAdvisor();
    const user = userEvent.setup();
    // Override after setup(): user-event installs its own clipboard stub.
    Object.defineProperty(navigator, 'clipboard', { value: { writeText }, configurable: true });

    await user.click(await screen.findByTestId('backtest-llm-manual-open'));
    expect(await screen.findByTestId('backtest-llm-prompt')).toHaveTextContent('COPY-ME-PROMPT');

    await user.click(screen.getByTestId('backtest-llm-copy'));
    expect(writeText).toHaveBeenCalledWith('COPY-ME-PROMPT with schema');

    await user.type(screen.getByTestId('backtest-llm-reply'), 'PASTED REPLY');
    await user.click(screen.getByTestId('backtest-llm-parse'));

    // The persisted manual row shows as its own slot alongside the server variants.
    expect(await screen.findByTestId('backtest-llm-summary')).toHaveTextContent('Manual read');

    await user.click(screen.getByTestId('backtest-llm-toggle-rsi'));
    await user.click(screen.getByTestId('backtest-llm-load-selected'));
    expect(onApply).toHaveBeenCalledTimes(1);
    const next = onApply.mock.calls[0]?.[0] as { buy: { indicatorGate: { rsiMaxBuy: string } } };
    expect(next.buy.indicatorGate.rsiMaxBuy).toBe('');
  });

  it('manual loop: surfaces a parse error from the API', async () => {
    install((url, init) => {
      if (isManualPromptGet(url, init)) return json({ prompt: 'P' });
      if (isManualPost(url, init))
        return errorEnvelope('VALIDATION_FAILED', "could not find JSON in Claude's reply", 422);
      if (isGetList(url, init)) return json({ results: [] });
      return new Response('not found', { status: 404 });
    });
    renderAdvisor();
    const user = userEvent.setup();

    await user.click(await screen.findByTestId('backtest-llm-manual-open'));
    await screen.findByTestId('backtest-llm-prompt');
    await user.type(screen.getByTestId('backtest-llm-reply'), 'garbage');
    await user.click(screen.getByTestId('backtest-llm-parse'));
    expect(await screen.findByTestId('backtest-llm-parse-error')).toHaveTextContent(
      'could not find JSON',
    );
  });
});
