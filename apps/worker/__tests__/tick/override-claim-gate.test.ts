// The claim the tick never took.
//
// `override_actions` rows carry a `processing_at` column and the repo states the
// contract for it: a consumer whose side effect is not idempotent must claim the row
// first and act only when the claim returns `true`. The tick path is the one consumer
// that places real Binance orders, and it never claims. So `processing_at` is null for
// every trade override, the cancel route's `processing_at is null` delete guard has
// never engaged, and an operator cancel lands mid-flight: the row is deleted, the
// operator is told the action was cancelled, and the order still reaches the exchange.
//
// The claim is also the race's only arbiter, so discarding its boolean is the mirror
// harm. `claimAction` returns false exactly when the operator won — dispatching anyway
// executes an order the operator was truthfully told was cancelled.
//
// These tests drive the REAL `createTickHandler` (same harness shape as
// override-abort-rearm.test.ts) with a strategy that emits a market SELL, because the
// property under test is about an order that can reach Binance. Four things are pinned:
//   1. Ordering — the claim is awaited to completion before the executor can transmit.
//   2. Fail-closed — a claim that returns false, throws, or stalls dispatches nothing.
//   3. Intent — a lost claim on a live row is handed back to the next tick; a lost
//      claim on a deleted row stands down silently, because the operator already has
//      their answer.
//   4. Settlement — a claimed row still settles exactly once on the happy path, and a
//      branch that re-arms hands the row back UNCLAIMED, fenced on this tick's stamp.

import { describe, expect, it, vi } from 'vitest';
import type { Job } from 'bullmq';
import type { MarketDataPort } from '@app/binance';
import { profileKey, type ProfileScope } from '@app/db';
import { createRegistry, type Strategy, type SymbolInfo } from '@app/strategy-core';
import { z } from 'zod';
import { asAccountId, asProfileId, asUserId } from '@app/contracts';

import { createChainByKey } from '../../src/lib/chain-by-key.js';
import { createTickHandler, type TickHandlerDeps } from '../../src/tick/tick-handler.js';
import type { ProfileTickContext } from '../../src/tick/build-tick-input.js';
import type { TickJobData } from '../../src/queues/job-payloads.js';

const OPERATOR = asUserId('11111111-1111-4111-8111-111111111111');
const ACCOUNT = asAccountId('33333333-3333-4333-8333-333333333333');
const PROFILE = asProfileId('22222222-2222-4222-8222-222222222222');
const SCOPE = { operatorId: OPERATOR, accountId: ACCOUNT, profileId: PROFILE };
const SYMBOL = 'BTCUSDT';
const OVERRIDE_ACTION_ID = '01234567-89ab-4cde-89ab-cdef01234567';
const OVERRIDE = { kind: 'trigger-sell' as const, overrideActionId: OVERRIDE_ACTION_ID };
const OVERRIDE_KEY = profileKey({ accountId: ACCOUNT, profileId: PROFILE }, 'override', SYMBOL);
const OVERRIDE_TTL_MS = 120_000;
/** Milliseconds the injected clock advances per read, so a re-armed window is provably shortened. */
const CLOCK_STEP_MS = 25;

/**
 * The claim dep's shape is declared here rather than read back off the type under
 * test: these tests are the specification of that dep surface, so reading it from
 * `TickHandlerDeps` would make them agree with whatever the handler happens to
 * declare instead of pinning what it owes the row.
 */
type ClaimOverrideAction = (
  scope: ProfileScope,
  overrideActionId: string,
  at: Date,
) => Promise<boolean>;

/** Same reasoning as {@link ClaimOverrideAction}: the release's fence is pinned here. */
type ReleaseOverrideClaim = (
  scope: ProfileScope,
  overrideActionId: string,
  at: Date,
) => Promise<void>;

/** What the executor reports back for the override's order; `phase` decides re-arm. */
type OrderResult =
  | { readonly ok: true }
  | {
      readonly ok: false;
      readonly retryable: boolean;
      readonly phase: 'pre-call' | 'rejected' | 'ambiguous' | 'accepted';
      readonly reason: string;
    };

const SYMBOL_INFO: SymbolInfo = {
  symbol: SYMBOL,
  baseAsset: 'BTC',
  quoteAsset: 'USDT',
  filters: { minQty: '0.00001', stepSize: '0.00001', minNotional: '10', tickSize: '0.01' },
};

