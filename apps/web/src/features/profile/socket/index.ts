// React bindings over the per-profile WebSocket store. Two hooks share one
// connection (`useSocketConnection`):
//   - `useProfileSocket` bridges the store into React via useSyncExternalStore
//     and runs the `isLive` ticker — use it where a component renders connection
//     state.
//   - `useProfileSocketHandlers` only registers frame/resync/unauth handlers and
//     ref-counts the connection; it does NOT subscribe to the store or run the
//     ticker, so it never re-renders on a frame. Use it where a component reacts
//     to frames but renders no connection state.
//
// The connection itself is a module-level singleton (registry.ts +
// connection.ts) so it survives re-renders, route revisits, and StrictMode
// double-mounts. Frame parsing lives in events.ts, the `isLive` ticker in
// use-liveness.ts, and the network listeners in use-network-status.ts.

import {
  useCallback,
  useEffect,
  useLayoutEffect,
  useMemo,
  useRef,
  useSyncExternalStore,
} from 'react';

import {
  connect,
  teardownIfIdle,
  _resetProfileSocketRegistryForTests,
} from '@/features/profile/socket/connection';
import {
  clearTimer,
  EMPTY_SNAPSHOT,
  ensureEntry,
  REGISTRY,
  type SocketFrame,
  type SocketSnapshot,
} from '@/features/profile/socket/registry';
import { useLiveness } from '@/features/profile/socket/use-liveness';
import { useNetworkStatus } from '@/features/profile/socket/use-network-status';

export type { SocketFrame, SocketSnapshot, SocketStatus } from '@/features/profile/socket/registry';
export { _resetProfileSocketRegistryForTests };

// StrictMode's mount → unmount → mount sequence would otherwise tear the
// connection down on every navigation; the debounce window lets the remount
// reclaim the entry before teardown runs.
const STRICT_MODE_DEBOUNCE_MS = 16;

export interface UseProfileSocketOptions {
  readonly profileId: string;
  /** Builds the WS URL given the optional `since` cursor. The hook never bakes a token in here. */
  readonly url: (since?: number | null) => string;
  /** Per-frame handler. Called inside the same microtask as `WebSocket.onmessage`. */
  readonly onMessage?: (frame: SocketFrame, snapshot: SocketSnapshot) => void;
  /** Triggered on `topic: 'resync-required'` so the caller can drop its query cache. */
  readonly onResyncRequired?: () => void;
  /** Triggered when the upgrade fails with 401 so the AppShell observer can route to /login. */
  readonly onUnauthenticated?: () => void;
  /** Test seam — defaults to globalThis.WebSocket. */
  readonly socketFactory?: (url: string) => WebSocket;
  /** Test seam — defaults to Date.now. */
  readonly clock?: () => number;
}

export interface UseProfileSocketResult extends SocketSnapshot {
  /** True iff the underlying WebSocket is `OPEN` and a frame arrived in the last 10s. */
  readonly isLive: boolean;
}

const NOOP_LISTENER = (): void => undefined;

interface SocketConnection {
  readonly subscribe: (listener: () => void) => () => void;
  readonly getSnapshot: () => SocketSnapshot;
  readonly clock: () => number;
}

/**
 * Shared connection plumbing for both public hooks: handler trampolines,
 * ref-counted subscribe/teardown, and the network/visibility listeners. Does
 * NOT bridge the store into React — that (and the liveness ticker) is layered
 * on only by `useProfileSocket`, so a caller that needs only the handlers can
 * skip the per-frame re-render entirely.
 */
