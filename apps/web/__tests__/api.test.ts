import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { z } from 'zod';

import {
  ApiError,
  RateLimitedError,
  UnauthenticatedError,
  ValidationFailedError,
  apiFetch,
  serverValidationErrors,
  setApiBaseUrl,
  setOnUnauthorized,
} from '@/shared/lib/api';

const ProfilePayload = z.object({ id: z.string(), name: z.string() });

const jsonResponse = (
  status: number,
  body: unknown,
  headers: Record<string, string> = {},
): Response =>
  new Response(JSON.stringify(body), {
    status,
    headers: { 'content-type': 'application/json', ...headers },
  });

describe('apiFetch', () => {
  beforeEach(() => {
    setApiBaseUrl('/api');
    setOnUnauthorized(() => undefined);
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  it('parses a 200 JSON body against the supplied schema', async () => {
    vi.spyOn(globalThis, 'fetch').mockResolvedValueOnce(
      jsonResponse(200, { id: 'p1', name: 'demo' }),
    );

    await expect(apiFetch('/profiles/p1', ProfilePayload)).resolves.toEqual({
      id: 'p1',
      name: 'demo',
    });
  });

  it('throws PARSE_FAILED when the response does not match the schema', async () => {
    vi.spyOn(globalThis, 'fetch').mockResolvedValueOnce(jsonResponse(200, { id: 1, name: 2 }));

    await expect(apiFetch('/profiles/p1', ProfilePayload)).rejects.toMatchObject({
      name: 'ApiError',
      code: 'PARSE_FAILED',
      status: 200,
    });
  });

  it('on 401 invokes onUnauthorized with the current URL and throws UnauthenticatedError', async () => {
    vi.spyOn(globalThis, 'fetch').mockResolvedValueOnce(
      jsonResponse(401, { error: { code: 'UNAUTHENTICATED', message: 'login required' } }),
    );
    const onUnauth = vi.fn();
    setOnUnauthorized(onUnauth);
    Object.defineProperty(window, 'location', {
      configurable: true,
      value: { pathname: '/profiles/abc', search: '?tab=orders', hash: '' },
    });

    await expect(apiFetch('/profiles/abc', ProfilePayload)).rejects.toBeInstanceOf(
      UnauthenticatedError,
    );
    expect(onUnauth).toHaveBeenCalledWith('/profiles/abc?tab=orders');
  });

  it('on 422 throws ValidationFailedError with zod issues exposed as details', async () => {
    const issues = [{ path: ['email'], message: 'invalid email', code: 'invalid_string' }];
    vi.spyOn(globalThis, 'fetch').mockResolvedValueOnce(
      jsonResponse(422, {
        error: { code: 'VALIDATION_FAILED', message: 'invalid request', details: issues },
      }),
    );

    const err = await apiFetch('/profiles', ProfilePayload).catch((e: unknown) => e);
    expect(err).toBeInstanceOf(ValidationFailedError);
    expect((err as ValidationFailedError).details).toEqual(issues);
  });

  it('on 429 surfaces Retry-After numeric header and never auto-retries', async () => {
    const fetchSpy = vi
      .spyOn(globalThis, 'fetch')
      .mockResolvedValueOnce(
        jsonResponse(
          429,
          { error: { code: 'RATE_LIMITED', message: 'slow down' } },
          { 'retry-after': '7' },
        ),
      );

    const err = await apiFetch('/profiles', ProfilePayload).catch((e: unknown) => e);
    expect(err).toBeInstanceOf(RateLimitedError);
    expect((err as RateLimitedError).retryAfterSeconds).toBe(7);
    expect(fetchSpy).toHaveBeenCalledTimes(1);
  });

  it('on 429 with HTTP-date Retry-After parses to a positive seconds delta', async () => {
    const future = new Date(Date.now() + 30_000).toUTCString();
    vi.spyOn(globalThis, 'fetch').mockResolvedValueOnce(
      jsonResponse(
        429,
        { error: { code: 'RATE_LIMITED', message: 'slow down' } },
        { 'retry-after': future },
      ),
    );

    const err = await apiFetch('/profiles', ProfilePayload).catch((e: unknown) => e);
    expect(err).toBeInstanceOf(RateLimitedError);
    expect((err as RateLimitedError).retryAfterSeconds).toBeGreaterThanOrEqual(28);
    expect((err as RateLimitedError).retryAfterSeconds).toBeLessThanOrEqual(31);
  });

  it('on network failure throws ApiError(NETWORK_FAILED)', async () => {
    vi.spyOn(globalThis, 'fetch').mockRejectedValueOnce(new TypeError('connection refused'));

    const err = await apiFetch('/profiles', ProfilePayload).catch((e: unknown) => e);
    expect(err).toBeInstanceOf(ApiError);
    expect((err as ApiError).code).toBe('NETWORK_FAILED');
    expect((err as ApiError).status).toBe(0);
  });

  it('serialises body as JSON and sets content-type when body is provided', async () => {
    const fetchSpy = vi
      .spyOn(globalThis, 'fetch')
      .mockResolvedValueOnce(jsonResponse(200, { id: 'p1', name: 'demo' }));

    await apiFetch('/profiles', ProfilePayload, {
      method: 'POST',
      body: { name: 'demo' },
      query: { mode: 'live', enabled: true, skip: undefined },
    });

    const [url, init] = fetchSpy.mock.calls[0] as [string, RequestInit];
    expect(url).toBe('/api/profiles?mode=live&enabled=true');
    expect(init.method).toBe('POST');
    expect(init.body).toBe(JSON.stringify({ name: 'demo' }));
    expect((init.headers as Headers).get('content-type')).toBe('application/json');
    expect((init.headers as Headers).get('accept')).toBe('application/json');
  });
});

describe('serverValidationErrors', () => {
  it('maps zod issues with a non-empty path to dotted field names', () => {
    const error = new ValidationFailedError('invalid request', [
      { path: ['email'], message: 'invalid email', code: 'invalid_string' },
      { path: ['buy', 'gridLevels', 0, 'triggerPercentage'], message: 'must equal 1' },
    ]);
    expect(serverValidationErrors(error)).toEqual([
      { name: 'email', message: 'invalid email' },
      { name: 'buy.gridLevels.0.triggerPercentage', message: 'must equal 1' },
    ]);
  });

  it('drops form-level (empty-path) issues — those stay the caller’s banner', () => {
    const error = new ValidationFailedError('invalid request', [
      { path: [], message: 'whole-form rule failed' },
      { path: ['symbol'], message: 'required' },
    ]);
    expect(serverValidationErrors(error)).toEqual([{ name: 'symbol', message: 'required' }]);
  });

  it('returns nothing for a non-array details payload', () => {
    expect(serverValidationErrors(new ValidationFailedError('bad input'))).toEqual([]);
  });

  it('returns nothing for a non-validation error (caller owns it)', () => {
    expect(serverValidationErrors(new ApiError(500, 'UNKNOWN', 'boom'))).toEqual([]);
    expect(serverValidationErrors(new Error('network down'))).toEqual([]);
  });
});
