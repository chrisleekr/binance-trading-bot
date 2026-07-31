import type { Context } from 'hono';

/**
 * Derive the client IP from a single trusted proxy hop.
 *
 * The proxy in front of the API appends the real client to the RIGHT of any
 * incoming x-forwarded-for chain, so the leftmost entries are client-controlled
 * and forgeable. Trust exactly one hop: take the rightmost non-empty entry.
 * Falls back to x-real-ip, then a literal 'unknown' so callers keying rate
 * limits or audit rows always get a string.
 */
export const clientIp = (c: Context): string => {
  const hops = (c.req.header('x-forwarded-for') ?? '')
    .split(',')
    .map((h) => h.trim())
    .filter((h) => h.length > 0);
  const realIp = c.req.header('x-real-ip')?.trim();
  return hops.at(-1) ?? (realIp !== undefined && realIp.length > 0 ? realIp : 'unknown');
};
