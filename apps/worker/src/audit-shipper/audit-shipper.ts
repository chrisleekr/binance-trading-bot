// Audit shipping: XADD per tick + audit-drain worker → Postgres bulk insert.
//
// Producer: every tick emits ONE
//   XADD audit:<u>:<p>:stream MAXLEN ~ 100000 *  payload
//
// Drainer: a single Worker reads with XREADGROUP from audit:* across enabled
// profiles, batches into bulk INSERT against action_logs, XACKs on success.
// Tick latency is O(1) regardless of decision count.
//
// PG outage handling: a batch the drainer read but could not persist is left
// unacked in the group's pending-entries list, and a later pass reclaims it with
// XPENDING IDLE + XCLAIM. Stream length still grows meanwhile; at MAXLEN 100k
// the oldest entries drop. Audit log loss is observational, not load-bearing for
// strategy correctness.

import type { Redis } from 'ioredis';
import type { Logger } from 'pino';
import type { AccountId, ProfileId } from '@app/contracts';
import { buildAuditStreamKey } from 'executor/redis-namespace.js';
import type { MetricsSink } from 'metrics/catalog.js';
import { errorMessage } from '@app/core/error';

/**
 * Fallback trim length, used when no config source is wired (tests) or before
 * the first successful read. The live value is operator-settable in
 * `retention_config`; this constant only has to match the migration's seed so a
 * worker that cannot reach the table behaves like one reading an untouched row.
 */
export const AUDIT_STREAM_MAXLEN = 100_000;
export const AUDIT_DRAINER_GROUP = 'audit-drainers';
export const AUDIT_DRAINER_CONSUMER = 'drainer';
// Alert on the drainer group's backlog (entries not yet delivered), NOT on
// stream length: XACK never removes entries, only MAXLEN trim on XADD does, so a
// healthy fully-drained stream permanently sits near MAXLEN.
export const AUDIT_CONSUMER_LAG_ALERT = 10_000;

/**
 * How long an entry must have sat unacked before a pass may claim it back.
 *
 * The floor is set by the drainer's own in-flight window, not by recovery
 * speed: a pass that is still awaiting `persistBatch` has not acked yet, so a
 * shorter idle time would let the next pass claim the batch out from under it
 * and insert every row twice.
 */
export const DEFAULT_RECLAIM_MIN_IDLE_MS = 60_000;
/**
 * Deliveries after which a redelivered entry has earned a verdict. Two readers,
 * two verdicts, because the evidence differs. An entry carrying a row that failed
 * as part of a batch is retried ALONE, and crossing this is never by itself
 * grounds to drop it — only the isolated retry can tell a bad row from a bad
 * backend. An entry whose claim reply carries no body has no row to retry, so
 * repetition is the only evidence there will ever be, and crossing this retires it.
 */
export const AUDIT_RECLAIM_DELIVERY_CEILING = 5;
/**
 * Persist statements the bisect may spend locating unwritable rows, per stream
 * per pass. One canary statement, then 2 per bisect level over the remaining
 * N-1 entries, so one unwritable row in a full `DEFAULT_BATCH` of 500 costs
 * 1 + 2*ceil(log2 499) = 19, and two rows landing in opposite halves of the root
 * split cost 35, because each half then descends on its own. The cap therefore
 * only binds from three unwritable rows in one batch upwards, where the search
 * is no longer worth finishing in a single pass and the remainder is better left
 * for the next one.
 *
 * Per stream rather than per pass so one profile's poisoned backlog cannot spend
 * the budget and starve every other profile's recovery.
 */
export const AUDIT_RECLAIM_PROBE_MAX = 48;
/**
 * Audit rows one pass may condemn per stream. A separate number from the probe
 * budget because it bounds a different cost: the probe budget caps the load a
 * recovery pass puts on Postgres, this caps how much of the trail one pass can
 * destroy. A search that isolates this many unwritable rows at once is seeing a
 * systematic rejection, a column that turned NOT NULL under a running worker or
 * a byte sequence the column type refuses, not a scattering of poison rows, and
 * the rest is worth an operator's look before it is gone. The remainder simply
 * keeps its place in the PEL, which is already the no-verdict state.
 */
export const AUDIT_RECLAIM_DROP_MAX = 8;

