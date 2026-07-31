import { describe, expect, it, vi } from 'vitest';

import { fetchClosedKlines } from '../src/public-klines.js';

// A closed Binance kline tuple: [openTime, open, high, low, close, volume, closeTime, ...].
const row = (openTimeMs: number, closeTimeMs: number, close = '10'): unknown[] => [
  openTimeMs,
  '10',
  '11',
  '9',
  close,
  '100',
  closeTimeMs,
  '0',
  0,
  '0',
  '0',
  '0',
];

const okResponse = (body: unknown): Response =>
  ({ ok: true, status: 200, json: async () => body }) as unknown as Response;

const errResponse = (status: number, retryAfter?: string): Response =>
  ({
    ok: false,
    status,
    headers: { get: (name: string) => (name === 'retry-after' ? (retryAfter ?? null) : null) },
    json: async () => [],
  }) as unknown as Response;

const baseDeps = (fetchImpl: typeof globalThis.fetch, nowMs = 5_000) => ({
  fetch: fetchImpl,
  nowMs: () => nowMs,
  sleep: async () => undefined,
});

const req = { baseUrl: 'https://api.binance.com', symbol: 'BTCUSDT', interval: '1h', limit: 251 };

describe('fetchClosedKlines', () => {
  it('decodes closed rows and drops the still-forming bar', async () => {
    const fetchImpl = vi.fn(async () =>
      okResponse([row(1000, 1999, '10'), row(2000, 6000, '11')]),
    ) as unknown as typeof globalThis.fetch;
    const out = await fetchClosedKlines(req, baseDeps(fetchImpl, 5_000));
    // closeTime 1999 < now(5000) kept; 6000 >= 5000 dropped.
    expect(out).toEqual([
      {
        openTimeMs: 1000,
        closeTimeMs: 1999,
        open: '10',
        high: '11',
        low: '9',
        close: '10',
        volume: '100',
        isClosed: true,
      },
    ]);
  });

  it('builds the URL with the bare symbol/interval/limit and a user-agent', async () => {
    const fetchImpl = vi.fn(async () => okResponse([])) as unknown as typeof globalThis.fetch;
    await fetchClosedKlines(req, baseDeps(fetchImpl));
    const [url, init] = (fetchImpl as unknown as ReturnType<typeof vi.fn>).mock.calls[0] as [
      string,
      RequestInit,
    ];
    expect(url).toBe('https://api.binance.com/api/v3/klines?symbol=BTCUSDT&interval=1h&limit=251');
    expect((init.headers as Record<string, string>)['user-agent']).toContain('binance-trading-bot');
  });

  it('reserves the flat klines weight before the request when a hook is given', async () => {
    const fetchImpl = vi.fn(async () => okResponse([])) as unknown as typeof globalThis.fetch;
    const reserveWeight = vi.fn(async () => undefined);
    await fetchClosedKlines({ ...req, limit: 251 }, { ...baseDeps(fetchImpl), reserveWeight });
    expect(reserveWeight).toHaveBeenCalledTimes(1);
    expect(reserveWeight).toHaveBeenCalledWith(2);
  });

  it('issues unreserved when no reserveWeight hook is given', async () => {
    const fetchImpl = vi.fn(async () => okResponse([])) as unknown as typeof globalThis.fetch;
    await expect(fetchClosedKlines(req, baseDeps(fetchImpl))).resolves.toEqual([]);
  });

  it('retries once on 429 honouring a numeric Retry-After, then succeeds', async () => {
    const fetchImpl = vi
      .fn()
      .mockResolvedValueOnce(errResponse(429, '1'))
      .mockResolvedValueOnce(okResponse([row(1000, 1999)])) as unknown as typeof globalThis.fetch;
    const sleep = vi.fn(async () => undefined);
    const out = await fetchClosedKlines(req, { ...baseDeps(fetchImpl), sleep });
    expect(out).toHaveLength(1);
    // numeric "1" → 1000ms (under the 2000ms cap).
    expect(sleep).toHaveBeenCalledWith(1000);
  });

  it('caps a Retry-After date at 2000ms', async () => {
    const future = new Date(5_000 + 999_999).toUTCString();
    const fetchImpl = vi
      .fn()
      .mockResolvedValueOnce(errResponse(503, future))
      .mockResolvedValueOnce(okResponse([])) as unknown as typeof globalThis.fetch;
    const sleep = vi.fn(async () => undefined);
    await fetchClosedKlines(req, { ...baseDeps(fetchImpl, 5_000), sleep });
    expect(sleep).toHaveBeenCalledWith(2000);
  });

  it('falls back to the base backoff when Retry-After is absent or malformed', async () => {
    const fetchImpl = vi
      .fn()
      .mockResolvedValueOnce(errResponse(429, 'not-a-date'))
      .mockResolvedValueOnce(okResponse([])) as unknown as typeof globalThis.fetch;
    const sleep = vi.fn(async () => undefined);
    await fetchClosedKlines(req, { ...baseDeps(fetchImpl), sleep });
    expect(sleep).toHaveBeenCalledWith(500);
  });

  it('throws the HTTP error when a retriable status persists past the retry budget', async () => {
    const fetchImpl = vi.fn(async () => errResponse(429)) as unknown as typeof globalThis.fetch;
    await expect(
      fetchClosedKlines(req, { ...baseDeps(fetchImpl), sleep: async () => undefined }),
    ).rejects.toThrow(/HTTP 429/);
  });

  it('throws immediately on a non-retriable HTTP status', async () => {
    const fetchImpl = vi.fn(async () => errResponse(400)) as unknown as typeof globalThis.fetch;
    await expect(fetchClosedKlines(req, baseDeps(fetchImpl))).rejects.toThrow(/HTTP 400/);
    expect((fetchImpl as unknown as ReturnType<typeof vi.fn>).mock.calls).toHaveLength(1);
  });

  it('retries a transient network error then surfaces it when it persists', async () => {
    const fetchImpl = vi.fn(async () => {
      throw new Error('network timeout');
    }) as unknown as typeof globalThis.fetch;
    const sleep = vi.fn(async () => undefined);
    await expect(fetchClosedKlines(req, { ...baseDeps(fetchImpl), sleep })).rejects.toThrow(
      /network timeout/,
    );
    expect(sleep).toHaveBeenCalledTimes(1);
  });

  it('does not retry a malformed-row parse error', async () => {
    const fetchImpl = vi.fn(async () =>
      okResponse([[1, 2, 3]]),
    ) as unknown as typeof globalThis.fetch;
    await expect(fetchClosedKlines(req, baseDeps(fetchImpl))).rejects.toThrow(/tuple of length/);
    expect((fetchImpl as unknown as ReturnType<typeof vi.fn>).mock.calls).toHaveLength(1);
  });
});