const useSocketConnection = (opts: UseProfileSocketOptions): SocketConnection => {
  const optsRef = useRef(opts);
  const clock = opts.clock ?? Date.now;

  // Trampolines registered on the entry so the hook can register the *same*
  // handlers on subscribe and remove them on unsubscribe. They forward
  // through `optsRef.current` so re-renders that rebind `onMessage` are
  // honoured without reconnecting the socket. Refs are written from a
  // layout effect rather than during render — concurrent React may discard
  // a render whose ref writes never commit, leaking stale closures.
  const noopFrame = (_f: SocketFrame, _s: SocketSnapshot): void => undefined;
  const noopVoid = (): void => undefined;
  const frameHandlerRef = useRef<(f: SocketFrame, s: SocketSnapshot) => void>(noopFrame);
  const resyncHandlerRef = useRef<() => void>(noopVoid);
  const unauthHandlerRef = useRef<() => void>(noopVoid);
  useLayoutEffect(() => {
    optsRef.current = opts;
    frameHandlerRef.current = (f, s): void => {
      opts.onMessage?.(f, s);
    };
    resyncHandlerRef.current = (): void => {
      opts.onResyncRequired?.();
    };
    unauthHandlerRef.current = (): void => {
      opts.onUnauthenticated?.();
    };
  });

  const subscribe = useCallback(
    (listener: () => void) => {
      const entry = ensureEntry(opts.profileId);
      entry.listeners.add(listener);
      // Each call captures a stable thunk that delegates through the ref so
      // late-binding works without re-registering on every render.
      const onFrame = (f: SocketFrame, s: SocketSnapshot): void => frameHandlerRef.current(f, s);
      const onResync = (): void => resyncHandlerRef.current();
      const onUnauth = (): void => unauthHandlerRef.current();
      entry.frameHandlers.add(onFrame);
      entry.resyncHandlers.add(onResync);
      entry.unauthHandlers.add(onUnauth);
      // Latest subscriber wins for url/factory; in this app every consumer
      // passes the same `buildProfileWsUrl` so the choice is moot, but the
      // semantics are explicit so we don't pin a URL after the first mount.
      entry.urlBuilder = optsRef.current.url;
      entry.socketFactory = optsRef.current.socketFactory ?? null;
      entry.refCount += 1;
      entry.closeTimer = clearTimer(entry.closeTimer);
      if (!entry.ws && entry.snapshot.status !== 'unauthenticated') {
        connect(opts.profileId, entry, clock);
      }

      return (): void => {
        entry.listeners.delete(listener);
        entry.frameHandlers.delete(onFrame);
        entry.resyncHandlers.delete(onResync);
        entry.unauthHandlers.delete(onUnauth);
        entry.refCount -= 1;
        if (entry.refCount === 0) {
          entry.closeTimer = setTimeout(() => {
            const e = REGISTRY.get(opts.profileId);
            if (e && e.refCount === 0) teardownIfIdle(opts.profileId, e);
          }, STRICT_MODE_DEBOUNCE_MS);
        }
      };
    },
    [opts.profileId, clock],
  );

  const getSnapshot = useCallback((): SocketSnapshot => {
    const entry = REGISTRY.get(opts.profileId);
    return entry?.snapshot ?? EMPTY_SNAPSHOT;
  }, [opts.profileId]);

  // NOTE: `useNetworkStatus` is intentionally NOT called here. Its effect must
  // run AFTER the subscribe effect that creates the registry entry, so each
  // public hook calls it below, after wiring its subscription.
  return { subscribe, getSnapshot, clock };
};

/**
 * Subscribe to (and ref-count) the per-profile WebSocket. The returned snapshot
 * is referentially stable while the underlying state is unchanged so React's
 * shallow equality checks short-circuit re-renders. Use this when a component
 * actually renders connection state (`isLive`, snapshot fields).
 */
export const useProfileSocket = (opts: UseProfileSocketOptions): UseProfileSocketResult => {
  const { subscribe, getSnapshot, clock } = useSocketConnection(opts);
  const snapshot = useSyncExternalStore(subscribe, getSnapshot, getSnapshot);
  // After the store subscription (which creates the registry entry), so the
  // network listeners attach to a live entry on first mount.
  useNetworkStatus(opts.profileId, clock);
  const isLive = useLiveness(snapshot, clock);
  return useMemo<UseProfileSocketResult>(() => ({ ...snapshot, isLive }), [snapshot, isLive]);
};

/**
 * Register frame/resync/unauth handlers and ref-count the connection WITHOUT
 * subscribing to the snapshot store or running the liveness ticker. A component
 * that only reacts to frames (e.g. to invalidate queries) and never renders
 * connection state must use this — otherwise `useSyncExternalStore` re-renders
 * it on every WS frame and the 1 Hz liveness tick, for a value it never reads.
 */
export const useProfileSocketHandlers = (opts: UseProfileSocketOptions): void => {
  const { subscribe, clock } = useSocketConnection(opts);
  // A no-op store listener: subscribe still ref-counts the connection and wires
  // the handler trampolines, but snapshot notifications fall on the floor, so
  // this component never re-renders on a frame. Declared before useNetworkStatus
  // so the subscribe effect creates the registry entry first.
  useEffect(() => subscribe(NOOP_LISTENER), [subscribe]);
  useNetworkStatus(opts.profileId, clock);
};
