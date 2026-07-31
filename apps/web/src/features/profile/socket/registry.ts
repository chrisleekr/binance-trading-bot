// The external store behind useProfileSocket.
//
// Why a module-level Map instead of React state: the connection MUST survive
// re-renders, route revisits, and StrictMode double-mounts. Multiple consumers
// in the same route share one socket via ref-counting. This file owns only the
// state; connection.ts owns the WebSocket lifecycle that mutates it.

import type { WsEvent } from '@app/contracts';

export type SocketStatus =
  | 'connecting'
  | 'open'
  | 'reconnecting'
  | 'offline'
  | 'unauthenticated'
  | 'closed';

export interface SocketSnapshot {
  /** Coarse-grained status driving the live indicator. */
  readonly status: SocketStatus;
  /** Last server-assigned sequence; sent back as `?since=<lastSeq>` on reconnect. */
  readonly lastSeq: number | null;
  /** Wall-clock ms when the socket last received any frame. */
  readonly lastMessageAt: number | null;
  /** Current reconnect attempt index — drives the backoff schedule. */
  readonly attempt: number;
}

/**
 * The server→client frame. This is the canonical `WsEvent` discriminated
 * union from `@app/contracts` — narrowing on `frame.topic` yields the typed
 * payload for that topic, so consumers never cast `payload`. Re-aliased here
 * (rather than re-declared) so the web cannot drift from the contract.
 */
export type SocketFrame = WsEvent;

/**
 * Per-profile entry tracked by the module-level registry. The four `Set`s
 * are why the hook supports multiple consumers safely: every subscriber
 * registers its own frame/resync/unauth callbacks, and the `ws.onmessage`
 * handler iterates the sets so the callback that fires for a given frame is
 * always the *current* subscriber's, not whoever connected first. Without
 * this fan-out, mounting the hook in two route components for the same
 * profile would silently drop frames into the first-mounted handler.
 */
export interface SocketEntry {
  ws: WebSocket | null;
  refCount: number;
  closeTimer: ReturnType<typeof setTimeout> | null;
  reconnectTimer: ReturnType<typeof setTimeout> | null;
  watchdogTimer: ReturnType<typeof setInterval> | null;
  snapshot: SocketSnapshot;
  paused: boolean;
  listeners: Set<() => void>;
  frameHandlers: Set<(frame: SocketFrame, snap: SocketSnapshot) => void>;
  resyncHandlers: Set<() => void>;
  unauthHandlers: Set<() => void>;
  /** Set by the most recent subscriber; reused by reconnects so all consumers see the same `since` cursor. */
  urlBuilder: ((since?: number | null) => string) | null;
  socketFactory: ((url: string) => WebSocket) | null;
}

export const REGISTRY = new Map<string, SocketEntry>();

// Frozen singleton returned by `getSnapshot` before `subscribe` has created
// the registry entry. useSyncExternalStore calls getSnapshot during render
// and rejects a fresh object each call as an infinite loop, so the no-entry
// fallback must be referentially stable.
export const EMPTY_SNAPSHOT: SocketSnapshot = Object.freeze({
  status: 'connecting',
  lastSeq: null,
  lastMessageAt: null,
  attempt: 0,
});

const initialSnapshot = (): SocketSnapshot => ({ ...EMPTY_SNAPSHOT });

export const ensureEntry = (profileId: string): SocketEntry => {
  let entry = REGISTRY.get(profileId);
  if (!entry) {
    entry = {
      ws: null,
      refCount: 0,
      closeTimer: null,
      reconnectTimer: null,
      watchdogTimer: null,
      snapshot: initialSnapshot(),
      paused: false,
      listeners: new Set(),
      frameHandlers: new Set(),
      resyncHandlers: new Set(),
      unauthHandlers: new Set(),
      urlBuilder: null,
      socketFactory: null,
    };
    REGISTRY.set(profileId, entry);
  }
  return entry;
};

export const updateSnapshot = (entry: SocketEntry, patch: Partial<SocketSnapshot>): void => {
  entry.snapshot = { ...entry.snapshot, ...patch };
  for (const listener of entry.listeners) listener();
};

export const clearTimer = (handle: ReturnType<typeof setTimeout> | null): null => {
  if (handle !== null) clearTimeout(handle);
  return null;
};
