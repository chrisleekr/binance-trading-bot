// Tick-latency-unchanged invariant for the audit shipper. Full backpressure
// scenarios (PG unreachable, stream length growing to MAXLEN, drainer catching
// up via XREADGROUP) are covered in the integration suite. Here we lock the
// in-process contract: publish() never throws, even when Redis fails.

import { describe, expect, it, vi } from 'vitest';

import type { ProfileId, UserId } from '@app/contracts';
import {
  AUDIT_CONSUMER_LAG_ALERT,
  AUDIT_DRAINER_CONSUMER,
  AUDIT_DRAINER_GROUP,
  AUDIT_RECLAIM_DELIVERY_CEILING,
  AUDIT_RECLAIM_DROP_MAX,
  AUDIT_RECLAIM_PROBE_MAX,
  DEFAULT_RECLAIM_MIN_IDLE_MS,
  createAuditDrainer,
  createAuditShipper,
  parseConsumerGroup,
  parsePendingEntries,
  type AuditEntry,
} from '../../src/audit-shipper/audit-shipper.js';
// The production classifier, not a copy: a test that re-implemented the SQLSTATE
// rule would keep passing after the real one drifted.
import { isUnpersistableRow } from '../../src/boot/builders/audit.js';
import { CATALOG, type MetricName } from '../../src/metrics/catalog.js';

// A RESP2 XINFO GROUPS reply: each group is a flat [field, value, ...] array.
const groupReply = (name: string, lag: number | null, pending: number | null = 0): unknown[] => [
  'name',
  name,
  'consumers',
  1,
  'pending',
  pending,
  'last-delivered-id',
  '1-0',
  'entries-read',
  5,
  'lag',
  lag,
];
const stubLogger = {
  warn: vi.fn(),
  info: vi.fn(),
  debug: vi.fn(),
  error: vi.fn(),
} as unknown as Parameters<typeof createAuditShipper>[0]['logger'];

const baseEntry: AuditEntry = {
  userId: 'u_1' as unknown as UserId,
  profileId: 'p_1' as unknown as ProfileId,
  tickId: '00000000-0000-4000-8000-000000000793',
  ts: 1_700_000_000_000,
  symbol: 'BTCUSDT',
  event: 'tick',
  latencyMs: 12,
  decisionTypes: ['noop'],
  clientOrderIds: [],
  payload: {},
};

describe('audit shipper publish', () => {
  it('forwards an XADD with MAXLEN ~ AUDIT_STREAM_MAXLEN', async () => {
    const xadd = vi.fn(async () => '0-0');
    const redis = { xadd, xlen: vi.fn() } as unknown as Parameters<
      typeof createAuditShipper
    >[0]['redis'];
    const shipper = createAuditShipper({ redis, logger: stubLogger });

    await shipper.publish(baseEntry);

    expect(xadd).toHaveBeenCalledTimes(1);
    const args = xadd.mock.calls[0];
    if (!args) throw new Error('xadd should have been called');
    // signature: (key, 'MAXLEN', '~', maxlenStr, '*', 'body', body)
    expect(args[1]).toBe('MAXLEN');
    expect(args[2]).toBe('~');
    expect(Number(args[3])).toBeGreaterThanOrEqual(100_000);
    expect(args[4]).toBe('*');
  });

  it('swallows Redis failures and logs a warn — tick must keep moving', async () => {
    const warn = vi.fn();
    const redis = {
      xadd: vi.fn(async () => {
        throw new Error('connection refused');
      }),
      xlen: vi.fn(),
    } as unknown as Parameters<typeof createAuditShipper>[0]['redis'];
    const shipper = createAuditShipper({
      redis,
      logger: { ...stubLogger, warn } as never,
    });

    // The whole point: this must not throw.
    await expect(shipper.publish(baseEntry)).resolves.toBeUndefined();
    expect(warn).toHaveBeenCalledTimes(1);
  });

  it('streamLength forwards XLEN against the per-(user,profile) stream key', async () => {
    const xlen = vi.fn(async (key: string) => (key.includes('p_1') ? 42 : 0));
    const redis = { xadd: vi.fn(), xlen } as unknown as Parameters<
      typeof createAuditShipper
    >[0]['redis'];
    const shipper = createAuditShipper({ redis, logger: stubLogger });

    const len = await shipper.streamLength(
      'u_1' as unknown as UserId,
      'p_1' as unknown as ProfileId,
    );
    expect(len).toBe(42);
    expect(xlen).toHaveBeenCalledTimes(1);
    // The stream key must encode both the user and profile parts so a
    // user_id mismatch can't silently land on someone else's stream.
    const [streamKey] = xlen.mock.calls[0] ?? [];
    expect(streamKey).toContain('u_1');
    expect(streamKey).toContain('p_1');
  });
});

// The drainer reads XINFO GROUPS through its metrics pipeline, so what needs
// pinning is the RESP2 reply parsing, not the round-trip that fetched it.
describe('parseConsumerGroup', () => {
  it('returns the numeric lag for the matching group, ignoring others', () => {
    expect(
      parseConsumerGroup(
        [groupReply('some-other-group', 99), groupReply(AUDIT_DRAINER_GROUP, 3)],
        AUDIT_DRAINER_GROUP,
      )?.lag,
    ).toBe(3);
  });

  it('returns a null lag when lag is null — trimming dropped entries the group had not read', () => {
    const parsed = parseConsumerGroup([groupReply(AUDIT_DRAINER_GROUP, null)], AUDIT_DRAINER_GROUP);
    // The group exists, so the result is present; only the lag is unknown. These
    // are different incidents and collapsing them mislabels the alert's cause.
    expect(parsed).not.toBeNull();
    expect(parsed?.lag).toBeNull();
  });

  it('returns null when the group is absent', () => {
    expect(parseConsumerGroup([groupReply('some-other-group', 0)], AUDIT_DRAINER_GROUP)).toBeNull();
  });

  it('returns 0 (not null) for a caught-up group', () => {
    expect(parseConsumerGroup([groupReply(AUDIT_DRAINER_GROUP, 0)], AUDIT_DRAINER_GROUP)?.lag).toBe(
      0,
    );
  });

  // Pending is the number a Postgres stall moves: reading keeps succeeding, so
  // lag stays flat while unacked entries accumulate. Parsing it is what lets the
  // alert see a stall at all.
  it('returns the pending (delivered-but-unacked) count alongside lag', () => {
    expect(
      parseConsumerGroup([groupReply(AUDIT_DRAINER_GROUP, 0, 4_200)], AUDIT_DRAINER_GROUP),
    ).toEqual({ lag: 0, pending: 4_200 });
  });

  // Documents the mapping rather than endorsing it: a value that is present but
  // unparseable becomes a null lag, which the drainer then labels
  // trimmed-past-group, i.e. reports loss. Not reachable through ioredis, whose
  // RESP2 parsing yields a number or null, which is why it is left as is.
  it('skips a non-array group entry and treats a non-numeric lag as null', () => {
    expect(
      parseConsumerGroup(
        ['not-a-group', groupReply(AUDIT_DRAINER_GROUP, 'abc' as unknown as number)],
        AUDIT_DRAINER_GROUP,
      ),
    ).toEqual({ lag: null, pending: 0 });
  });

  it('returns a null pending when the reply carries no pending field', () => {
    expect(
      parseConsumerGroup([groupReply(AUDIT_DRAINER_GROUP, 3, null)], AUDIT_DRAINER_GROUP)?.pending,
    ).toBeNull();
  });
});

// XPENDING's extended form answers with one [id, consumer, idleMs, deliveries]
// tuple per entry. The drainer reads two of those four: the id to claim, and the
// delivery count that decides whether a failing entry gets isolated.
describe('parsePendingEntries', () => {
  it('parses id and delivery count out of the RESP2 tuple', () => {
    expect(parsePendingEntries([['5-0', AUDIT_DRAINER_CONSUMER, 90_000, 3]])).toMatchObject([
      { id: '5-0', deliveries: 3 },
    ]);
  });

  it('coerces numeric fields, which RESP2 can hand back as strings', () => {
    expect(parsePendingEntries([['5-0', AUDIT_DRAINER_CONSUMER, '90000', '3']])).toMatchObject([
      { id: '5-0', deliveries: 3 },
    ]);
  });

  // Fail-safe direction. The delivery count is the only input to the isolation
  // decision, and isolation is the only route to a poison drop. Reading an
  // unparseable count as 0 keeps the entry below the ceiling forever: it is
  // retried in bulk on every pass and can never be dropped. Defaulting it high
  // would do the opposite and make an unreadable reply a licence to delete.
  it('reads an unreadable delivery count as 0, so the entry is never isolated and never dropped', () => {
    expect(
      parsePendingEntries([['5-0', AUDIT_DRAINER_CONSUMER, 90_000, 'not-a-number']]),
    ).toMatchObject([{ id: '5-0', deliveries: 0 }]);
    expect(parsePendingEntries([['5-0', AUDIT_DRAINER_CONSUMER, 90_000]])).toMatchObject([
      { id: '5-0', deliveries: 0 },
    ]);
  });

  it('returns an empty list for a null or non-array reply', () => {
    expect(parsePendingEntries(null)).toEqual([]);
    expect(parsePendingEntries('OK')).toEqual([]);
  });

  // One bad tuple must not cost the rest of the batch its reclaim, or a single
  // malformed reply strands every sibling entry in the PEL indefinitely.
  it('skips a malformed entry instead of discarding the whole reply', () => {
    expect(
      parsePendingEntries(['not-a-tuple', ['6-0', AUDIT_DRAINER_CONSUMER, 1, 1]]).map((e) => e.id),
    ).toEqual(['6-0']);
  });

  it('skips an entry with no id, which cannot be claimed or acked', () => {
    expect(parsePendingEntries([[null, AUDIT_DRAINER_CONSUMER, 1, 1]])).toEqual([]);
  });
});

const STREAM = 'audit:u_1:p_1:stream';

