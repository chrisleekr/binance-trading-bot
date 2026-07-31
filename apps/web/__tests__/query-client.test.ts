import { describe, expect, it } from 'vitest';

import { ApiError, UnauthenticatedError } from '@/shared/lib/api';
import {
  createQueryClient,
  defaultQueryClientConfig,
  queryDefaults,
} from '@/shared/lib/query-client';

const queryRetry = (): ((failureCount: number, error: unknown) => boolean | number) => {
  const retry = defaultQueryClientConfig.defaultOptions?.queries?.retry;
  if (typeof retry !== 'function') {
    throw new Error('expected retry to be a function');
  }
  return retry as (failureCount: number, error: unknown) => boolean | number;
};

describe('defaultQueryClientConfig', () => {
  it('sets WS-first defaults: staleTime Infinity, gcTime 30min, no focus/reconnect refetch', () => {
    const queries = defaultQueryClientConfig.defaultOptions?.queries;
    expect(queries?.staleTime).toBe(Infinity);
    expect(queries?.gcTime).toBe(1000 * 60 * 30);
    expect(queries?.refetchOnWindowFocus).toBe(false);
    expect(queries?.refetchOnReconnect).toBe(false);
  });

  it('disables mutation retries by default', () => {
    expect(defaultQueryClientConfig.defaultOptions?.mutations?.retry).toBe(0);
  });

  it('retry never fires on 401', () => {
    const retry = queryRetry();
    expect(retry(0, new UnauthenticatedError())).toBe(false);
    expect(retry(1, new UnauthenticatedError())).toBe(false);
  });

  it('retry caps at 2 attempts for non-401 ApiError', () => {
    const retry = queryRetry();
    const err = new ApiError(500, 'INTERNAL', 'boom');
    expect(retry(0, err)).toBe(true);
    expect(retry(1, err)).toBe(true);
    expect(retry(2, err)).toBe(false);
  });

  it('retry caps at 2 for arbitrary errors as well', () => {
    const retry = queryRetry();
    expect(retry(0, new Error('x'))).toBe(true);
    expect(retry(2, new Error('x'))).toBe(false);
  });
});

describe('createQueryClient', () => {
  it('returns a configured QueryClient instance', () => {
    const client = createQueryClient();
    const opts = client.getDefaultOptions();
    expect(opts.queries?.staleTime).toBe(Infinity);
    expect(opts.queries?.refetchOnWindowFocus).toBe(false);
    expect(opts.mutations?.retry).toBe(0);
  });
});

describe('queryDefaults', () => {
  it('exchange-info and notify-providers use 5-minute staleTime', () => {
    expect(queryDefaults.exchangeInfo()).toMatchObject({
      queryKey: ['exchange-info'],
      staleTime: 1000 * 60 * 5,
    });
    expect(queryDefaults.notifyProviders()).toMatchObject({
      queryKey: ['notify-providers'],
      staleTime: 1000 * 60 * 5,
    });
  });

  it('archive paginated keys use 5-minute gcTime', () => {
    expect(queryDefaults.archive('p1', 0)).toMatchObject({
      queryKey: ['archive', 'p1', 0],
      gcTime: 1000 * 60 * 5,
    });
  });

  it('dashboard-aggregate uses 10-second stale and refetch interval', () => {
    expect(queryDefaults.dashboardAggregate('acc-1')).toMatchObject({
      queryKey: ['dashboard-aggregate', 'acc-1'],
      staleTime: 10_000,
      refetchInterval: 10_000,
    });
  });
});
