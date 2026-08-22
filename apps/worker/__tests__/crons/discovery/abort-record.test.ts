// Every Redis touch behind the asset-policy abort finding: the two writes and the shared read.
//
// All three are exercised here rather than stubbed, because each carries a guarantee its callers cannot state on their own: the record keeps the START of a run of refusals across its rewrites, and nothing here ever rejects. The second is why these live in one module — `record` is called from inside the handler's per-profile catch, so a rejection would escape the catch and the loop and cost the whole wake, and the read is called by a health monitor that must not mute itself when Redis blips.

import { describe, expect, it, vi } from 'vitest';
import type { Logger } from 'pino';
import { DISCOVERY_ASSET_POLICY_ABORT_TTL_S, GLOBAL_KEYS } from '@app/db';

import {
  createAssetPolicyAbortRecordStore,
  readAssetPolicyAbortRecord,
} from '../../../src/crons/discovery/abort-record.js';

const PID = '00000000-0000-4000-8000-000000000001';
const KEY = GLOBAL_KEYS.discoveryAssetPolicyAbort(PID);
const NOW = 1_700_000_000_000;
const REFRESH = 900_000;

const mkLogger = () =>
  ({ info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() }) as unknown as Logger;

/** A Redis stand-in over one in-memory value, so a run of writes reads back what the previous one wrote. */
const mkRedis = (seed: string | null = null) => {
  let value = seed;
  return {
    get: vi.fn(async () => value),
    set: vi.fn(async (_k: string, v: string) => {
      value = v;
      return 'OK' as const;
    }),
    del: vi.fn(async () => {
      value = null;
      return 1;
    }),
    read: () => (value === null ? null : (JSON.parse(value) as Record<string, unknown>)),
  };
};

describe('the asset-policy abort record store', () => {
  it('parks the refusal under the shared key, with the TTL that outlives the longest gap between cycles', async () => {
    const redis = mkRedis();
    await createAssetPolicyAbortRecordStore(redis, mkLogger()).record(
      PID,
      'stablecoin-route-empty',
      NOW,
    );

    expect(redis.set).toHaveBeenCalledWith(
      KEY,
      JSON.stringify({ cause: 'stablecoin-route-empty', atMs: NOW, firstAtMs: NOW }),
      'EX',
      DISCOVERY_ASSET_POLICY_ABORT_TTL_S,
    );
  });

  it('holds the start time across a run of refusals, so a chronic fault does not read as minutes old', async () => {
    // Every aborting cycle rewrites the record. Without the carry-forward the operator's duration is capped at one refresh period however long the fault has been in force, which is exactly the distinction between an unlucky scan and a dead classification route that this finding exists to draw.
    const redis = mkRedis();
    const store = createAssetPolicyAbortRecordStore(redis, mkLogger());
    await store.record(PID, 'stablecoin-route-empty', NOW);
    await store.record(PID, 'stablecoin-route-empty', NOW + REFRESH);
    await store.record(PID, 'stablecoin-route-empty', NOW + 2 * REFRESH);

    expect(redis.read()).toEqual({
      cause: 'stablecoin-route-empty',
      atMs: NOW + 2 * REFRESH,
      firstAtMs: NOW,
    });
  });

  it('starts a new run when the cause changes, because the remedy changed with it', async () => {
    const redis = mkRedis();
    const store = createAssetPolicyAbortRecordStore(redis, mkLogger());
    await store.record(PID, 'stablecoin-route-empty', NOW);
    await store.record(PID, 'cross-check-gap', NOW + REFRESH);

    expect(redis.read()).toEqual({
      cause: 'cross-check-gap',
      atMs: NOW + REFRESH,
      firstAtMs: NOW + REFRESH,
    });
  });

  it('replaces a record it cannot read rather than mining it for a start time', async () => {
    // A plain Redis value outlives every deploy and can be hand-edited. Carrying a start time out of something that did not parse would date the finding from a number nothing vouches for.
    const redis = mkRedis('not json at all');
    await createAssetPolicyAbortRecordStore(redis, mkLogger()).record(PID, 'fiat-route-empty', NOW);

    expect(redis.read()).toEqual({ cause: 'fiat-route-empty', atMs: NOW, firstAtMs: NOW });
  });

  it('keeps the start of a record parked before this field existed', async () => {
    // The deploy that ships `firstAtMs` finds records that predate it. Dropping the `?? atMs` fallback would re-date every one of them to now, and keep re-dating them each cycle, for exactly the profiles that were already refusing — the chronic-versus-transient distinction lost precisely where it matters.
    const redis = mkRedis(JSON.stringify({ cause: 'fiat-route-empty', atMs: NOW - 3 * REFRESH }));
    await createAssetPolicyAbortRecordStore(redis, mkLogger()).record(PID, 'fiat-route-empty', NOW);

    expect(redis.read()).toEqual({
      cause: 'fiat-route-empty',
      atMs: NOW,
      firstAtMs: NOW - 3 * REFRESH,
    });
  });

  it('clears the record under the same key the writer used', async () => {
    const redis = mkRedis(JSON.stringify({ cause: 'cross-check-gap', atMs: NOW, firstAtMs: NOW }));
    await createAssetPolicyAbortRecordStore(redis, mkLogger()).clear(PID);

    expect(redis.del).toHaveBeenCalledWith(KEY);
    expect(redis.read()).toBeNull();
  });

  it('never rejects when Redis is down, and says so exactly once per call', async () => {
    // The contract the handler depends on. `record` runs inside the per-profile catch: a rejection there escapes both the catch and the loop, so a Redis blip would skip every remaining profile's cycle — a diagnostic write taking down the trading cron.
    const down = {
      get: vi.fn(async () => {
        throw new Error('redis down');
      }),
      set: vi.fn(async () => {
        throw new Error('redis down');
      }),
      del: vi.fn(async () => {
        throw new Error('redis down');
      }),
    };
    const logger = mkLogger();
    const store = createAssetPolicyAbortRecordStore(down, logger);

    await expect(store.record(PID, 'empty-admission-map', NOW)).resolves.toBeUndefined();
    await expect(store.clear(PID)).resolves.toBeUndefined();
    // Three, not two: the read and the write inside `record` fail separately and say so separately, because they cost different things.
    expect(logger.warn).toHaveBeenCalledTimes(3);
  });

  it('still parks the record when only the read fails, dating it from this cycle', async () => {
    // A failed read costs the run's start time. Letting it cost the whole record would leave the profile reading as merely stale, which is the silence the record exists to end — and the operator would be told nothing at all rather than told the fault is younger than it is.
    const redis = mkRedis();
    redis.get.mockRejectedValueOnce(new Error('redis down'));
    const logger = mkLogger();
    await createAssetPolicyAbortRecordStore(redis, logger).record(PID, 'cross-check-gap', NOW);

    expect(redis.set).toHaveBeenCalledWith(
      KEY,
      JSON.stringify({ cause: 'cross-check-gap', atMs: NOW, firstAtMs: NOW }),
      'EX',
      DISCOVERY_ASSET_POLICY_ABORT_TTL_S,
    );
    expect(logger.warn).toHaveBeenCalledTimes(1);
  });
});