interface DrainerOpts {
  /** XINFO slot errors for this stream index only, leaving siblings healthy. */
  readonly failXinfoIndex?: number;
  readonly persistFails?: boolean;
  /** Raw XREADGROUP reply; `null` models the BLOCK timeout. */
  readonly readReply?: unknown;
  readonly streams?: readonly string[];
  readonly noMetrics?: boolean;
  /** XINFO GROUPS `pending` for every stream. */
  readonly pending?: number;
  /** Raw value for every XINFO slot, replacing the default group reply. */
  readonly xinfoValue?: unknown;
  /** `exec()` rejects outright, rather than resolving null. */
  readonly execRejects?: boolean;
  /** XREADGROUP rejects, the one path that escapes drainOnce. */
  readonly readThrows?: boolean;
  /** Raw XPENDING reply, used for EVERY stream in the reclaim pipeline. */
  readonly pendingEntries?: readonly unknown[];
  /**
   * PEL ids whose stream entry no longer exists. Redis 7 answers XCLAIM for
   * those with nothing and purges the dangling PEL reference itself, so the
   * stub omits them from the claim reply.
   */
  readonly trimmedIds?: readonly string[];
  /**
   * Ids whose XCLAIM reply carries a field array with no `body` key at all —
   * distinct from `trimmedIds`, where the id is missing from the reply and Redis
   * has already purged the PEL reference. Here the entry still exists and still
   * holds its place in the pending list.
   */
  readonly bodylessIds?: readonly string[];
  /** The cross-stream persist of the claimed batch rejects. */
  readonly reclaimPersistFails?: boolean;
  /**
   * Ids whose presence in ANY persist statement rejects it with a ROW-deterministic
   * SQLSTATE (23502, not-null violation), the only class that may cost an entry its
   * place. Applies to the whole claimed batch, every search sub-batch and the
   * singleton alike, so one row gives one verdict wherever the search meets it.
   */
  readonly isolatedFailIds?: readonly string[];
  /** As `isolatedFailIds`, but every statement on these streams rejects. */
  readonly isolatedFailStreams?: readonly string[];
  /**
   * As `isolatedFailIds`, but with a TRANSIENT SQLSTATE (53300, too many
   * connections), modelling a backend that is simply down. The same row succeeds
   * once Postgres recovers, so it must never be dropped.
   */
  readonly transientFailIds?: readonly string[];
  /** Overrides DEFAULT_BATCH, which bounds the XPENDING COUNT argument. */
  readonly batchCount?: number;
  /** Ids whose XCLAIMed body is not valid JSON, so no backend could accept it. */
  readonly corruptIds?: readonly string[];
  /**
   * Ids whose XCLAIMed body parses but is missing the fields the action_logs
   * mapping reads. The mapper would throw a TypeError, which carries no
   * SQLSTATE, so nothing downstream could ever classify or retire the entry.
   */
  readonly unmappableIds?: readonly string[];
  /** Fail the XPENDING slot for ONE stream, by position, leaving the rest good. */
  readonly failXpendingIndex?: number;
  /**
   * Ids that resolve having written NOTHING, modelling the production noop: the
   * entry is non-actionable, maps to zero action_log rows, and so returns without
   * ever reaching Postgres. Subtracted from the written-row count of whatever
   * statement carries them, so a batch of them proves nothing about the backend.
   */
  readonly vacuousIds?: readonly string[];
  /** XCLAIM rejects, modelling Redis dying mid-reclaim. */
  readonly claimThrows?: boolean;
  /** Overrides DEFAULT_RECLAIM_MIN_IDLE_MS on the drainer under test. */
  readonly reclaimMinIdleMs?: number;
  /**
   * The ACK pipeline's `exec()` rejects, leaving every id it carried in the PEL.
   *
   * Narrower than `execRejects` on purpose: that one fails EVERY pipeline, which
   * takes XPENDING down with it, so no entry is ever claimed and a drop-gating
   * assertion would pass without the gate existing. Keyed on the pipeline having
   * a queued XACK so the discovery and probe round-trips stay healthy and the
   * pass genuinely reaches a drop decision.
   */
  readonly ackExecRejects?: boolean;
  /** As above, but `exec()` resolves to null — ioredis' discarded-pipeline reply. */
  readonly ackExecNull?: boolean;
  /**
   * Fail the XACK slot for these streams only, leaving every other stream's slot
   * good. `failSlot: 'xack'` fails them all, which cannot tell a drop gate that
   * is scoped per stream from one that gives up wholesale on any ACK error.
   */
  readonly failAckStreams?: readonly string[];
}

// Marks a row as having arrived via XCLAIM rather than the `>` read, and carries
// its PEL id, so the persist stub can tell the reclaim batch from the solo
// retries and the assertions can name exactly which entries landed.
const RECLAIMED_EVENT = 'reclaimed';
// Shaped like what reaches the drainer in production: the driver's SQLSTATE
// hangs off `cause`, because drizzle wraps every query error before re-throwing.
const pgError = (message: string, code: string): Error =>
  new Error(message, { cause: Object.assign(new Error(message), { code }) });
// The owning stream rides in the payload because `pendingEntries` is reused for
// every stream, so a PEL id alone cannot say which stream a claimed row came
// from — and the persist now runs per stream.
const reclaimedBody = (id: string, stream: string): string =>
  JSON.stringify({
    ...baseEntry,
    event: RECLAIMED_EVENT,
    clientOrderIds: [id],
    payload: { stream },
  });
// Valid JSON, no `decisionTypes` or `payload`: the shape the mapper cannot use.
const UNMAPPABLE_BODY = JSON.stringify({ hello: 'world' });
const claimedBody = (id: string, stream: string, opts: DrainerOpts): string => {
  if ((opts.corruptIds ?? []).includes(id)) return '{not json';
  if ((opts.unmappableIds ?? []).includes(id)) return UNMAPPABLE_BODY;
  return reclaimedBody(id, stream);
};
const pendingTuple = (id: string, deliveries = 1, idleMs = 90_000): unknown[] => [
  id,
  AUDIT_DRAINER_CONSUMER,
  idleMs,
  deliveries,
];

// One entry per stream, in the RESP2 shape XREADGROUP returns.
const deliverOnePerStream = (streams: readonly string[]): unknown =>
  streams.map((s) => [s, [['1-0', ['body', JSON.stringify(baseEntry)]]]]);

// A drainer over `streams` that delivers exactly one entry per pass, with the
// group's XINFO lag stubbed to `lag`. Captures logger.warn + metrics.record.
const drainerWithLag = (
  lag: number | null,
  failSlot?: 'xack' | 'xlen' | 'xinfo' | 'xpending' | 'exec',
  opts: DrainerOpts = {},
) => {
  const streams = opts.streams ?? [STREAM];
  const warn = vi.fn();
  const error = vi.fn();
  const record = vi.fn();
  // The ACK and the two per-stream gauges now ride pipelines, so the stub has
  // to answer in pipeline reply shape ([err, value] per queued command) rather
  // than as standalone methods.
  const xackCalls: unknown[][] = [];
  const xpendingCalls: unknown[][] = [];
  // Fires when a pipeline holding an XACK actually round-trips. Queue-time
  // capture cannot tell "the ids were staged" from "the ids reached Redis", and
  // that gap is exactly what a deferred drop has to clear.
  const ackExec = vi.fn();
  const slot = (
    kind: 'xack' | 'xlen' | 'xinfo' | 'xpending',
    value: unknown,
  ): [Error | null, unknown] =>
    failSlot === kind ? [new Error(`${kind} boom`), null] : [null, value];
  const makePipeline = () => {
    const replies: [Error | null, unknown][] = [];
    let xinfoCalls = 0;
    let queuedAck = false;
    const chain = {
      xack: (...args: unknown[]) => {
        xackCalls.push(args);
        queuedAck = true;
        replies.push(
          (opts.failAckStreams ?? []).includes(String(args[0]))
            ? [new Error('xack boom'), null]
            : slot('xack', 1),
        );
        return chain;
      },
      xpending: (...args: unknown[]) => {
        const streamIndex = xpendingCalls.length;
        xpendingCalls.push(args);
        replies.push(
          streamIndex === opts.failXpendingIndex
            ? [new Error('xpending boom'), null]
            : slot('xpending', opts.pendingEntries ?? []),
        );
        return chain;
      },
      xlen: () => {
        replies.push(slot('xlen', 100_000));
        return chain;
      },
      xinfo: () => {
        const streamIndex = xinfoCalls++;
        const value =
          opts.xinfoValue === undefined
            ? [groupReply(AUDIT_DRAINER_GROUP, lag, opts.pending ?? 0)]
            : opts.xinfoValue;
        replies.push(
          opts.failXinfoIndex === streamIndex
            ? [new Error('xinfo boom'), null]
            : slot('xinfo', value),
        );
        return chain;
      },
      // ioredis resolves `exec()` to null when the pipeline is discarded.
      exec: async () => {
        if (opts.execRejects) throw new Error('pipeline boom');
        if (queuedAck) {
          // Recorded before the two failure branches: this fires when the ACK
          // pipeline round-TRIPPED, which is what the deferral asserts against,
          // not when it succeeded.
          ackExec();
          if (opts.ackExecRejects) throw new Error('ack pipeline boom');
          if (opts.ackExecNull) return null;
        }
        return failSlot === 'exec' ? null : replies;
      },
    };
    return chain;
  };
  const pipeline = vi.fn(makePipeline);
  const xreadgroup = vi.fn(async () => {
    if (opts.readThrows) throw new Error('redis down');
    return opts.readReply === undefined ? deliverOnePerStream(streams) : opts.readReply;
  });
  // Standalone (not pipelined): XCLAIM's reply is what the persist consumes, so
  // the drainer needs it in hand before it can build the batch.
  const xclaim = vi.fn(async (...args: unknown[]) => {
    if (opts.claimThrows) throw new Error('redis down');
    // (stream, group, consumer, minIdleMs, ...ids)
    const ids = args.slice(4).map(String);
    return ids
      .filter((id) => !(opts.trimmedIds ?? []).includes(id))
      .map((id) =>
        (opts.bodylessIds ?? []).includes(id)
          ? [id, ['ts', '1']]
          : [id, ['body', claimedBody(id, String(args[0]), opts)]],
      );
  });
  const redis = {
    xgroup: vi.fn(async () => 'OK'),
    xreadgroup,
    xclaim,
    // Captured alongside the pipelined form so the reclaim ACK is visible
    // whichever round-trip shape it uses.
    xack: vi.fn(async (...args: unknown[]) => {
      xackCalls.push(args);
      return args.length - 2;
    }),
    pipeline,
  } as unknown as Parameters<typeof createAuditDrainer>[0]['redis'];
  // The reclaim path persists per stream: that stream's whole claimed batch,
  // then the sub-batches its bisect splits out of it. Every rule below is keyed
  // on the ROW SET, so the whole batch, an arbitrary sub-batch and a singleton
  // all answer consistently. A stub keyed on call position would decide the
  // outcome of the search strategy it is supposed to measure.
  const batchedIds = new Set<string>();
  const persistBatch = vi.fn(async (rows: readonly AuditEntry[]): Promise<number> => {
    const reclaimed = rows.filter((r) => r.event === RECLAIMED_EVENT);
    if (reclaimed.length === 0) {
      if (opts.persistFails) throw new Error('postgres unreachable');
      return rows.length;
    }
    const ids = reclaimed.map((r) => r.clientOrderIds[0] ?? '');
    const stream = String(
      (reclaimed[0]?.payload as { stream?: unknown } | undefined)?.stream ?? '',
    );
    // Routing on "ids not yet seen" rather than "first call wins" keeps the
    // whole-batch failure attached to the batch itself now that a second
    // stream's batch arrives AFTER the first stream's sub-batches. Recorded
    // before any rejection below, because a batch that failed is still a batch
    // that has been seen, and re-answering its sub-batches as if each were the
    // batch would repeat the whole-batch failure all the way down.
    const firstSighting = ids.some((id) => !batchedIds.has(id));
    for (const id of ids) batchedIds.add(id);
    // SQLSTATEs, not bare Errors: the drop gate classifies the rejection, so a
    // codeless error would exercise only the fail-closed default. Answered
    // before the whole-batch rule so an unwritable row fails every batch that
    // carries it, which is what admits the batch to the search at all.
    const rejected = ids.find((id) => (opts.isolatedFailIds ?? []).includes(id));
    if (rejected !== undefined || (opts.isolatedFailStreams ?? []).includes(stream))
      throw pgError(`postgres rejected ${rejected ?? ids[0] ?? ''}`, '23502');
    const transient = ids.find((id) => (opts.transientFailIds ?? []).includes(id));
    if (transient !== undefined) throw pgError(`postgres unreachable for ${transient}`, '53300');
    if (firstSighting && opts.reclaimPersistFails)
      throw new Error('postgres unreachable (reclaim batch)');
    // Written-row count, not entry count: a vacuous entry maps to zero
    // action_log rows and so returns without proving the backend is up.
    return ids.filter((id) => !(opts.vacuousIds ?? []).includes(id)).length;
  });
  const drainer = createAuditDrainer({
    redis,
    logger: { ...stubLogger, warn, error } as never,
    persistBatch,
    isUnpersistableRow,
    enabledStreams: async () => streams,
    ...(opts.batchCount === undefined ? {} : { batchCount: opts.batchCount }),
    ...(opts.reclaimMinIdleMs === undefined ? {} : { reclaimMinIdleMs: opts.reclaimMinIdleMs }),
    ...(opts.noMetrics ? {} : { metrics: { record, forget: vi.fn() } }),
  });
  return {
    drainer,
    warn,
    error,
    record,
    pipeline,
    persistBatch,
    xackCalls,
    ackExec,
    xpendingCalls,
    xclaim,
    xreadgroup,
  };
};

