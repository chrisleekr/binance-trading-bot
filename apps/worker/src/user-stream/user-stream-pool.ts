// UserStreamPool: one user-data WS connection per enabled profile.
//
// Lifecycle (post-2025-10-24 ws-api subscribe.signature flow):
//   1. open(profileId)
//        → WS  wss://ws-api.*/ws-api/v3
//        → send `userDataStream.subscribe.signature` (HMAC-signed)
//        → ack `{ status:200, result: { subscriptionId } }`
//        → resync tick enqueued for every symbol the profile owns
//   2. close(profileId)             (graceful shutdown)
//        → ws.close()
//
// Connection liveness is owned by the pool itself. Two mechanisms together
// distinguish "healthy but quiet" from "half-dead":
//   a) Per-connection application-level heartbeat: every `heartbeatIntervalMs`
//      the pool sends a Binance ws-api `ping` RPC (`{id:"hb-N",method:"ping"}`)
//      and treats the matching response as proof the channel is alive — even
//      when the wallet sees no account events for hours.
//   b) `startConnectionWatchdog()` schedules a 60s timer that reconnects any
//      stream whose `lastMessageMs` is older than `idleThresholdMs`. With the
//      heartbeat seeded, `lastMessageMs` advances on every pong; the watchdog
//      now only fires on a genuinely silent socket (TCP up, server stopped).
//   c) The same watchdog keeps a SECOND, slower clock: `lastAccountEventMs`,
//      written only on a recognised account event. A pong proves the socket is
//      alive and nothing else, so a ws-api connection that keeps ponging while
//      its user-data subscription has stopped pushing is invisible to (b). Past
//      `accountEventIdleMs` the pool reconnects, resyncs, and raises
//      `onStreamSilent` so the consumer can converge positions against the
//      exchange — a fill that landed in that window was never delivered.
// The retired REST `listenKey` keepalive cron is intentionally absent.
//
// On every executionReport / balanceUpdate, the pool emits a tick onto the
// EventRouter (single-profile route; only the owning profile cares).
//
// Per-profile credentials and Binance mode (live / test) are resolved
// via the deps.credentials lookup so the pool stays I/O-free for tests.

import type { Logger } from 'pino';
import type { AccountId, ProfileId, UserId } from '@app/contracts';
import type { BinanceWs, BinanceWsFactory } from 'market-data/binance-ws.js';
import {
  type BinanceMode,
  type BinanceRestClient,
  BINANCE_WS_API_HOSTS,
  parseUserStreamFrame,
  type UserStreamEvent as WireUserStreamEvent,
} from '@app/binance';

/**
 * Worker-side user-stream event: the Binance wire event (decoded by
 * `@app/binance`) plus the `(userId, profileId)` envelope the pool attaches
 * at dispatch so the event router can route to the owning profile. The
 * intersection distributes over the wire union, so each variant keeps its
 * `kind` discriminant.
 *
 * The Binance trade id (`tradeId`) is unique per fill within an order; the
 * fill-adopter combines it with orderId for the idempotency key so a
 * duplicated executionReport (reconnect replay) mutates state exactly once.
 */
export type UserStreamEvent = WireUserStreamEvent & {
  readonly userId: UserId;
  readonly profileId: ProfileId;
};

export interface UserStreamHandlers {
  onEvent(event: UserStreamEvent): Promise<void> | void;
  onResync(userId: UserId, profileId: ProfileId): Promise<void> | void;
}

export interface ProfileBinanceCredentials {
  readonly mode: BinanceMode;
  readonly rest: BinanceRestClient;
}