// The read is stated here, in the module that promises it, because its two callers are a health monitor and an on-demand diagnosis and neither has a way to handle a rejection: the monitor would go quiet on a Redis blip and the diagnosis would fail a whole page over one finding.
describe('reading the asset-policy abort record', () => {
  it('returns the parked record for the profile', async () => {
    const parked = { cause: 'cross-check-gap', atMs: NOW, firstAtMs: NOW - REFRESH };
    const redis = mkRedis(JSON.stringify(parked));
    await expect(readAssetPolicyAbortRecord(redis, mkLogger(), PID)).resolves.toEqual(parked);
    expect(redis.get).toHaveBeenCalledWith(KEY);
  });

  it('resolves null instead of rejecting when Redis is unavailable', async () => {
    const redis = mkRedis();
    redis.get.mockRejectedValueOnce(new Error('redis down'));
    const logger = mkLogger();
    await expect(readAssetPolicyAbortRecord(redis, logger, PID)).resolves.toBeNull();
    expect(logger.warn).toHaveBeenCalledTimes(1);
  });

  it('resolves null for a value it cannot trust, rather than putting an unknown cause on the page', async () => {
    // Two shapes, one answer. A plain Redis value outlives any deploy, so an older worker's vocabulary and a hand-edited half-value both have to degrade to "no abort recorded".
    const logger = mkLogger();
    await expect(readAssetPolicyAbortRecord(mkRedis('{not json'), logger, PID)).resolves.toBeNull();
    await expect(
      readAssetPolicyAbortRecord(
        mkRedis(JSON.stringify({ cause: 'tag-moved', atMs: NOW })),
        logger,
        PID,
      ),
    ).resolves.toBeNull();
    expect(logger.warn).toHaveBeenCalledTimes(2);
  });

  it('resolves null when nothing is parked, without warning about it', async () => {
    const logger = mkLogger();
    await expect(readAssetPolicyAbortRecord(mkRedis(), logger, PID)).resolves.toBeNull();
    expect(logger.warn).not.toHaveBeenCalled();
  });
});