// The MetricName annotation documents intent; it is not a gate. No tsconfig
// `include` covers `__tests__/**/*.test.ts` and vitest runs no typecheck, so a
// renamed metric would not fail here. The compile-time pin for the catalogue is
// catalog.test-d.ts, which tsconfig.test-d.json does compile.
const recordsNamed = (record: ReturnType<typeof vi.fn>, name: MetricName): unknown[] =>
  record.mock.calls.filter((c) => c[0] === name);
const lagRecords = (record: ReturnType<typeof vi.fn>): unknown[] =>
  recordsNamed(record, 'audit_consumer_lag');
const pendingRecords = (record: ReturnType<typeof vi.fn>): unknown[] =>
  recordsNamed(record, 'audit_consumer_pending');
// Incidents only. Every stream is also seeded with a zero per counter on its
// first probe so `increase()` has a floor to rise from, and those zeroes are not
// incidents: folding them in here would make every `toHaveLength` below count
// bookkeeping instead of the thing under test.
const incidentRecords = (record: ReturnType<typeof vi.fn>, name: MetricName): unknown[] =>
  recordsNamed(record, name).filter((c) => (c as unknown[])[1] !== 0);
const zeroRecords = (record: ReturnType<typeof vi.fn>, name: MetricName): unknown[] =>
  recordsNamed(record, name).filter((c) => (c as unknown[])[1] === 0);
const unknownRecords = (record: ReturnType<typeof vi.fn>): unknown[] =>
  incidentRecords(record, 'audit_consumer_lag_unknown');
const seedRecords = (record: ReturnType<typeof vi.fn>): unknown[] =>
  zeroRecords(record, 'audit_consumer_lag_unknown');
const reclaimRecords = (record: ReturnType<typeof vi.fn>): unknown[] =>
  incidentRecords(record, 'audit_entries_reclaimed');
const dropRecords = (record: ReturnType<typeof vi.fn>): unknown[] =>
  incidentRecords(record, 'audit_poison_entries_dropped');
const warnMessages = (warn: ReturnType<typeof vi.fn>): string[] =>
  warn.mock.calls.map((c) => String(c[1]));
const errorMessages = (error: ReturnType<typeof vi.fn>): string[] =>
  error.mock.calls.map((c) => String(c[1]));
// Every id acked for `stream`, flattened across calls, so a drainer that acks
// one id per round-trip and one that acks a whole stream's ids in a single call
// read the same here. What matters is which entries left the PEL, not how.
const ackedIds = (xackCalls: unknown[][], stream: string): string[] =>
  xackCalls.filter((c) => c[0] === stream).flatMap((c) => c.slice(2).map(String));
// persistBatch calls carrying XCLAIMed rows, in call order: first the whole
// claimed batch, then one call per search probe, the canary samples first.
const reclaimBatches = (persistBatch: ReturnType<typeof vi.fn>): AuditEntry[][] =>
  persistBatch.mock.calls
    .map((c) => (c[0] ?? []) as AuditEntry[])
    .filter((rows) => rows.some((r) => r.event === RECLAIMED_EVENT));
const idsOf = (rows: readonly AuditEntry[]): string[] => rows.map((r) => r.clientOrderIds[0] ?? '');

describe('drainOnce consumer-lag alerting (#510)', () => {
  it('records the lag gauge and does NOT warn for a healthy (caught-up) group', async () => {
    const { drainer, warn, record } = drainerWithLag(0);
    await drainer.drainOnce();
    expect(lagRecords(record)).toEqual([['audit_consumer_lag', 0, { stream: STREAM }]]);
    expect(warnMessages(warn)).toHaveLength(0);
    // A known-good lag must not also claim the backlog is unknown, or the
    // unknown counter alerts on every healthy pass.
    expect(unknownRecords(record)).toHaveLength(0);
    // Positive control for the length gauge, which every other assertion here
    // only ever checks negatively: deleting the record call would go unnoticed.
    expect(recordsNamed(record, 'audit_stream_length')).toEqual([
      ['audit_stream_length', 100_000, { stream: STREAM }],
    ]);
  });

  // The counter children must exist before an incident, once per stream. Without
  // them a stream's first incident is a series that appears already at its final
  // value, which `increase()` reads as no change: the trimming rule would never
  // fire for a short first event.
  it('seeds all three unknown causes at zero on the first probe, once per stream', async () => {
    const { drainer, record } = drainerWithLag(0);
    await drainer.drainOnce();
    await drainer.drainOnce();
    expect(seedRecords(record)).toEqual([
      ['audit_consumer_lag_unknown', 0, { stream: STREAM, cause: 'probe-failed' }],
      ['audit_consumer_lag_unknown', 0, { stream: STREAM, cause: 'trimmed-past-group' }],
      ['audit_consumer_lag_unknown', 0, { stream: STREAM, cause: 'group-missing' }],
    ]);
  });

  it('warns "above alert threshold" and records the gauge when lag exceeds the cap', async () => {
    const { drainer, warn, record } = drainerWithLag(AUDIT_CONSUMER_LAG_ALERT + 1);
    await drainer.drainOnce();
    expect(lagRecords(record)).toEqual([
      ['audit_consumer_lag', AUDIT_CONSUMER_LAG_ALERT + 1, { stream: STREAM }],
    ]);
    expect(warnMessages(warn).some((m) => m.includes('above alert threshold'))).toBe(true);
  });

  // In a Redis pipeline each queued command carries its own [err, value], so one
  // slot can fail while the rest succeed. Each degradation branch is pinned here
  // because they are the difference between a real alert and a false one.
  it('warns on an errored XACK slot without failing the drain', async () => {
    const { drainer, warn } = drainerWithLag(0, 'xack');
    await expect(drainer.drainOnce()).resolves.toMatchObject({ batched: 1 });
    expect(warnMessages(warn).some((m) => m.includes('XACK failed'))).toBe(true);
  });

  it('reports an errored XINFO slot as "probe failed", NOT as entries lost', async () => {
    // A transport error means the backlog is unknown. Claiming "entries lost
    // before delivery" would send the operator chasing data loss that Redis
    // never reported — that message is reserved for a positively null lag.
    const { drainer, warn, record } = drainerWithLag(0, 'xinfo');
    await drainer.drainOnce();
    expect(lagRecords(record)).toHaveLength(0);
    expect(warnMessages(warn).some((m) => m.includes('probe failed'))).toBe(true);
    expect(warnMessages(warn).some((m) => m.includes('entries lost before delivery'))).toBe(false);
    // The lag gauge is last-value-wins, so skipping it leaves the previous
    // healthy number in place. A separate counter is what makes the gap visible.
    expect(unknownRecords(record)).toEqual([
      ['audit_consumer_lag_unknown', 1, { stream: STREAM, cause: 'probe-failed' }],
    ]);
  });

  // XLEN and XINFO ride the same pipeline but are independent slots. Reading the
  // wrong slot on an error would cost the stream the two gauges the alert
  // actually reads, and would report it unknown when the backlog was measured.
  it('records the backlog gauges even when the XLEN slot errors', async () => {
    const { drainer, record } = drainerWithLag(7, 'xlen', { pending: 3 });
    await drainer.drainOnce();
    expect(recordsNamed(record, 'audit_stream_length')).toHaveLength(0);
    expect(lagRecords(record)).toEqual([['audit_consumer_lag', 7, { stream: STREAM }]]);
    expect(pendingRecords(record)).toEqual([['audit_consumer_pending', 3, { stream: STREAM }]]);
    expect(unknownRecords(record)).toHaveLength(0);
  });

  it('survives exec() resolving null (pipeline discarded) and reports every stream unknown', async () => {
    const { drainer, record } = drainerWithLag(0, 'exec');
    await expect(drainer.drainOnce()).resolves.toMatchObject({ batched: 1 });
    expect(lagRecords(record)).toHaveLength(0);
    expect(unknownRecords(record)).toEqual([
      ['audit_consumer_lag_unknown', 1, { stream: STREAM, cause: 'probe-failed' }],
    ]);
  });

  // A discarded pipeline resolves null; a dead connection rejects. Both have to
  // land on the same counter, or the alert reads a dead Redis as a healthy one.
  it('reports every stream unknown when the probe pipeline rejects outright', async () => {
    const { drainer, record, warn } = drainerWithLag(0, undefined, { execRejects: true });
    await expect(drainer.drainOnce()).resolves.toMatchObject({ batched: 1 });
    expect(lagRecords(record)).toHaveLength(0);
    expect(unknownRecords(record)).toEqual([
      ['audit_consumer_lag_unknown', 1, { stream: STREAM, cause: 'probe-failed' }],
    ]);
    // The per-stream warn cannot see a whole-pipeline error, so the cause is
    // only ever recorded by the pipeline-level line.
    expect(warnMessages(warn).some((m) => m.includes('probe pipeline failed'))).toBe(true);
    const [payload] =
      warn.mock.calls.find((c) => String(c[1]).includes('probe pipeline failed')) ?? [];
    expect((payload as { err?: unknown }).err).toBeInstanceOf(Error);
    // The PEL discovery pipeline rides the same exec(). Its failure is absorbed
    // on purpose, so this warn is the ONLY record that a pass skipped its
    // reclaim; without it a silently skipped recovery looks like a clean pass.
    expect(warnMessages(warn).some((m) => m.includes('PEL discovery pipeline failed'))).toBe(true);
  });

  it('reports a malformed (non-array) XINFO reply as "probe failed"', async () => {
    const { drainer, record } = drainerWithLag(0, undefined, { xinfoValue: 'not-an-array' });
    await drainer.drainOnce();
    expect(lagRecords(record)).toHaveLength(0);
    expect(unknownRecords(record)).toEqual([
      ['audit_consumer_lag_unknown', 1, { stream: STREAM, cause: 'probe-failed' }],
    ]);
  });

  // Redis answered, but with no such group: nothing is draining the stream. That
  // is a worse incident than trimming, and must not borrow its cause label.
  it('reports an absent consumer group as "group-missing", NOT as entries trimmed', async () => {
    const { drainer, record, warn } = drainerWithLag(0, undefined, {
      xinfoValue: [groupReply('some-other-group', 0)],
    });
    await drainer.drainOnce();
    expect(lagRecords(record)).toHaveLength(0);
    expect(unknownRecords(record)).toEqual([
      ['audit_consumer_lag_unknown', 1, { stream: STREAM, cause: 'group-missing' }],
    ]);
    expect(warnMessages(warn).some((m) => m.includes('entries lost before delivery'))).toBe(false);
  });

  it('warns "entries lost" and skips the gauge when lag is null (trimmed past the group)', async () => {
    const { drainer, warn, record } = drainerWithLag(null);
    await drainer.drainOnce();
    // A null lag is not a number, so the gauge is intentionally not recorded.
    expect(lagRecords(record)).toHaveLength(0);
    expect(warnMessages(warn).some((m) => m.includes('entries lost before delivery'))).toBe(true);
    // Distinct cause from a failed probe: Redis answered, and the answer was loss.
    expect(unknownRecords(record)).toEqual([
      ['audit_consumer_lag_unknown', 1, { stream: STREAM, cause: 'trimmed-past-group' }],
    ]);
  });
});

