import { vi } from 'vitest';

type PathMatcher = string | RegExp;

const requestPath = (input: RequestInfo | URL): string => {
  const target = typeof input === 'string' ? input : input instanceof URL ? input.href : input.url;
  let url: URL;
  try {
    url = new URL(target, globalThis.location.href);
  } catch {
    return '<malformed-url>';
  }
  if (url.origin !== globalThis.location.origin) {
    throw new Error(`Unexpected test fetch origin: ${url.pathname || '/'}`);
  }
  return url.pathname;
};

export const pendingFetchForPaths = (...allowed: readonly PathMatcher[]) =>
  vi.fn((input: RequestInfo | URL): Promise<Response> => {
    const path = requestPath(input);
    const permitted = allowed.some((matcher) =>
      typeof matcher === 'string' ? path === matcher : matcher.test(path),
    );
    if (!permitted) throw new Error(`Unexpected test fetch: ${path}`);
    return new Promise<Response>(() => undefined);
  });
