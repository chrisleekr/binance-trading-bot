import type { Context } from 'hono';
import { clientIpFromHeaders } from '../auth/client-address.js';

/**
 * The client IP of a Hono request, trusting exactly one proxy hop. See {@link clientIpFromHeaders} for the rule; this wrapper exists so middleware can pass a context.
 *
 * @param c - The request context.
 * @returns The trusted client address, or `unknown`.
 */
export const clientIp = (c: Context): string => clientIpFromHeaders(c.req.raw.headers);
