// Worker-fleet membership registry — write side.
//
// This pod registers `worker:members:<id>` with a short TTL and refreshes it on
// a heartbeat; the key expiring is this pod leaving the fleet (crash-only, no
// lock). On SIGTERM the key is deleted immediately so a rolling update re-homes
// its work fast instead of waiting a full TTL. Owner election considers only
// ready members; not-ready pods heartbeat but are excluded. Each beat also
// publishes the derived fleet count so the api reads it O(1) instead of SCANning.

import { hostname } from 'node:os';

import { countWorkerMembers, FLEET_COUNT_KEY, MEMBER_KEY_PREFIX, type MemberRecord } from '@app/db';
import { Gauge, type Registry } from '@app/observability';
import type { Redis } from 'ioredis';
import type { Logger } from 'pino';

// TTL outlives two refreshes so a single missed beat does not drop the member;
// a dead pod's key expires within one TTL (~30s), fast enough to re-home its
// subscriptions. Refresh strictly < TTL/2. Exported so the invariant is testable.
export const MEMBER_TTL_S = 30;
export const MEMBER_REFRESH_MS = 10_000;

/** Stable per-process pod identity: k8s sets hostname to the unique pod name. */
export const workerMemberId = (): string => `${hostname()}:${process.pid}`;

export interface MemberRegistryDeps {
  readonly redis: Redis;
  readonly logger: Logger;
  readonly id: string;
  readonly sha: string;
  readonly bootedAt: string;
  /** Only the prom-client registry is needed, to register the fleet gauges. */
  readonly metrics: { readonly registry: Registry };
  /** Overridable for tests; default to the module constants. */
  readonly ttlS?: number;
  readonly refreshMs?: number;
}

export interface MemberRegistry {
  /** Write this pod's record (not-ready) and start the refresh heartbeat. */
  start(): Promise<void>;
  /** Flip the member to ready once boot is complete; reflected immediately. */
  markReady(): Promise<void>;
  /** Clear the timer and delete the member key (immediate deregister). */
  stop(): Promise<void>;
}

export const createMemberRegistry = (deps: MemberRegistryDeps): MemberRegistry => {
  const { redis, logger, id, sha, bootedAt, metrics } = deps;
  const ttlS = deps.ttlS ?? MEMBER_TTL_S;
  const refreshMs = deps.refreshMs ?? MEMBER_REFRESH_MS;
  const key = `${MEMBER_KEY_PREFIX}${id}`;
  let ready = false;
  let stopped = false;
  let timer: ReturnType<typeof setInterval> | undefined;

  const totalGauge = new Gauge({
    name: 'worker_members_total',
    help: 'Live worker pods currently registered in the fleet membership registry.',
    registers: [metrics.registry],
  });
  const readyGauge = new Gauge({
    name: 'worker_members_ready',
    help: 'Registered worker pods past their boot ready-gate (ownership-eligible).',
    registers: [metrics.registry],
  });

  const record = (): string => JSON.stringify({ id, sha, bootedAt, ready } satisfies MemberRecord);

  // Best-effort: a Redis hiccup never aborts boot or a refresh loop; the member
  // self-heals on the next beat or expires via TTL.
  const beat = async (): Promise<void> => {
    // An in-flight beat scheduled before stop() must not re-create the deleted
    // key, or the immediate-deregister guarantee is lost until the TTL expires.
    if (stopped) return;
    try {
      await redis.set(key, record(), 'EX', ttlS);
      const count = await countWorkerMembers(redis);
      // Publish so the api reads the count O(1) rather than SCANning per request.
      await redis.set(FLEET_COUNT_KEY, JSON.stringify(count), 'EX', ttlS);
      totalGauge.set(count.total);
      readyGauge.set(count.ready);
    } catch (err) {
      logger.warn({ err, key }, 'member registry heartbeat failed');
    }
  };

  return {
    async start() {
      await beat();
      timer = setInterval(() => void beat(), refreshMs);
      timer.unref();
    },
    async markReady() {
      ready = true;
      await beat();
    },
    async stop() {
      stopped = true;
      if (timer) clearInterval(timer);
      // Deregister now, don't wait for TTL, so a rolling update re-homes fast.
      await redis
        .del(key)
        .catch((err: unknown) => logger.warn({ err, key }, 'member deregister failed'));
    },
  };
};