// The lag gauge is last-value-wins. Every drainOnce early return that skips the
// probe leaves it pinned at the last healthy number, so a Postgres stall or an
// idle BLOCK timeout reads as "caught up" for as long as it lasts.
describe('drainOnce backlog probe runs on every pass', () => {
  it('backlog probe runs on every pass when persistBatch rejects', async () => {
    const { drainer, record, persistBatch } = drainerWithLag(7, undefined, { persistFails: true });
    await expect(drainer.drainOnce()).resolves.toEqual({ batched: 0, streams: 1 });
    expect(lagRecords(record)).toEqual([['audit_consumer_lag', 7, { stream: STREAM }]]);
    // The probe rides a `finally`, so it must not re-enter the persist path.
    expect(persistBatch).toHaveBeenCalledTimes(1);
  });

  // The failure this alert is named for. Reading keeps succeeding through a
  // Postgres stall, so lag stays flat and only pending moves; a probe that
  // skipped pending would leave the incident invisible on every series.
  it('records the pending gauge, which is what a Postgres stall actually moves', async () => {
    const { drainer, record } = drainerWithLag(0, undefined, {
      persistFails: true,
      pending: 12_345,
    });
    await drainer.drainOnce();
    expect(pendingRecords(record)).toEqual([
      ['audit_consumer_pending', 12_345, { stream: STREAM }],
    ]);
    expect(lagRecords(record)).toEqual([['audit_consumer_lag', 0, { stream: STREAM }]]);
    expect(unknownRecords(record)).toHaveLength(0);
  });

  // XREADGROUP rejecting is the one path that escapes drainOnce. The `finally`
  // must still probe, and must not swallow the rejection into a resolved pass.
  it('probes the backlog and still rethrows when XREADGROUP rejects', async () => {
    const { drainer, record, pipeline } = drainerWithLag(7, undefined, { readThrows: true });
    await expect(drainer.drainOnce()).rejects.toThrow('redis down');
    // Two: the reclaim pass's XPENDING probe, then the backlog probe.
    expect(pipeline).toHaveBeenCalledTimes(2);
    expect(lagRecords(record)).toEqual([['audit_consumer_lag', 7, { stream: STREAM }]]);
  });

  it('backlog probe runs on every pass when XREADGROUP returns null (BLOCK timeout)', async () => {
    const { drainer, record } = drainerWithLag(7, undefined, { readReply: null });
    await expect(drainer.drainOnce()).resolves.toEqual({ batched: 0, streams: 1 });
    expect(lagRecords(record)).toEqual([['audit_consumer_lag', 7, { stream: STREAM }]]);
  });

  it('backlog probe runs on every pass when no delivered entry is parseable', async () => {
    const { drainer, record } = drainerWithLag(7, undefined, {
      // No `body` field, so nothing lands in the batch.
      readReply: [[STREAM, [['1-0', ['not-body', 'ignored']]]]],
    });
    await expect(drainer.drainOnce()).resolves.toEqual({ batched: 0, streams: 1 });
    expect(lagRecords(record)).toEqual([['audit_consumer_lag', 7, { stream: STREAM }]]);
  });

  // The `>` read sees an entry exactly once and has no delivery count to weigh,
  // so a single sighting of a field array with no `body` is no evidence at all:
  // the entry may be a foreign producer's, and acking it here would destroy a row
  // this drainer never wrote. Retiring such an entry belongs to the reclaim,
  // which is the only path that can tell a repeat offender from a first sighting.
  it('leaves a body-less entry from the live read unacked', async () => {
    const { drainer, xackCalls, record } = drainerWithLag(0, undefined, {
      readReply: [[STREAM, [['9-0', ['ts', '1']]]]],
    });
    await expect(drainer.drainOnce()).resolves.toEqual({ batched: 0, streams: 1 });
    expect(ackedIds(xackCalls, STREAM)).toEqual([]);
    expect(dropRecords(record)).toHaveLength(0);
  });

  // Silence was the defect. The read path took the right ACTION — hold the entry
  // for the reclaim to judge — but emitted nothing, so the first sighting of a
  // foreign writer on audit:* was unobservable. The verdict that does speak,
  // cause="no-body", needs a delivery count that only the pending list carries,
  // which puts it at least AUDIT_RECLAIM_DELIVERY_CEILING reclaim passes and a
  // 60s min-idle floor apiece away. This counter is what dates the condition.
  it('counts and logs a body-less entry the live read saw', async () => {
    const { drainer, record, warn } = drainerWithLag(0, undefined, {
      readReply: [[STREAM, [['9-0', ['ts', '1']]]]],
    });
    await drainer.drainOnce();

    expect(incidentRecords(record, 'audit_read_no_body')).toEqual([
      ['audit_read_no_body', 1, { stream: STREAM }],
    ]);
    // Nothing was destroyed, so this must NOT reach the discard counter: the two
    // send an operator to different conclusions, and only one of them means an
    // action_logs row is gone.
    expect(dropRecords(record)).toHaveLength(0);
    // The counter says a foreign entry exists but not which one. The runbook
    // sends the operator to this phrase to find the id to XRANGE, so the wording
    // is asserted alongside the payload.
    const [payload] =
      warn.mock.calls.find((c) => String(c[1]).includes('read an entry with no body')) ?? [];
    expect(payload).toMatchObject({ stream: STREAM, entryId: '9-0' });
  });

  // prom-client creates a labelled child on first write, so an unseeded counter's
  // first sample IS its final value and increase() reads no change at all —
  // AuditEntryReadWithoutBody would miss the first-ever sighting, which is the
  // one occurrence the rule exists for. Ordering is the assertion, not just
  // presence: a zero written after the incident would re-flatten the series.
  it('seeds the body-less read counter at zero before the first sighting, once per stream', async () => {
    const { drainer, record } = drainerWithLag(0, undefined, {
      readReply: [[STREAM, [['9-0', ['ts', '1']]]]],
    });
    await drainer.drainOnce();
    await drainer.drainOnce();

    expect(zeroRecords(record, 'audit_read_no_body')).toEqual([
      ['audit_read_no_body', 0, { stream: STREAM }],
    ]);
    const seedIndex = record.mock.calls.findIndex(
      (c) => c[0] === 'audit_read_no_body' && c[1] === 0,
    );
    const firstIncident = record.mock.calls.findIndex(
      (c) => c[0] === 'audit_read_no_body' && c[1] === 1,
    );
    expect(seedIndex).toBeGreaterThanOrEqual(0);
    expect(firstIncident).toBeGreaterThan(seedIndex);
  });

  // The corrupt-JSON branch logs "dropping entry" and queues the id for ACK. If
  // an all-corrupt batch returned before the ACK pipeline, that log would be
  // false: the entries would sit in the PEL until the reclaim's min-idle window
  // elapsed, only to fail to parse again on every pass forever, holding
  // audit_consumer_pending up.
  it('ACKs a batch whose entries are all corrupt, so the drop actually happens', async () => {
    const { drainer, xackCalls, persistBatch, record } = drainerWithLag(0, undefined, {
      readReply: [[STREAM, [['9-0', ['body', 'not json']]]]],
    });
    await expect(drainer.drainOnce()).resolves.toEqual({ batched: 0, streams: 1 });
    expect(persistBatch).not.toHaveBeenCalled();
    expect(xackCalls).toEqual([[STREAM, AUDIT_DRAINER_GROUP, '9-0']]);
    // The live `>` read is the second discard route onto the poison counter, and
    // it is the one nothing else asserts. A drop nobody measures reads as
    // recovery on both backlog gauges.
    expect(dropRecords(record)).toEqual([
      ['audit_poison_entries_dropped', 1, { stream: STREAM, cause: 'corrupt-json' }],
    ]);
  });

  it('rejects an entry without tickId instead of persisting it with weaker replay identity', async () => {
    const body = JSON.stringify(
      Object.fromEntries(Object.entries(baseEntry).filter(([key]) => key !== 'tickId')),
    );
    const { drainer, xackCalls, persistBatch, record } = drainerWithLag(0, undefined, {
      readReply: [[STREAM, [['9-0', ['body', body]]]]],
    });

    await expect(drainer.drainOnce()).resolves.toEqual({ batched: 0, streams: 1 });
    expect(persistBatch).not.toHaveBeenCalled();
    expect(xackCalls).toEqual([[STREAM, AUDIT_DRAINER_GROUP, '9-0']]);
    expect(dropRecords(record)).toEqual([
      ['audit_poison_entries_dropped', 1, { stream: STREAM, cause: 'corrupt-json' }],
    ]);
  });

  it('does not count a corrupt entry as dropped when the batch persist abandons its ACK', async () => {
    const { drainer, xackCalls, record } = drainerWithLag(0, undefined, {
      readReply: [
        [
          STREAM,
          [
            ['9-0', ['body', 'not json']],
            ['1-0', ['body', JSON.stringify(baseEntry)]],
          ],
        ],
      ],
      persistFails: true,
    });
    await expect(drainer.drainOnce()).resolves.toEqual({ batched: 0, streams: 1 });
    // The counter and the ACK must never part company: the corrupt entry is
    // still pending, so counting it here would claim a loss that has not
    // happened and the reclaim pass that finally acks it would count it twice.
    expect(ackedIds(xackCalls, STREAM)).toEqual([]);
    expect(dropRecords(record)).toEqual([]);
  });

  it('makes no probe at all with zero enabled streams', async () => {
    const { drainer, record, pipeline } = drainerWithLag(7, undefined, { streams: [] });
    await expect(drainer.drainOnce()).resolves.toEqual({ batched: 0, streams: 0 });
    expect(pipeline).toHaveBeenCalledTimes(0);
    expect(record).toHaveBeenCalledTimes(0);
  });

  it('backlog probe runs on every pass without a metrics sink wired', async () => {
    // failXinfoIndex drives the unknown-counter branch, the only new call site
    // that is not already optional-chained through an existing helper.
    const { drainer, pipeline, warn } = drainerWithLag(7, undefined, {
      persistFails: true,
      noMetrics: true,
      failXinfoIndex: 0,
    });
    await expect(drainer.drainOnce()).resolves.toEqual({ batched: 0, streams: 1 });
    // Without this the pre-fix code passes too: it returned the same object from
    // the persist-failure early return, having never probed at all. Two now: the
    // reclaim pass's XPENDING probe, then the backlog probe.
    expect(pipeline).toHaveBeenCalledTimes(2);
    // The probe body runs inside a per-stream `try {} catch {}`, so an unguarded
    // `deps.metrics.record` would throw, be swallowed, and leave both assertions
    // above still passing. This warn is emitted one line AFTER the counter call
    // in that same try, so it is only reached if the call survived a missing sink.
    expect(warnMessages(warn).some((m) => m.includes('probe failed'))).toBe(true);
  });

  // A null pending must cost only its own gauge. Passing it to prom-client would
  // throw inside the sink, and the swallow above would take the lag record and
  // the threshold warn down with it, silently.
  it('skips only the pending gauge when pending is null, keeping the lag record', async () => {
    const { drainer, record } = drainerWithLag(0, undefined, {
      xinfoValue: [groupReply(AUDIT_DRAINER_GROUP, 3, null)],
    });
    await drainer.drainOnce();
    expect(pendingRecords(record)).toHaveLength(0);
    expect(lagRecords(record)).toEqual([['audit_consumer_lag', 3, { stream: STREAM }]]);
    expect(unknownRecords(record)).toHaveLength(0);
  });

  it('backlog probe runs on every pass per stream, so one bad XINFO slot cannot mask a sibling', async () => {
    const OTHER = 'audit:u_1:p_2:stream';
    const { drainer, record } = drainerWithLag(7, undefined, {
      streams: [STREAM, OTHER],
      failXinfoIndex: 0,
    });
    await drainer.drainOnce();
    expect(lagRecords(record)).toEqual([['audit_consumer_lag', 7, { stream: OTHER }]]);
    expect(unknownRecords(record)).toEqual([
      ['audit_consumer_lag_unknown', 1, { stream: STREAM, cause: 'probe-failed' }],
    ]);
  });
});

