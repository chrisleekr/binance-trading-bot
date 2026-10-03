import type { Redis } from 'ioredis';
import type { DI } from '../di.js';

/** Redis channel every api replica listens on to close live connections whose session just ended. */
export const SESSION_REVOCATION_CHANNEL = 'auth:session-revoked';

/**
 * Which live connections to close.
 * - `sessionIds`: exactly these sessions.
 * - `userId` with `exceptSessionIds`: every session of the user except those listed.
 */
export type SessionRevocation =
  | { readonly sessionIds: readonly string[] }
  | { readonly userId: string; readonly exceptSessionIds: readonly string[] };

/**
 * Tells every api replica to close live connections for sessions that just ended. Deleting a session row stops its next HTTP request, but a WebSocket authenticated at upgrade keeps streaming until something closes it. The periodic revalidation in the WebSocket router is the backstop when this message is lost.
 *
 * @param di - The container.
 * @param revocation - Which sessions ended.
 * @returns Nothing; a failed publish is logged, and revalidation closes the connection within its interval regardless.
 */
export const publishSessionRevocation = async (
  di: DI,
  revocation: SessionRevocation,
): Promise<void> => {
  try {
    await publishSessionRevocationOn(di.redis.raw(), revocation);
  } catch (err) {
    di.logger.warn({ err }, 'session_revocation_publish_failed');
  }
};

/**
 * The same message on a given connection, for the recovery command, which has no container. Throws on failure; the command reports it, and revalidation closes the sockets within its interval regardless.
 *
 * @param redis - Any connection not in subscriber mode.
 * @param revocation - Which sessions ended.
 * @returns Nothing.
 */
export const publishSessionRevocationOn = async (
  redis: Pick<Redis, 'publish'>,
  revocation: SessionRevocation,
): Promise<void> => {
  await redis.publish(SESSION_REVOCATION_CHANNEL, JSON.stringify(revocation));
};
