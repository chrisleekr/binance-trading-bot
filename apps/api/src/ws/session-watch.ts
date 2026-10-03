import { repo, type Database } from '@app/db';
import type { Redis } from 'ioredis';
import type { Logger } from 'pino';
import { SESSION_REVOCATION_CHANNEL } from '../auth/session-revocation.js';
import type { SecurityServices } from '../auth/security.js';
import { sessionExpiry, sessionLimits } from '../middleware/auth.js';

/** Close code sent when the session behind a socket has ended. In the 4000-4999 range RFC 6455 leaves to applications; the web client treats it as "sign in again", not "reconnect". */
export const WEBSOCKET_SESSION_ENDED = 4401;
/** Close code sent to the oldest socket of a session that opened one too many. */
export const WEBSOCKET_TOO_MANY = 4409;
/** Open sockets allowed per session. A dashboard uses one per open profile tab; more than this is a leak or a script. */
export const WEBSOCKETS_PER_SESSION = 5;
/** Open sockets allowed per client address, counted before any session check so a flood of upgrades cannot exhaust file descriptors. */
export const WEBSOCKETS_PER_IP_ADDRESS = 20;
/** How often every tracked session is re-read. The revocation message usually closes a socket at once; this bounds how long one survives when that message is lost. */
export const WEBSOCKET_REVALIDATE_MS = 60_000;

/** One open socket, as the watcher sees it. `close` must be safe to call on a socket that already closed. */
export interface WatchedSocket {
  readonly userId: string;
  /** Null for the live-demo identity, which has no session to end. */
  readonly sessionId: string | null;
  close(code: number, reason: string): void;
}

/** One address slot held from the upgrade check until the socket closes. Counting at reservation rather than at open is what stops a burst of concurrent upgrades from all passing the check before any of them is counted. */
export interface WebSocketReservation {
  /** Starts tracking the socket that took this slot, closing the session's oldest socket when it exceeds the per-session cap. Returns `release`, to call from the socket's close handler. */
  open(socket: WatchedSocket): () => void;
  /** Frees the slot and stops tracking the socket, if one opened. Safe to call more than once; only the first call frees anything. */
  release(): void;
}

/** Tracks open WebSockets so an ended session closes its sockets and connection counts stay bounded. */
export interface WebSocketSessionWatch {
  /** Takes one of the address's slots, or returns null when it already holds its maximum and the upgrade must be refused. The caller must `release` the reservation if no socket opens. */
  reserve(ipAddress: string): WebSocketReservation | null;
  /** Re-reads every tracked session and closes sockets whose session ended. Exposed so the revocation message and tests can run it on demand. */
  revalidate(): Promise<void>;
  /** Stops the timer and the subscription. */
  stop(): Promise<void>;
}

export interface WebSocketSessionWatchDeps {
  readonly db: Database;
  /** A dedicated connection: SUBSCRIBE puts a Redis connection into a mode where it accepts no other command. */
  readonly subscriber: Redis | null;
  readonly security: SecurityServices;
  readonly logger: Logger;
  /** Clock, injectable for tests. */
  readonly now?: () => number;
  /** Revalidation interval; tests shorten it. */
  readonly intervalMs?: number;
}

/**
 * Builds the watcher. A socket is authenticated once, at upgrade; without this, a session revoked from Settings, expired, or ended by sign-out-everywhere would keep streaming account events for as long as the tab stayed open.
 *
 * On any revocation message the watcher re-reads every tracked session from the database rather than trusting the message's contents, so a malformed or partial message can only cause an extra check, never a missed close.
 *
 * @param deps - Database, the subscriber connection, the sign-in services and the logger.
 * @returns The watcher; call `stop` on shutdown.
 */