export interface UserStreamDeps {
  // Credentials are per-account (one key pair shared by every profile under the
  // account), so the pool resolves them by (operatorId, accountId), not per profile.
  readonly resolveCredentials: (
    operatorId: UserId,
    accountId: AccountId,
  ) => Promise<ProfileBinanceCredentials | null>;
  readonly factory: BinanceWsFactory;
  readonly handlers: UserStreamHandlers;
  readonly logger: Logger;
  /**
   * Injected clock so the watchdog can be exercised deterministically in
   * tests. Production defaults to `Date.now`.
   */
  readonly nowMs?: () => number;
  /**
   * Per-connection heartbeat cadence. Each open socket pings Binance ws-api
   * at this interval; the matching response advances `lastMessageMs`. Must
   * be safely smaller than the watchdog idle threshold so a healthy quiet
   * stream cannot trip a reconnect.
   * Defaults to 30000 (30s).
   */
  readonly heartbeatIntervalMs?: number;
  /**
   * How long a connection may go without a RECOGNISED ACCOUNT EVENT before the
   * watchdog distrusts it, reconnects, and resyncs. Distinct from the idle
   * threshold, which is about the socket: a heartbeat pong proves the socket is
   * alive, and nothing more. A socket that is alive but has silently stopped
   * delivering account events looks perfectly healthy to the idle check — that
   * is the failure this threshold catches.
   * Defaults to 2700000 (45 min).
   */
  readonly accountEventIdleMs?: number;
  /**
   * Fired when the account-event clock exceeds {@link accountEventIdleMs}, after
   * the reconnect + resync. `ageMs` is how long the stream had been quiet.
   *
   * Silence is NOT proof of a broken stream (Binance emits an account event only
   * on a balance change, so a profile holding an untouched position is quiet by
   * design). It IS the window in which a missed fill would be invisible, so the
   * consumer converges the profile's positions against exchange truth. Optional;
   * omission just means no consumer is listening.
   */
  readonly onStreamSilent?: (
    operatorId: UserId,
    accountId: AccountId,
    profileId: ProfileId,
    ageMs: number,
  ) => Promise<void> | void;
}

/**
 * Watchdog tuning. The defaults match the prior 15-minute cron's effective
 * reconnect cadence (idle for ≥90s before reconnect, polled every 60s) so
 * the change is behaviour-compatible with the cron-driven path.
 */
export interface ConnectionWatchdogOptions {
  /** Poll cadence in milliseconds. Defaults to 60000 (60s). */
  readonly intervalMs?: number;
  /**
   * Connection is reconnected when `nowMs() - lastMessageMs > idleThresholdMs`.
   * Defaults to 90000 (90s).
   */
  readonly idleThresholdMs?: number;
}

export interface UserStreamPool {
  open(operatorId: UserId, accountId: AccountId, profileId: ProfileId): Promise<void>;
  close(operatorId: UserId, accountId: AccountId, profileId: ProfileId): Promise<void>;
  closeAll(): Promise<void>;
  /**
   * Schedule the in-process watchdog. Idempotent: calling twice replaces
   * the prior timer. Returns a `stop()` handle so `closeAll()` can cancel
   * it during graceful shutdown.
   */
  startConnectionWatchdog(options?: ConnectionWatchdogOptions): () => void;
  /**
   * Run the watchdog tick once (no setInterval). Exposed so tests can
   * drive reconnect deterministically without sleeping.
   */
  runWatchdogOnce(idleThresholdMs?: number): Promise<void>;
  /** Inspection hook used by tests. */
  isOpen(profileId: ProfileId): boolean;
}

interface ConnectionState {
  operatorId: UserId;
  accountId: AccountId;
  rest: BinanceRestClient;
  mode: BinanceMode;
  ws: BinanceWs;
  subscriptionId: number | null;
  /** Epoch-ms of the last `onMessage` frame seen on this socket (heartbeat pongs included). */
  lastMessageMs: number;
  /**
   * Epoch-ms of the last RECOGNISED ACCOUNT EVENT. A separate clock from
   * `lastMessageMs` on purpose: pongs keep that one fresh forever, which is
   * correct for "is the socket alive" and useless for "is this stream still
   * delivering my fills".
   */
  lastAccountEventMs: number;
  /** Monotonic counter sourcing heartbeat request ids. */
  pingSeq: number;
  /** Periodic heartbeat timer; cleared on close/reconnect. */
  heartbeatTimer: ReturnType<typeof setInterval> | null;
}

