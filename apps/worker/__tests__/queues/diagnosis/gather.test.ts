// The timeline read is the ONE fail-soft read in the gather: losing the edge
// tail costs history, not a verdict. These tests pin that the degradation
// actually happens — for a bound method that is missing at runtime, for a
// synchronous throw, and for a rejected promise — and that what comes back is a
// COMPLETE input every time, not a stub that happens not to throw.

import { describe, expect, it, vi } from 'vitest';
import type { Logger } from 'pino';
import { asAccountId, asProfileId, asUserId } from '@app/contracts';
import { profileRepoFromScope, type Database, type ProfileScope } from '@app/db';

import {
  gatherDiagnosisInput,
  type DiagnosisGatherDeps,
} from '../../../src/queues/diagnosis/gather.js';

const NOW = 1_700_000_000_000;

// A scope whose `db` is never touched: every namespace the gather reads is
// stubbed, so no bound method reaches drizzle. It exists only so the REAL
// `profileRepoFromScope` can be built and its runtime surface exercised.
const stubScope = {
  db: { __stub: 'db' } as unknown as Database,
  operatorId: asUserId('00000000-0000-0000-0000-0000000a0001'),
  accountId: asAccountId('00000000-0000-0000-0000-0000000ac001'),
  profileId: asProfileId('00000000-0000-0000-0000-0000000a1001'),
} as unknown as ProfileScope;

const profileRow = {
  enabled: true,
  quoteAsset: 'usdt',
  strategyName: 'trailing-trade',
  config: { foo: 1 },
  discoveryConfig: { enabled: true, maxAutoSymbols: 5, refreshPeriodMs: 900_000 },
};

const conditionRow = {
  condition: 'entry-blocked',
  symbol: 'BTCUSDT',
  code: 'no-funds',
  detail: { free: '0' },
  since: new Date(NOW - 60_000),
};

const snapshotRow = {
  capturedAt: new Date(NOW - 30_000),
  snapshot: { funnel: { universe: 400, eligible: 4, added: 1, breadthOk: true } },
};

const symbolRows = [
  { symbol: 'BTCUSDT', source: 'auto' },
  { symbol: 'ETHUSDT', source: 'manual' },
];

/**
 * Everything but the timeline read resolves normally, so a rejection from
 * `gatherDiagnosisInput` can only have come from the edge-list read.
 */
const makeDeps = (
  actionLogs: unknown,
  logger: Logger,
): { deps: DiagnosisGatherDeps; logger: Logger } => {
  const repo = {
    ...profileRepoFromScope(stubScope),
    profile: { findById: vi.fn(async () => profileRow) },
    conditionStates: { listOpen: vi.fn(async () => [conditionRow]) },
    discoveryUniverseSnapshots: { listForProfile: vi.fn(async () => [snapshotRow]) },
    profileSymbols: { listForProfile: vi.fn(async () => symbolRows) },
    actionLogs,
  } as unknown as DiagnosisGatherDeps['repo'];

  return {
    logger,
    deps: {
      repo,
      // Key-aware, because the gather now GETs two different keys off one client: a blanket payload would feed the heartbeat's bytes to the abort parser and make every case log a parse warning.
      redis: {
        get: vi.fn(async (key: string) => (key === 'worker:status' ? 'sha:booted' : null)),
        exists: vi.fn(async () => 0),
      } as never,
      strategies: { get: () => undefined } as never,
      logger,
      keyParts: { accountId: stubScope.accountId, profileId: stubScope.profileId },
      nowMs: NOW,
    },
  };
};

const makeLogger = (): Logger =>
  ({ warn: vi.fn(), info: vi.fn(), error: vi.fn(), debug: vi.fn() }) as unknown as Logger;

/** A degraded run must still carry every field the ladder rests on. */
const expectCompleteButTimelineless = (
  gathered: Awaited<ReturnType<typeof gatherDiagnosisInput>>,
) => {
  const { input } = gathered;
  expect(input.timeline).toEqual([]);
  expect(input.profile.quoteAsset).toBe('USDT');
  expect(input.profile.enabled).toBe(true);
  expect(input.profile.discoveryEnabled).toBe(true);
  expect(input.profile.maxAutoSymbols).toBe(5);
  expect(input.profile.autoSymbolCount).toBe(1);
  expect(input.worker.heartbeatPresent).toBe(true);
  expect(input.halts).toEqual([]);
  expect(input.assetPolicyAbort).toBeNull();
  expect(input.conditions).toEqual([
    {
      condition: 'entry-blocked',
      symbol: 'BTCUSDT',
      code: 'no-funds',
      detail: { free: '0' },
      sinceMs: NOW - 60_000,
    },
  ]);
  expect(input.snapshots).toHaveLength(1);
  expect(input.snapshots[0]?.capturedAtMs).toBe(NOW - 30_000);
  expect(input.snapshots[0]?.funnel?.eligible).toBe(4);
  expect(gathered.discovery?.autoSymbols).toEqual(['BTCUSDT']);
  expect(gathered.discovery?.manualSymbols).toEqual(['ETHUSDT']);
};