// A failed persist deliberately skips the ACK so the batch stays retryable in the
// consumer group's PEL — but every read passes `>`, which returns only
// never-delivered entries, so nothing ever came back for it. Those action_logs
// rows were lost for good and audit_consumer_pending kept a permanent floor.
//
// The fix reclaims the PEL, and the sharp edge is what it does with an entry that
// keeps failing. A bare delivery-count ceiling would be WRONG: during a long
// Postgres outage every entry crosses it, so "drop over the ceiling" deletes the
// whole audit backlog, the exact loss being fixed. Crossing the ceiling admits an
// entry's whole BATCH to a bisect search, never an entry to a drop. An entry is
// poison only when ALL THREE hold: the entry the search isolated has itself
// crossed the ceiling, a sibling row actually reached Postgres in this pass, and
// the rejection names a row-deterministic SQLSTATE. A sibling that resolved
// without writing proves nothing, a transient fault mid-search looks identical to
// poison on timing alone, and the search reaches young entries no walk from the
// head ever did. Each of the three is pinned by its own case below.
describe('drainOnce PEL reclaim (#781)', () => {
  it('claims and persists PEL entries idle past the min-idle-time before the > read', async () => {
    const { drainer, persistBatch, xpendingCalls, xclaim, xreadgroup } = drainerWithLag(
      0,
      undefined,
      { pendingEntries: [pendingTuple('5-0')], batchCount: 37 },
    );

    await expect(drainer.drainOnce()).resolves.toEqual({ batched: 2, streams: 1 });

    expect(xpendingCalls[0]?.slice(0, 6).map(String)).toEqual([
      STREAM,
      AUDIT_DRAINER_GROUP,
      'IDLE',
      String(DEFAULT_RECLAIM_MIN_IDLE_MS),
      '-',
      '+',
    ]);
    // Bounded by the drainer's own batch size, asserted as equality against the
    // injected value: an unbounded XPENDING against a backlog that grew through
    // an outage is a single huge reply on the drain loop's hot path, and a
    // "greater than zero" check would pass for a hardcoded COUNT just as well.
    expect(String(xpendingCalls[0]?.[6])).toBe('37');
    expect(xclaim).toHaveBeenCalledTimes(1);

    // The claimed ROW reaches the persist, not merely its id: the reply body is
    // the only copy of the entry left once it is out of the `>` delivery window.
    expect(reclaimBatches(persistBatch).map(idsOf)).toEqual([['5-0']]);

    // Reclaim leads. A PEL entry is older than anything `>` can return, and
    // action_logs is read time-ordered, so draining fresh entries first would
    // hold the recovered rows behind the live ones for the whole outage.
    expect(persistBatch.mock.invocationCallOrder[0] ?? Number.MAX_SAFE_INTEGER).toBeLessThan(
      xreadgroup.mock.invocationCallOrder[0] ?? 0,
    );
  });

  it('passes the min-idle-time to XPENDING and to XCLAIM, and claims nothing when Redis returns no idle-enough entry', async () => {
    const idle = 15_000;
    const claimed = drainerWithLag(0, undefined, {
      pendingEntries: [pendingTuple('5-0')],
      reclaimMinIdleMs: idle,
    });
    await claimed.drainer.drainOnce();

    expect(claimed.xpendingCalls[0]?.slice(0, 6).map(String)).toEqual([
      STREAM,
      AUDIT_DRAINER_GROUP,
      'IDLE',
      String(idle),
      '-',
      '+',
    ]);
    // XCLAIM re-checks idleness server-side against the same window. Passing 0
    // here would claim an entry a sibling consumer picked up moments ago, which
    // is how one drainer's in-flight batch becomes another's duplicate insert.
    expect(claimed.xclaim.mock.calls[0]?.slice(0, 4).map(String)).toEqual([
      STREAM,
      AUDIT_DRAINER_GROUP,
      AUDIT_DRAINER_CONSUMER,
      String(idle),
    ]);

    // Redis filtered every entry out as too fresh: nothing to claim, and the
    // live read still runs, so an empty PEL costs the pass nothing.
    const none = drainerWithLag(0, undefined, { pendingEntries: [] });
    await expect(none.drainer.drainOnce()).resolves.toEqual({ batched: 1, streams: 1 });
    expect(none.xclaim).not.toHaveBeenCalled();
  });

  it('ACKs reclaimed entries once they persist, so the pending gauge can fall back', async () => {
    const { drainer, xackCalls } = drainerWithLag(0, undefined, {
      pendingEntries: [pendingTuple('5-0'), pendingTuple('6-0')],
    });
    await drainer.drainOnce();
    // Persisted-but-unacked is its own defect: the entries stay in the PEL, get
    // reclaimed again next pass, and duplicate themselves into action_logs
    // forever while audit_consumer_pending never falls.
    expect(ackedIds(xackCalls, STREAM)).toEqual(expect.arrayContaining(['5-0', '6-0']));
  });

  it('leaves a below-ceiling reclaimed batch unacked when the persist fails, dropping nothing', async () => {
    const { drainer, xackCalls, record, persistBatch } = drainerWithLag(0, undefined, {
      // AT the ceiling, not over it — the isolation trigger is a strict `>`, so
      // this pins the boundary itself rather than some value far below it.
      pendingEntries: [
        pendingTuple('5-0', AUDIT_RECLAIM_DELIVERY_CEILING),
        pendingTuple('6-0', AUDIT_RECLAIM_DELIVERY_CEILING),
      ],
      reclaimPersistFails: true,
    });

    // A failed reclaim must not abort the pass: the live read still persists.
    await expect(drainer.drainOnce()).resolves.toEqual({ batched: 1, streams: 1 });

    expect(ackedIds(xackCalls, STREAM)).not.toContain('5-0');
    expect(ackedIds(xackCalls, STREAM)).not.toContain('6-0');
    expect(dropRecords(record)).toHaveLength(0);
    // Below the ceiling there is no isolation at all: the batch is simply left
    // for the next pass to reclaim whole.
    expect(reclaimBatches(persistBatch).map(idsOf)).toEqual([['5-0', '6-0']]);
  });

  it('retries an over-ceiling entry in isolation instead of dropping it', async () => {
    const { drainer, persistBatch, xackCalls, record } = drainerWithLag(0, undefined, {
      pendingEntries: [
        pendingTuple('5-0', AUDIT_RECLAIM_DELIVERY_CEILING + 1),
        pendingTuple('6-0', 1),
      ],
      reclaimPersistFails: true,
    });
    await drainer.drainOnce();

    // Bulk first, then the over-ceiling id alone as the search's health canary,
    // then the remainder. The solo call is what separates "this row is poison"
    // from "the backend is down"; without it the ceiling could only ever be a
    // delete trigger.
    expect(reclaimBatches(persistBatch).map(idsOf)).toEqual([['5-0', '6-0'], ['5-0'], ['6-0']]);
    // It persisted alone, so it is an ordinary recovered row: acked, not dropped.
    expect(ackedIds(xackCalls, STREAM)).toContain('5-0');
    // The ceiling admits the BATCH to the search, and the search then writes
    // whatever it can. Leaving the below-ceiling sibling behind because its own
    // count was low would strand a writable row for no evidence at all.
    expect(ackedIds(xackCalls, STREAM)).toContain('6-0');
    expect(dropRecords(record)).toHaveLength(0);
  });

  it('ACKs an isolated entry as poison, counts it and logs at error, when a sibling isolated entry persists', async () => {
    const over = AUDIT_RECLAIM_DELIVERY_CEILING + 1;
    const { drainer, xackCalls, record, error } = drainerWithLag(0, undefined, {
      pendingEntries: [pendingTuple('5-0', over), pendingTuple('6-0', over)],
      reclaimPersistFails: true,
      isolatedFailIds: ['5-0'],
    });
    await drainer.drainOnce();

    // '6-0' landing alone is the proof the backend is up, and it is the ONLY
    // thing that licenses deleting '5-0'. The row is unrecoverable either way,
    // but without that proof the same evidence reads as an outage.
    expect(ackedIds(xackCalls, STREAM)).toContain('5-0');
    expect(ackedIds(xackCalls, STREAM)).toContain('6-0');
    expect(dropRecords(record)).toEqual([
      ['audit_poison_entries_dropped', 1, { stream: STREAM, cause: 'rejected' }],
    ]);

    // A dropped audit row is silent by construction, so the log carrying the
    // rejection is the only way an operator learns what Postgres objected to.
    expect(errorMessages(error).filter((m) => m.includes('poison'))).toHaveLength(1);
    const [payload] = error.mock.calls.find((c) => String(c[1]).includes('poison')) ?? [];
    expect((payload as { err?: unknown }).err).toBeInstanceOf(Error);
  });

  it('drops nothing and ACKs nothing when every isolated retry fails (whole-backend outage)', async () => {
    const over = AUDIT_RECLAIM_DELIVERY_CEILING + 1;
    const { drainer, xackCalls, record, persistBatch, error } = drainerWithLag(0, undefined, {
      pendingEntries: [pendingTuple('5-0', over), pendingTuple('6-0', over)],
      reclaimPersistFails: true,
      isolatedFailIds: ['5-0', '6-0'],
    });
    await drainer.drainOnce();

    // Both isolations ran, oldest first — otherwise the assertions below would
    // hold vacuously against a drainer that never isolated anything.
    expect(reclaimBatches(persistBatch).map(idsOf)).toEqual([['5-0', '6-0'], ['5-0'], ['6-0']]);
    // A long Postgres outage puts EVERY entry over the ceiling. Dropping on the
    // count alone would delete the entire audit backlog, which is precisely the
    // loss this path exists to prevent.
    expect(ackedIds(xackCalls, STREAM)).not.toContain('5-0');
    expect(ackedIds(xackCalls, STREAM)).not.toContain('6-0');
    expect(dropRecords(record)).toHaveLength(0);
    expect(errorMessages(error).filter((m) => m.includes('poison'))).toHaveLength(0);
  });

  it('does not treat a sibling that wrote nothing as proof the backend is healthy', async () => {
    const over = AUDIT_RECLAIM_DELIVERY_CEILING + 1;
    const { drainer, xackCalls, record, persistBatch, error } = drainerWithLag(0, undefined, {
      pendingEntries: [pendingTuple('5-0', over), pendingTuple('6-0', over)],
      reclaimPersistFails: true,
      // '5-0' is a noop: production filters it to zero action_log rows and skips
      // the INSERT, so it resolves without ever reaching Postgres. '6-0' is
      // actionable and fails because Postgres really is down.
      vacuousIds: ['5-0'],
      isolatedFailIds: ['6-0'],
    });
    await drainer.drainOnce();

    expect(reclaimBatches(persistBatch).map(idsOf)).toEqual([['5-0', '6-0'], ['5-0'], ['6-0']]);
    // Noops dominate the stream, so gating the drop on a resolved persist rather
    // than on rows actually written would let one of them condemn every
    // actionable entry beside it during an outage.
    expect(ackedIds(xackCalls, STREAM)).not.toContain('6-0');
    expect(dropRecords(record)).toHaveLength(0);
    expect(errorMessages(error).filter((m) => m.includes('poison'))).toHaveLength(0);
    // The noop itself still leaves the PEL: it has nothing to write, so holding
    // it would park the pending gauge on a permanent floor.
    expect(ackedIds(xackCalls, STREAM)).toContain('5-0');
  });

  it('keeps an entry whose solo retry failed on a TRANSIENT fault, even beside a written sibling', async () => {
    const over = AUDIT_RECLAIM_DELIVERY_CEILING + 1;
    const { drainer, xackCalls, record, persistBatch, error } = drainerWithLag(0, undefined, {
      pendingEntries: [pendingTuple('5-0', over), pendingTuple('6-0', over)],
      reclaimPersistFails: true,
      // Postgres dies part-way through the isolate loop: '5-0' writes, then
      // '6-0' hits 53300. On timing alone that is indistinguishable from poison.
      transientFailIds: ['6-0'],
    });
    await drainer.drainOnce();

    expect(reclaimBatches(persistBatch).map(idsOf)).toEqual([['5-0', '6-0'], ['5-0'], ['6-0']]);
    expect(ackedIds(xackCalls, STREAM)).toContain('5-0');
    // The same row lands as soon as the backend recovers, so dropping it would
    // destroy a perfectly writable audit record.
    expect(ackedIds(xackCalls, STREAM)).not.toContain('6-0');
    expect(dropRecords(record)).toHaveLength(0);
    expect(errorMessages(error).filter((m) => m.includes('poison'))).toHaveLength(0);
  });

  it('spends exactly three persist statements on a whole-backend outage, ACKing and dropping nothing', async () => {
    const over = AUDIT_RECLAIM_DELIVERY_CEILING + 1;
    const ids = Array.from({ length: 64 }, (_, i) => `${i + 5}-0`);
    const { drainer, persistBatch, xackCalls, record, warn } = drainerWithLag(0, undefined, {
      pendingEntries: ids.map((id) => pendingTuple(id, over)),
      // Every statement rejects on a TRANSIENT class, which is what a dead
      // backend looks like from here: no row is at fault and nothing is written.
      transientFailIds: ids,
    });
    await drainer.drainOnce();

    // The failed batch and the two canary samples, and nothing more. A search
    // that bisected a dead backend would explore the whole tree and spend its
    // entire budget learning what the first statement already said, on the drain
    // loop's hot path, during the outage that caused it. Both samples are needed
    // before halting, so a single row nobody can classify cannot stall a stream.
    expect(reclaimBatches(persistBatch)).toHaveLength(3);
    // Nothing was written anywhere, so there is no health proof and nothing may
    // be dropped. ('1-0' is the live `>` read's own entry, unrelated to this.)
    for (const id of ids) expect(ackedIds(xackCalls, STREAM)).not.toContain(id);
    expect(dropRecords(record)).toHaveLength(0);
    // A pass that declines to search almost the whole backlog and says nothing
    // is indistinguishable from one that searched it and found it clean.
    expect(warnMessages(warn).filter((m) => m.includes('search stopped early'))).toHaveLength(1);
    const [payload] =
      warn.mock.calls.find((c) => String(c[1]).includes('search stopped early')) ?? [];
    expect(payload).toMatchObject({
      stream: STREAM,
      unresolved: ids.length - 2,
      reason: 'no-proven-write',
    });
  });

  it('locates one unwritable row in a deep batch in O(log N) persist statements', async () => {
    const over = AUDIT_RECLAIM_DELIVERY_CEILING + 1;
    const ids = Array.from({ length: 64 }, (_, i) => `${i + 5}-0`);
    const poisonId = ids[45] ?? '';
    const { drainer, persistBatch, warn } = drainerWithLag(0, undefined, {
      pendingEntries: ids.map((id) => pendingTuple(id, over)),
      isolatedFailIds: [poisonId],
    });
    await drainer.drainOnce();

    // Exact, not a bound: the failed batch, the canary, then 2 statements per
    // level of the bisect down to the singleton (6 levels for this position).
    // The old walk paid one statement per entry and still resolved nothing past
    // its window, so a loose assertion here would not tell the two apart.
    expect(reclaimBatches(persistBatch)).toHaveLength(14);
    expect(reclaimBatches(persistBatch).length - 1).toBeLessThanOrEqual(AUDIT_RECLAIM_PROBE_MAX);
    // The whole batch was resolved, so nothing was left owing.
    expect(warnMessages(warn).filter((m) => m.includes('search stopped early'))).toHaveLength(0);
  });

  it('stops searching a stream once its probe budget is spent, leaving the remainder in the PEL', async () => {
    const over = AUDIT_RECLAIM_DELIVERY_CEILING + 1;
    // Every entry unwritable, so no split ever succeeds and the search cannot
    // terminate: this is the shape the budget exists for. The rejections are
    // row-deterministic, so the pass never halts on them.
    const ids = Array.from({ length: 128 }, (_, i) => `${i + 5}-0`);
    const { drainer, persistBatch, xackCalls, record, warn } = drainerWithLag(0, undefined, {
      pendingEntries: ids.map((id) => pendingTuple(id, over)),
      isolatedFailIds: ids,
    });
    await drainer.drainOnce();

    // The two canary samples spend one probe each, then every node spends two,
    // so 23 nodes run and the budget lands exactly on its cap: 2 + 46 = 48
    // probes behind the failed batch. Asserted exactly, because the cap is a
    // load ceiling on the drain loop's hot path and a `<=` would pass for a
    // search that stopped early for some other reason entirely.
    expect(reclaimBatches(persistBatch).length - 1).toBe(48);
    expect(reclaimBatches(persistBatch).length - 1).toBeLessThanOrEqual(AUDIT_RECLAIM_PROBE_MAX);
    // Nothing landed, so nothing is proven and nothing may be destroyed.
    for (const id of ids) expect(ackedIds(xackCalls, STREAM)).not.toContain(id);
    expect(dropRecords(record)).toHaveLength(0);
    expect(warnMessages(warn).filter((m) => m.includes('search stopped early'))).toHaveLength(1);
    const [payload] =
      warn.mock.calls.find((c) => String(c[1]).includes('search stopped early')) ?? [];
    // The count is the operator's only measure of what this pass left behind, so
    // a positive number is not enough: it has to be the real remainder. The 23
    // nodes above bring 19 entries down to a singleton verdict, which with the
    // two canary samples makes 21; the other 107 are handed back unsearched.
    expect(payload).toMatchObject({ stream: STREAM, reason: 'probe-budget', unresolved: 107 });
    // Conservation: every claimed entry is either resolved to a verdict or
    // reported as owed. An entry counted in neither is one this pass silently
    // dropped from its own bookkeeping.
    expect((payload as { unresolved: number }).unresolved + 21).toBe(ids.length);
  });

  it("spends the probe budget per stream, so one stream's poison cannot starve another's", async () => {
    const other = 'audit:u_1:p_2:stream';
    const over = AUDIT_RECLAIM_DELIVERY_CEILING + 1;
    const ids = Array.from({ length: 64 }, (_, i) => `${i + 5}-0`);
    const poisonId = ids[45] ?? '';
    const { drainer, xackCalls, warn } = drainerWithLag(0, undefined, {
      streams: [STREAM, other],
      pendingEntries: ids.map((id) => pendingTuple(id, over)),
      // The first stream is unwritable end to end and burns its whole budget;
      // the second holds one bad row among 64 and must still recover the rest.
      isolatedFailStreams: [STREAM],
      isolatedFailIds: [poisonId],
    });
    await drainer.drainOnce();

    const acked = new Set(ackedIds(xackCalls, other));
    expect(ids.filter((id) => id !== poisonId && acked.has(id))).toHaveLength(ids.length - 1);
    // A budget shared across streams would be gone before this stream was even
    // reached, and its healthy rows would sit in the PEL until MAXLEN took them.
    expect(warnMessages(warn).filter((m) => m.includes('search stopped early'))).toHaveLength(1);
    const [payload] =
      warn.mock.calls.find((c) => String(c[1]).includes('search stopped early')) ?? [];
    // Pinned to the budget, not just the stream: a halt would also stop this
    // stream after two statements and report the same stream name, and the
    // point of the case is that the FIRST stream really did spend its own cap.
    expect(payload).toMatchObject({ stream: STREAM, reason: 'probe-budget' });
  });

  it('keeps a below-ceiling row the search isolated, even beside a written sibling', async () => {
    const { drainer, xackCalls, record } = drainerWithLag(0, undefined, {
      pendingEntries: [
        pendingTuple('5-0', AUDIT_RECLAIM_DELIVERY_CEILING + 1),
        // First redelivery: the batch is admitted to the search by its sibling,
        // so the bisect reaches this row far earlier than any walk from the head
        // ever did.
        pendingTuple('6-0', 1),
      ],
      isolatedFailIds: ['6-0'],
    });
    await drainer.drainOnce();

    // The sibling landed, so the health proof and the SQLSTATE both hold and the
    // ONLY thing standing between this row and destruction is its delivery
    // count. The ceiling authorises the drop; the search only located the row.
    expect(ackedIds(xackCalls, STREAM)).toContain('5-0');
    expect(ackedIds(xackCalls, STREAM)).not.toContain('6-0');
    expect(dropRecords(record)).toHaveLength(0);
  });

  it('keeps searching when the oldest pending row fails with a rejection nothing can classify', async () => {
    const over = AUDIT_RECLAIM_DELIVERY_CEILING + 1;
    const ids = Array.from({ length: 64 }, (_, i) => `${i + 5}-0`);
    const headId = ids[0] ?? '';
    const { drainer, persistBatch, xackCalls, record } = drainerWithLag(0, undefined, {
      pendingEntries: ids.map((id) => pendingTuple(id, over)),
      // XPENDING walks the pending list in ascending id order, so this is the
      // SAME oldest row on every pass. Its SQLSTATE is not row-deterministic, so
      // it can never be dropped either. Halting the pass on this one sample
      // would strand its whole stream behind it forever, which is worse than the
      // walk the search replaced: that walk at least retried the entries after it.
      transientFailIds: [headId],
    });
    await drainer.drainOnce();

    const acked = new Set(ackedIds(xackCalls, STREAM));
    expect(ids.filter((id) => id !== headId && acked.has(id))).toHaveLength(ids.length - 1);
    expect(acked.has(headId)).toBe(false);
    expect(dropRecords(record)).toHaveLength(0);
    // The failed batch, both canary samples, then one split that clears the rest.
    expect(reclaimBatches(persistBatch)).toHaveLength(5);
  });

  it('stops the search when the backend dies mid-bisect, leaving the unsearched half in the PEL', async () => {
    const over = AUDIT_RECLAIM_DELIVERY_CEILING + 1;
    const ids = Array.from({ length: 8 }, (_, i) => `${i + 5}-0`);
    const headId = ids[0] ?? '';
    const { drainer, persistBatch, xackCalls, record, warn } = drainerWithLag(0, undefined, {
      pendingEntries: ids.map((id) => pendingTuple(id, over)),
      // The canary resolves, so the pass does not halt on it, but it maps to no
      // action_log row and so proves nothing: the search carries on.
      vacuousIds: [headId],
      // Postgres is in fact down. The halt therefore fires DEEP in the descent,
      // on the first singleton it reaches, while a sibling half is still owed a
      // search. That sibling is what the halt arm of the budget gate hands back.
      transientFailIds: ids.slice(1),
    });
    await drainer.drainOnce();

    for (const id of ids.slice(1)) expect(ackedIds(xackCalls, STREAM)).not.toContain(id);
    expect(dropRecords(record)).toHaveLength(0);
    // Batch, canary, the root split of the remaining 7, then one more split
    // before the halt. A search that ignored the halt would keep bisecting both
    // owed halves and pay for re-proving an outage it had already established.
    expect(reclaimBatches(persistBatch)).toHaveLength(6);
    const [payload] =
      warn.mock.calls.find((c) => String(c[1]).includes('search stopped early')) ?? [];
    expect(payload).toMatchObject({ stream: STREAM, reason: 'no-proven-write', unresolved: 6 });
  });

  it('stops condemning rows once one pass hits its drop cap, holding the rest in the PEL', async () => {
    const over = AUDIT_RECLAIM_DELIVERY_CEILING + 1;
    const ids = Array.from({ length: 16 }, (_, i) => `${i + 5}-0`);
    const healthyId = ids[0] ?? '';
    const { drainer, xackCalls, record, error } = drainerWithLag(0, undefined, {
      pendingEntries: ids.map((id) => pendingTuple(id, over)),
      // Every row but the first rejects row-deterministically: the signature of
      // a systematic fault, a column that turned NOT NULL under a running
      // worker, not of 15 independently poisoned rows. Each one clears all three
      // drop conditions, so only the cap stands between them and destruction.
      isolatedFailIds: ids.slice(1),
    });
    await drainer.drainOnce();

    const acked = new Set(ackedIds(xackCalls, STREAM));
    expect(acked.has(healthyId)).toBe(true);
    expect(ids.slice(1).filter((id) => acked.has(id))).toHaveLength(AUDIT_RECLAIM_DROP_MAX);
    expect(dropRecords(record)).toHaveLength(AUDIT_RECLAIM_DROP_MAX);
    // The cap binding is itself the finding: silently stopping would leave an
    // operator reading a drop count that looks like an ordinary poison row.
    expect(errorMessages(error).filter((m) => m.includes('drop cap'))).toHaveLength(1);
  });

  // A fixed-size retry window caps retry COST, but it also caps the pass's entire
  // forward progress: once the bulk persist fails, every entry outside the window
  // is left for the next pass, whatever its own row is worth. One unwritable row
  // therefore held a whole stream to a handful of entries per pass, and MAXLEN
  // trims the tail of a deep backlog faster than that drains it, so the healthy
  // rows were destroyed by the trim rather than by the poison.
  it('persists every healthy entry of a deep claimed batch in ONE pass, not just the isolate window', async () => {
    const over = AUDIT_RECLAIM_DELIVERY_CEILING + 1;
    const ids = Array.from({ length: 64 }, (_, i) => `${i + 5}-0`);
    // Deliberately past the isolate window: a walk that starts at the head never
    // reaches this row, so the rest of the batch can never be told apart from it.
    const poisonId = ids[45] ?? '';
    const { drainer, persistBatch, xackCalls, record } = drainerWithLag(0, undefined, {
      pendingEntries: ids.map((id) => pendingTuple(id, over)),
    });
    // Keyed on the row SET, not on call order, so the whole batch, any sub-batch
    // and any singleton all answer consistently. A stub keyed on position would
    // decide the outcome of the retry strategy it is supposed to measure.
    persistBatch.mockImplementation(async (rows: readonly AuditEntry[]): Promise<number> => {
      const reclaimed = rows.filter((r) => r.event === RECLAIMED_EVENT);
      if (reclaimed.length === 0) return rows.length;
      if (idsOf(reclaimed).includes(poisonId))
        throw pgError(`postgres rejected ${poisonId}`, '23502');
      return reclaimed.length;
    });

    await drainer.drainOnce();

    const acked = new Set(ackedIds(xackCalls, STREAM));
    // The poison row is excluded either way: retiring it is a separate contract,
    // and neither retiring nor holding it counts as progress.
    expect(ids.filter((id) => id !== poisonId && acked.has(id))).toHaveLength(ids.length - 1);
    // ACKs alone would also pass for a drainer that acked rows it never wrote,
    // which is the same audit loss with the pending gauge hiding it.
    const written = reclaimRecords(record).reduce(
      (n: number, c) => n + Number((c as unknown[])[1]),
      0,
    );
    expect(written).toBe(ids.length - 1);
  });

  it('counts a corrupt reclaimed body on the poison counter instead of dropping it silently', async () => {
    const { drainer, xackCalls, record } = drainerWithLag(0, undefined, {
      pendingEntries: [pendingTuple('5-0')],
      corruptIds: ['5-0'],
    });
    await drainer.drainOnce();

    // It is acked, because no backend could ever accept it. That makes it a
    // destroyed audit row, and a destroyed row nothing measures reads as
    // recovery on both backlog gauges.
    expect(ackedIds(xackCalls, STREAM)).toContain('5-0');
    expect(dropRecords(record)).toHaveLength(1);
    expect((dropRecords(record)[0] as unknown[])[2]).toMatchObject({ cause: 'corrupt-json' });
  });

  it('retires a body that parses but has none of the fields action_logs needs', async () => {
    const { drainer, xackCalls, record, persistBatch } = drainerWithLag(0, undefined, {
      pendingEntries: [pendingTuple('5-0')],
      unmappableIds: ['5-0'],
    });
    await drainer.drainOnce();

    // Carried forward it would make the mapper throw a TypeError, which has no
    // SQLSTATE, so the poison gate could never classify it and it would fail its
    // stream's batch on every pass forever. It never reaches the persist at all.
    expect(reclaimBatches(persistBatch)).toEqual([]);
    expect(ackedIds(xackCalls, STREAM)).toContain('5-0');
    expect(dropRecords(record)).toHaveLength(1);
    expect((dropRecords(record)[0] as unknown[])[2]).toMatchObject({ cause: 'corrupt-json' });
  });

  // An entry whose field array carries no `body` is one this drainer did not
  // write, so a single sighting is not grounds to destroy it. Repetition is: the
  // delivery count is the only evidence that the entry is not in flight from some
  // other producer but simply stuck, decoding to nothing on every pass while its
  // XCLAIM keeps the pending floor up forever.
  it('leaves a body-less claimed entry in the PEL below the delivery ceiling, dropping nothing', async () => {
    const { drainer, xackCalls, record, persistBatch } = drainerWithLag(0, undefined, {
      // AT the ceiling, not over it, so this pins the boundary itself.
      pendingEntries: [pendingTuple('5-0', AUDIT_RECLAIM_DELIVERY_CEILING)],
      bodylessIds: ['5-0'],
    });
    await drainer.drainOnce();

    // It carries no row, so it never reaches the persist on any pass: the ACK is
    // the only thing separating "kept for another look" from "retired".
    expect(reclaimBatches(persistBatch)).toEqual([]);
    expect(ackedIds(xackCalls, STREAM)).not.toContain('5-0');
    expect(dropRecords(record)).toHaveLength(0);
    // audit_read_no_body belongs to the live read alone, where a `>` delivers an
    // id exactly once so the counter moves once and increase() decays back to
    // zero. The reclaim re-claims this same entry on every pass for as long as it
    // stays below the ceiling, so emitting here would hold AuditEntryReadWithoutBody
    // open forever instead of reporting a start.
    expect(incidentRecords(record, 'audit_read_no_body')).toHaveLength(0);
  });

  // An entry the reclaim keeps claiming but neither writes nor retires is the one
  // state with no series at all today: the drop counter stays flat, the persist
  // counter stays flat, and audit_consumer_pending only says the floor is up, not
  // that it is stuck. The operator sees a healthy-looking drainer holding an audit
  // row it will never ship.
  // Summed, not counted as calls: one increment per entry and one increment of N
  // for a batch of N are the same counter movement, and nothing here has an
  // opinion on the round-trip shape.
  const stuckTotal = (record: ReturnType<typeof vi.fn>): number =>
    incidentRecords(record, 'audit_entries_stuck').reduce(
      (sum, c) => sum + ((c as unknown[])[1] as number),
      0,
    );

  it('counts every claimed entry a failed persist left behind, once each per pass', async () => {
    const { drainer, record } = drainerWithLag(0, undefined, {
      // Below the ceiling, so the batch is left whole for the next pass: claimed,
      // unwritten, unacked, and repeating.
      pendingEntries: [
        pendingTuple('5-0', AUDIT_RECLAIM_DELIVERY_CEILING),
        pendingTuple('6-0', AUDIT_RECLAIM_DELIVERY_CEILING),
      ],
      reclaimPersistFails: true,
    });
    await drainer.drainOnce();

    // Per entry, not per batch: a batch-level count reads the same whether one row
    // or a thousand were stranded, which is the difference between a nuisance and
    // an audit gap.
    expect(stuckTotal(record)).toBe(2);
    // Unlabelled the series cannot say which profile's audit trail is missing
    // rows, and the streams are per profile.
    expect(record).toHaveBeenCalledWith(
      'audit_entries_stuck',
      expect.any(Number),
      expect.objectContaining({ stream: STREAM }),
    );
    // Catalogued, not ad-hoc: the sink drops an unregistered name, so without the
    // entry the counter never reaches Prometheus at all.
    expect(CATALOG['audit_entries_stuck']).toMatchObject({
      kind: 'counter',
      labelNames: ['stream'],
    });
  });

  it('counts a claimed entry that reached neither the database nor the drop path, on every pass', async () => {
    const { drainer, record } = drainerWithLag(0, undefined, {
      // Below the ceiling, so the entry is kept rather than retired: exactly the
      // state that repeats unbounded.
      pendingEntries: [pendingTuple('5-0', AUDIT_RECLAIM_DELIVERY_CEILING)],
      bodylessIds: ['5-0'],
    });
    await drainer.drainOnce();
    await drainer.drainOnce();

    // Once per pass, not once per entry lifetime: a single sighting cannot be
    // told apart from an entry that is merely in flight, and it is the repetition
    // over a window that names it stuck.
    expect(stuckTotal(record)).toBe(2);
  });

  it('seeds the stuck counter at zero per stream before the first sighting', async () => {
    // prom-client creates a labelled child on first write, so a counter whose
    // first sample IS the incident reads as no change at all under increase().
    // A first-ever stuck entry is precisely the event that must not be invisible.
    const { drainer, record } = drainerWithLag(0);
    await drainer.drainOnce();

    expect(zeroRecords(record, 'audit_entries_stuck')).toHaveLength(1);
    // A clean pass strands nothing, so the seed is the only sample.
    expect(stuckTotal(record)).toBe(0);
  });

  it('does not count an entry it retired as poison as stuck', async () => {
    // Dropped is resolved: the drop counter and its error line already own the
    // operator's notice, and counting both would hold a stuck alert open over an
    // entry that is already gone.
    const { drainer, record } = drainerWithLag(0, undefined, {
      pendingEntries: [pendingTuple('5-0', AUDIT_RECLAIM_DELIVERY_CEILING + 1)],
      bodylessIds: ['5-0'],
    });
    await drainer.drainOnce();

    expect(dropRecords(record)).toHaveLength(1);
    expect(stuckTotal(record)).toBe(0);
  });

  it('retires a body-less claimed entry as poison once deliveries pass the ceiling', async () => {
    const { drainer, xackCalls, record, error } = drainerWithLag(0, undefined, {
      pendingEntries: [pendingTuple('5-0', AUDIT_RECLAIM_DELIVERY_CEILING + 1)],
      bodylessIds: ['5-0'],
    });
    await drainer.drainOnce();

    // Left unacked it is XPENDINGed and XCLAIMed again on every pass forever, one
    // round-trip apiece, holding audit_consumer_pending on a permanent floor.
    expect(ackedIds(xackCalls, STREAM)).toContain('5-0');
    // Its own cause, not corrupt-json: nothing here failed to parse, and the two
    // point an operator at different producers.
    expect(dropRecords(record)).toEqual([
      ['audit_poison_entries_dropped', 1, { stream: STREAM, cause: 'no-body' }],
    ]);
    // The counter alone says a row is gone but not which one. Without the stream
    // and the id bound here there is nothing left to trace the loss back to.
    //
    // The phrase is asserted too, not just the payload: both runbooks send the
    // operator to `dropping` to find this line, so a reword would break the
    // documented incident path with every test still green.
    expect(errorMessages(error).filter((m) => m.includes('dropping'))).toHaveLength(1);
    const [payload] = error.mock.calls.find((c) => String(c[1]).includes('no body')) ?? [];
    expect(payload).toMatchObject({ stream: STREAM, entryId: '5-0' });
  });

  it('defers the body-less drop until its ACK is on the wire', async () => {
    const { drainer, record, ackExec } = drainerWithLag(0, undefined, {
      pendingEntries: [pendingTuple('5-0', AUDIT_RECLAIM_DELIVERY_CEILING + 1)],
      bodylessIds: ['5-0'],
    });
    await drainer.drainOnce();

    const dropIndex = record.mock.calls.findIndex(
      (c) => c[0] === 'audit_poison_entries_dropped' && c[1] === 1,
    );
    expect(dropIndex).toBeGreaterThanOrEqual(0);
    // Counted before the ACK round-trips, the record asserts a loss that has not
    // happened: a pass that dies in between leaves the entry still pending with
    // its destruction already on the counter, and the pass that finally acks it
    // counts the same loss twice.
    expect(record.mock.invocationCallOrder[dropIndex] ?? 0).toBeGreaterThan(
      ackExec.mock.invocationCallOrder[0] ?? Number.MAX_SAFE_INTEGER,
    );
  });

  // Ordering alone was not the contract. The drop asserts an action_logs row is
  // gone for good, which is false while the entry is still pending — and a
  // failed XACK leaves it exactly there. Counting anyway is the fail-OPEN
  // direction on the one series that measures deliberate audit-row destruction,
  // and it repeats: the entry stays pending in the same terminal state, so every
  // later pass re-derives the same drop and counts it again. One entry plus a
  // flaky XACK yielded N increments and N alert firings.
  //
  // Withholding loses nothing. The entry is still in the PEL, so the next pass
  // claims it, reaches the same verdict, and counts it exactly once.
  it('does not count a reclaimed drop when the ACK pipeline rejects', async () => {
    const { drainer, record, ackExec, warn } = drainerWithLag(0, undefined, {
      pendingEntries: [pendingTuple('5-0', AUDIT_RECLAIM_DELIVERY_CEILING + 1)],
      bodylessIds: ['5-0'],
      ackExecRejects: true,
    });
    await drainer.drainOnce();

    // Positive control: the pass really did reach the ACK, so the empty
    // assertion below is the gate holding and not the drop never being derived.
    expect(ackExec).toHaveBeenCalled();
    expect(dropRecords(record)).toEqual([]);
    expect(warnMessages(warn).some((m) => m.includes('XACK pipeline failed'))).toBe(true);
  });

  // ioredis resolves exec() to null for a discarded pipeline. That said nothing
  // about whether the queued XACKs ran, yet the optional-chained forEach made it
  // the ONE failure mode that produced no trace whatsoever — it read as a clean
  // pass, and the drop was counted on the strength of it.
  it('does not count a reclaimed drop when the ACK pipeline returns no replies', async () => {
    const { drainer, record, ackExec, warn } = drainerWithLag(0, undefined, {
      pendingEntries: [pendingTuple('5-0', AUDIT_RECLAIM_DELIVERY_CEILING + 1)],
      bodylessIds: ['5-0'],
      ackExecNull: true,
    });
    await drainer.drainOnce();

    expect(ackExec).toHaveBeenCalled();
    expect(dropRecords(record)).toEqual([]);
    expect(warnMessages(warn).some((m) => m.includes('XACK pipeline returned no replies'))).toBe(
      true,
    );
  });

  // Same gate on the `>` read's own discard route. Both call sites run
  // `reportDrops(drops, await flushAcks(acks))`, and a fix applied to only one
  // of them would leave corrupt-json fail-open on the live path.
  it('does not count a live-read corrupt drop when the ACK pipeline rejects', async () => {
    const { drainer, record, ackExec } = drainerWithLag(0, undefined, {
      readReply: [[STREAM, [['9-0', ['body', 'not json']]]]],
      ackExecRejects: true,
    });
    await drainer.drainOnce();

    expect(ackExec).toHaveBeenCalled();
    expect(dropRecords(record)).toEqual([]);
  });

  // The proof an XACK carries is per stream: the pipeline holds one XACK per
  // stream, so a clean slot vouches for that stream's ids and no others. A gate
  // that collapsed the replies to a single boolean would pass every test above
  // and still be wrong here — it would either withhold the healthy stream's drop
  // or release the failed stream's.
  it('releases a drop only for the stream whose own XACK slot came back clean', async () => {
    const other = 'audit:u_1:p_2:stream';
    const { drainer, record } = drainerWithLag(0, undefined, {
      streams: [STREAM, other],
      readReply: [
        [STREAM, [['9-0', ['body', 'not json']]]],
        [other, [['9-1', ['body', 'not json']]]],
      ],
      failAckStreams: [STREAM],
    });
    await drainer.drainOnce();

    expect(dropRecords(record)).toEqual([
      ['audit_poison_entries_dropped', 1, { stream: other, cause: 'corrupt-json' }],
    ]);
  });

  it('treats an unreadable delivery count on a body-less entry as 0, so it is never retired', async () => {
    const { drainer, xackCalls, record, xclaim } = drainerWithLag(0, undefined, {
      // Non-numeric in the tuple's delivery-count position. Built inline because
      // the whole point is a field pendingTuple's signature cannot express.
      pendingEntries: [['5-0', AUDIT_DRAINER_CONSUMER, 90_000, 'not-a-number']],
      bodylessIds: ['5-0'],
    });
    await drainer.drainOnce();

    // Both assertions below are negative, so they also hold when the entry was
    // never looked at. This pins that it WAS: a parse that discarded the whole
    // tuple over its unreadable count would satisfy them while proving nothing.
    // XCLAIM args are (stream, group, consumer, minIdleMs, ...ids).
    expect(xclaim.mock.calls[0]?.slice(4)).toContain('5-0');
    // Fail-safe direction: a reply Redis garbled must never become a licence to
    // delete, so an unreadable count keeps the entry below the ceiling forever.
    expect(ackedIds(xackCalls, STREAM)).not.toContain('5-0');
    expect(dropRecords(record)).toHaveLength(0);
  });

  it("does not let one stream's unwritable row hold another stream's rows in the PEL", async () => {
    const other = 'audit:u_1:p_2:stream';
    const { drainer, xackCalls, record } = drainerWithLag(0, undefined, {
      streams: [STREAM, other],
      // Every claimed entry is over the ceiling, so both streams reach isolation.
      pendingEntries: [pendingTuple('5-0', 9), pendingTuple('6-0', 9)],
      reclaimPersistFails: true,
      // Every solo retry on the first stream rejects, so it has no sibling write
      // of its own; the second stream's identical ids persist normally.
      isolatedFailStreams: [STREAM],
    });
    await drainer.drainOnce();

    // persistBatch is one all-or-nothing INSERT. Batched across streams, the
    // first stream's rejects would fail the second stream's writable rows in the
    // same statement, and the search would then spend its budget bisecting a
    // mixed batch, so the second stream would drain only what the first left it.
    expect(ackedIds(xackCalls, other)).toEqual(expect.arrayContaining(['5-0', '6-0']));
    // And with no proven write of its OWN, the first stream drops nothing.
    expect(dropRecords(record)).toEqual([]);
  });

  it('costs only the failing stream its reclaim when one XPENDING slot errors', async () => {
    const other = 'audit:u_1:p_2:stream';
    const { drainer, warn, persistBatch } = drainerWithLag(0, undefined, {
      streams: [STREAM, other],
      pendingEntries: [pendingTuple('5-0')],
      failXpendingIndex: 0,
    });
    await drainer.drainOnce();

    expect(warnMessages(warn).filter((m) => m.includes('XPENDING failed'))).toHaveLength(1);
    // The healthy stream still reclaims. A pipeline whose per-slot error aborted
    // the loop would strand every other stream behind one stream's blip.
    expect(reclaimBatches(persistBatch).map(idsOf)).toEqual([['5-0']]);
  });

  it('skips a PEL id whose stream entry was trimmed away, without wedging the pass', async () => {
    const { drainer, persistBatch, xackCalls, record } = drainerWithLag(0, undefined, {
      // Over the ceiling, so an omitted id cannot borrow the body-less arm's
      // retirement: Redis already purged the PEL reference, and counting it
      // would report an audit row destroyed that this pass never even saw.
      pendingEntries: [
        pendingTuple('5-0', AUDIT_RECLAIM_DELIVERY_CEILING + 1),
        pendingTuple('6-0'),
      ],
      trimmedIds: ['5-0'],
    });

    // MAXLEN trimming drops a stream entry while its PEL reference survives.
    // Redis 7 answers XCLAIM by purging that reference and returning nothing for
    // it, so the id never comes back. A drainer that expected one reply per
    // requested id, or that acked by requested id, would stall or lie here.
    await expect(drainer.drainOnce()).resolves.toEqual({ batched: 2, streams: 1 });
    expect(reclaimBatches(persistBatch).map(idsOf)).toEqual([['6-0']]);
    expect(ackedIds(xackCalls, STREAM)).toContain('6-0');
    expect(ackedIds(xackCalls, STREAM)).not.toContain('5-0');
    expect(dropRecords(record)).toHaveLength(0);
  });

  it('surfaces a reclaim failure and still runs the backlog probe for that pass', async () => {
    const { drainer, record, pipeline, xreadgroup } = drainerWithLag(7, undefined, {
      pendingEntries: [pendingTuple('5-0')],
      claimThrows: true,
    });

    // XCLAIM rejecting means Redis went away mid-reclaim; swallowing it would
    // report a clean pass. The XPENDING discovery step is the opposite call —
    // its failure is absorbed, which the 'probe pipeline rejects outright' case
    // above pins by still resolving.
    await expect(drainer.drainOnce()).rejects.toThrow('redis down');
    // The pass aborted before the live read, so the `finally` probe is the only
    // thing that measured the backlog this pass — and it still must.
    expect(xreadgroup).not.toHaveBeenCalled();
    expect(pipeline).toHaveBeenCalledTimes(2);
    expect(lagRecords(record)).toEqual([['audit_consumer_lag', 7, { stream: STREAM }]]);
    expect(recordsNamed(record, 'audit_stream_length')).toEqual([
      ['audit_stream_length', 100_000, { stream: STREAM }],
    ]);
  });

  it('records the catalogued reclaim counter and seeds both new counters at zero', async () => {
    const { drainer, record } = drainerWithLag(0, undefined, {
      pendingEntries: [pendingTuple('5-0'), pendingTuple('6-0')],
    });
    await drainer.drainOnce();
    await drainer.drainOnce();

    expect(reclaimRecords(record)).toEqual([
      ['audit_entries_reclaimed', 2, { stream: STREAM }],
      ['audit_entries_reclaimed', 2, { stream: STREAM }],
    ]);
    // Seeded once per stream, for the same reason the lag-unknown causes are:
    // prom-client creates a labelled child on first write, so a counter whose
    // first sample IS the incident reads as no change at all under increase().
    // The poison counter is the one that matters — a first-ever drop is exactly
    // the event that would otherwise be invisible.
    expect(zeroRecords(record, 'audit_entries_reclaimed')).toHaveLength(1);
    // Once per CAUSE: prom-client's children are per label set, so seeding only
    // some causes would leave the rest invisible to increase() on their first
    // drop. This asserts the seeding HAPPENS; it is not what keeps the list
    // exhaustive. Nothing here objects to a new union member, because whoever
    // forgets the seed array is the same person who forgets this list. The
    // exhaustiveness gate is the `satisfies Record<PoisonDropCause, 0>` the seed
    // list is keyed on, where a missing cause is a compile error.
    expect(
      zeroRecords(record, 'audit_poison_entries_dropped').map(
        (c) => ((c as unknown[])[2] as { cause: string }).cause,
      ),
    ).toEqual(['rejected', 'corrupt-json', 'no-body']);

    // Catalogued, not ad-hoc: the sink drops an unregistered name, so without
    // these entries neither counter reaches Prometheus at all.
    expect(CATALOG['audit_entries_reclaimed']).toMatchObject({
      kind: 'counter',
      labelNames: ['stream'],
    });
    expect(CATALOG['audit_poison_entries_dropped']).toMatchObject({
      kind: 'counter',
      labelNames: ['stream', 'cause'],
    });
  });
});