const DEFAULT_WATCHDOG_INTERVAL_MS = 60_000;
const DEFAULT_WATCHDOG_IDLE_MS = 90_000;
const DEFAULT_HEARTBEAT_INTERVAL_MS = 30_000;
// 45 min without an account event. Long, deliberately: a quiet stream is the
// NORMAL state for a profile holding a position nothing is trading against, and
// each trip costs a reconnect + a resync + a reconcile fan-out. Short enough that
// a genuinely dead stream is caught within an hour rather than at the next
// restart.
const DEFAULT_ACCOUNT_EVENT_IDLE_MS = 2_700_000;
// Floor so a misconfigured caller cannot turn every watchdog tick into a
// reconnect storm. Well above the watchdog's own poll cadence.
const MIN_ACCOUNT_EVENT_IDLE_MS = 60_000;
// Floor heartbeat cadence so a misconfigured caller cannot hammer the
// ws-api with ping RPCs. The watchdog floor is 5s; keep the heartbeat
// floor below that so heartbeats remain meaningful liveness signals.
const MIN_HEARTBEAT_INTERVAL_MS = 1_000;
// Heartbeat request ids carry this prefix so the frame router can
// distinguish them from the subscribe ack (which uses the profileId).
const HEARTBEAT_ID_PREFIX = 'hb-';
// Floors stop a misconfigured caller from hammering Binance with
// subscribe.signature requests. Each reconnect runs an HMAC + a full
// resync; a sub-second loop would melt the rate limit. Tests that need
// fast feedback drive `runWatchdogOnce` directly instead of relying on
// the timer.
const MIN_WATCHDOG_INTERVAL_MS = 5_000;
const MIN_WATCHDOG_IDLE_MS = 5_000;

// Binance ws-api requires request `id` to match /^[a-zA-Z0-9-_]{1,36}$/.
// Colons and full UUIDs-with-prefix violate the regex / 36-char cap; use
// only alphanumerics + dashes so profileId (36-char UUID) fits as-is.
const subscribeId = (profileId: string): string => profileId;

