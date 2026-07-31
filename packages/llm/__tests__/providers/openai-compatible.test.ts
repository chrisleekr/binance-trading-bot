import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { createOpenAiCompatClient } from '../../src/providers/openai-compatible.js';

const req = {
  name: 'emit',
  description: 'produce the thing',
  systemText: 'sys',
  user: 'u',
  schema: { type: 'object' },
  maxTokens: 256,
};

const okResponse = (content: string): Response =>
  ({
    ok: true,
    json: async () => ({ choices: [{ message: { content } }] }),
  }) as unknown as Response;

let fetchMock: ReturnType<typeof vi.fn>;

beforeEach(() => {
  fetchMock = vi.fn();
  vi.stubGlobal('fetch', fetchMock);
});

afterEach(() => {
  vi.unstubAllGlobals();
});

describe('createOpenAiCompatClient', () => {
  it('is unavailable without a base URL or model', async () => {
    expect(createOpenAiCompatClient({ baseUrl: '', apiKey: '', model: 'm' }).available).toBe(false);
    const client = createOpenAiCompatClient({ baseUrl: 'http://x/v1', apiKey: '', model: '' });
    expect(client.available).toBe(false);
    await expect(client.generateStructured(req)).rejects.toThrow(/base URL and model/);
  });

  it('posts response_format json_schema and returns the parsed content', async () => {
    fetchMock.mockResolvedValue(okResponse('{"a":1}'));
    const client = createOpenAiCompatClient({
      baseUrl: 'http://host:11434/v1/',
      apiKey: '',
      model: 'qwen2.5',
    });
    const out = await client.generateStructured(req);
    expect(out).toEqual({ a: 1 });

    const [url, init] = fetchMock.mock.calls[0] as [string, RequestInit];
    // Trailing slash on the base URL is trimmed, not doubled.
    expect(url).toBe('http://host:11434/v1/chat/completions');
    const headers = init.headers as Record<string, string>;
    expect(headers.authorization).toBeUndefined();
    const body = JSON.parse(init.body as string);
    expect(body.model).toBe('qwen2.5');
    expect(body.max_tokens).toBe(256);
    expect(body.response_format).toEqual({
      type: 'json_schema',
      json_schema: { name: 'emit', schema: { type: 'object' } },
    });
    expect(body.messages).toEqual([
      { role: 'system', content: 'sys' },
      { role: 'user', content: 'u' },
    ]);
  });

  it('sends a Bearer header when an API key is set', async () => {
    fetchMock.mockResolvedValue(okResponse('{"a":1}'));
    const client = createOpenAiCompatClient({
      baseUrl: 'http://host/v1',
      apiKey: 'secret',
      model: 'm',
    });
    await client.generateStructured(req);
    const init = fetchMock.mock.calls[0][1] as RequestInit;
    expect((init.headers as Record<string, string>).authorization).toBe('Bearer secret');
  });

  it('throws on a non-2xx response with the status and body', async () => {
    fetchMock.mockResolvedValue({
      ok: false,
      status: 500,
      statusText: 'Server Error',
      text: async () => 'boom',
    } as unknown as Response);
    const client = createOpenAiCompatClient({ baseUrl: 'http://host/v1', apiKey: '', model: 'm' });
    await expect(client.generateStructured(req)).rejects.toThrow(/500/);
  });

  it('throws when the response carries no message content', async () => {
    fetchMock.mockResolvedValue({
      ok: true,
      json: async () => ({ choices: [] }),
    } as unknown as Response);
    const client = createOpenAiCompatClient({ baseUrl: 'http://host/v1', apiKey: '', model: 'm' });
    await expect(client.generateStructured(req)).rejects.toThrow(/no message content/);
  });

  it('throws (fails honestly) on malformed JSON content', async () => {
    fetchMock.mockResolvedValue(okResponse('not json'));
    const client = createOpenAiCompatClient({ baseUrl: 'http://host/v1', apiKey: '', model: 'm' });
    await expect(client.generateStructured(req)).rejects.toThrow();
  });

  it('wraps a transport/abort failure', async () => {
    fetchMock.mockRejectedValue(new Error('aborted'));
    const client = createOpenAiCompatClient({ baseUrl: 'http://host/v1', apiKey: '', model: 'm' });
    await expect(client.generateStructured(req)).rejects.toThrow(/request failed/);
  });
});
