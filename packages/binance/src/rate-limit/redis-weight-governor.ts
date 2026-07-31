// Shared per-IP Binance weight governor, backed by Redis.
//
// N worker pods egress through one NAT IP, so the Binance per-IP request-weight
// budget (spot REST 6000/min) is a fleet-shared resource. An in-process governor
// per pod would let the fleet collectively blow the budget → 429s → IP-ban risk.
// This governor moves the admission counter into one Redis key so every pod
// contends for the same budget.
//
// Ratified design (epic #561, WS6 ADR — non-negotiable):
//   1. Consume-and-decay. A monotonic `used` counter that decays as a pure
//      function of wall-clock time (refill = elapsed × rate). No per-caller
//      ownership, no release, NO REFUND. A mid-op crash only over-counts weight
//      the caller never spent → more conservative for ≤ one window → self-heals.
//      This is NOT a lock: there is no holder whose death wedges the fleet.
//   2. Server-side atomic. Check-and-account is one Lua EVAL; Redis is
//      single-threaded per key, so the script IS the compare-and-set. There is
//      no client-side read-modify-write and no lock around the counter.
//   3. Fail-mode split on Redis-unavailable. Priority (order) calls fail OPEN
//      via a conservative local per-process backstop — a protective SELL must
//      never hostage on the cache. Bulk reads fail CLOSED (throw; the cron skips
//      and retries next tick). Never silent: every fallback is logged.

import {
  computeAdmissionLimit,
  createWeightGovernor,
  resolveWeightGovernorConfig,
  WINDOW_MS,
  type ReserveOptions,
  type WeightGovernor,
  type WeightGovernorOptions,
} from './weight-governor.js';

/**
 * Minimal Redis surface the governor needs: one atomic `EVAL`. Declared
 * structurally so `@app/binance` stays free of an `ioredis` dependency — the
 * worker injects its real ioredis client, which satisfies this shape.
 */
export interface RedisEvalClient {
  eval(script: string, numKeys: number, ...args: (string | number)[]): Promise<unknown>;
}

/** Minimal logger surface for the "never silent" fail-mode logging. */
export interface GovernorLogger {
  warn(obj: Record<string, unknown>, msg: string): void;
}

/**
 * Thrown when a BULK (non-priority) reservation cannot reach Redis. Bulk reads
 * fail closed: the caller (discovery / technicals cron) skips this run and
 * retries next tick rather than issuing an unmetered request that could breach
 * the shared per-IP budget.
 */
export class RedisUnavailableError extends Error {
  constructor(cause: unknown) {
    super('WeightGovernor: Redis unavailable — bulk read skipped');
    this.name = 'RedisUnavailableError';
    this.cause = cause;
  }
}

export interface RedisWeightGovernorOptions extends WeightGovernorOptions {
  /** Injected Redis client (the worker's shared ioredis handle). */
  readonly redis: RedisEvalClient;
  /** Injected logger; every Redis-unavailable admission is logged through it. */
  readonly logger: GovernorLogger;
  /**
   * Bucket key. Single master account today, one shared egress IP → one key.
   * The budget is per-IP, so all profiles behind the IP share this key.
   * Default `binance:weight:master`.
   */
  readonly key?: string;
  /**
   * Upper bound on the Redis round-trip, in ms. If the `EVAL` does not settle
   * within this window the call is treated as Redis-unavailable and takes the
   * fail-mode path (priority admits via the local backstop, bulk throws). This
   * is what makes fail-open *fast*: ioredis's default client queues commands
   * and retries across reconnects for tens of seconds on an outage, which would
   * otherwise stall a protective SELL. Default 500 ms. Injected mainly so tests
   * can drive the timeout branch deterministically.
   */
  readonly evalTimeoutMs?: number;
}

const DEFAULT_KEY = 'binance:weight:master';
// Idle bucket self-expires after two windows: long enough a live-but-quiet
// fleet never loses its count, short enough a fully-idle key is reclaimed.
const KEY_TTL_MS = WINDOW_MS * 2;
const DEFAULT_EVAL_TIMEOUT_MS = 500;

// Atomic consume-and-decay token bucket. Rejection does NOT mutate state (no
// reservation is held): decay is a pure function of the stored `ts`, so the
// next call recomputes it identically. `used` is stored as a string to keep
// sub-unit decay precision across calls (RESP integer replies would truncate).
//   KEYS[1] = bucket key
//   ARGV    = now(ms), cost, limit, refillPerMs, ttlMs
//   returns = { admitted(0|1), waitMs, usedAfter(floored, for observability) }
const BUCKET_LUA = `
local now = tonumber(ARGV[1])
local cost = tonumber(ARGV[2])
local limit = tonumber(ARGV[3])
local refill = tonumber(ARGV[4])
local ttl = tonumber(ARGV[5])

local data = redis.call('HMGET', KEYS[1], 'used', 'ts')
local used = tonumber(data[1]) or 0
local ts = tonumber(data[2]) or now

local elapsed = now - ts
if elapsed < 0 then elapsed = 0 end
local decayed = used - elapsed * refill
if decayed < 0 then decayed = 0 end

if decayed + cost <= limit then
  local newUsed = decayed + cost
  redis.call('HSET', KEYS[1], 'used', tostring(newUsed), 'ts', tostring(now))
  redis.call('PEXPIRE', KEYS[1], ttl)
  return {1, 0, math.floor(newUsed)}
end

local excess = (decayed + cost) - limit
local waitMs = math.ceil(excess / refill)
if waitMs < 1 then waitMs = 1 end
return {0, waitMs, math.floor(decayed)}
`;

