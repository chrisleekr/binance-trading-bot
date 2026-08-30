import { ErrorEnvelope, type ErrorCode } from '@app/contracts';
import type { z } from 'zod';

export class ApiError extends Error {
  constructor(
    public readonly status: number,
    public readonly code: ErrorCode | 'PARSE_FAILED' | 'NETWORK_FAILED' | 'UNKNOWN',
    message: string,
    public readonly details?: unknown,
  ) {
    super(message);
    this.name = 'ApiError';
  }
}

export class UnauthenticatedError extends ApiError {
  constructor(message = 'unauthenticated', details?: unknown) {
    super(401, 'UNAUTHENTICATED', message, details);
    this.name = 'UnauthenticatedError';
  }
}

export class ValidationFailedError extends ApiError {
  constructor(message: string, details?: unknown) {
    super(422, 'VALIDATION_FAILED', message, details);
    this.name = 'ValidationFailedError';
  }
}

export class RateLimitedError extends ApiError {
  constructor(
    message: string,
    public readonly retryAfterSeconds: number | undefined,
    details?: unknown,
  ) {
    super(429, 'RATE_LIMITED', message, details);
    this.name = 'RateLimitedError';
  }
}

/**
 * Render any thrown value as a one-line, operator-facing message.
 *
 * Owns the `ApiError → "${code}: ${message}"` idiom for mutation surfaces that previously hand-rolled it, with two deliberate carve-outs rather than a clean monopoly. Surfaces wanting per-code copy (e.g. the add-symbol form) keep their own richer mapper. And a site that must show fixed copy for a non-ApiError keeps the hand-rolled ternary, because the non-Error arm here returns a driver message: the notifications panel's test-fire handler is one.
 *
 * @param err - Any thrown value, including a non-Error a driver or provider threw.
 * @returns One line of operator-facing text: `"CODE: message"` for an ApiError, the message for any other Error, and a fixed generic string otherwise. Never empty, so a caller wanting an action-specific fallback must narrow to Error first rather than rely on `|| 'x failed'`.
 */
export function errorMessage(err: unknown): string {
  if (err instanceof ApiError) return `${err.code}: ${err.message}`;
  if (err instanceof Error) return err.message;
  return 'request failed';
}

/** One server-side validation issue bound to a form field. */
export interface ServerFieldIssue {
  /** Dotted react-hook-form path, e.g. `buy.gridLevels.0.triggerPercentage`. */
  readonly name: string;
  readonly message: string;
}

/**
 * Parse a thrown value into the field-bound validation issues a form can render
 * inline. The API throws `VALIDATION_FAILED` with the zod `issues` array as
 * `details` (each `{ path, message }`); only issues with a non-empty `path` map
 * to a field. Non-validation errors (and form-level issues with no path) return
 * nothing, so the caller's generic banner still owns them.
 */
export function serverValidationErrors(err: unknown): ServerFieldIssue[] {
  if (!(err instanceof ApiError) || err.code !== 'VALIDATION_FAILED') return [];
  if (!Array.isArray(err.details)) return [];
  const issues: ServerFieldIssue[] = [];
  for (const issue of err.details) {
    if (!issue || typeof issue !== 'object') continue;
    const message = (issue as { message?: unknown }).message;
    if (typeof message !== 'string') continue;
    const path = (issue as { path?: unknown }).path;
    if (Array.isArray(path) && path.length > 0) {
      issues.push({ name: path.map(String).join('.'), message });
    }
  }
  return issues;
}

const noopUnauthorized = (_returnTo: string): void => undefined;
let onUnauthorized: (returnTo: string) => void = noopUnauthorized;

export const setOnUnauthorized = (handler: (returnTo: string) => void): void => {
  onUnauthorized = handler;
};

const env = (import.meta as unknown as { env?: Record<string, string | undefined> }).env;
const DEFAULT_BASE_URL = env?.['VITE_API_BASE_URL'] ?? '/api';
let baseUrl = DEFAULT_BASE_URL;

export const setApiBaseUrl = (url: string): void => {
  baseUrl = url;
};

export const getApiBaseUrl = (): string => baseUrl;

const parseRetryAfter = (header: string | null): number | undefined => {
  if (!header) return undefined;
  const seconds = Number(header);
  if (Number.isFinite(seconds) && seconds >= 0) return seconds;
  const date = Date.parse(header);
  if (Number.isNaN(date)) return undefined;
  return Math.max(0, Math.round((date - Date.now()) / 1000));
};

const readErrorEnvelope = async (
  response: Response,
): Promise<{ code: ErrorCode | undefined; message: string; details: unknown }> => {
  const text = await response.text();
  if (!text)
    return {
      code: undefined,
      message: response.statusText || 'request failed',
      details: undefined,
    };
  try {
    const json: unknown = JSON.parse(text);
    const parsed = ErrorEnvelope.safeParse(json);
    if (parsed.success) {
      return {
        code: parsed.data.error.code,
        message: parsed.data.error.message,
        details: parsed.data.error.details,
      };
    }
  } catch {
    // fall through
  }
  return { code: undefined, message: response.statusText || 'request failed', details: text };
};

