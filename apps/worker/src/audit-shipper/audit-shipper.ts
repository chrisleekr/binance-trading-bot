// Audit shipping: XADD per tick + audit-drain worker → Postgres bulk insert.
//
// Producer: every tick emits ONE
//   XADD audit:<u>:<p>:stream MAXLEN ~ 100000 *  payload
//
// Drainer: a single Worker reads with XREADGROUP from audit:* across enabled
// profiles, batches into bulk INSERT against action_logs, XACKs on success.
// Tick latency is O(1) regardless of decision count.
//
// PG outage handling: stream length grows; at MAXLEN 100k oldest entries
// drop. Audit log loss is observational, not load-bearing for strategy
// correctness.

import type { Redis } from 'ioredis';
import type { Logger } from 'pino';
import type { AccountId, ProfileId } from '@app/contracts';
import { buildAuditStreamKey } from 'executor/redis-namespace.js';
import type { MetricsSink } from 'metrics/catalog.js';
import { errorMessage } from '@app/core/error';

export const AUDIT_STREAM_MAXLEN = 100_000;
export const AUDIT_DRAINER_GROUP = 'audit-drainers';
export const AUDIT_DRAINER_CONSUMER = 'drainer';
// Alert on the drainer group's backlog (entries not yet delivered), NOT on
// stream length: XACK never removes entries, only MAXLEN trim on XADD does, so a
// healthy fully-drained stream permanently sits near MAXLEN (issue #510).
export const AUDIT_CONSUMER_LAG_ALERT = 10_000;

export interface AuditEntry {
  readonly accountId: AccountId;
  readonly profileId: ProfileId;
  readonly ts: number;
  readonly symbol: string;
  readonly event: string;
  readonly latencyMs: number;
  readonly decisionTypes: readonly string[];
  readonly clientOrderIds: readonly string[];
  readonly payload: Record<string, unknown>;
}

export interface AuditShipper {
  publish(entry: AuditEntry): Promise<void>;
  /** Approximate stream length at the time of the call. */
  streamLength(accountId: AccountId, profileId: ProfileId): Promise<number>;
}

export const createAuditShipper = (deps: {
  readonly redis: Redis;
  readonly logger: Logger;
}): AuditShipper => ({
  async publish(entry) {
    const stream = buildAuditStreamKey(entry.accountId, entry.profileId);
    const body = JSON.stringify(entry);
    try {
      await deps.redis.xadd(stream, 'MAXLEN', '~', String(AUDIT_STREAM_MAXLEN), '*', 'body', body);
    } catch (err) {
      // Audit failure must NOT fail the tick.
      deps.logger.warn(
        { profileId: entry.profileId, err: err },
        'audit XADD failed (tick continues)',
      );
    }
  },
  async streamLength(accountId, profileId) {
    return deps.redis.xlen(buildAuditStreamKey(accountId, profileId));
  },
});

/**
 * Parse the audit drainer group's backlog — entries XADDed to the stream but not
 * yet delivered to the group's consumers — out of an XINFO GROUPS reply (`lag`,
 * Redis 7.0+). The caller owns the round-trip. This is the honest backpressure
 * signal; stream length is not, because XACK does not trim.
 *
 * Returns null when Redis cannot compute lag, which (for a group created at a
 * normal start ID) means trimming dropped entries the group had not yet read —
 * the drainer fell so far behind that audit data was lost before delivery.
 * Callers treat null as "behind". Lag self-heals to a number once the group
 * delivers the stream's last entry.
 */
export const parseConsumerLag = (groups: readonly unknown[], group: string): number | null => {
  // RESP2 flattens each group entry to a [field, value, field, value, ...] array.
  for (const g of groups) {
    if (!Array.isArray(g)) continue;
    let name: unknown;
    let lag: unknown;
    for (let i = 0; i + 1 < g.length; i += 2) {
      if (g[i] === 'name') name = g[i + 1];
      else if (g[i] === 'lag') lag = g[i + 1];
    }
    if (name !== group) continue;
    if (lag == null) return null;
    const n = Number(lag);
    return Number.isFinite(n) ? n : null;
  }
  return null;
};