/** ioredis stub: empty snapshot slots (cold-load), plus the tick-meta / re-arm SETs. */
const buildFakeRedis = (setCalls: unknown[][]): import('ioredis').Redis => {
  const makeChain = (count: { n: number }) => {
    const chain = {
      get() {
        count.n += 1;
        return chain;
      },
      exec: async () => Array.from({ length: count.n }, () => [null, null] as const),
    };
    return chain;
  };
  return {
    pipeline: () => makeChain({ n: 0 }),
    exists: async () => 0,
    get: async () => null,
    set: async (...argv: unknown[]): Promise<'OK'> => {
      setCalls.push(argv);
      return 'OK';
    },
    del: async () => 1,
  } as unknown as import('ioredis').Redis;
};

const marketDataPort = {
  loadWindow: async () => [],
} as unknown as MarketDataPort;

/**
 * Stub honouring `trigger-sell` with a real market SELL. A noop-only strategy would
 * leave every claim assertion vacuous: nothing could reach the exchange, so nothing
 * would need claiming.
 */
const buildStubStrategy = (): Strategy =>
  ({
    name: 'stub-claim-gate',
    version: '1.0.0',
    displayName: 'stub',
    description: 'stub',
    capabilities: {
      candleIntervals: ['1h'],
      needsUserDataStream: false,
      needsMiniTicker: false,
      bundleProviders: ['override'],
      operatorActions: ['trigger-sell'],
    },
    bundleSchema: z.object({}),
    initialState: () => ({ schemaVersion: '1.0.0' }),
    tick: () => ({
      nextState: { schemaVersion: '1.0.0' },
      decisions: [
        {
          type: 'place-order',
          // Stamped, as the contract requires of a strategy honouring an override:
          // without it the settle cannot correlate the order back to the row and every
          // order-fate branch collapses to "nothing was placed".
          intent: {
            symbol: SYMBOL,
            side: 'SELL',
            reason: 'exit',
            clientOrderId: 'stub-exit-1',
            overrideActionId: OVERRIDE_ACTION_ID,
          },
          params: { type: 'MARKET', quantity: '1' },
        },
      ],
      logs: [],
      metrics: [],
    }),
  }) as unknown as Strategy;

interface RunOpts {
  /** Shared ordering log; the executor and claim stubs both append to it. */
  readonly calls?: string[];
  readonly claimOverrideAction?: ClaimOverrideAction;
  /**
   * What the liveness read finds after a lost claim: `live` = the operator's row is
   * still there (their intent stands), `gone` = they cancelled and already have
   * their answer.
   */
  readonly activeOverride?: 'live' | 'gone';
  readonly persistTimeoutMs?: number;
  /** What the executor reports for the override's order. Defaults to a clean fill. */
  readonly orderResult?: OrderResult;
  /** Wired only where the release is under test, so its absence stays observable. */
  readonly releaseOverrideClaim?: ReturnType<typeof vi.fn<ReleaseOverrideClaim>>;
}

interface RunResult {
  readonly calls: string[];
  readonly setCalls: unknown[][];
  readonly applyAll: ReturnType<typeof vi.fn>;
  readonly claimOverrideAction: ReturnType<typeof vi.fn>;
  readonly settleOverrideAction: ReturnType<typeof vi.fn>;
  readonly markOverridePickedUp: ReturnType<typeof vi.fn>;
  readonly record: ReturnType<typeof vi.fn>;
  readonly commit: ReturnType<typeof vi.fn>;
  readonly publish: ReturnType<typeof vi.fn>;
  readonly thrown: unknown;
  /** The handler's own return value, so a skip can be asserted as a skip. */
  readonly result: unknown;
}

