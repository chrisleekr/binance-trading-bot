import { createHmac, randomBytes, timingSafeEqual } from 'node:crypto';

/** Name of the cookie that marks a browser the operator has signed in from before. */
export const KNOWN_DEVICE_COOKIE = 'app.known_device';

interface KnownDevicePayload {
  /** Better Auth user id the browser signed in as. */
  readonly u: string;
  /** Security epoch at issue; a sign-out-everywhere raises the epoch and so invalidates every known device. */
  readonly e: number;
  /** Expiry, ms since epoch. */
  readonly x: number;
  /** Random value so two cookies are never equal. */
  readonly n: string;
}

/** Derives the signing key from AUTH_SECRET under a label of its own, so this cookie's MAC can never be confused with any other value signed by the same secret. */
const keyFor = (secret: string): Buffer =>
  createHmac('sha256', secret).update('known-device-cookie/v1').digest();

/**
 * Issues a known-device cookie value.
 *
 * A known device exempts the operator's own browser from the per-email lockout and the site-wide backoff, which are the two limits a stranger can trip on the operator's behalf. It grants no access: the browser still needs the password or single sign-on, and still faces the per-IP limit.
 *
 * @param secret - AUTH_SECRET.
 * @param userId - The user that just signed in.
 * @param securityEpoch - The current security epoch.
 * @param lifetimeMs - How long the browser stays recognised.
 * @param now - Clock, injectable for tests.
 * @returns The signed cookie value.
 */
export const issueKnownDevice = (
  secret: string,
  userId: string,
  securityEpoch: number,
  lifetimeMs: number,
  now: number = Date.now(),
): string => {
  const payload: KnownDevicePayload = {
    u: userId,
    e: securityEpoch,
    x: now + lifetimeMs,
    n: randomBytes(12).toString('base64url'),
  };
  const body = Buffer.from(JSON.stringify(payload)).toString('base64url');
  const mac = createHmac('sha256', keyFor(secret)).update(body).digest('base64url');
  return `${body}.${mac}`;
};

/**
 * Whether a cookie value is a valid, current known-device mark for this user.
 *
 * @param secret - AUTH_SECRET.
 * @param value - The cookie value, possibly absent or forged.
 * @param userId - The sole operator's user id.
 * @param securityEpoch - The current security epoch; a mark from an older epoch is refused.
 * @param now - Clock, injectable for tests.
 * @returns True only for an authentic, unexpired mark issued to this user under the current epoch.
 */
export const isKnownDevice = (
  secret: string,
  value: string | undefined,
  userId: string | null,
  securityEpoch: number,
  now: number = Date.now(),
): boolean => {
  if (value === undefined || userId === null) return false;
  const dot = value.indexOf('.');
  if (dot <= 0) return false;
  const body = value.slice(0, dot);
  const given = Buffer.from(value.slice(dot + 1), 'base64url');
  const expected = createHmac('sha256', keyFor(secret)).update(body).digest();
  if (given.length !== expected.length || !timingSafeEqual(given, expected)) return false;
  try {
    const payload = JSON.parse(
      Buffer.from(body, 'base64url').toString('utf8'),
    ) as Partial<KnownDevicePayload>;
    return (
      payload.u === userId &&
      payload.e === securityEpoch &&
      typeof payload.x === 'number' &&
      payload.x > now
    );
  } catch {
    return false;
  }
};

/**
 * The `Set-Cookie` header value for a known-device mark. Strict, httpOnly and path-wide; `secure` whenever the app runs in production.
 *
 * @param value - The signed value from {@link issueKnownDevice}.
 * @param lifetimeMs - Cookie lifetime.
 * @param secure - Whether to set the `Secure` attribute.
 * @returns The header value.
 */
export const knownDeviceSetCookie = (value: string, lifetimeMs: number, secure: boolean): string =>
  `${KNOWN_DEVICE_COOKIE}=${value}; Path=/; HttpOnly; SameSite=Strict; Max-Age=${Math.floor(lifetimeMs / 1000)}${secure ? '; Secure' : ''}`;