export const createWebSocketSessionWatch = (
  deps: WebSocketSessionWatchDeps,
): WebSocketSessionWatch => {
  const now = deps.now ?? Date.now;
  const sockets = new Set<WatchedSocket>();
  const perIp = new Map<string, number>();

  const close = (
    socket: WatchedSocket,
    code: number,
    reason: 'session_ended' | 'too_many_connections',
  ): void => {
    deps.security.metrics.websocketClosed.inc({ reason });
    try {
      socket.close(code, reason);
    } catch (err) {
      deps.logger.warn({ err }, 'websocket_close_failed');
    }
  };

  const revalidate = async (): Promise<void> => {
    const tracked = [...sockets].filter((s) => s.sessionId !== null);
    if (tracked.length === 0) return;
    const policy = sessionLimits(await deps.security.settings.get());
    const t = now();
    const live = new Set<string>();
    for (const userId of new Set(tracked.map((s) => s.userId))) {
      for (const row of await repo.authIdentity.listSessions(deps.db, userId)) {
        if (row.expiresAt.getTime() > t && sessionExpiry(row, policy, t) === null) live.add(row.id);
      }
    }
    let closed = 0;
    for (const socket of tracked) {
      if (socket.sessionId !== null && !live.has(socket.sessionId)) {
        close(socket, WEBSOCKET_SESSION_ENDED, 'session_ended');
        closed += 1;
      }
    }
    if (closed > 0) {
      await deps.security.events.record({
        event: 'websocket-closed-session-invalid',
        actor: 'system',
        reason: 'session_refused',
        detail: { sockets: closed },
      });
    }
  };

  const safeRevalidate = (): void => {
    revalidate().catch((err: unknown) =>
      deps.logger.error({ err }, 'websocket_session_revalidation_failed'),
    );
  };

  const timer = setInterval(safeRevalidate, deps.intervalMs ?? WEBSOCKET_REVALIDATE_MS);
  timer.unref?.();
  if (deps.subscriber !== null) {
    deps.subscriber.on('message', (channel: string) => {
      if (channel === SESSION_REVOCATION_CHANNEL) safeRevalidate();
    });
    deps.subscriber.subscribe(SESSION_REVOCATION_CHANNEL).catch((err: unknown) => {
      // Revalidation on the timer still closes ended sessions, only later.
      deps.logger.error({ err }, 'websocket_session_revocation_subscribe_failed');
    });
  }

  return {
    reserve(ipAddress) {
      const held = perIp.get(ipAddress) ?? 0;
      if (held >= WEBSOCKETS_PER_IP_ADDRESS) {
        deps.security.metrics.limited.inc({ limit: 'websocket_connections' });
        void deps.security.events.record({
          event: 'websocket-connection-limited',
          reason: 'ip_address',
          ipAddress,
        });
        return null;
      }
      perIp.set(ipAddress, held + 1);
      let tracked: WatchedSocket | null = null;
      let released = false;
      const release = (): void => {
        if (released) return;
        released = true;
        if (tracked !== null) sockets.delete(tracked);
        const left = (perIp.get(ipAddress) ?? 1) - 1;
        if (left <= 0) perIp.delete(ipAddress);
        else perIp.set(ipAddress, left);
      };
      return {
        open(socket) {
          tracked = socket;
          sockets.add(socket);
          if (socket.sessionId !== null) {
            // Set iteration is insertion order, so the first match is the oldest socket of this session.
            const same = [...sockets].filter((s) => s.sessionId === socket.sessionId);
            const oldest = same[0];
            if (same.length > WEBSOCKETS_PER_SESSION && oldest !== undefined) {
              // Untrack before closing: the close handler runs later, and while the evicted socket stays in the set the next open would pick it as oldest again and leave one socket too many. Its address slot is still freed by its own close handler, since the connection stays open until then.
              sockets.delete(oldest);
              close(oldest, WEBSOCKET_TOO_MANY, 'too_many_connections');
            }
          }
          return release;
        },
        release,
      };
    },
    revalidate,
    async stop() {
      clearInterval(timer);
      if (deps.subscriber !== null) await deps.subscriber.quit().catch(() => undefined);
    },
  };
};

/**
 * Runs a WebSocket upgrade under a reservation and frees the slot when no socket will open, so a refused or failed upgrade does not hold an address slot forever.
 *
 * @param reservation - The slot taken by {@link WebSocketSessionWatch.reserve} for this request.
 * @param upgrade - Performs the upgrade. hono's Bun adapter resolves to undefined when the server refused to upgrade the request, and to a response when the socket will open.
 * @returns Whatever `upgrade` returned; a throw from it is rethrown after the slot is freed.
 */
export const upgradeWithReservation = async <T>(
  reservation: WebSocketReservation,
  upgrade: () => Promise<T | void>,
): Promise<T | void> => {
  try {
    const result = await upgrade();
    if (result === undefined) reservation.release();
    return result;
  } catch (err) {
    reservation.release();
    throw err;
  }
};