const currentUrl = (): string => {
  if (typeof window === 'undefined') return '/';
  return window.location.pathname + window.location.search + window.location.hash;
};

/**
 * URL-encode a path segment before interpolating into an API path.
 *
 * Profile IDs are UUIDs and symbols are uppercase alphanumerics today, but
 * relying on that contract for safety couples the route layer to upstream
 * shape. Encoding at the boundary makes a slash, hash, or space in any future
 * path-param a 404 from the backend, never a malformed request.
 */
export const encodePathSegment = (segment: string): string => encodeURIComponent(segment);

/** One query-string value: scalar, or an array of scalars for repeatable params. */
type ApiQueryValue = string | number | boolean | undefined | null;

export interface ApiFetchOptions extends Omit<RequestInit, 'body'> {
  body?: unknown;
  query?: Record<string, ApiQueryValue | readonly ApiQueryValue[]>;
}

const buildUrl = (path: string, query?: ApiFetchOptions['query']): string => {
  const isAbsolute = /^https?:\/\//i.test(path);
  const base = isAbsolute ? '' : baseUrl.replace(/\/$/, '');
  const cleaned = isAbsolute ? path : path.startsWith('/') ? path : `/${path}`;
  const url = `${base}${cleaned}`;
  if (!query) return url;
  const params = new URLSearchParams();
  const appendOne = (key: string, value: ApiQueryValue): void => {
    if (value === undefined || value === null) return;
    params.append(key, String(value));
  };
  for (const [key, value] of Object.entries(query)) {
    if (
      value === undefined ||
      value === null ||
      typeof value === 'string' ||
      typeof value === 'number' ||
      typeof value === 'boolean'
    )
      appendOne(key, value);
    else for (const item of value) appendOne(key, item);
  }
  const qs = params.toString();
  return qs ? `${url}${url.includes('?') ? '&' : '?'}${qs}` : url;
};

/**
 * Builds a browser-owned download URL through the same query serializer as JSON requests so streamed responses cannot drift onto a second wire format.
 * @param path - API-relative or absolute download path without a caller-built query string.
 * @param staticQuery - Statically named query values; nullish values are omitted and arrays become repeated parameters.
 * @returns The fully encoded URL for an anchor or browser navigation sink.
 */
export const apiDownloadUrl = (
  path: string,
  staticQuery: NonNullable<ApiFetchOptions['query']>,
): string => buildUrl(path, staticQuery);

export async function apiFetch<T>(
  path: string,
  schema: z.ZodType<T>,
  options: ApiFetchOptions = {},
): Promise<T> {
  const { body, query, headers: extraHeaders, ...rest } = options;
  const headers = new Headers(extraHeaders);
  if (!headers.has('accept')) headers.set('accept', 'application/json');
  if (body !== undefined && !headers.has('content-type')) {
    headers.set('content-type', 'application/json');
  }
  const init: RequestInit = {
    credentials: 'include',
    ...rest,
    headers,
  };
  if (body !== undefined) init.body = JSON.stringify(body);

  let response: Response;
  try {
    response = await fetch(buildUrl(path, query), init);
  } catch (cause) {
    throw new ApiError(
      0,
      'NETWORK_FAILED',
      cause instanceof Error ? cause.message : 'network error',
    );
  }

  if (response.status === 401) {
    onUnauthorized(currentUrl());
    const { message, details } = await readErrorEnvelope(response);
    throw new UnauthenticatedError(message, details);
  }

  if (response.status === 422) {
    const { message, details } = await readErrorEnvelope(response);
    throw new ValidationFailedError(message, details);
  }

  if (response.status === 429) {
    const retryAfter = parseRetryAfter(response.headers.get('retry-after'));
    const { message, details } = await readErrorEnvelope(response);
    throw new RateLimitedError(message, retryAfter, details);
  }

  if (!response.ok) {
    const { code, message, details } = await readErrorEnvelope(response);
    throw new ApiError(response.status, code ?? 'UNKNOWN', message, details);
  }

  if (response.status === 204) {
    const parsed = schema.safeParse(undefined);
    if (parsed.success) return parsed.data;
    throw new ApiError(
      response.status,
      'PARSE_FAILED',
      'expected empty body to match schema',
      parsed.error,
    );
  }

  const text = await response.text();
  let json: unknown = undefined;
  if (text.length > 0) {
    try {
      json = JSON.parse(text);
    } catch (cause) {
      throw new ApiError(
        response.status,
        'PARSE_FAILED',
        'response is not valid JSON',
        cause instanceof Error ? cause.message : cause,
      );
    }
  }

  const parsed = schema.safeParse(json);
  if (!parsed.success) {
    throw new ApiError(
      response.status,
      'PARSE_FAILED',
      'response failed schema validation',
      parsed.error,
    );
  }
  return parsed.data;
}