/**
 * Deps whose condition and symbol reads are the variables under test. Built on
 * `makeDeps` so the rest of the surface stays the real one; the timeline read
 * resolves empty because it is not what these cases are about.
 */
const makeConditionDeps = (
  conditionRows: readonly {
    condition: string;
    symbol: string;
    code: string;
    detail: unknown;
    since: Date;
  }[],
  boundSymbols: readonly { symbol: string; source: string }[],
): DiagnosisGatherDeps => {
  const { deps } = makeDeps({ listConditionEdges: async () => [] }, makeLogger());
  return {
    ...deps,
    repo: {
      ...deps.repo,
      conditionStates: { listOpen: vi.fn(async () => conditionRows) },
      profileSymbols: { listForProfile: vi.fn(async () => boundSymbols) },
    } as unknown as DiagnosisGatherDeps['repo'],
  };
};

const openCondition = (symbol: string, code: string) => ({
  condition: 'entry-blocked',
  symbol,
  code,
  detail: null,
  since: new Date(NOW - 60_000),
});

// A condition row is closed only by the owning tick writing a null code, so a
// row for a symbol the profile no longer holds can never close. Reporting it
// names a coin the operator does not own as the thing blocking them, which is
// the one wrong answer a tool built to prove things can give. The bound symbol
// set is the authority on what the profile owns.
describe('gatherDiagnosisInput — open conditions are filtered to bound symbols', () => {
  it('drops a condition whose symbol is no longer bound', async () => {
    const deps = makeConditionDeps(
      [openCondition('BTCUSDT', 'no-funds'), openCondition('DOGEUSDT', 'knife-guard')],
      [{ symbol: 'BTCUSDT', source: 'auto' }],
    );

    const { input } = await gatherDiagnosisInput(deps);
    expect(input.conditions.map((c) => c.symbol)).toEqual(['BTCUSDT']);
  });

  it('keeps a bound symbol condition, so the filter is not dropping everything', async () => {
    const deps = makeConditionDeps(
      [openCondition('BTCUSDT', 'no-funds'), openCondition('ETHUSDT', 'cooldown')],
      [
        { symbol: 'BTCUSDT', source: 'auto' },
        { symbol: 'ETHUSDT', source: 'manual' },
      ],
    );

    const { input } = await gatherDiagnosisInput(deps);
    expect(input.conditions.map((c) => c.symbol)).toEqual(['BTCUSDT', 'ETHUSDT']);
  });

  it('keeps a profile-level condition when no symbol is bound at all', async () => {
    // The profile subject is the empty-string sentinel, not a symbol name, so a
    // filter keyed on the bound set alone would delete exactly the conditions
    // that explain an empty profile.
    const deps = makeConditionDeps(
      [
        { ...openCondition('', 'no-candidates'), condition: 'discovery-idle' },
        openCondition('DOGEUSDT', 'knife-guard'),
      ],
      [],
    );

    const { input } = await gatherDiagnosisInput(deps);
    expect(input.conditions).toEqual([
      {
        condition: 'discovery-idle',
        symbol: '',
        code: 'no-candidates',
        detail: null,
        sinceMs: NOW - 60_000,
      },
    ]);
  });
});

describe('gatherDiagnosisInput — timeline is the only fail-soft read', () => {
  it('degrades when the bound listConditionEdges is missing from the runtime repo', async () => {
    // The production shape, reconstructed on the REAL bound module: a name the
    // `only` list forgets is absent from the surface, so the call site reads
    // `undefined(200)` and throws while the Promise.all array is still being
    // built. Deleting it here rather than passing a stub keeps the rest of the
    // real binding in place, and keeps the case distinct from the rejection
    // control below — with the name restored it is just an async read.
    const logger = makeLogger();
    const actionLogs: Record<string, unknown> = { ...profileRepoFromScope(stubScope).actionLogs };
    delete actionLogs['listConditionEdges'];
    const { deps } = makeDeps(actionLogs, logger);

    expectCompleteButTimelineless(await gatherDiagnosisInput(deps));
    expect(logger.warn).toHaveBeenCalledTimes(1);
  });

  it('degrades when the edge read throws synchronously', async () => {
    // A sync throw happens while the Promise.all array literal is being built,
    // so there is no promise yet for a trailing `.catch` to attach to.
    const logger = makeLogger();
    const { deps } = makeDeps(
      {
        listConditionEdges: () => {
          throw new Error('boom');
        },
      },
      logger,
    );

    expectCompleteButTimelineless(await gatherDiagnosisInput(deps));
    expect(logger.warn).toHaveBeenCalledTimes(1);
  });

  it('degrades when the edge read rejects', async () => {
    // Control: the async path the existing `.catch` already covers. Its passing
    // while the two above fail is what isolates the gap to sync failures.
    const logger = makeLogger();
    const { deps } = makeDeps(
      { listConditionEdges: () => Promise.reject(new Error('db down')) },
      logger,
    );

    expectCompleteButTimelineless(await gatherDiagnosisInput(deps));
    expect(logger.warn).toHaveBeenCalledTimes(1);
  });
});