const run = async (opts: RunOpts = {}): Promise<RunResult> => {
  const calls = opts.calls ?? [];
  const setCalls: unknown[][] = [];
  const orderResult: OrderResult = opts.orderResult ?? { ok: true };
  const applyAll = vi.fn(
    async (_ctx: unknown, _accountId: unknown, decisions: readonly unknown[]) => {
      calls.push('applyAll');
      return decisions.map((decision) => ({ decision, result: orderResult }));
    },
  );
  const claimOverrideAction = vi.fn<ClaimOverrideAction>(
    opts.claimOverrideAction ?? (async () => true),
  );
  const settleOverrideAction = vi.fn(async () => undefined);
  const markOverridePickedUp = vi.fn(async () => undefined);
  const record = vi.fn();
  const commit = vi.fn(async () => undefined);
  const publish = vi.fn(async () => undefined);
  const findActiveOverride = vi.fn(async () =>
    opts.activeOverride === 'gone' ? null : { id: OVERRIDE_ACTION_ID },
  );
  // Monotonic and stepping: every read burns 25ms of the operator's window, so a
  // re-arm that restarted the TTL instead of continuing it cannot pass.
  let nowMs = 1_700_000_000_000;
  const clock = {
    nowMs: () => {
      nowMs += CLOCK_STEP_MS;
      return nowMs;
    },
  };
  const registry = createRegistry();
  registry.register(buildStubStrategy());

  const profile: ProfileTickContext = {
    operatorId: OPERATOR,
    accountId: ACCOUNT,
    profileId: PROFILE,
    scope: SCOPE,
    symbol: SYMBOL,
    strategyName: 'stub-claim-gate',
    strategyVersion: '1.0.0',
    config: {},
    // A non-null `bundle.override` IS the proof the bundle-builder already DEL'd the
    // operator's key: from here the intent exists only in this process.
    bundleProvider: async () => ({
      bundle: { override: OVERRIDE },
      overrideTtlMs: OVERRIDE_TTL_MS,
    }),
    binanceMode: 'test',
    quoteAsset: 'USDT',
    weightLimit1m: 1200,
    candleInterval: '1h',
    technicalsConfig: { useOnlyWithinMin: 2, ifExpires: 'do-not-buy', intervals: [] },
    needsAccountDeployedQuote: false,
    reserveBaseQuantity: null,
  } as unknown as ProfileTickContext;

  const deps = {
    redis: buildFakeRedis(setCalls),
    registry,
    executor: { applyAll },
    chain: createChainByKey(),
    logger: {
      debug: () => undefined,
      info: () => undefined,
      warn: () => undefined,
      error: () => undefined,
    },
    coldLoad: {
      loadAccount: async () => ({ balances: {} }),
      loadAccountDeployedQuote: async () => '0',
      loadOpenOrders: async () => [],
      loadSymbolState: async () => null,
    },
    symbolInfoCache: { get: async () => SYMBOL_INFO },
    statePort: {
      loadForTick: async () => ({
        state: { schemaVersion: '1.0.0' },
        commit,
      }),
    },
    marketDataPort,
    resolveProfile: async () => profile,
    auditShipper: { publish },
    metrics: { record, forget: vi.fn() },
    claimOverrideAction,
    findActiveOverride,
    settleOverrideAction,
    markOverridePickedUp,
    ...(opts.releaseOverrideClaim ? { releaseOverrideClaim: opts.releaseOverrideClaim } : {}),
    clock,
    ...(opts.persistTimeoutMs === undefined ? {} : { persistTimeoutMs: opts.persistTimeoutMs }),
  } as unknown as TickHandlerDeps;

  const job = {
    data: {
      userId: String(OPERATOR),
      accountId: String(ACCOUNT),
      profileId: String(PROFILE),
      symbol: SYMBOL,
      event: 'tick',
      enqueuedAtMs: 0,
      payload: {},
    } satisfies TickJobData,
  } as unknown as Job<TickJobData>;

  let result: unknown;
  const thrown = await createTickHandler(deps)(job).then(
    (r: unknown) => {
      result = r;
      return undefined as unknown;
    },
    (err: unknown) => err,
  );
  return {
    calls,
    setCalls,
    applyAll,
    claimOverrideAction,
    settleOverrideAction,
    markOverridePickedUp,
    record,
    commit,
    publish,
    thrown,
    result,
  };
};

/**
 * Everything a stood-down tick must NOT have done. `thrown === undefined` alone is
 * true of a perfectly normal tick, so each fail-closed case asserts the whole shape:
 * a skip result rather than a worked one, no dispatch, no state commit, no audit, and
 * no pick-up breadcrumb. The breadcrumb is the direct evidence for the gate sitting
 * ahead of `markOrderAttempted()` — it is that marker which starts the stamp — and
 * therefore for compensation still seeing `orderAttempted === false`.
 */