// =============================================================================
// Drainer
// =============================================================================

export interface AuditDrainerDeps {
  readonly redis: Redis;
  readonly logger: Logger;
  readonly persistBatch: (rows: readonly AuditEntry[]) => Promise<void>;
  readonly enabledStreams: () => Promise<readonly string[]>;
  readonly batchCount?: number;
  readonly blockMs?: number;
  readonly sleepMs?: number;
  readonly metrics?: MetricsSink;
}

export interface AuditDrainer {
  /** Process exactly one drain pass (across all known streams). */
  drainOnce(): Promise<{ batched: number; streams: number }>;
  /** Run continuously until stopped. */
  start(): Promise<void>;
  stop(): Promise<void>;
  isRunning(): boolean;
}

const DEFAULT_BATCH = 500;
const DEFAULT_BLOCK_MS = 1_000;

export const createAuditDrainer = (deps: AuditDrainerDeps): AuditDrainer => {
  const batchCount = deps.batchCount ?? DEFAULT_BATCH;
  const blockMs = deps.blockMs ?? DEFAULT_BLOCK_MS;
  const sleepMs = deps.sleepMs ?? 250;
  const groupsCreated = new Set<string>();
  let running = false;

  const ensureGroup = async (stream: string): Promise<void> => {
    if (groupsCreated.has(stream)) return;
    try {
      await deps.redis.xgroup('CREATE', stream, AUDIT_DRAINER_GROUP, '$', 'MKSTREAM');
    } catch (err) {
      const message = errorMessage(err);
      if (!message.includes('BUSYGROUP')) {
        deps.logger.warn({ stream, err }, 'XGROUP CREATE failed (non-fatal if BUSYGROUP)');
      }
    }
    groupsCreated.add(stream);
  };

  const drainOnce: AuditDrainer['drainOnce'] = async () => {
    const streams = await deps.enabledStreams();
    if (streams.length === 0) return { batched: 0, streams: 0 };
    for (const s of streams) await ensureGroup(s);
    const ids = streams.map(() => '>');
    const reply = (await deps.redis.xreadgroup(
      'GROUP',
      AUDIT_DRAINER_GROUP,
      AUDIT_DRAINER_CONSUMER,
      'COUNT',
      String(batchCount),
      'BLOCK',
      String(blockMs),
      'STREAMS',
      ...streams,
      ...ids,
    )) as readonly [string, readonly [string, readonly string[]][]][] | null;
    if (!reply) return { batched: 0, streams: streams.length };

    const flatEntries: AuditEntry[] = [];
    const ackIds = new Map<string, string[]>();
    for (const [stream, entries] of reply) {
      const acks: string[] = [];
      for (const [entryId, fields] of entries) {
        const idx = fields.indexOf('body');
        if (idx < 0) continue;
        const body = fields[idx + 1];
        if (!body) continue;
        try {
          const parsed = JSON.parse(body) as AuditEntry;
          flatEntries.push(parsed);
          acks.push(entryId);
        } catch (err) {
          deps.logger.warn(
            { stream, entryId, err: err },
            'audit drainer: corrupt JSON; dropping entry',
          );
          acks.push(entryId);
        }
      }
      if (acks.length > 0) ackIds.set(stream, acks);
    }

    if (flatEntries.length === 0) return { batched: 0, streams: streams.length };

    try {
      await deps.persistBatch(flatEntries);
    } catch (err) {
      deps.logger.error(
        { count: flatEntries.length, err: err },
        'audit persistBatch failed; entries will be re-delivered',
      );
      // Don't ACK; entries get re-delivered on next pass.
      return { batched: 0, streams: streams.length };
    }

    // One round-trip for every stream's ACK instead of one per stream. This runs
    // on every pass, and passes run at the tick rate, so the serial version's
    // cost scaled with the active-profile count on the drainer's own hot loop.
    const ackEntries = [...ackIds];
    if (ackEntries.length > 0) {
      const ackPipe = deps.redis.pipeline();
      for (const [stream, acks] of ackEntries) {
        ackPipe.xack(stream, AUDIT_DRAINER_GROUP, ...acks);
      }
      try {
        const replies = (await ackPipe.exec()) as readonly [Error | null, unknown][] | null;
        replies?.forEach(([err], i) => {
          if (err) {
            deps.logger.warn(
              { stream: ackEntries[i]?.[0], err: err },
              'XACK failed; entries may be re-delivered',
            );
          }
        });
      } catch (err) {
        deps.logger.warn({ err: err }, 'XACK pipeline failed; entries may be re-delivered');
      }
    }

    deps.metrics?.record('audit_batch_size', flatEntries.length);
    // Both gauges for every stream in ONE pipeline. These are pure instrumentation,
    // and the serial form paid 2N round-trips per pass — so the drainer's own
    // measurement overhead grew with the backlog it was measuring, throttling the
    // drain exactly when it was already behind.
    const probePipe = deps.redis.pipeline();
    for (const stream of streams) {
      probePipe.xlen(stream);
      probePipe.xinfo('GROUPS', stream);
    }
    const replies = (await probePipe.exec().catch(() => null)) as
      | readonly [Error | null, unknown][]
      | null;
    streams.forEach((stream, i) => {
      // Per-stream, so one stream's bad slot cannot cost the rest their gauges.
      try {
        const lenReply = replies?.[i * 2];
        const groupsReply = replies?.[i * 2 + 1];
        if (lenReply && !lenReply[0] && typeof lenReply[1] === 'number') {
          // Record raw length as a gauge but never alert on it (issue #510): a
          // caught-up stream sits near MAXLEN forever, so an XLEN threshold fires
          // on every pass. Alert on the consumer group's undelivered backlog.
          deps.metrics?.record('audit_stream_length', lenReply[1], { stream });
        }
        // A FAILED probe and a null lag are different facts and must not share a
        // message: null lag means Redis positively reported that trimming dropped
        // entries the group never read, which is data loss. A transport error
        // means we simply do not know, and claiming loss would send the operator
        // chasing an incident that did not happen.
        if (!groupsReply || groupsReply[0] || !Array.isArray(groupsReply[1])) {
          deps.logger.warn(
            { stream, err: groupsReply?.[0] },
            'audit consumer lag probe failed; backlog unknown this pass',
          );
          return;
        }
        const lag = parseConsumerLag(groupsReply[1], AUDIT_DRAINER_GROUP);
        if (lag != null) deps.metrics?.record('audit_consumer_lag', lag, { stream });
        if (lag == null || lag > AUDIT_CONSUMER_LAG_ALERT) {
          deps.logger.warn(
            { stream, lag, threshold: AUDIT_CONSUMER_LAG_ALERT },
            lag == null
              ? 'audit consumer lag unavailable — stream trimmed past the drainer group; entries lost before delivery'
              : 'audit consumer lag above alert threshold',
          );
        }
      } catch {
        // lag/length probe is best-effort; a Redis hiccup must not fail the drain.
      }
    });

    return { batched: flatEntries.length, streams: streams.length };
  };

  const sleep = (ms: number): Promise<void> =>
    new Promise((r) => {
      const t = setTimeout(r, ms);
      t.unref?.();
    });

  return {
    drainOnce,
    async start() {
      if (running) return;
      running = true;
      while (running) {
        try {
          const { batched } = await drainOnce();
          if (batched === 0) await sleep(sleepMs);
        } catch (err) {
          deps.logger.error({ err: err }, 'audit drainer loop error');
          await sleep(sleepMs);
        }
      }
    },
    async stop() {
      running = false;
    },
    isRunning: () => running,
  };
};
