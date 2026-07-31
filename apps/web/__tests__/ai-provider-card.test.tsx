import { QueryClientProvider } from '@tanstack/react-query';
import { render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { toast } from 'sonner';

import { createQueryClient } from '@/shared/lib/query-client';
import { AiProviderCard } from '@/features/account/components/ai-provider-card';

// ActionBanner renders nothing inline — it fires a Sonner toast — so assert on it.
vi.mock('sonner', () => ({ toast: { success: vi.fn(), error: vi.fn() } }));

type Json = Record<string, unknown>;

const json = (body: Json, status = 200): Response =>
  new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } });

const VIEW = {
  provider: 'anthropic',
  anthropic: { model: 'claude-sonnet-5', hasApiKey: false, hasOauthToken: false },
  openai: { baseUrl: 'http://host.docker.internal:11434/v1', model: '', hasApiKey: false },
};

const setUp = (responder: (url: string, init?: RequestInit) => Response | Promise<Response>) => {
  const fetchMock = vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
    const url =
      typeof input === 'string' ? input : input instanceof URL ? input.toString() : input.url;
    return responder(url, init);
  });
  vi.stubGlobal('fetch', fetchMock);
  const queryClient = createQueryClient();
  const utils = render(
    <QueryClientProvider client={queryClient}>
      <AiProviderCard />
    </QueryClientProvider>,
  );
  return { fetchMock, ...utils };
};

describe('AiProviderCard', () => {
  beforeEach(() => {
    vi.spyOn(console, 'error').mockImplementation(() => undefined);
  });
  afterEach(() => {
    vi.unstubAllGlobals();
    vi.restoreAllMocks();
  });

  it('seeds the model from the stored config and marks the key as not set', async () => {
    setUp(() => json(VIEW));
    const model = (await screen.findByLabelText(/^model$/i)) as HTMLInputElement;
    await waitFor(() => expect(model.value).toBe('claude-sonnet-5'));
    const key = screen.getByLabelText(/^api key$/i) as HTMLInputElement;
    expect(key.placeholder).toMatch(/not set/i);
  });

  it('reveals the OpenAI-compatible fields when that provider is selected', async () => {
    setUp(() => json(VIEW));
    const select = (await screen.findByTestId('ai-provider-select')) as HTMLSelectElement;
    const user = userEvent.setup();
    await user.selectOptions(select, 'openai-compatible');
    const base = (await screen.findByLabelText(/base url/i)) as HTMLInputElement;
    expect(base.value).toBe('http://host.docker.internal:11434/v1');
  });

  it('PATCHes the config on Save, sending the typed API key', async () => {
    const { fetchMock } = setUp((url, init) => {
      if (url.includes('/account/ai-provider') && init?.method === 'PATCH') {
        return json({ ...VIEW, anthropic: { ...VIEW.anthropic, hasApiKey: true } });
      }
      return json(VIEW);
    });
    await screen.findByLabelText(/^model$/i);
    const user = userEvent.setup();
    await user.type(screen.getByLabelText(/^api key$/i), 'sk-ant-typed');
    await user.click(screen.getByTestId('ai-provider-save'));

    await waitFor(() => {
      const patch = fetchMock.mock.calls.find(
        ([u, i]) =>
          String(u).includes('/account/ai-provider') && (i as RequestInit)?.method === 'PATCH',
      );
      expect(patch).toBeTruthy();
      const body = JSON.parse((patch?.[1] as RequestInit).body as string);
      expect(body.anthropic.apiKey).toBe('sk-ant-typed');
    });
    await waitFor(() => expect(toast.success).toHaveBeenCalledWith('AI provider saved.'));
  });

  it('POSTs the probe on Test connection and reflects the result', async () => {
    const { fetchMock } = setUp((url, init) => {
      if (url.includes('/account/ai-provider/test') && init?.method === 'POST') {
        return json({ ok: false, detail: 'HTTP 401' });
      }
      return json(VIEW);
    });
    await screen.findByLabelText(/^model$/i);
    const user = userEvent.setup();
    await user.click(screen.getByTestId('ai-provider-test'));
    await waitFor(() => {
      expect(
        fetchMock.mock.calls.some(
          ([u, i]) =>
            String(u).includes('/account/ai-provider/test') &&
            (i as RequestInit)?.method === 'POST',
        ),
      ).toBe(true);
    });
    await waitFor(() => expect(toast.error).toHaveBeenCalledWith('Not reachable — HTTP 401'));
  });
});
