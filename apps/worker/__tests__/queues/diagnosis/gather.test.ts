// The timeline read is the ONE fail-soft read in the gather: losing the edge
// tail costs history, not a verdict. These tests pin that the degradation
// actually happens — for a bound method that is missing at runtime, for a
// synchronous throw, and for a rejected promise — and that what comes back is a
// COMPLETE input every time, not a stub that happens not to throw.

import { describe, expect, it, vi } from 'vitest';
import type { Logger } from 'pino';
import { buildStrategyRegistry } from '@app/strategy-registry';
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

// One rotatable row and one pinned one. The pin, not the provenance, is what the slot maths and the funnel probe read.
const symbolRows = [
  { symbol: 'BTCUSDT', source: 'auto', pinned: false },
  { symbol: 'ETHUSDT', source: 'manual', pinned: true },
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
  expect(gathered.discovery?.rotatableSymbols).toEqual(['BTCUSDT']);
  expect(gathered.discovery?.pinnedSymbols).toEqual(['ETHUSDT']);
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

/**
 * Deps whose profile row is the variable under test, for the three fields the entry-signal-reach rung reads off it.
 *
 * `strategies` is the REAL registry unless a case overrides it: the entry-cadence flag comes off a plugin's own capability declaration, so a stub would assert the fixture rather than the strategy.
 */
const makeProfileDeps = (
  over: Record<string, unknown>,
  strategies?: DiagnosisGatherDeps['strategies'],
): DiagnosisGatherDeps => {
  const { deps } = makeDeps({ listConditionEdges: async () => [] }, makeLogger());
  return {
    ...deps,
    strategies: strategies ?? buildStrategyRegistry(),
    repo: {
      ...deps.repo,
      profile: { findById: vi.fn(async () => ({ ...profileRow, ...over })) },
    } as unknown as DiagnosisGatherDeps['repo'],
  };
};

// The rung that answers "can a coin still produce a buy signal before it is rotated out" reads two settings and no market data. Both have to survive the gather intact, and both have to degrade to null rather than to a guess — reporting health off a cadence nobody read is the failure that rung exists to fix.
describe('gatherDiagnosisInput — the entry-signal-reach inputs', () => {
  it('carries the minimum hold and the entry candle interval through', async () => {
    const { input } = await gatherDiagnosisInput(
      makeProfileDeps({
        config: { candleInterval: '1d' },
        discoveryConfig: { enabled: true, maxAutoSymbols: 5, minHoldMinutes: 1440 },
      }),
    );
    expect(input.profile.minHoldMinutes).toBe(1440);
    expect(input.profile.candleInterval).toBe('1d');
  });

  it("reads the entry cadence off each plugin's own capability, not off a strategy name", async () => {
    // Momentum's entry IS an EMA cross over closed candles; trailing-trade's first buy is a price trigger that can fire seconds after a symbol is bound. The rung's arithmetic is only meaningful for the first, so the flag decides whether it answers at all.
    const momentum = await gatherDiagnosisInput(makeProfileDeps({ strategyName: 'momentum' }));
    expect(momentum.input.profile.entryOnCandleClose).toBe(true);

    const tt = await gatherDiagnosisInput(makeProfileDeps({ strategyName: 'trailing-trade' }));
    expect(tt.input.profile.entryOnCandleClose).toBe(false);
  });

  it('reports null, not false, for a strategy that is not registered', async () => {
    // Nobody answered, which is not the same as a plugin answering "on price". The rung reports unknown for both, and keeping them apart is what stops silence from reading as a claim.
    const { input } = await gatherDiagnosisInput(
      makeProfileDeps({ strategyName: 'not-a-strategy' }, {
        get: () => undefined,
      } as unknown as DiagnosisGatherDeps['strategies']),
    );
    expect(input.profile.entryOnCandleClose).toBeNull();
  });

  it('reads the interval by literal key, so a config that names it nothing reports null', async () => {
    // Contracts is the leaf and may not know a strategy type, so this is a duck-read. The one thing it must not do is fall back to a default cadence.
    const { input } = await gatherDiagnosisInput(
      makeProfileDeps({ config: { entryInterval: '1h' } }),
    );
    expect(input.profile.candleInterval).toBeNull();
  });

  it('narrows to the closed interval set, not merely to a string', async () => {
    // The column is jsonb and the api's enum guards only the write path, so a restore or an out-of-band edit can put any string here. A bare `typeof === 'string'` would carry it into an operator-facing sentence verbatim, and an inherited-member name would once have divided to NaN and read as a mapped cadence.
    const { input } = await gatherDiagnosisInput(
      makeProfileDeps({ config: { candleInterval: 'constructor' } }),
    );
    expect(input.profile.candleInterval).toBeNull();

    const other = await gatherDiagnosisInput(makeProfileDeps({ config: { candleInterval: '7h' } }));
    expect(other.input.profile.candleInterval).toBeNull();
  });

  it('reports a non-string interval as null rather than passing the raw value on', async () => {
    const { input } = await gatherDiagnosisInput(
      makeProfileDeps({ config: { candleInterval: 60 } }),
    );
    expect(input.profile.candleInterval).toBeNull();
  });

  it('reports the minimum hold as null when the discovery config did not parse', async () => {
    // Unreadable is not "no minimum hold": the rung answers unknown off this, and a zero here would make it answer with a division by a number nobody stored.
    const { input } = await gatherDiagnosisInput(
      makeProfileDeps({ discoveryConfig: { enabled: 'yes' } }),
    );
    expect(input.profile.minHoldMinutes).toBeNull();
  });
});

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

  it('reports one line per active breaker, with no start time to invent', async () => {
    // Each flag is a bare key with a TTL. It carries no start, and a guessed one
    // would date a breaker the operator can act on.
    const deps = withRedis(
      { exists: async (key: string) => (key.endsWith('entry-halt:drawdown') ? 1 : 0) },
      makeLogger(),
    );

    const { input } = await gatherDiagnosisInput(deps);
    // Only the guard that is actually set: naming the daily limit here would send
    // the operator to a setting that is off.
    expect(input.halts).toEqual([{ label: 'The drawdown guard is pausing buys', sinceMs: null }]);
  });

  it('reports every active breaker, in EntryHaltKind order', async () => {
    const deps = withRedis({ exists: async () => 1 }, makeLogger());

    const { input } = await gatherDiagnosisInput(deps);
    expect(input.halts?.map((h) => h.label)).toEqual([
      "Today's loss limit was hit",
      'The loss-streak guard is pausing buys',
      'The drawdown guard is pausing buys',
    ]);
  });

  it('reports null, not a PARTIAL list, when one of the three key reads fails', async () => {
    // The first key answers "set" and the second throws. A per-key try would
    // return the one halt it managed to read and call that the whole answer,
    // which is the same false claim as an empty list with a halt hidden inside it.
    let call = 0;
    const deps = withRedis(
      {
        exists: async () => {
          call += 1;
          if (call === 1) return 1;
          throw new Error('redis down mid-read');
        },
      },
      makeLogger(),
    );

    const { input } = await gatherDiagnosisInput(deps);
    expect(input.halts).toBeNull();
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
