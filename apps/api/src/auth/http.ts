import { errorResponse } from '../middleware/error.js';
import { KNOWN_DEVICE_COOKIE } from './known-device.js';

/**
 * The uniform "slow down" answer: the project error envelope with a `Retry-After` header in whole seconds. The message never says which limit refused the request; that is recorded for the operator, not told to the client.
 *
 * @param retryAfterMs - How long the client must wait.
 * @returns A 429 response.
 */
export const rateLimitedResponse = (retryAfterMs: number): Response => {
  const res = errorResponse(
    'RATE_LIMITED',
    'Too many attempts. Wait before trying again.',
    undefined,
  );
  res.headers.set('Retry-After', String(Math.max(1, Math.ceil(retryAfterMs / 1000))));
  return res;
};

/**
 * Reads one cookie from a request's `Cookie` header.
 *
 * @param headers - Request headers.
 * @param name - Cookie name.
 * @returns The raw value, or undefined when absent.
 */
export const readCookie = (headers: Headers, name: string): string | undefined => {
  for (const part of (headers.get('cookie') ?? '').split(';')) {
    const eq = part.indexOf('=');
    if (eq < 0) continue;
    if (part.slice(0, eq).trim() === name) return part.slice(eq + 1).trim();
  }
  return undefined;
};

/**
 * Reads the known-device mark the browser sent, which is what lets a recognised device skip the stricter unknown-device sign-in limits.
 *
 * @param headers - Request headers carrying the browser's cookies.
 * @returns The raw known-device cookie value, or undefined when the browser sent none.
 */
export const readKnownDevice = (headers: Headers): string | undefined =>
  readCookie(headers, KNOWN_DEVICE_COOKIE);

/**
 * Copies a Better Auth response into a new JSON response with a replacement body, keeping every `Set-Cookie` separately. `Headers.get('set-cookie')` would join several cookies with commas into one unusable value, so they are copied one by one.
 *
 * @param source - Better Auth's response, whose cookies must reach the browser.
 * @param body - The body to send instead of Better Auth's, which may contain the session token. `null` sends no body, which a 204 requires.
 * @param status - Status to send; defaults to the source status.
 * @returns The rewritten response.
 */
export const withCookiesFrom = (
  source: Response,
  body: unknown,
  status: number = source.status,
): Response => {
  const headers = new Headers(body === null ? {} : { 'content-type': 'application/json' });
  for (const cookie of source.headers.getSetCookie()) headers.append('set-cookie', cookie);
  return new Response(body === null ? null : JSON.stringify(body), { status, headers });
};

/** A fixed origin that no real request can share; resolving against it shows whether a value would leave the app. */
const PROBE_ORIGIN = 'http://same-origin.invalid';

/**
 * Keeps a post-sign-in redirect inside the app. The value is resolved with the WHATWG URL parser, the same algorithm the browser applies to a `Location` header, because string checks miss inputs the parser rewrites: it strips tab and newline, so `/\t/evil.example` becomes `//evil.example`, it treats a backslash as a slash, and it removes dot segments, so `/.//evil.example` serialises to `//evil.example`. Anything that resolves to another origin, or to a path that would read back as one, becomes `/`; a same-origin value is returned in its re-serialised form so the header carries exactly what the parser saw.
 *
 * @param value - Where the browser asked to go, untrusted.
 * @returns A path, query and fragment on this origin, or `/` when the value was absent, unparseable or pointed elsewhere.
 */
export const sameOriginPath = (value: string | undefined): string => {
  if (value === undefined || !value.startsWith('/')) return '/';
  let resolved: URL;
  try {
    resolved = new URL(value, PROBE_ORIGIN);
  } catch {
    return '/';
  }
  // Dot-segment removal can turn `/.//evil.example` into the pathname `//evil.example`, which the browser would read back as another host.
  if (resolved.origin !== PROBE_ORIGIN || resolved.pathname.startsWith('//')) return '/';
  return `${resolved.pathname}${resolved.search}${resolved.hash}`;
};