const expectStoodDown = (r: RunResult): void => {
  expect(r.thrown).toBeUndefined();
  expect(r.result).toMatchObject({
    profileId: PROFILE,
    symbol: SYMBOL,
    decisionCount: 0,
    throttled: true,
  });
  expect(r.applyAll).not.toHaveBeenCalled();
  expect(r.commit).not.toHaveBeenCalled();
  expect(r.publish).not.toHaveBeenCalled();
  expect(r.markOverridePickedUp).not.toHaveBeenCalled();
  // The counter is the ONLY numeric trace this skip leaves anywhere, so it is part of
  // the shape rather than a separate nicety.
  expect(r.record).toHaveBeenCalledWith(
    'tick_throttled_override_claim',
    1,
    expect.objectContaining({ profileId: PROFILE, symbol: SYMBOL }),
  );
};

// The handler also SETs its tick-meta blob and the order re-arm flag, so only writes
// to the override key count as a re-arm.
const rearmCalls = (setCalls: unknown[][]): unknown[][] =>
  setCalls.filter((argv) => argv[0] === OVERRIDE_KEY);

describe('tick handler — the override row must be claimed before anything is dispatched', () => {
  it('claims the row before the executor can dispatch, and blocks on it', async () => {
    // Held open by a gate rather than a sleep: the dispatch must not merely be
    // slower than the claim, it must be BLOCKED on it. The claim records both entry
    // and settlement, so a fire-and-forget claim (or one moved below `applyAll`)
    // leaves 'applyAll' ahead of 'claim:settled'. Asserting both were merely called
    // would pass for either arrangement, and a claim resolved after the order is on
    // the wire protects nothing.
    const calls: string[] = [];
    let release: () => void = () => undefined;
    const gate = new Promise<void>((resolve) => {
      release = resolve;
    });
    // Generous deadline: the persist budget firing would let the dispatch through
    // for a reason other than the one under test.
    const pending = run({
      calls,
      persistTimeoutMs: 5_000,
      claimOverrideAction: async () => {
        calls.push('claim:entered');
        await gate;
        calls.push('claim:settled');
        return true;
      },
    });

    // The tick is now parked on the unresolved claim. Nothing may have dispatched.
    await vi.waitFor(() => expect(calls).toContain('claim:entered'));
    expect(calls).not.toContain('applyAll');

    release();
    const { claimOverrideAction, applyAll } = await pending;

    expect(claimOverrideAction).toHaveBeenCalledTimes(1);
    // The stamp is the caller's, not the database's, because the release is fenced on
    // it and has to be known even when this call's reply never arrives.
    expect(claimOverrideAction).toHaveBeenCalledWith(
      SCOPE,
      OVERRIDE_ACTION_ID,
      expect.any(Date) as unknown as Date,
    );
    expect(applyAll).toHaveBeenCalledTimes(1);
    expect(calls.indexOf('claim:settled')).toBeLessThan(calls.indexOf('applyAll'));
  });

  it('skips the whole tick and dispatches nothing when the claim returns false', async () => {
    // False means the operator's cancel already won the CAS. Dispatching now would
    // place an order they were told was cancelled.
    const r = await run({ claimOverrideAction: async () => false });

    // A skip, not a DLQ: nothing went wrong, this tick simply lost the race.
    expect(r.thrown).toBeUndefined();
    expect(r.applyAll).not.toHaveBeenCalled();
    expectStoodDown(r);
  });

  it('dispatches nothing when the claim itself throws', async () => {
    // An unreachable Postgres leaves the claim unproven, and an unproven claim means
    // the cancel route's delete guard is not holding. Fail closed.
    const r = await run({
      claimOverrideAction: async () => {
        throw new Error('pg exploded');
      },
    });

    expect(r.thrown).toBeUndefined();
    expect(r.applyAll).not.toHaveBeenCalled();
    expectStoodDown(r);
  });

  it('dispatches nothing when the claim stalls past the persist deadline', async () => {
    // A wedged Postgres must cost the tick its deadline and then the tick, not the
    // dispatch: waiting forever would hold the per-symbol chain lock, and proceeding
    // on the timeout would dispatch under a claim that never landed.
    const r = await run({
      persistTimeoutMs: 20,
      claimOverrideAction: () => new Promise<boolean>(() => undefined),
    });

    expect(r.thrown).toBeUndefined();
    expect(r.applyAll).not.toHaveBeenCalled();
    expectStoodDown(r);
  });

  it('stands down without re-arm or outcome when the row is gone', async () => {
    // The operator cancelled and was answered. Re-arming would resurrect a revoked
    // force-sell; recording an outcome would attach a verdict to a row that no
    // longer exists and that the operator already considers closed.
    const { applyAll, setCalls, settleOverrideAction } = await run({
      claimOverrideAction: async () => false,
      activeOverride: 'gone',
    });

    expect(applyAll).not.toHaveBeenCalled();
    expect(rearmCalls(setCalls)).toHaveLength(0);
    expect(settleOverrideAction).not.toHaveBeenCalled();
  });

  it('re-arms for the remaining window when the claim is lost but the row is live', async () => {
    // Lost the claim, yet the operator's row is still pending: something else holds
    // it (a stale `processing_at` from a dead worker, a concurrent consumer). Their
    // intent stands, so hand it to the next tick instead of dropping it — but on
    // what is LEFT of their original window, never a fresh one.
    const { applyAll, setCalls, settleOverrideAction } = await run({
      claimOverrideAction: async () => false,
      activeOverride: 'live',
    });

    expect(applyAll).not.toHaveBeenCalled();
    const rearms = rearmCalls(setCalls);
    expect(rearms).toHaveLength(1);
    expect(rearms[0]?.[1]).toBe(JSON.stringify(OVERRIDE));
    expect(rearms[0]?.[2]).toBe('PX');
    expect(typeof rearms[0]?.[3]).toBe('number');
    expect(rearms[0]?.[3] as number).toBeGreaterThan(0);
    // Strictly less than the full TTL: the stepping clock proves this tick's own
    // latency was charged against the operator's deadline.
    expect(rearms[0]?.[3] as number).toBeLessThan(OVERRIDE_TTL_MS);
    // NX yields to a newer override the operator pushed while this tick was losing.
    expect(rearms[0]?.[4]).toBe('NX');
    // Re-armed means unresolved, so a verdict now would be a lie about a retry that
    // has not happened yet.
    expect(settleOverrideAction).not.toHaveBeenCalled();
  });

  it('settles a claimed override tick exactly once', async () => {
    // At-most-once guard on the gate itself: a claim added ahead of the dispatch must
    // not block, duplicate, or replace the settle. `settle` carries no
    // `processing_at` predicate, so a claimed row settles like any other.
    const { applyAll, claimOverrideAction, settleOverrideAction, setCalls, thrown } = await run();

    expect(thrown).toBeUndefined();
    expect(claimOverrideAction).toHaveBeenCalledTimes(1);
    expect(applyAll).toHaveBeenCalledTimes(1);
    expect(settleOverrideAction).toHaveBeenCalledTimes(1);
    expect(settleOverrideAction.mock.calls[0]?.[1]).toBe(OVERRIDE_ACTION_ID);
    expect(rearmCalls(setCalls)).toHaveLength(0);
  });

  it('releases the claim, fenced on its own stamp, when a retriable failure re-arms', async () => {
    // The success path's own re-arm branch. Every other release assertion is one level
    // down against `settleOverride`, so the handler could stop forwarding
    // `releaseOverrideClaim` + `claimAt` and the suite would stay green — while the next
    // tick found the row still claimed, unable to take the override it was just handed
    // back, and the operator's cancel got a 409 for a dispatch nobody is running.
    const releaseOverrideClaim = vi.fn<ReleaseOverrideClaim>(async () => undefined);
    const { claimOverrideAction, setCalls, thrown } = await run({
      releaseOverrideClaim,
      // Provably never executed and transient, which is the exact re-arm condition.
      orderResult: { ok: false, retryable: true, phase: 'pre-call', reason: 'weight exhausted' },
    });

    expect(thrown).toBeUndefined();
    expect(rearmCalls(setCalls)).toHaveLength(1);
    const claimAt = claimOverrideAction.mock.calls[0]?.[2];
    expect(claimAt).toBeInstanceOf(Date);
    // The SAME stamp the claim was made with: an unfenced release could strip a later
    // tick's live claim off its dispatch.
    expect(releaseOverrideClaim).toHaveBeenCalledWith(SCOPE, OVERRIDE_ACTION_ID, claimAt);
  });
});
