/**
 * `JSON.parse` that returns `null` instead of throwing on malformed input.
 * Projections use this for Redis-cached blobs (dashboard cache, account
 * info, ticker, per-profile state) so a single corrupt value degrades to a
 * cache miss / default rather than failing the whole read with a 500.
 */
export const tryParseJson = <T>(raw: string | null): T | null => {
  if (!raw) return null;
  try {
    return JSON.parse(raw) as T;
  } catch {
    return null;
  }
};
