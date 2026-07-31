// Tick-latency-unchanged invariant for the audit shipper. Full backpressure
// scenarios (PG unreachable, stream length growing to MAXLEN, drainer catching
// up via XREADGROUP) are covered in the integration suite. Here we lock the
// in-process contract: publish() never throws, even when Redis fails.

import { describe, expect, it, vi } from 'vitest';

import type { ProfileId, UserId } from '@app/contracts';
import {
  AUDIT_CONSUMER_LAG_ALERT,
  AUDIT_DRAINER_GROUP,
  createAuditDrainer,
  createAuditShipper,
  parseConsumerLag,
  type AuditEntry,
} from '../../src/audit-shipper/audit-shipper.js';

// A RESP2 XINFO GROUPS reply: each group is a flat [field, value, ...] array.
const groupReply = (name: string, lag: number | null): unknown[] => [
  'name',
  name,
  'consumers',
  1,
  'pending',
  0,
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
describe('parseConsumerLag', () => {
  it('returns the numeric lag for the matching group, ignoring others', () => {
    expect(
      parseConsumerLag(
        [groupReply('some-other-group', 99), groupReply(AUDIT_DRAINER_GROUP, 3)],
        AUDIT_DRAINER_GROUP,
      ),
    ).toBe(3);
  });

  it('returns null when lag is null — trimming dropped entries the group had not read', () => {
    expect(
      parseConsumerLag([groupReply(AUDIT_DRAINER_GROUP, null)], AUDIT_DRAINER_GROUP),
    ).toBeNull();
  });

  it('returns null when the group is absent', () => {
    expect(parseConsumerLag([groupReply('some-other-group', 0)], AUDIT_DRAINER_GROUP)).toBeNull();
  });

  it('returns 0 (not null) for a caught-up group', () => {
    expect(parseConsumerLag([groupReply(AUDIT_DRAINER_GROUP, 0)], AUDIT_DRAINER_GROUP)).toBe(0);
  });
});

describe('drainOnce consumer-lag alerting (#510)', () => {
  const STREAM = 'audit:u_1:p_1:stream';

  // A drainer over one stream that delivers exactly one entry per pass, with the
  // group's XINFO lag stubbed to `lag`. Captures logger.warn + metrics.record.
  const drainerWithLag = (lag: number | null, failSlot?: 'xack' | 'xlen' | 'xinfo' | 'exec') => {
    const warn = vi.fn();
    const record = vi.fn();
    // The ACK and the two per-stream gauges now ride pipelines, so the stub has
    // to answer in pipeline reply shape ([err, value] per queued command) rather
    // than as standalone methods.
    const slot = (kind: 'xack' | 'xlen' | 'xinfo', value: unknown): [Error | null, unknown] =>
      failSlot === kind ? [new Error(`${kind} boom`), null] : [null, value];
    const makePipeline = () => {
      const replies: [Error | null, unknown][] = [];
      const chain = {
        xack: () => {
          replies.push(slot('xack', 1));
          return chain;
        },
        xlen: () => {
          replies.push(slot('xlen', 100_000));
          return chain;
        },
        xinfo: () => {
          replies.push(slot('xinfo', [groupReply(AUDIT_DRAINER_GROUP, lag)]));
          return chain;
        },
        // ioredis resolves `exec()` to null when the pipeline is discarded.
        exec: async () => (failSlot === 'exec' ? null : replies),
      };
      return chain;
    };
    const redis = {
      xgroup: vi.fn(async () => 'OK'),
      xreadgroup: vi.fn(async () => [[STREAM, [['1-0', ['body', JSON.stringify(baseEntry)]]]]]),
      pipeline: makePipeline,
    } as unknown as Parameters<typeof createAuditDrainer>[0]['redis'];
    const drainer = createAuditDrainer({
      redis,
      logger: { ...stubLogger, warn } as never,
      persistBatch: vi.fn(async () => undefined),
      enabledStreams: async () => [STREAM],
      metrics: { record },
    });
    return { drainer, warn, record };
  };

  const lagRecords = (record: ReturnType<typeof vi.fn>): unknown[] =>
    record.mock.calls.filter((c) => c[0] === 'audit_consumer_lag');
  const warnMessages = (warn: ReturnType<typeof vi.fn>): string[] =>
    warn.mock.calls.map((c) => String(c[1]));

  it('records the lag gauge and does NOT warn for a healthy (caught-up) group', async () => {
    const { drainer, warn, record } = drainerWithLag(0);
    await drainer.drainOnce();
    expect(lagRecords(record)).toEqual([['audit_consumer_lag', 0, { stream: STREAM }]]);
    expect(warnMessages(warn)).toHaveLength(0);
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
  });

  it('survives exec() resolving null (pipeline discarded) without throwing', async () => {
    const { drainer } = drainerWithLag(0, 'exec');
    await expect(drainer.drainOnce()).resolves.toMatchObject({ batched: 1 });
  });

  it('warns "entries lost" and skips the gauge when lag is null (trimmed past the group)', async () => {
    const { drainer, warn, record } = drainerWithLag(null);
    await drainer.drainOnce();
    // A null lag is not a number, so the gauge is intentionally not recorded.
    expect(lagRecords(record)).toHaveLength(0);
    expect(warnMessages(warn).some((m) => m.includes('entries lost before delivery'))).toBe(true);
  });
});
