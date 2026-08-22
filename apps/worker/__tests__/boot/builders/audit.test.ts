import { afterEach, describe, expect, it, vi } from 'vitest';
import pino from 'pino';

import { repo } from '@app/db';

import type { AuditEntry } from '../../../src/audit-shipper/audit-shipper.js';
import {
  auditPersistBatch,
  buildAudit,
  isUnpersistableRow,
} from '../../../src/boot/builders/audit.js';
import { anyProxy, fakeDb, fakeRedis, silentLogger } from './fakes.js';

// drizzle wraps every query error and hangs the driver's error off `cause`, so
// the SQLSTATE is never on the error the drainer receives.
const wrapped = (code: string): Error =>
  new Error('Failed query: insert into action_logs', {
    cause: Object.assign(new Error('boom'), { code }),
  });

// `depth` wrappers above an error carrying `code`, for pinning the walk's bound.
const nested = (depth: number, code: string): Error => {
  let err: Error = Object.assign(new Error('driver'), { code });
  for (let i = 0; i < depth; i++) err = new Error(`wrapper ${i}`, { cause: err });
  return err;
};

const entry = (decisionTypes: readonly string[]): AuditEntry =>
  ({
    accountId: 'a_1',
    profileId: 'p_1',
    tickId: '00000000-0000-4000-8000-000000000793',
    ts: 1_700_000_000_000,
    symbol: 'BTCUSDT',
    event: 'tick',
    latencyMs: 12,
    decisionTypes,
    clientOrderIds: [],
    payload: { results: [{ type: 'place-order', ok: true }] },
  }) as unknown as AuditEntry;

describe('buildAudit', () => {
  it('gives the drainer its own connection, distinct from the shared client', () => {
    const redis = fakeRedis();
    const a = buildAudit({
      db: fakeDb(),
      redis,
      logger: silentLogger(),
      metrics: anyProxy(),
      profileManager: { listActive: () => [] } as never,
    });

    expect(Object.keys(a).sort()).toEqual(['auditDrainer', 'auditDrainerRedis', 'auditShipper']);
    // Blocking XREADGROUP must not share the shared socket.
    expect(a.auditDrainerRedis).not.toBe(redis);
  });
});

// This predicate is the second half of the poison gate: it decides whether a
// rejection may cost an audit record its place in the pending list. Getting it
// wrong in the permissive direction destroys writable rows during an outage, so
// every class below is pinned rather than sampled.
describe('isUnpersistableRow', () => {
  // Faults of the ROW. The same values fail identically against any healthy
  // backend, so retrying forever would only hold the pending floor up.
  it.each([
    ['22P02', 'invalid_text_representation'],
    ['22001', 'string_data_right_truncation'],
    ['23502', 'not_null_violation'],
    ['23505', 'unique_violation'],
    ['23514', 'check_violation'],
  ])('treats %s (%s) as a fault of the row', (code) => {
    expect(isUnpersistableRow(wrapped(code))).toBe(true);
  });

  // Faults of the BACKEND. Each rejects one statement and accepts the next, so
  // each produces the "failed alone beside a success" shape without the row
  // being at fault.
  it.each([
    ['08006', 'connection_failure'],
    ['08003', 'connection_does_not_exist'],
    ['40001', 'serialization_failure'],
    ['40P01', 'deadlock_detected'],
    ['53300', 'too_many_connections'],
    ['57P01', 'admin_shutdown'],
    ['57014', 'query_canceled'],
  ])('treats %s (%s) as a fault of the backend', (code) => {
    expect(isUnpersistableRow(wrapped(code))).toBe(false);
  });

  it('reads the SQLSTATE off a bare driver error, not only a wrapped one', () => {
    expect(isUnpersistableRow(Object.assign(new Error('boom'), { code: '23502' }))).toBe(true);
  });

  it.each([
    ['an unclassifiable error', new Error('boom')],
    ['a non-SQLSTATE code', Object.assign(new Error('boom'), { code: 'ECONNREFUSED' })],
    ['a non-Error rejection', 'boom'],
    ['null', null],
  ])('fails closed on %s', (_label, err) => {
    // The drainer drops on true, so anything unrecognised must keep its place.
    expect(isUnpersistableRow(err)).toBe(false);
  });

  it('stops walking a self-referential cause chain instead of hanging', () => {
    const cyclic: { cause?: unknown } = {};
    cyclic.cause = cyclic;
    expect(isUnpersistableRow(cyclic)).toBe(false);
  });

  // Both sides of the bound, because either one alone is satisfied by a walk
  // that only ever reaches the two levels drizzle nests today.
  it('finds a SQLSTATE four wrappers down, not just the one drizzle adds', () => {
    expect(isUnpersistableRow(nested(4, '23505'))).toBe(true);
  });

  it('gives up past the hop ceiling rather than walking an unbounded chain', () => {
    expect(isUnpersistableRow(nested(6, '23505'))).toBe(false);
  });
});