interface BucketReply {
  admitted: boolean;
  waitMs: number;
  usedAfter: number;
}

const parseReply = (raw: unknown): BucketReply => {
  const arr = raw as [number, number, number];
  return { admitted: arr[0] === 1, waitMs: arr[1], usedAfter: arr[2] };
};

const sleepOrAbort = async (
  sleep: (ms: number) => Promise<void>,
  ms: number,
  signal: AbortSignal | undefined,
): Promise<void> => {
  // Check up front: the signal may have aborted during the preceding Redis
  // round-trip, before this listener attaches — the abort event would already
  // be dispatched and the race below would never settle.
  if (signal?.aborted) throw new Error('WeightGovernor: aborted');
  if (!signal) {
    await sleep(ms);
    return;
  }
  let onAbort: (() => void) | undefined;
  const aborted = new Promise<void>((_, reject) => {
    onAbort = () => reject(new Error('WeightGovernor: aborted'));
    signal.addEventListener('abort', onAbort, { once: true });
  });
  try {
    await Promise.race([sleep(ms), aborted]);
  } finally {
    /* v8 ignore start -- reason: the Promise executor runs synchronously and assigns onAbort before this finally, so it is always defined here */
    if (onAbort) signal.removeEventListener('abort', onAbort);
    /* v8 ignore stop -- reason: end of the unreachable onAbort-undefined guard above */
  }
};

/**
 * Race a Redis round-trip against a timeout so a hung connection takes the
 * fail-mode path promptly instead of stalling. ioredis's default client queues
 * commands and retries across reconnects for tens of seconds on an outage; a
 * timeout rejects with an ordinary Error, which the caller treats as
 * Redis-unavailable (priority fails open, bulk fails closed).
 */
const withTimeout = async <T>(op: Promise<T>, timeoutMs: number): Promise<T> => {
  let timer: ReturnType<typeof setTimeout> | undefined;
  const timeout = new Promise<never>((_, reject) => {
    timer = setTimeout(() => reject(new Error('WeightGovernor: Redis eval timed out')), timeoutMs);
  });
  try {
    return await Promise.race([op, timeout]);
  } finally {
    /* v8 ignore start -- reason: the Promise executor runs synchronously and assigns timer before this finally, so it is always defined here */
    if (timer) clearTimeout(timer);
    /* v8 ignore stop -- reason: end of the unreachable timer-undefined guard above */
  }
};

/**
 * Build a Redis-backed {@link WeightGovernor}. Interface-compatible with
 * {@link createWeightGovernor}, so it drops into the same injection point with
 * no change to any REST caller. `used()` returns the last usage observed from
 * Redis (best-effort; no extra round-trip) and has no production consumers.
 */
export const createRedisWeightGovernor = (opts: RedisWeightGovernorOptions): WeightGovernor => {
  const { budget, ceiling, orderReserve, clock, sleep } = resolveWeightGovernorConfig(opts);
  const key = opts.key ?? DEFAULT_KEY;
  const evalTimeoutMs = opts.evalTimeoutMs ?? DEFAULT_EVAL_TIMEOUT_MS;
  // Weight decays back to zero over one window at a steady rate. Matches the
  // in-process governor's steady-state throughput (ceiling per WINDOW_MS).
  const refillPerMs = ceiling / WINDOW_MS;
  // Fail-open backstop for priority calls when Redis is down. Same budget, so a
  // single isolated pod still self-limits to the per-IP ceiling; bulk fails
  // closed (below), freeing most of the budget, so priority over-admission
  // across the fleet during a rare outage stays small.
  const backstop = createWeightGovernor(opts);
  let lastUsed = 0;

  return {
    used: () => lastUsed,
    ceiling: () => ceiling,
    async reserve(cost: number, reserveOpts?: ReserveOptions): Promise<void> {
      const signal = reserveOpts?.signal;
      const priority = reserveOpts?.priority ?? false;
      if (!Number.isFinite(cost) || cost < 0) {
        throw new Error(`WeightGovernor: cost must be non-negative, got ${String(cost)}`);
      }
      if (cost > ceiling) {
        throw new Error(
          `WeightGovernor: cost ${cost} exceeds soft ceiling ${ceiling} (budget=${budget})`,
        );
      }
      if (signal?.aborted) throw new Error('WeightGovernor: aborted');

      const limit = computeAdmissionLimit(ceiling, orderReserve, cost, priority);

      while (true) {
        let reply: BucketReply;
        try {
          const raw = await withTimeout(
            opts.redis.eval(
              BUCKET_LUA,
              1,
              key,
              clock.nowMs(),
              cost,
              limit,
              refillPerMs,
              KEY_TTL_MS,
            ),
            evalTimeoutMs,
          );
          reply = parseReply(raw);
        } catch (err) {
          if (priority) {
            opts.logger.warn(
              { key, cost, err },
              'weight governor: Redis unavailable, priority call admitting via local backstop',
            );
            await backstop.reserve(cost, reserveOpts);
            return;
          }
          opts.logger.warn(
            { key, cost, err },
            'weight governor: Redis unavailable, bulk read skipped (fail-closed)',
          );
          throw new RedisUnavailableError(err);
        }

        lastUsed = reply.usedAfter;
        if (reply.admitted) return;
        await sleepOrAbort(sleep, reply.waitMs, signal);
      }
    },
  };
};