describe('gatherDiagnosisInput — the Redis reads report absence, never health', () => {
  const withRedis = (redis: Partial<Record<'get' | 'exists', unknown>>, logger: Logger) => {
    const { deps } = makeDeps({ listConditionEdges: async () => [] }, logger);
    return { ...deps, redis: { ...deps.redis, ...redis } as never };
  };

  it('reports the daily-loss halt, with no start time to invent', async () => {
    // The flag is a bare key with a TTL to the next UTC day. It carries no start,
    // and a guessed one would date a breaker the operator can act on.
    const deps = withRedis({ exists: async () => 1 }, makeLogger());

    const { input } = await gatherDiagnosisInput(deps);
    expect(input.halts).toEqual([{ label: "Today's loss limit was hit", sinceMs: null }]);
  });

  it('reports the halt state as unreadable rather than as clear', async () => {
    // null, not []. The two Redis reads run concurrently over one client, so
    // this command can fail while the heartbeat GET succeeds: an empty list
    // here would clear a halt nobody ever saw, on a ladder that still reports
    // a live engine.
    const logger = makeLogger();
    const deps = withRedis(
      {
        exists: async () => {
          throw new Error('redis down');
        },
      },
      logger,
    );

    const { input } = await gatherDiagnosisInput(deps);
    expect(input.halts).toBeNull();
    expect(input.worker.heartbeatPresent).toBe(true);
    expect(logger.warn).toHaveBeenCalledTimes(1);
  });

  it('never claims a live engine off a failed heartbeat read', async () => {
    // Unreadable is not the same as absent, but both leave liveness unproven,
    // and "the engine is running" is the one answer a failed read must not give.
    const logger = makeLogger();
    // Scoped to the heartbeat key: the same client also carries the abort read, and a blanket throw would prove two reads failed rather than what this case is about.
    const deps = withRedis(
      {
        get: async (key: string) => {
          if (key === 'worker:status') throw new Error('redis down');
          return null;
        },
      },
      logger,
    );

    const { input } = await gatherDiagnosisInput(deps);
    expect(input.worker.heartbeatPresent).toBe(false);
    expect(logger.warn).toHaveBeenCalledTimes(1);
  });

  it('carries the parked asset-policy abort so the discovery rung can name the cause', async () => {
    // The record is the ONLY channel between the cron that refused and the page the operator reads: the abort leaves no condition row and no snapshot, so a gather that dropped it would leave rung 5 blaming staleness for a cycle that never got as far as ranking.
    const deps = withRedis(
      {
        get: async (key: string) =>
          key === 'worker:status'
            ? 'sha:booted'
            : JSON.stringify({ cause: 'stablecoin-route-empty', atMs: NOW - 3_600_000 }),
      },
      makeLogger(),
    );

    const { input } = await gatherDiagnosisInput(deps);
    expect(input.assetPolicyAbort).toEqual({
      cause: 'stablecoin-route-empty',
      atMs: NOW - 3_600_000,
    });
  });

  it('reads an unparseable abort record as absent rather than inventing a cause', async () => {
    // A plain Redis value written by an older worker, or by hand, outlives any deploy. Guessing a cause from it would put a named upstream fault on the page that no check ever produced, which is worse than the weaker true answer of judging the profile on staleness alone.
    const logger = makeLogger();
    const deps = withRedis(
      {
        get: async (key: string) =>
          key === 'worker:status' ? 'sha:booted' : '{"cause":"tag-vocabulary-moved","atMs":1}',
      },
      logger,
    );

    const { input } = await gatherDiagnosisInput(deps);
    expect(input.assetPolicyAbort).toBeNull();
    expect(logger.warn).toHaveBeenCalledTimes(1);
  });

  it('reports a failed abort read as absent, and leaves the other reads alone', async () => {
    const logger = makeLogger();
    const deps = withRedis(
      {
        get: async (key: string) => {
          if (key === 'worker:status') return 'sha:booted';
          throw new Error('redis down');
        },
      },
      logger,
    );

    const { input } = await gatherDiagnosisInput(deps);
    expect(input.assetPolicyAbort).toBeNull();
    expect(input.worker.heartbeatPresent).toBe(true);
    expect(logger.warn).toHaveBeenCalledTimes(1);
  });
});