export interface AuditEntry {
  readonly accountId: AccountId;
  readonly profileId: ProfileId;
  /** Correlates the stream entry, its `action_logs` row and the tick's pino lines. */
  readonly tickId: string;
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
  /**
   * Resolves the current trim length. Operator-settable, because it is the one
   * knob that decides how far back the raw per-tick trace reaches and how long
   * the drainer can be down before unpersisted entries are trimmed away.
   * Omitted in tests and in any caller with no config source, which falls back
   * to the seeded default.
   */
  readonly maxlen?: () => Promise<number>;
}): AuditShipper => ({
  async publish(entry) {
    const stream = buildAuditStreamKey(entry.accountId, entry.profileId);
    const body = JSON.stringify(entry);
    try {
      const maxlen = (await deps.maxlen?.()) ?? AUDIT_STREAM_MAXLEN;
      await deps.redis.xadd(stream, 'MAXLEN', '~', String(maxlen), '*', 'body', body);
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

/** The drainer group's backlog, as reported by one XINFO GROUPS round-trip. */
export interface ConsumerGroupBacklog {
  /**
   * Entries XADDed to the stream but never delivered to a consumer. Null when
   * Redis cannot compute it, which for a group created at a normal start ID
   * means trimming dropped entries the group had not yet read: audit data lost
   * before delivery. Self-heals to a number once the group delivers the
   * stream's last entry.
   */
  readonly lag: number | null;
  /**
   * Entries delivered but not yet XACKed. This is the number that climbs when
   * Redis is healthy and Postgres is not: the drainer keeps reading, so every
   * failed persist leaves its batch here while `lag` stays near zero.
   */
  readonly pending: number | null;
}

const finiteOrNull = (value: unknown): number | null => {
  if (value == null) return null;
  const n = Number(value);
  return Number.isFinite(n) ? n : null;
};

/**
 * Parse the audit drainer group's backlog out of an XINFO GROUPS reply (Redis
 * 7.0+). The caller owns the round-trip. Both numbers beat stream length as a
 * backpressure signal, because XACK does not trim.
 *
 * Returns null when the group is absent from the reply, which is a different
 * incident from either number being unreadable: nothing is draining the stream.
 */
export const parseConsumerGroup = (
  groups: readonly unknown[],
  group: string,
): ConsumerGroupBacklog | null => {
  // RESP2 flattens each group entry to a [field, value, field, value, ...] array.
  for (const g of groups) {
    if (!Array.isArray(g)) continue;
    let name: unknown;
    let lag: unknown;
    let pending: unknown;
    for (let i = 0; i + 1 < g.length; i += 2) {
      if (g[i] === 'name') name = g[i + 1];
      else if (g[i] === 'lag') lag = g[i + 1];
      else if (g[i] === 'pending') pending = g[i + 1];
    }
    if (name !== group) continue;
    return { lag: finiteOrNull(lag), pending: finiteOrNull(pending) };
  }
  return null;
};

/**
 * One entry of the drainer group's pending-entries list, narrowed to what the
 * reclaim acts on. XPENDING also returns the owning consumer name and the idle
 * time, and neither reaches a decision here: the consumer is always this
 * drainer, and IDLE filtering happens server-side.
 */
export interface PendingEntry {
  readonly id: string;
  /**
   * Times Redis has handed this entry to a consumer. XCLAIM bumps it (JUSTID
   * would not), so it keeps climbing across passes and is the only durable
   * record that an entry has repeatedly failed to persist.
   */
  readonly deliveries: number;
}

/**
 * A count that is allowed to be missing. Zero rather than a throw, because the
 * only consumer is the isolation decision and 0 is its safe end: an entry read
 * as never-redelivered stays below the ceiling, so it is retried in bulk
 * forever and can never be dropped. Defaulting high would make an unreadable
 * reply a licence to delete audit rows.
 */
const countOrZero = (value: unknown): number => {
  const n = Number(value);
  return Number.isFinite(n) ? n : 0;
};

/**
 * Parse XPENDING's extended form (Redis 5.0+; the IDLE filter the caller passes
 * is 6.2+), whose RESP2 reply is one `[id, consumer, idleMs, deliveries]` array
 * per entry. The caller owns the round-trip and the IDLE filtering.
 *
 * Skips a malformed tuple rather than rejecting the reply: one bad entry must
 * not cost its siblings their reclaim, or a single unreadable id strands the
 * whole pending list for the life of the group.
 */
export const parsePendingEntries = (reply: unknown): readonly PendingEntry[] => {
  if (!Array.isArray(reply)) return [];
  const entries: PendingEntry[] = [];
  for (const raw of reply) {
    if (!Array.isArray(raw)) continue;
    const id = raw[0];
    // An entry with no id can be neither claimed nor acked, so carrying it
    // forward could only produce a phantom XCLAIM argument.
    if (typeof id !== 'string' || id.length === 0) continue;
    entries.push({ id, deliveries: countOrZero(raw[3]) });
  }
  return entries;
};

// =============================================================================
// Drainer
// =============================================================================

export interface AuditDrainerDeps {
  readonly redis: Redis;
  readonly logger: Logger;
  /**
   * Persist a batch and resolve with the number of rows actually written. The
   * count is the poison guard's only proof that the backend is healthy: the
   * production implementation drops non-actionable entries and skips the INSERT
   * entirely for an empty set, so a resolved promise alone says nothing about
   * Postgres. Returning 0 keeps a vacuous success from authorising a drop.
   */
  readonly persistBatch: (rows: readonly AuditEntry[]) => Promise<number>;
  /**
   * Whether a rejection is a property of the row rather than of the backend.
   * Only a row-deterministic fault may cost an audit record its place in the
   * pending list; a connection reset, a failover or a pool exhaustion rejects
   * one statement and accepts the next, which is indistinguishable from poison
   * on timing alone. Absent means never drop, so an unclassified failure fails
   * closed.
   */
  readonly isUnpersistableRow?: (err: unknown) => boolean;
  readonly enabledStreams: () => Promise<readonly string[]>;
  readonly batchCount?: number;
  readonly blockMs?: number;
  readonly sleepMs?: number;
  readonly reclaimMinIdleMs?: number;
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

/**
 * Why a pass could not put a number on the backlog. These are different facts
 * and must stay separable, because each sends the operator somewhere different:
 * `trimmed-past-group` is Redis positively reporting that trimming dropped
 * entries the group never read, which is audit data loss; `probe-failed` is a
 * transport error, which says only that we do not know; `group-missing` means
 * the reply carried no such group, so nothing is draining the stream at all.
 */
type LagUnknownCause = 'probe-failed' | 'trimmed-past-group' | 'group-missing';

/**
 * Every `cause` label `audit_consumer_lag_unknown` can carry, for zero-seeding.
 *
 * Keyed on the union rather than listed as `readonly LagUnknownCause[]`, because
 * an array missing a member is a well-typed array: adding a cause and forgetting
 * the seed would compile clean, and the omission is invisible until the new
 * cause's first-ever incident fails to reach its alert. Satisfying
 * `Record<Cause, 0>` makes a missing key TS1360 and an unlisted one TS2353, the
 * same both-directions guarantee `Record<MetricName, MetricSpec>` gives the
 * metric-name space.
 */
const LAG_UNKNOWN_CAUSES = Object.keys({
  'probe-failed': 0,
  'trimmed-past-group': 0,
  'group-missing': 0,
} satisfies Record<LagUnknownCause, 0>) as readonly LagUnknownCause[];

/**
 * Why an audit record was acknowledged away without ever being written.
 * `rejected` means Postgres refused the row itself; `corrupt-json` means the
 * body would not parse, so no retry against any backend could ever land it;
 * `no-body` means the claim reply carried no body to judge at all and kept
 * carrying none past the delivery ceiling. All three destroy a row, so all three
 * must move the same counter — a discard that nothing measures reads as recovery
 * on the backlog gauges.
 */
type PoisonDropCause = 'rejected' | 'corrupt-json' | 'no-body';

/**
 * Every `cause` label `audit_poison_entries_dropped` can carry, for zero-seeding.
 * Union-keyed for the reason above.
 */
const POISON_DROP_CAUSES = Object.keys({
  rejected: 0,
  'corrupt-json': 0,
  'no-body': 0,
} satisfies Record<PoisonDropCause, 0>) as readonly PoisonDropCause[];

/**
 * What one stream-reply tuple's field array turned out to hold. `absent` and
 * `corrupt` must stay apart because they end differently: unparseable JSON can
 * never persist and is acked on sight, while an entry with no `body` is one this
 * drainer did not write and cannot judge, so the claim loop keeps it until
 * repeated deliveries make the case against it.
 */
type DecodedEntry =
  | { readonly kind: 'ok'; readonly row: AuditEntry }
  | { readonly kind: 'corrupt'; readonly err: unknown }
  | { readonly kind: 'absent' };

/**
 * Whether a parsed body carries the fields the `action_logs` mapping reads.
 * `JSON.parse(...) as AuditEntry` asserts nothing at runtime, and a body that
 * parses but lacks `decisionTypes` or `payload` makes the mapper throw a
 * TypeError rather than a database error. A TypeError has no SQLSTATE, so the
 * poison gate can never classify it and the entry blocks its stream's batch on
 * every pass forever. Only what the mapper dereferences is checked: `accountId`
 * is part of the contract but never read on this path, and rejecting an entry
 * over a field nothing uses would discard a usable row.
 */
const isMappableEntry = (v: unknown): v is AuditEntry => {
  if (typeof v !== 'object' || v === null) return false;
  const e = v as Partial<AuditEntry>;
  return (
    Array.isArray(e.decisionTypes) &&
    Array.isArray(e.clientOrderIds) &&
    typeof e.payload === 'object' &&
    e.payload !== null &&
    typeof e.profileId === 'string' &&
    typeof e.tickId === 'string' &&
    typeof e.symbol === 'string' &&
    typeof e.event === 'string' &&
    typeof e.ts === 'number' &&
    typeof e.latencyMs === 'number'
  );
};

// Shared by the `>` read and the reclaim: both receive the same RESP2 entry
// shape, and letting them drift would mean two answers to "is this row usable".
const decodeEntry = (fields: unknown): DecodedEntry => {
  if (!Array.isArray(fields)) return { kind: 'absent' };
  const idx = fields.indexOf('body');
  if (idx < 0) return { kind: 'absent' };
  const body = fields[idx + 1];
  if (typeof body !== 'string' || body.length === 0) return { kind: 'absent' };
  let parsed: unknown;
  try {
    parsed = JSON.parse(body);
  } catch (err) {
    return { kind: 'corrupt', err };
  }
  // An unmappable body shares the corrupt route because it shares the outcome:
  // it can only ever fail, so it must leave by a route that counts the loss.
  if (!isMappableEntry(parsed)) {
    return { kind: 'corrupt', err: new Error('audit entry body is not a mappable AuditEntry') };
  }
  return { kind: 'ok', row: parsed };
};

/** An entry this pass now owns: claimed out of the PEL and decoded. */
interface ClaimedEntry {
  readonly stream: string;
  readonly id: string;
  /** Deliveries as of the XPENDING that found it, before XCLAIM's own bump. */
  readonly deliveries: number;
  readonly row: AuditEntry;
}

const addAck = (acks: Map<string, string[]>, stream: string, id: string): void => {
  const queued = acks.get(stream);
  if (queued) queued.push(id);
  else acks.set(stream, [id]);
};

/**
 * The log and the counter for one discard, held back until its ACK has come
 * back clean. Both assert an `action_logs` row is gone for good, which is not
 * true while the entry is still in the pending list: reporting before the XACK
 * lands would leave the counter claiming a loss that has not happened, and the
 * later pass that finally acks the entry would count it a second time.
 *
 * `stream` is what makes the deferral enforceable rather than merely ordered.
 * The ACK pipeline carries one XACK per stream, so a clean slot is proof for
 * that stream's ids and no other, and a drop can only be released against its
 * own proof.
 */
interface DeferredDrop {
  readonly stream: string;
  readonly report: () => void;
}

/**
 * Release only the drops whose stream actually got its ACK through.
 *
 * A withheld drop is not a lost measurement. The entry it describes is still in
 * the pending list precisely because the ACK failed, so the next pass claims it,
 * re-derives the same terminal state, and counts it exactly once. Withholding is
 * therefore the fail-closed direction on the one counter that measures
 * deliberate audit-row destruction; reporting anyway would inflate it by one per
 * pass for as long as the ACK kept failing.
 */
const reportDrops = (drops: readonly DeferredDrop[], acked: ReadonlySet<string>): void => {
  for (const drop of drops) {
    if (acked.has(drop.stream)) drop.report();
  }
};

export const createAuditDrainer = (deps: AuditDrainerDeps): AuditDrainer => {
  const batchCount = deps.batchCount ?? DEFAULT_BATCH;
  const blockMs = deps.blockMs ?? DEFAULT_BLOCK_MS;
  const sleepMs = deps.sleepMs ?? 250;
  const reclaimMinIdleMs = deps.reclaimMinIdleMs ?? DEFAULT_RECLAIM_MIN_IDLE_MS;
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

  const seededStreams = new Set<string>();

  /**
   * Export every counter series this stream can ever move, at zero, the first
   * time the stream is touched.
   *
   * `increase()` reads a rise between two samples, and prom-client only creates a
   * labelled child on its first write. Without this, a stream's first incident is
   * a series that appears already at its final value and never moves again, which
   * `increase()` reports as no change at all. Short incidents are the ones that
   * vanish: a trimming event the drainer clears within one scrape interval, or a
   * single poison entry dropped once and never again, would otherwise be
   * invisible to the very rules that watch for them.
   *
   * Seeding must therefore happen at the head of a pass, ahead of anything that
   * can write a real value onto the same series.
   */
  const seedStreamCounters = (stream: string): void => {
    if (seededStreams.has(stream)) return;
    seededStreams.add(stream);
    for (const cause of LAG_UNKNOWN_CAUSES) {
      deps.metrics?.record('audit_consumer_lag_unknown', 0, { stream, cause });
    }
    deps.metrics?.record('audit_entries_reclaimed', 0, { stream });
    deps.metrics?.record('audit_entries_stuck', 0, { stream });
    deps.metrics?.record('audit_read_no_body', 0, { stream });
    for (const cause of POISON_DROP_CAUSES) {
      deps.metrics?.record('audit_poison_entries_dropped', 0, { stream, cause });
    }
  };

  const recordUnknown = (stream: string, cause: LagUnknownCause): void => {
    deps.metrics?.record('audit_consumer_lag_unknown', 1, { stream, cause });
  };

  /**
   * ACK every queued id in ONE round-trip, and report which streams' ids
   * actually left the pending list. Shared by the `>` read and the reclaim: a
   * failed ACK is not a failed drain in either case, because the rows are
   * already in `action_logs` and the worst outcome is a redelivery.
   *
   * The returned set is what `reportDrops` gates on, so every non-success has to
   * leave its stream OUT of it rather than merely log. That includes the `null`
   * reply, though not for the obvious reason: ioredis types `exec()` as nullable
   * because `Pipeline` is shared with `multi()`, where a null EXEC means Redis
   * aborted the transaction. A non-transaction pipeline always resolves an
   * array, so the narrowing below is type-driven, not a live failure mode. It
   * still refuses to vouch, because a set that releases a drop must only ever
   * hold streams whose reply was actually read.
   *
   * One pipeline instead of one call per stream. This runs on every pass, and
   * passes run at the tick rate, so the serial version's cost scaled with the
   * active-profile count on the drainer's own hot loop.
   */
  const flushAcks = async (
    acks: ReadonlyMap<string, readonly string[]>,
  ): Promise<ReadonlySet<string>> => {
    const acked = new Set<string>();
    const ackEntries = [...acks].filter(([, ids]) => ids.length > 0);
    if (ackEntries.length === 0) return acked;
    const ackPipe = deps.redis.pipeline();
    for (const [stream, ids] of ackEntries) {
      ackPipe.xack(stream, AUDIT_DRAINER_GROUP, ...ids);
    }
    try {
      const replies = (await ackPipe.exec()) as readonly [Error | null, unknown][] | null;
      if (!replies) {
        // Logged rather than optional-chained past. Unreachable on a plain
        // pipeline, so reaching it means ioredis returned a shape this code does
        // not model, and it is the only branch here with neither a per-slot
        // error to walk nor a rejection to catch. Silence would make that the
        // one way a lost ACK could read as a clean pass.
        deps.logger.warn(
          { streams: ackEntries.length },
          'XACK pipeline returned no replies; rows are persisted but stay in the drainer group PEL',
        );
        return acked;
      }
      replies.forEach(([err], i) => {
        const stream = ackEntries[i]?.[0];
        if (err) {
          deps.logger.warn(
            { stream, err: err },
            'XACK failed; rows are persisted but stay in the drainer group PEL',
          );
        } else if (stream !== undefined) {
          acked.add(stream);
        }
      });
    } catch (err) {
      deps.logger.warn(
        { err: err },
        'XACK pipeline failed; rows are persisted but stay in the drainer group PEL',
      );
    }
    return acked;
  };

  /**
   * Read one batch across `streams`, persist it, and ACK what landed. Returns the
   * number of entries persisted. An empty read, an unparseable batch and a failed
   * persist all return 0 instead of throwing, because none of them is a reason to
   * skip the backlog probe. A Redis rejection still propagates; the caller's
   * `finally` probes first, so even that path leaves the backlog measured.
   */
  const readAndPersist = async (streams: readonly string[]): Promise<number> => {
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
    if (!reply) return 0;

    const flatEntries: AuditEntry[] = [];
    const acks = new Map<string, string[]>();
    const drops: DeferredDrop[] = [];
    for (const [stream, entries] of reply) {
      for (const [entryId, fields] of entries) {
        const decoded = decodeEntry(fields);
        if (decoded.kind === 'absent') {
          // Left unacked deliberately: a live read sees an entry once and holds
          // no delivery count to weigh, so the verdict belongs to the reclaim,
          // which does. Counted here anyway, because that verdict is at least
          // the delivery ceiling in passes away and the operator otherwise
          // learns nothing until it arrives. A `>` read delivers a given id
          // exactly once, so the log is bounded by the number of such entries.
          deps.metrics?.record('audit_read_no_body', 1, { stream });
          deps.logger.warn(
            { stream, entryId },
            'audit drainer: read an entry with no body; leaving it pending for the reclaim to judge',
          );
          continue;
        }
        if (decoded.kind === 'corrupt') {
          drops.push({
            stream,
            report: () => {
              deps.logger.warn(
                { stream, entryId, err: decoded.err },
                'audit drainer: corrupt JSON; dropping entry',
              );
              deps.metrics?.record('audit_poison_entries_dropped', 1, {
                stream,
                cause: 'corrupt-json',
              });
            },
          });
        } else {
          flatEntries.push(decoded.row);
        }
        addAck(acks, stream, entryId);
      }
    }

    // Not an early return on an empty batch: a corrupt entry is queued for ACK
    // too, so a batch where every entry failed to parse still has ids that must
    // reach the XACK below. Returning here would strand them in the PEL until the
    // reclaim's min-idle window elapsed, only to fail to parse again forever, and
    // the "dropping entry" warn above would be false.
    if (flatEntries.length > 0) {
      try {
        await deps.persistBatch(flatEntries);
      } catch (err) {
        deps.logger.error(
          { count: flatEntries.length, err: err },
          'audit persistBatch failed; entries left unacked in the drainer group PEL',
        );
        // No ACK, so the batch stays in the group's pending-entries list, where
        // `reclaimAndPersist` picks it up once it has been idle long enough.
        // `audit_consumer_pending` is what makes the pile-up visible meanwhile.
        return 0;
      }
    }

    reportDrops(drops, await flushAcks(acks));

    if (flatEntries.length === 0) return 0;
    // Reclaimed entries are counted separately, so this histogram keeps meaning
    // "entries a live read carried", not "rows written on this pass".
    deps.metrics?.record('audit_batch_size', flatEntries.length);
    return flatEntries.length;
  };

  const recordReclaimed = (entries: readonly ClaimedEntry[]): void => {
    const perStream = new Map<string, number>();
    for (const entry of entries) {
      perStream.set(entry.stream, (perStream.get(entry.stream) ?? 0) + 1);
    }
    for (const [stream, count] of perStream) {
      deps.metrics?.record('audit_entries_reclaimed', count, { stream });
    }
  };

  /**
   * Ask every stream for its idle pending entries in ONE pipeline. Returns null
   * when the round-trip itself failed, which means no reclaim this pass and
   * nothing more: discovery is best-effort, and letting it abort the pass would
   * cost the live `>` read too, so a Redis blip would stop the drain outright
   * instead of merely postponing the recovery.
   */
  const pendingReplies = async (
    streams: readonly string[],
  ): Promise<readonly [Error | null, unknown][] | null> => {
    try {
      const pendingPipe = deps.redis.pipeline();
      for (const stream of streams) {
        pendingPipe.xpending(
          stream,
          AUDIT_DRAINER_GROUP,
          'IDLE',
          String(reclaimMinIdleMs),
          '-',
          '+',
          String(batchCount),
        );
      }
      return (await pendingPipe.exec()) as readonly [Error | null, unknown][] | null;
    } catch (err) {
      // Logged here because the per-stream loop below reads a per-slot
      // `[err, value]` that a whole-pipeline failure never produced.
      deps.logger.warn(
        { err: err, streams: streams.length },
        'audit PEL discovery pipeline failed; no reclaim this pass',
      );
      return null;
    }
  };

  /**
   * Take ownership of every entry that has been pending longer than the min-idle
   * window and decode it. Two kinds are queued for ACK here rather than carried
   * forward, because leaving either would hold the pending floor up forever: a
   * corrupt body, which can never persist, and a body-less claim reply, which
   * carries no row to persist and is retired only once repeated deliveries have
   * put it past the ceiling.
   *
   * XCLAIM rejecting is NOT absorbed. Discovery failing means we did not look;
   * the claim failing means Redis went away while this pass held entries in an
   * unknown ownership state, and reporting that as a clean pass would hide it.
   */
  const claimIdleEntries = async (
    streams: readonly string[],
  ): Promise<{
    entries: ClaimedEntry[];
    acks: Map<string, string[]>;
    drops: DeferredDrop[];
    claimed: Map<string, string[]>;
  }> => {
    const acks = new Map<string, string[]>();
    const entries: ClaimedEntry[] = [];
    const drops: DeferredDrop[] = [];
    // Every id this pass took ownership of, whatever the decode said about it.
    // The stuck count is claimed-minus-resolved, and an entry skipped before it
    // ever became a `ClaimedEntry` (a body-less reply below the ceiling) is
    // precisely the one that repeats unbounded, so the tally cannot be derived
    // from the decoded rows alone.
    const claimed = new Map<string, string[]>();
    const replies = await pendingReplies(streams);
    if (!replies) return { entries, acks, drops, claimed };

    for (const [i, stream] of streams.entries()) {
      const slot = replies[i];
      if (!slot) continue;
      if (slot[0]) {
        // Per-slot, so one stream's failure costs only that stream its reclaim.
        deps.logger.warn(
          { stream, err: slot[0] },
          'audit XPENDING failed; no reclaim for this stream this pass',
        );
        continue;
      }
      const pending = parsePendingEntries(slot[1]);
      if (pending.length === 0) continue;
      const deliveriesById = new Map(pending.map((p) => [p.id, p.deliveries]));

      // Plain XCLAIM, never JUSTID: JUSTID skips the delivery-counter bump, and
      // that counter is the only thing that lets a repeatedly failing entry ever
      // cross the ceiling into an isolated retry. It would otherwise be retried
      // in bulk forever, alongside the batch it keeps poisoning.
      //
      // Over-ceiling ids are claimed too. Isolation is a persist-side decision,
      // and an entry left unclaimed is an entry whose row we never hold.
      const reply = (await deps.redis.xclaim(
        stream,
        AUDIT_DRAINER_GROUP,
        AUDIT_DRAINER_CONSUMER,
        reclaimMinIdleMs,
        ...pending.map((p) => p.id),
      )) as readonly [string, readonly string[]][] | null;
      if (!reply) continue;

      // Redis answers with fewer entries than were asked for when MAXLEN trimming
      // deleted the entry while its PEL reference survived; the claim purges that
      // reference itself (Redis 7+), so a missing id needs no ACK and no retry.
      for (const [entryId, fields] of reply) {
        const queued = claimed.get(stream);
        if (queued) queued.push(entryId);
        else claimed.set(stream, [entryId]);
        const decoded = decodeEntry(fields);
        if (decoded.kind === 'ok') {
          entries.push({
            stream,
            id: entryId,
            deliveries: deliveriesById.get(entryId) ?? 0,
            row: decoded.row,
          });
        } else if (decoded.kind === 'corrupt') {
          drops.push({
            stream,
            report: () => {
              deps.logger.warn(
                { stream, entryId, err: decoded.err },
                'audit drainer: corrupt JSON on a reclaimed entry; dropping it',
              );
              // Counted on the same series as a rejected row: this acks an audit
              // record away too, and a discard nothing measures reads as recovery
              // on both backlog gauges.
              deps.metrics?.record('audit_poison_entries_dropped', 1, {
                stream,
                cause: 'corrupt-json',
              });
            },
          });
          addAck(acks, stream, entryId);
        } else if (decoded.kind === 'absent') {
          // Narrowed rather than a bare `else`: this is the one arm that ends in
          // an ACK it does not have to justify against a row, so a decode kind
          // added later must land somewhere it cannot silently destroy.
          //
          // A claimed id whose fields carry no body is not a documented reply:
          // Redis 7+ omits an id whose stream entry was trimmed and purges the
          // dangling PEL reference itself, so nothing here explains the shape.
          // Acking on sight would destroy an audit row on an unknown reply,
          // which is the loss this whole path exists to prevent. Repetition is
          // the only evidence available, so the entry is kept until it has been
          // delivered past the same ceiling that governs isolation — a bound on
          // the forever-reclaim cost, not a verdict on the first sighting.
          //
          // Retirement lives here and not on the `>` read because the delivery
          // count is a property of the pending list: a live read sees an entry
          // once and has no count to weigh. Its body-less entries reach this
          // ceiling too, one pass later, by way of the PEL.
          const deliveries = deliveriesById.get(entryId) ?? 0;
          if (deliveries <= AUDIT_RECLAIM_DELIVERY_CEILING) continue;
          drops.push({
            stream,
            report: () => {
              deps.logger.error(
                { stream, entryId, deliveries },
                'audit drainer: claimed entry carries no body after repeated deliveries; dropping it as poison',
              );
              deps.metrics?.record('audit_poison_entries_dropped', 1, {
                stream,
                cause: 'no-body',
              });
            },
          });
          addAck(acks, stream, entryId);
        } else {
          // Unreached today. Left as a compile error rather than a silent skip
          // because a kind that falls out of this chain is neither acked nor
          // carried forward, which is exactly the permanent PEL resident the
          // arm above exists to retire.
          decoded satisfies never;
        }
      }
    }
    return { entries, acks, drops, claimed };
  };

  /**
   * Count the entries this pass claimed and then left exactly where it found
   * them: not written, not retired, still pending, and due to be claimed again
   * next pass at the same cost.
   *
   * Resolution is read off the ACK queue rather than off the persisted rows,
   * because both ways out of the pending list go through it — a persisted entry
   * and a dropped one are equally resolved, and neither is stuck.
   *
   * Emitted per pass, not per entry lifetime. One sighting cannot be told apart
   * from a batch merely in flight; it is the same entries counted again on the
   * next pass that make the condition legible over an alert window.
   */
  const recordStuck = (
    claimed: ReadonlyMap<string, readonly string[]>,
    acks: ReadonlyMap<string, readonly string[]>,
  ): void => {
    for (const [stream, ids] of claimed) {
      const resolved = new Set(acks.get(stream) ?? []);
      const stuck = ids.filter((id) => !resolved.has(id)).length;
      if (stuck > 0) deps.metrics?.record('audit_entries_stuck', stuck, { stream });
    }
  };

  /**
   * Persist ONE stream's claimed entries, and decide what a repeated failure
   * means. Called per stream so the decision below is scoped to the profile that
   * owns the rows.
   *
   * The ceiling on its own would be WRONG as a drop trigger. A long Postgres
   * outage redelivers every entry on every pass, so every entry crosses the
   * ceiling together, and "drop over the ceiling" would delete the whole audit
   * backlog, precisely the loss this path exists to prevent. Crossing it
   * therefore admits the whole BATCH to a search, never an entry to a drop.
   *
   * The search narrows the two cases, because its statements run against the same
   * backend within the same pass, but a sibling write alone is not enough to
   * condemn a row. THREE independent things must all hold before an entry is
   * dropped: the entry the search isolated has itself crossed the ceiling, some
   * sibling row actually reached Postgres in this pass, AND the rejection names a
   * fault of the row rather than of the backend. The ceiling is a separate test
   * from admission because the search reaches entries on their first redelivery
   * that the old head-first walk never handed to a retry. A connection reset or a
   * failover part-way through the search produces exactly the "failed alone beside
   * a success" signature without the row being at fault, so timing evidence on its
   * own would delete healthy audit records. If any test fails, nothing is dropped:
   * a PEL holding an unwritable entry with no proven sibling holds a flat pending
   * floor until one appears, which is a flat gauge, not a wedge.
   *
   * The isolation is found by BISECTING the failed batch, not by walking it. A
   * walk retried a fixed number of entries from the head, so a batch's forward
   * progress was that number per pass however deep the pending list was, and one
   * unwritable row far enough down the list held every healthy entry behind it
   * until MAXLEN trimmed the tail away. Bisect writes each healthy half in one
   * statement, so a batch of N with one unwritable row lands N-1 entries in a
   * single pass for O(log N) statements.
   */
  const persistOneStream = async (
    entries: readonly ClaimedEntry[],
    acks: Map<string, string[]>,
    drops: DeferredDrop[],
  ): Promise<number> => {
    try {
      await deps.persistBatch(entries.map((e) => e.row));
      for (const entry of entries) addAck(acks, entry.stream, entry.id);
      recordReclaimed(entries);
      return entries.length;
    } catch (err) {
      // warn, not error: nothing is lost, the entries stay claimable, and during
      // a Postgres outage `readAndPersist` already logs the same root cause at
      // error on the same pass.
      deps.logger.warn(
        { count: entries.length, err: err },
        'audit reclaim persist failed; entries stay in the drainer group PEL',
      );
    }

    // Eligibility only, and still on the ceiling: an entry that has not been
    // redelivered enough times has not yet earned the cost of a search, and a
    // batch of them is simply left whole for the next pass. Once ANY entry has
    // earned it the whole batch is searched, because the healthy entries beside
    // it are the ones the search exists to rescue.
    if (!entries.some((e) => e.deliveries > AUDIT_RECLAIM_DELIVERY_CEILING)) return 0;

    const persisted: ClaimedEntry[] = [];
    const failed: { readonly entry: ClaimedEntry; readonly err: unknown }[] = [];
    // Entries the search gave up on this pass. They are neither acked nor
    // condemned: an unsearched entry has no verdict, so it stays in the PEL for
    // the next pass exactly as if this one had never claimed it.
    const unresolved: ClaimedEntry[] = [];
    // Rows the backend confirmed it wrote. A resolved persist is NOT proof of
    // health: most audit entries are noops that map to zero action_log rows and
    // never open a connection, so they resolve happily with Postgres down.
    // Gating the drop on a resolve would let those vacuous successes condemn
    // the actionable entries failing beside them, which is the loss this path
    // exists to stop.
    let provenWrites = 0;
    let probesLeft = AUDIT_RECLAIM_PROBE_MAX;
    let halted = false;
    // Latched at the FIRST shed, not read off `halted` at the end. Budget shedding
    // runs before a later singleton can halt the pass, so a flag read afterwards
    // would blame an outage for entries the cap had already handed back and point
    // the operator at the wrong failure.
    let shedReason: 'no-proven-write' | 'probe-budget' | undefined;

    // One persist statement. Success takes the whole sub-batch out of the PEL,
    // so a healthy half costs one statement no matter how many entries it holds.
    // No re-XCLAIM anywhere below: this pass already owns every entry, already
    // bumped its delivery count, and already holds the decoded row.
    const attempt = async (
      sub: readonly ClaimedEntry[],
    ): Promise<{ readonly ok: true } | { readonly ok: false; readonly err: unknown }> => {
      probesLeft -= 1;
      try {
        provenWrites += await deps.persistBatch(sub.map((e) => e.row));
        for (const entry of sub) {
          persisted.push(entry);
          addAck(acks, entry.stream, entry.id);
        }
        return { ok: true };
      } catch (err) {
        return { ok: false, err };
      }
    };

    /**
     * What a failed sub-batch means, and whether to keep searching it.
     *
     * The halt is decided on a SINGLETON alone, and only when nothing anywhere
     * in this pass has been written and the rejection does not name a fault of
     * the row. That is the signature of a backend that is simply down, and
     * descending further would spend the whole budget re-proving it one entry at
     * a time. A failed sub-batch that still holds several entries proves nothing
     * on its own, and a row-deterministic rejection proves the opposite, so
     * neither may stop the search: an unwritable row sitting at the head of the
     * list must not stop the pass before its healthy siblings are written.
     */
    const resolveFailure = async (half: readonly ClaimedEntry[], err: unknown): Promise<void> => {
      const [only] = half;
      if (half.length === 1 && only) {
        failed.push({ entry: only, err });
        if (deps.isUnpersistableRow?.(err) !== true && provenWrites === 0) halted = true;
        return;
      }
      // `< 2` rather than `<= 0`, because a node always issues both halves: a
      // budget that allowed a node to start with one probe left would overspend
      // it, and the whole point of the cap is a hard statement ceiling.
      if (halted || probesLeft < 2) {
        shedReason ??= halted ? 'no-proven-write' : 'probe-budget';
        unresolved.push(...half);
        return;
      }
      await probeNode(half);
    };

    /** Split a failed sub-batch and write whichever half is writable. */
    const probeNode = async (sub: readonly ClaimedEntry[]): Promise<void> => {
      const mid = sub.length >> 1;
      const left = sub.slice(0, mid);
      const right = sub.slice(mid);
      // BOTH statements are issued before either failure is descended into. A
      // half that lands is the health proof the drop gate needs, and a search
      // that descended the left half first would reach a singleton verdict with
      // no sibling evidence yet on the wire.
      const leftResult = await attempt(left);
      const rightResult = await attempt(right);
      if (!leftResult.ok) await resolveFailure(left, leftResult.err);
      if (!rightResult.ok) await resolveFailure(right, rightResult.err);
    };

    // Health canary, before any bisect. A pass against a dead backend would
    // otherwise explore the whole tree and spend the entire budget learning what
    // one statement can tell it.
    //
    // Sampled from BOTH ends, and the halt needs both samples to fail. `entries`
    // arrives in ascending id order, so entries[0] is the same oldest pending row
    // on every pass, and halting on it alone would let one row whose rejection we
    // cannot classify stall its whole stream forever, which is worse than the walk
    // this search replaced. A sample that maps to no `action_logs` row resolves
    // without ever reaching Postgres and so proves nothing either way, in which
    // case the search simply carries on and the probe budget is what bounds it.
    const head = entries[0];
    const tail = entries.length > 1 ? entries[entries.length - 1] : undefined;
    let searchable = entries.slice(1);
    if (head) {
      const first = await attempt([head]);
      if (!first.ok) {
        if (tail) {
          // Resolved BEFORE the head's own verdict, so a tail that writes raises
          // `provenWrites` in time to keep the head from halting the pass.
          searchable = searchable.slice(0, -1);
          const second = await attempt([tail]);
          if (!second.ok) await resolveFailure([tail], second.err);
        }
        await resolveFailure([head], first.err);
      }
    }
    if (searchable.length > 0) {
      // Recorded as unresolved rather than silently skipped: a halted pass has
      // looked at two entries, and the rest are owed a search it is declining.
      if (halted) {
        shedReason ??= 'no-proven-write';
        unresolved.push(...searchable);
      } else if (searchable.length === 1) {
        const result = await attempt(searchable);
        if (!result.ok) await resolveFailure(searchable, result.err);
      } else await probeNode(searchable);
    }

    if (unresolved.length > 0) {
      // One line per stream, not per entry: the interesting number is how much
      // of the backlog this pass declined to search, and a line per entry would
      // bury it under the same message repeated.
      deps.logger.warn(
        {
          stream: unresolved[0]?.stream,
          unresolved: unresolved.length,
          reason: shedReason ?? 'no-proven-write',
        },
        'audit reclaim search stopped early; unsearched entries stay in the drainer group PEL',
      );
    }

    if (provenWrites > 0) {
      let dropped = 0;
      for (const { entry, err } of failed) {
        // The ceiling authorises the drop; the bisect only located the entry.
        // The search isolates young entries the old head-first walk never
        // reached, so without this test a row on its first redelivery could be
        // destroyed on the strength of a single rejection.
        if (entry.deliveries <= AUDIT_RECLAIM_DELIVERY_CEILING) continue;
        // A sibling write proves the backend answered at some point in this
        // pass, not that it was up when this entry failed. Without the second
        // test, a backend that dies mid-search condemns every entry after the
        // first success.
        if (deps.isUnpersistableRow?.(err) !== true) continue;
        if (dropped >= AUDIT_RECLAIM_DROP_MAX) {
          // error, not warn: the pass is declining to destroy rows it believes it
          // is entitled to destroy, and that belief is what wants checking.
          deps.logger.error(
            { stream: entry.stream, condemned: failed.length, cap: AUDIT_RECLAIM_DROP_MAX },
            'audit reclaim hit its per-pass drop cap; a systematic rejection is likelier than this many poison rows, remainder held in the PEL',
          );
          break;
        }
        dropped += 1;
        addAck(acks, entry.stream, entry.id);
        drops.push({
          stream: entry.stream,
          report: () => {
            deps.metrics?.record('audit_poison_entries_dropped', 1, {
              stream: entry.stream,
              cause: 'rejected',
            });
            // The only trace a dropped audit row leaves. Without the rejection
            // bound here an operator sees a counter tick and nothing to act on.
            deps.logger.error(
              { stream: entry.stream, entryId: entry.id, deliveries: entry.deliveries, err: err },
              'audit entry rejected alone while a sibling row was written to Postgres; dropping it as poison',
            );
          },
        });
      }
    }

    recordReclaimed(persisted);
    return persisted.length;
  };

  /**
   * Fan the claimed entries out one stream at a time. `persistBatch` is a single
   * all-or-nothing INSERT, so a cross-stream batch lets one profile's unwritable
   * row fail every other profile's rows in the same statement, and the search
   * would then spend one shared probe budget bisecting a mixed batch, starving
   * whichever streams it reached last until MAXLEN trimmed their entries away.
   * A stream's backlog
   * must only ever be held up by its own rows. Splitting also narrows the health
   * proof: a sibling write on the SAME stream is stronger evidence than one on
   * an unrelated profile's.
   */
  const persistReclaimed = async (
    entries: readonly ClaimedEntry[],
    acks: Map<string, string[]>,
    drops: DeferredDrop[],
  ): Promise<number> => {
    const byStream = new Map<string, ClaimedEntry[]>();
    for (const entry of entries) {
      const queued = byStream.get(entry.stream);
      if (queued) queued.push(entry);
      else byStream.set(entry.stream, [entry]);
    }

    let persisted = 0;
    // Serial: the search awaits each probe and is capped per stream, so it already
    // paces itself, and a recovery path has no reason to widen its own load
    // during an outage.
    for (const streamEntries of byStream.values()) {
      persisted += await persistOneStream(streamEntries, acks, drops);
    }
    return persisted;
  };

  /**
   * Reclaim what earlier passes abandoned. Runs BEFORE the `>` read: a pending
   * entry is older than anything a live read can return, and `action_logs` is
   * read time-ordered, so draining fresh entries first would hold the recovered
   * rows behind the live ones for the whole outage.
   */
  const reclaimAndPersist = async (streams: readonly string[]): Promise<number> => {
    for (const stream of streams) seedStreamCounters(stream);
    const { entries, acks, drops, claimed } = await claimIdleEntries(streams);
    const persisted = entries.length === 0 ? 0 : await persistReclaimed(entries, acks, drops);
    // Before the flush, so the verdict is what this pass decided rather than
    // whether Redis accepted the ACK. A failed ACK leaves rows that ARE in
    // action_logs pending, and counting those as stuck would report an audit gap
    // that does not exist.
    recordStuck(claimed, acks);
    reportDrops(drops, await flushAcks(acks));
    return persisted;
  };

  // Both gauges for every stream in ONE pipeline. These are pure instrumentation,
  // and the serial form paid 2N round-trips per pass, so the drainer's own
  // measurement overhead grew with the backlog it was measuring, throttling the
  // drain exactly when it was already behind.
  const probeReplies = async (
    streams: readonly string[],
  ): Promise<readonly [Error | null, unknown][] | null> => {
    try {
      const probePipe = deps.redis.pipeline();
      for (const stream of streams) {
        probePipe.xlen(stream);
        probePipe.xinfo('GROUPS', stream);
      }
      return (await probePipe.exec()) as readonly [Error | null, unknown][] | null;
    } catch (err) {
      // Logged here because the per-stream loop below cannot see this error: it
      // reads a per-slot `[err, value]` that a whole-pipeline failure never
      // produced, so without this line the only record of the cause is lost and
      // every stream reports `err: undefined`.
      deps.logger.warn({ err: err, streams: streams.length }, 'audit lag probe pipeline failed');
      // A null reply set makes every stream report its backlog unknown below,
      // which is the honest reading of a pipeline that never came back.
      return null;
    }
  };

  /**
   * Re-read stream length and consumer-group backlog for every stream and emit
   * them. Runs on EVERY pass, including passes that persisted nothing: the lag
   * gauge is last-value-wins, so a pass that skips it leaves the previous healthy
   * number standing and a Postgres stall reads as a caught-up drainer.
   *
   * Never throws and never reports a batched count, so it cannot change what the
   * pass returns or turn an instrumentation hiccup into a failed drain.
   */
  const probeStreams = async (streams: readonly string[]): Promise<void> => {
    const replies = await probeReplies(streams);
    streams.forEach((stream, i) => {
      // Per-stream, so one stream's bad slot cannot cost the rest their gauges.
      try {
        seedStreamCounters(stream);
        const lenReply = replies?.[i * 2];
        const groupsReply = replies?.[i * 2 + 1];
        if (lenReply && !lenReply[0] && typeof lenReply[1] === 'number') {
          // Record raw length as a gauge but never alert on it: a
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
          // Both gauges keep their last value, so the skip is invisible on their
          // own series. The counter is what makes the gap countable in PromQL.
          recordUnknown(stream, 'probe-failed');
          deps.logger.warn(
            { stream, err: groupsReply?.[0] },
            'audit consumer lag probe failed; backlog unknown this pass',
          );
          return;
        }
        const backlog = parseConsumerGroup(groupsReply[1], AUDIT_DRAINER_GROUP);
        // Redis answered, but with no such group. Not the same as a null lag:
        // there is no consumer to be behind, so nothing is draining this stream.
        if (!backlog) {
          recordUnknown(stream, 'group-missing');
          deps.logger.error(
            { stream, group: AUDIT_DRAINER_GROUP },
            'audit drainer consumer group absent from XINFO GROUPS; stream is not being drained',
          );
          return;
        }
        // Pending is the signal a Postgres stall actually moves. The drainer
        // keeps reading through one, so lag stays near zero while every failed
        // batch accumulates here unacked.
        if (backlog.pending != null) {
          deps.metrics?.record('audit_consumer_pending', backlog.pending, { stream });
        }
        const lag = backlog.lag;
        if (lag != null) deps.metrics?.record('audit_consumer_lag', lag, { stream });
        else recordUnknown(stream, 'trimmed-past-group');
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
  };

  const drainOnce: AuditDrainer['drainOnce'] = async () => {
    const streams = await deps.enabledStreams();
    if (streams.length === 0) return { batched: 0, streams: 0 };
    for (const s of streams) await ensureGroup(s);
    try {
      const reclaimed = await reclaimAndPersist(streams);
      const read = await readAndPersist(streams);
      return { batched: reclaimed + read, streams: streams.length };
    } finally {
      // `finally`, so the probe also runs on the paths that return nothing:
      // an idle BLOCK timeout, an unparseable batch, and a rejected persist.
      // Those are exactly the passes during which the backlog is growing.
      await probeStreams(streams);
    }
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