// The production wiring for BOTH halves of the poison gate. Injected stubs stand
// in for it everywhere else, so without these the drainer's proof-of-health
// contract and the log-leak strip are only ever asserted against a test double.
describe('auditPersistBatch', () => {
  afterEach(() => {
    vi.restoreAllMocks();
  });

  it('resolves with the inserted row count, so a noop batch cannot prove the backend healthy', async () => {
    const insertMany = vi.spyOn(repo.actionLogs, 'insertMany').mockResolvedValue(0);
    // Non-actionable: it maps to zero action_logs rows and never reaches
    // Postgres, so reporting the INPUT count here would let a batch of noops
    // authorise dropping the actionable entries failing beside it.
    await expect(auditPersistBatch(fakeDb())([entry(['noop'])])).resolves.toBe(0);
    expect(insertMany).toHaveBeenCalledWith(expect.anything(), []);
  });

  it('resolves with the row count once an entry is actionable', async () => {
    vi.spyOn(repo.actionLogs, 'insertMany').mockResolvedValue(1);
    await expect(auditPersistBatch(fakeDb())([entry(['place-order'])])).resolves.toBe(1);
  });

  it('reports only rows inserted when a batch mixes a replay with a new entry', async () => {
    const insertMany = vi.spyOn(repo.actionLogs, 'insertMany').mockResolvedValue(1);
    await expect(
      auditPersistBatch(fakeDb())([
        entry(['place-order']),
        { ...entry(['place-order']), ts: 1_700_000_000_001 },
      ]),
    ).resolves.toBe(1);
    expect(insertMany.mock.calls[0]?.[1]).toHaveLength(2);
  });

  it('keeps the statement and its bound parameters off a rejection, without losing the SQLSTATE', async () => {
    // drizzle's own message IS the statement plus every bound value, and pino
    // folds a cause's message into the log line.
    const drizzleErr = Object.assign(
      new Error("Failed query: insert into action_logs ...\nparams: ['0.00123', 'BTCUSDT']"),
      {
        query: 'insert into action_logs ...',
        params: ['0.00123', 'BTCUSDT'],
        cause: Object.assign(new Error('null value in column "symbol"'), { code: '23502' }),
      },
    );
    vi.spyOn(repo.actionLogs, 'insertMany').mockRejectedValue(drizzleErr);

    const thrown = await auditPersistBatch(fakeDb())([entry(['place-order'])]).then(
      () => {
        throw new Error('expected the batch to reject');
      },
      (e: unknown) => e as Error,
    );

    // Serialise the way the drainer's logger will, and check the bytes.
    const line = JSON.parse(
      await new Promise<string>((resolve) => {
        const log = pino({ base: null }, {
          write: (chunk: string) => resolve(chunk),
        } as unknown as NodeJS.WritableStream);
        log.error({ err: thrown }, 'audit persistBatch failed');
      }),
    ) as { err: { message: string; stack: string } };
    const serialised = `${line.err.message} ${line.err.stack}`;
    expect(serialised).not.toContain('Failed query');
    expect(serialised).not.toContain('0.00123');
    expect(serialised).toContain('sqlstate 23502');
    // Still classifiable, or the gate fails closed on a row that can only fail.
    expect(isUnpersistableRow(thrown)).toBe(true);
  });

  it('stays classifiable when the driver rejects bare, with no wrapper to take the cause from', async () => {
    // The rewrap only ever forwards `err.cause`, so a driver that rejects
    // without a wrapper leaves nothing to forward. The SQLSTATE has to survive
    // on the thrown error itself, or the gate fails closed on a row that can
    // only ever fail and the entry is retried out of the PEL forever.
    vi.spyOn(repo.actionLogs, 'insertMany').mockRejectedValue(
      Object.assign(new Error('null value in column "symbol"'), { code: '23502' }),
    );
    const thrown = await auditPersistBatch(fakeDb())([entry(['place-order'])]).then(
      () => {
        throw new Error('expected the batch to reject');
      },
      (e: unknown) => e as Error,
    );
    expect(thrown.message).toContain('sqlstate 23502');
    expect(isUnpersistableRow(thrown)).toBe(true);
  });

  it('reports an unclassifiable rejection as unknown, leaving the gate to fail closed', async () => {
    vi.spyOn(repo.actionLogs, 'insertMany').mockRejectedValue(new Error('socket hang up'));
    const thrown = await auditPersistBatch(fakeDb())([entry(['place-order'])]).then(
      () => {
        throw new Error('expected the batch to reject');
      },
      (e: unknown) => e as Error,
    );
    expect(thrown.message).toContain('sqlstate unknown');
    expect(isUnpersistableRow(thrown)).toBe(false);
  });
});
