import { dispatchFrame } from '@/features/profile/socket/events';
import {
  clearTimer,
  REGISTRY,
  updateSnapshot,
  type SocketEntry,
} from '@/features/profile/socket/registry';

const DEFAULT_DEAD_CONN_THRESHOLD_MS = 30_000;
const BACKOFF_BASE_MS = 500;
const BACKOFF_CAP_MS = 30_000;
const NORMAL_CLOSE = 1000;

const computeBackoffMs = (attempt: number): number =>
  Math.min(BACKOFF_CAP_MS, BACKOFF_BASE_MS * 2 ** Math.max(0, attempt - 1));

/** Detach all handlers, stop the timers, and close the socket if still live. */
export const closeAndForget = (entry: SocketEntry, code = NORMAL_CLOSE): void => {
  entry.reconnectTimer = clearTimer(entry.reconnectTimer);
  if (entry.watchdogTimer !== null) {
    clearInterval(entry.watchdogTimer);
    entry.watchdogTimer = null;
  }
  if (entry.ws) {
    entry.ws.onopen = null;
    entry.ws.onclose = null;
    entry.ws.onerror = null;
    entry.ws.onmessage = null;
    if (entry.ws.readyState === WebSocket.OPEN || entry.ws.readyState === WebSocket.CONNECTING) {
      try {
        entry.ws.close(code);
      } catch {
        // The runtime may have already closed it; ignore.
      }
    }
    entry.ws = null;
  }
};

/** Drop the registry entry once its last subscriber has left. */
export const teardownIfIdle = (profileId: string, entry: SocketEntry): void => {
  if (entry.refCount > 0) return;
  closeAndForget(entry, NORMAL_CLOSE);
  REGISTRY.delete(profileId);
};

/** Open (or re-open) the per-profile WebSocket and wire its lifecycle handlers. */
export const connect = (profileId: string, entry: SocketEntry, clock: () => number): void => {
  if (entry.snapshot.status === 'unauthenticated' || entry.snapshot.status === 'offline') {
    return;
  }
  if (!entry.urlBuilder) return;
  closeAndForget(entry, NORMAL_CLOSE);
  const factory = entry.socketFactory ?? ((url: string) => new WebSocket(url));
  const url = entry.urlBuilder(entry.snapshot.lastSeq);
  let ws: WebSocket;
  try {
    ws = factory(url);
  } catch {
    scheduleReconnect(profileId, entry, clock);
    return;
  }
  entry.ws = ws;
  updateSnapshot(entry, { status: 'connecting' });

  ws.onopen = (): void => {
    updateSnapshot(entry, { status: 'open', attempt: 0 });
    if (entry.watchdogTimer !== null) clearInterval(entry.watchdogTimer);
    entry.watchdogTimer = setInterval(() => {
      const last = entry.snapshot.lastMessageAt;
      if (last !== null && clock() - last > DEFAULT_DEAD_CONN_THRESHOLD_MS) {
        // Dead connection — force-close so onclose triggers the reconnect path.
        try {
          ws.close(NORMAL_CLOSE);
        } catch {
          // ignore
        }
      }
    }, 5_000);
  };

  ws.onmessage = (event: MessageEvent): void => {
    dispatchFrame(entry, event.data, clock);
  };

  ws.onclose = (event: CloseEvent): void => {
    if (entry.watchdogTimer !== null) {
      clearInterval(entry.watchdogTimer);
      entry.watchdogTimer = null;
    }
    if (event.code === 4401) {
      // Server signals auth expiry with custom 4401; AppShell observer routes to /login.
      updateSnapshot(entry, { status: 'unauthenticated' });
      for (const handler of [...entry.unauthHandlers]) handler();
      return;
    }
    if (entry.refCount === 0) {
      updateSnapshot(entry, { status: 'closed' });
      return;
    }
    scheduleReconnect(profileId, entry, clock);
  };

  ws.onerror = (): void => {
    // onerror always precedes onclose; let onclose drive the reconnect schedule.
  };
};

/** Schedule the next reconnect attempt on the exponential-backoff curve. */
export const scheduleReconnect = (
  profileId: string,
  entry: SocketEntry,
  clock: () => number,
): void => {
  if (entry.snapshot.status === 'offline' || entry.snapshot.status === 'unauthenticated') return;
  const nextAttempt = entry.snapshot.attempt + 1;
  const delay = computeBackoffMs(nextAttempt);
  updateSnapshot(entry, { status: 'reconnecting', attempt: nextAttempt });
  entry.reconnectTimer = clearTimer(entry.reconnectTimer);
  entry.reconnectTimer = setTimeout(() => connect(profileId, entry, clock), delay);
};

/**
 * Test-only escape hatch: drop the module-level registry between cases so the
 * vitest harness starts each test from a clean slate.
 */
export const _resetProfileSocketRegistryForTests = (): void => {
  for (const [, entry] of REGISTRY) closeAndForget(entry, NORMAL_CLOSE);
  REGISTRY.clear();
};