export const createUserStreamPool = (deps: UserStreamDeps): UserStreamPool => {
  const conns = new Map<ProfileId, ConnectionState>();
  // Intended-open set: every profile `open()` ever added that has not been
  // explicitly `close()`d. The watchdog walks this — not `conns` — so a
  // server-side WS close (which deletes the conn) is still reconnected
  // next tick. Without this, a Binance disconnect would silently strand a
  // profile until the worker is restarted, which is the exact failure
  // mode the retired keepalive cron used to mask.
  const intended = new Map<ProfileId, { operatorId: UserId; accountId: AccountId }>();
  const nowMs = deps.nowMs ?? ((): number => Date.now());
  const heartbeatIntervalMs = Math.max(
    deps.heartbeatIntervalMs ?? DEFAULT_HEARTBEAT_INTERVAL_MS,
    MIN_HEARTBEAT_INTERVAL_MS,
  );
  const accountEventIdleMs = Math.max(
    deps.accountEventIdleMs ?? DEFAULT_ACCOUNT_EVENT_IDLE_MS,
    MIN_ACCOUNT_EVENT_IDLE_MS,
  );
  let watchdogTimer: ReturnType<typeof setInterval> | null = null;

  // Frame router. The ws-api connection carries two kinds of messages:
  // 1) request/response acks (have an `id` matching our outgoing call), and
  // 2) server-pushed events (have `event.e`, no `id`).
  const handleFrame = (state: ConnectionState, profileId: ProfileId, raw: string): void => {
    let data: Record<string, unknown>;
    try {
      data = JSON.parse(raw) as Record<string, unknown>;
    } catch (err) {
      deps.logger.warn({ profileId, err: err }, 'user-stream invalid JSON');
      return;
    }
    if (typeof data['id'] === 'string') {
      // Heartbeat pong: proves the channel is alive when no account
      // events are flowing. Bump `lastMessageMs` so the watchdog treats
      // a healthy quiet stream as live.
      if (data['id'].startsWith(HEARTBEAT_ID_PREFIX)) {
        state.lastMessageMs = nowMs();
        return;
      }
      const result = data['result'] as { subscriptionId?: number } | undefined;
      if (result && typeof result.subscriptionId === 'number') {
        state.subscriptionId = result.subscriptionId;
        deps.logger.info(
          { profileId, subscriptionId: result.subscriptionId },
          'user-stream subscribed',
        );
      } else if (data['error']) {
        deps.logger.error(
          { profileId, err: JSON.stringify(data['error']) },
          'user-stream subscribe rejected',
        );
      }
      return;
    }
    // Account event push. `@app/binance` owns the Binance wire shape and
    // the event-wrapper tolerance; the pool only attaches the (userId,
    // profileId) envelope and routes. `null` covers acks / heartbeats /
    // unknown event types — none of which prove account-stream liveness, so
    // `lastMessageMs` is bumped only on a recognised event.
    const event = parseUserStreamFrame(data);
    if (event === null) return;
    state.lastMessageMs = nowMs();
    // The ONLY write to the account-event clock. A pong must never reach it, or
    // the clock proves nothing the socket clock did not already prove.
    state.lastAccountEventMs = state.lastMessageMs;
    Promise.resolve(deps.handlers.onEvent({ ...event, userId: state.operatorId, profileId })).catch(
      (err: unknown) => {
        deps.logger.error(
          { profileId, kind: event.kind, err: err },
          'user-stream onEvent handler failed',
        );
      },
    );
  };

  const sendHeartbeat = (state: ConnectionState, profileId: ProfileId): void => {
    state.pingSeq += 1;
    const id = `${HEARTBEAT_ID_PREFIX}${state.pingSeq}`;
    try {
      state.ws.send(JSON.stringify({ id, method: 'ping', params: {} }));
    } catch (err) {
      // ws closed mid-send; onClose tears down. Log at debug since the
      // watchdog will recover on the next tick.
      deps.logger.debug({ profileId, err: err }, 'user-stream heartbeat send failed');
    }
  };

  const startHeartbeat = (state: ConnectionState, profileId: ProfileId): void => {
    if (state.heartbeatTimer !== null) clearInterval(state.heartbeatTimer);
    state.heartbeatTimer = setInterval(() => {
      sendHeartbeat(state, profileId);
    }, heartbeatIntervalMs);
    const t = state.heartbeatTimer as unknown as { unref?: () => void };
    t.unref?.();
  };

  const stopHeartbeat = (state: ConnectionState): void => {
    if (state.heartbeatTimer !== null) {
      clearInterval(state.heartbeatTimer);
      state.heartbeatTimer = null;
    }
  };

  const wireWs = (state: ConnectionState, profileId: ProfileId): void => {
    state.ws.onOpen(() => {
      const payload = state.rest.signWsApiPayload(
        subscribeId(profileId),
        'userDataStream.subscribe.signature',
      );
      state.ws.send(JSON.stringify(payload));
      // Start the heartbeat once the socket is open. Subscribe and
      // heartbeat are independent — heartbeat proves channel liveness
      // even if the subscribe ack is delayed or replayed.
      startHeartbeat(state, profileId);
    });
    state.ws.onMessage((data) => {
      // Bump `lastMessageMs` only on the event-push branch inside
      // handleFrame (executionReport / balanceUpdate / outboundAccountPosition).
      // Subscribe-acks and ws-library pong frames are not proof of stream
      // liveness — they could keep the watchdog clock fresh on a half-dead
      // socket that has stopped delivering account events.
      handleFrame(state, profileId, data);
    });
    state.ws.onError((err) => deps.logger.warn({ profileId, err: err }, 'user-stream WS error'));
    state.ws.onClose(() => {
      deps.logger.warn({ profileId }, 'user-stream WS closed');
      // Stop the heartbeat unconditionally — even if this onClose
      // belongs to a stale socket replaced by a newer connection, the
      // stale state's timer is per-connection and safe to clear.
      stopHeartbeat(state);
      // Compare-and-delete: only drop the entry when it is still THIS
      // socket. The watchdog tears down a stale socket and then
      // openInternal-s a replacement — if the stale socket's deferred
      // onClose lands after the replacement is in `conns`, an
      // unconditional delete would clobber the new live connection and
      // strand the profile until the next watchdog tick.
      if (conns.get(profileId) === state) {
        conns.delete(profileId);
      }
    });
  };

  const openInternal = async (
    operatorId: UserId,
    accountId: AccountId,
    profileId: ProfileId,
  ): Promise<void> => {
    if (conns.has(profileId)) return;
    const creds = await deps.resolveCredentials(operatorId, accountId);
    if (!creds) {
      deps.logger.warn({ profileId }, 'user-stream open: no credentials available');
      return;
    }
    const wsHost = BINANCE_WS_API_HOSTS[creds.mode];
    const ws = deps.factory(wsHost);
    const state: ConnectionState = {
      operatorId,
      accountId,
      rest: creds.rest,
      mode: creds.mode,
      ws,
      subscriptionId: null,
      // Seed with `now` so a freshly-opened socket isn't immediately
      // flagged as idle before the first server frame arrives. Seeding the
      // account-event clock here is also what makes the silence trip
      // once-per-window BY CONSTRUCTION: the reconnect the trip causes re-enters
      // this function and rearms the clock.
      lastMessageMs: nowMs(),
      lastAccountEventMs: nowMs(),
      pingSeq: 0,
      heartbeatTimer: null,
    };
    conns.set(profileId, state);
    wireWs(state, profileId);
    deps.logger.info({ profileId, mode: creds.mode }, 'user-stream WS opened');
  };

  // Tear down a live-but-distrusted socket and open a fresh one. Shared by both
  // watchdog reconnect paths (socket silent / account stream silent) so the
  // teardown ordering — stop heartbeat, drop from `conns`, close, reopen, resync
  // — exists once. The reopen reseeds both liveness clocks, which is what makes a
  // repeated trip impossible until the next full idle window elapses.
  const reconnect = async (
    state: ConnectionState,
    operatorId: UserId,
    accountId: AccountId,
    profileId: ProfileId,
  ): Promise<void> => {
    const stale = state.ws;
    stopHeartbeat(state);
    conns.delete(profileId);
    try {
      stale.close();
    } catch (err) {
      deps.logger.warn({ profileId, err: err }, 'user-stream watchdog: stale ws.close threw');
    }
    try {
      await openInternal(operatorId, accountId, profileId);
      if (conns.has(profileId)) await deps.handlers.onResync(operatorId, profileId);
    } catch (err) {
      deps.logger.error({ profileId, err: err }, 'user-stream watchdog: reconnect failed');
    }
  };

  return {
    async open(operatorId, accountId, profileId) {
      // Record intent first so a partial-failure path (credentials resolve
      // OK but the WS handshake throws) is still reconnected by the
      // watchdog on the next tick.
      intended.set(profileId, { operatorId, accountId });
      try {
        await openInternal(operatorId, accountId, profileId);
        // Race: a concurrent close(profileId) could have revoked intent
        // while we were awaiting openInternal. Drop the freshly-opened
        // socket so the invariant "intended ⊇ conns" holds and the
        // watchdog never sees an orphan connection.
        if (!intended.has(profileId)) {
          const orphan = conns.get(profileId);
          if (orphan) {
            conns.delete(profileId);
            orphan.ws.close();
          }
          return;
        }
        await deps.handlers.onResync(operatorId, profileId);
      } catch (err) {
        deps.logger.error({ profileId, err: err }, 'user-stream open failed');
        throw err;
      }
    },
    async close(_operatorId, _accountId, profileId) {
      // Explicit close revokes intent so the watchdog stops reopening it.
      intended.delete(profileId);
      const state = conns.get(profileId);
      if (!state) return;
      stopHeartbeat(state);
      conns.delete(profileId);
      state.ws.close();
    },
    async closeAll() {
      // Stop the watchdog before tearing down sockets so a tick in
      // flight can't race the close and re-open a profile we just
      // closed.
      if (watchdogTimer !== null) {
        clearInterval(watchdogTimer);
        watchdogTimer = null;
      }
      // Walk intent so a profile in the intended set with no live conn
      // (e.g. reconnect-in-progress) is still revoked from intent.
      const entries = Array.from(intended.entries());
      for (const [id, { operatorId, accountId }] of entries) {
        await this.close(operatorId, accountId, id);
      }
    },
    startConnectionWatchdog(options) {
      const intervalMs = Math.max(
        options?.intervalMs ?? DEFAULT_WATCHDOG_INTERVAL_MS,
        MIN_WATCHDOG_INTERVAL_MS,
      );
      const idleThresholdMs = Math.max(
        options?.idleThresholdMs ?? DEFAULT_WATCHDOG_IDLE_MS,
        MIN_WATCHDOG_IDLE_MS,
      );
      // Idempotent: a second call replaces the timer rather than stacking.
      if (watchdogTimer !== null) clearInterval(watchdogTimer);
      watchdogTimer = setInterval(() => {
        void this.runWatchdogOnce(idleThresholdMs);
      }, intervalMs);
      // `unref` lets the worker exit cleanly even with the timer armed —
      // relevant in tests where the pool outlives the test runner's
      // event loop. `unref` is Node-only; guard for non-Node runtimes.
      const t = watchdogTimer as unknown as { unref?: () => void };
      t.unref?.();
      return () => {
        if (watchdogTimer !== null) {
          clearInterval(watchdogTimer);
          watchdogTimer = null;
        }
      };
    },
    async runWatchdogOnce(idleThresholdMs = DEFAULT_WATCHDOG_IDLE_MS) {
      const now = nowMs();
      // Walk the intent set so a server-side close (which deletes from
      // `conns`) is still reconnected. Snapshot first because the inner
      // reconnect awaits and could be re-entered by a concurrent caller.
      const snapshot = Array.from(intended.entries());
      for (const [profileId, { operatorId, accountId }] of snapshot) {
        const state = conns.get(profileId);

        // Case 1: socket missing entirely (e.g. server closed it and the
        // onClose handler dropped the entry). Just open it.
        if (state === undefined) {
          deps.logger.warn({ profileId }, 'user-stream watchdog: connection missing, reopening');
          try {
            await openInternal(operatorId, accountId, profileId);
            if (conns.has(profileId)) await deps.handlers.onResync(operatorId, profileId);
          } catch (err) {
            deps.logger.error({ profileId, err: err }, 'user-stream watchdog: reopen failed');
          }
          continue;
        }

        // Case 2: the SOCKET went quiet past the idle threshold — no frames at
        // all, not even a pong. Tear down + reopen so a half-dead connection
        // (TCP up, no traffic) doesn't strand the profile.
        if (now - state.lastMessageMs > idleThresholdMs) {
          const ageMs = now - state.lastMessageMs;
          deps.logger.warn(
            { profileId, ageMs, idleThresholdMs },
            'user-stream watchdog: idle threshold exceeded, reconnecting',
          );
          await reconnect(state, operatorId, accountId, profileId);
          continue;
        }

        // Case 3: the socket is answering pings, but the ACCOUNT stream has
        // delivered nothing for a long time. This is the failure Case 2 cannot
        // see: a ws-api connection that keeps ponging while its user-data
        // subscription has silently stopped pushing. The pool cannot distinguish
        // that from a genuinely quiet wallet, so it does the one thing that is
        // safe under both readings — reconnect, resync, and let the consumer
        // converge the profile's positions against the exchange.
        const accountAgeMs = now - state.lastAccountEventMs;
        if (accountAgeMs <= accountEventIdleMs) continue;
        deps.logger.warn(
          { profileId, accountAgeMs, accountEventIdleMs },
          'user-stream watchdog: no account event for the idle window, reconnecting to verify the stream',
        );
        await reconnect(state, operatorId, accountId, profileId);
        try {
          await deps.onStreamSilent?.(operatorId, accountId, profileId, accountAgeMs);
        } catch (err) {
          deps.logger.error(
            { profileId, err: err },
            'user-stream watchdog: onStreamSilent handler failed',
          );
        }
      }
    },
    isOpen: (profileId) => conns.has(profileId),
  };
};
