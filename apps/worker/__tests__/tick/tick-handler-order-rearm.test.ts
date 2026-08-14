// A failed order that the bot COULD have placed must not be silently forgotten.
//
// The strategy is the thing that decides to place an order, and it decides from
// its state. So if the order fails and the tick commits `nextState` anyway, the
// strategy now believes the order exists: a stop it "armed" is never re-emitted,
// and the position sits unguarded until the loss lands. There is no replay queue
// to fall back on — the tick job carries no `attempts`, so nothing re-runs it.
//
// The retry is therefore the ABSENCE of a commit: leaving the state un-advanced
// makes the next tick recompute from fresh market data and re-emit the order
// itself. That is also why a replay queue would be wrong — a replayed order is a
// stale-priced order.
//
// Which failures qualify is the `phase` x `retryable` question the executor
// answers: safe to re-issue (`pre-call` / `rejected` — the order provably never
// executed) AND worth re-issuing (`retryable` — the cause clears). An `ambiguous`
// or `accepted` failure may be live on the exchange, so the state MUST advance
// and the order must never be re-issued.

import { describe, expect, it, vi } from 'vitest';
import type { Job } from 'bullmq';
import type { MarketDataPort } from '@app/binance';
import { createRegistry, type Decision, type Strategy, type SymbolInfo } from '@app/strategy-core';
import { z } from 'zod';
import { asAccountId, asProfileId, asUserId } from '@app/contracts';

// The blocker audit resolves its condition writer off the scope. Mock the
// binding so a test can read exactly which conditions a withheld-commit tick
// wrote, without a real Postgres.
const recordSpy = vi.fn(async (_input: { condition: string; code: string | null }) => ({
  changed: true as const,
  previousCode: null,
  sinceMs: 0,
}));
vi.mock('@app/db', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@app/db')>();
  return {
    ...actual,
    profileRepoFromScope: () => ({ conditionStates: { recordCondition: recordSpy } }),
  };
});

import { createChainByKey } from '../../src/lib/chain-by-key.js';
import { buildProfileTickMetaKey } from '../../src/executor/redis-namespace.js';
import { createTickHandler, type TickHandlerDeps } from '../../src/tick/tick-handler.js';
import type { ProfileTickContext } from '../../src/tick/build-tick-input.js';
import type { TickJobData } from '../../src/queues/job-payloads.js';
import type { AuditEntry } from '../../src/audit-shipper/audit-shipper.js';

const OPERATOR = asUserId('11111111-1111-4111-8111-111111111111');
const ACCOUNT = asAccountId('33333333-3333-4333-8333-333333333333');
const PROFILE = asProfileId('22222222-2222-4222-8222-222222222222');
const SYMBOL = 'BTCUSDT';
const REARM_KEY = `order-rearm:${PROFILE}:${SYMBOL}`;
// The re-arm flag and the tick-meta stamp share one `set` stub, so every assertion
// below filters by key. Derived through the same builder `src` uses, so a namespace
// change moves both together instead of silently targeting a key nothing writes.
const META_KEY = buildProfileTickMetaKey(ACCOUNT, PROFILE);

const SYMBOL_INFO: SymbolInfo = {
  symbol: SYMBOL,
  baseAsset: 'BTC',
  quoteAsset: 'USDT',
  filters: { minQty: '0.00001', stepSize: '0.00001', minNotional: '10', tickSize: '0.01' },
};

type OrderFailure = {
  readonly ok: false;
  readonly retryable: boolean;
  readonly phase: 'pre-call' | 'rejected' | 'ambiguous' | 'accepted';
  readonly reason: string;
  /** Withheld by the order-rate governor rather than attempted and failed. */
  readonly deferred?: true;
};
type OrderResult = { readonly ok: true } | OrderFailure;

const STOP: Decision = {
  type: 'place-order',
  intent: {
    symbol: SYMBOL,
    side: 'SELL',
    reason: 'stop-loss',
    clientOrderId: 'cid-stop',
  },
  params: { type: 'STOP_LOSS_LIMIT', price: '100', stopPrice: '101', quantity: '1' },
};

/** The state the strategy WOULD advance to. Committing it is what buries a failed order. */
const NEXT_STATE = { schemaVersion: '1.0.0', stopArmed: true };

const buildStubStrategy = (decisions: readonly Decision[], nextState: unknown): Strategy =>
  ({
    name: 'stub-rearm',
    version: '1.0.0',
    displayName: 'stub',
    description: 'stub',
    capabilities: {
      candleIntervals: ['1h'],
      needsUserDataStream: false,
      needsMiniTicker: false,
      bundleProviders: [],
      operatorActions: [],
    },
    // Permissive: the tick boundary now parses the bundle before tick(), and a
    // stub must satisfy the required contract field without constraining shape.
    bundleSchema: z.object({}),
    initialState: () => ({ schemaVersion: '1.0.0' }),
    tick: () => ({ nextState, decisions, logs: [], metrics: [] }),
  }) as unknown as Strategy;

/** The result `applyAll` stamps on a decision behind a broken chain. Nothing was sent. */
const SKIPPED: OrderFailure = {
  ok: false,
  retryable: true,
  phase: 'pre-call',
  reason: 'skipped: an earlier order in this tick failed',
};

/** The payload the real dep declares, so an override can assert on it. */
type NotifyOrderFailedInput = Parameters<NonNullable<TickHandlerDeps['notifyOrderFailed']>>[0];

/**
 * Throws rather than returning undefined, because `expect` inside `vi.waitFor` does
 * not narrow, which would force an optional access on a value `waitFor` has already
 * guaranteed. The message lists what WAS logged, so a needle typo reads as a typo.
 */
const findWarn = (warnings: readonly { ctx: unknown; msg: string }[], needle: string) => {
  const warn = warnings.find((w) => w.msg.includes(needle));
  if (!warn) throw new Error(`no warn matching "${needle}" in [${warnings.map((w) => w.msg)}]`);
  return warn;
};

const waitForWarn = (warnings: readonly { ctx: unknown; msg: string }[], needle: string) =>
  vi.waitFor(() => findWarn(warnings, needle));

interface RunOpts {
  readonly decisions?: readonly Decision[];
  readonly orderResult: OrderResult;
  /** When set, the cancel fails and the placement behind it is SKIPPED (chain break). */
  readonly cancelResult?: OrderResult;
  /** A re-arm flag already set by an earlier tick (this tick is the retry). */
  readonly rearmFlagSet?: boolean;
  /** Replaces the default notify stub so a test can make the operator alert fail. */
  readonly notifyOrderFailed?: (input: NotifyOrderFailedInput) => unknown;
  /** Replaces the reply of `redis.set` so a test can break one key's write. */
  readonly redisSet?: (...argv: unknown[]) => unknown;
  /** Replaces the reply of `redis.del` so a test can break the re-arm clear. */
  readonly redisDel?: (key: string) => unknown;
  /** Replaces the tick clock so a test can throw from inside a payload build. */
  readonly clock?: { readonly nowMs: () => number };
  /** The body the strategy would advance to, for the blocker fields it carries. */
  readonly nextState?: unknown;
}

const run = async (opts: RunOpts) => {
  const decisions = opts.decisions ?? [STOP];
  recordSpy.mockClear();
  const setCalls: unknown[][] = [];
  const delCalls: string[] = [];
  const commit = vi.fn(async () => undefined);
  const audits: AuditEntry[] = [];
  const warnings: { ctx: unknown; msg: string }[] = [];
  // Delegates so the spy `run()` returns is the one actually injected: returning a
  // different stub would let a future override's assertions pass vacuously.
  // MUST NOT be async — an async wrapper would turn an override's SYNCHRONOUS throw
  // into a rejection, which is precisely the defect the sync-throw test reproduces.
  const notifyOrderFailed = vi.fn((input: NotifyOrderFailedInput) =>
    opts.notifyOrderFailed ? opts.notifyOrderFailed(input) : Promise.resolve(undefined),
  );
  // Same MUST-NOT-be-async constraint as above: an async wrapper would convert an
  // override's synchronous throw into a rejection, which is the one shape the
  // deadline helper already handles. The argument is recorded before delegating so a
  // throwing override still proves the call happened.
  const redisSet = (...argv: unknown[]): unknown => {
    setCalls.push(argv);
    return opts.redisSet ? opts.redisSet(...argv) : Promise.resolve('OK');
  };
  const redisDel = (key: string): unknown => {
    delCalls.push(key);
    return opts.redisDel ? opts.redisDel(key) : Promise.resolve(1);
  };

  // Key-aware, because the re-arm flag now rides the tick's opening snapshot
  // pipeline rather than a standalone GET: the stub has to answer per key, not
  // per anonymous slot, for the reply to land in the right field.
  const makeChain = (keys: string[]) => {
    const chain = {
      get(key: string) {
        keys.push(key);
        return chain;
      },
      exec: async () =>
        keys.map((k) =>
          opts.rearmFlagSet === true && k === REARM_KEY
            ? ([null, '1'] as const)
            : ([null, null] as const),
        ),
    };
    return chain;
  };
  const redis = {
    pipeline: () => makeChain([]),
    exists: async () => 0,
    // The re-arm flag rides the snapshot pipeline now, so nothing on this path
    // should reach a standalone GET. Fail loudly if a read path reappears.
    get: async (key: string) => {
      throw new Error(`unexpected standalone GET on the tick path: ${key}`);
    },
    set: redisSet,
    del: redisDel,
  } as unknown as import('ioredis').Redis;

  const registry = createRegistry();
  registry.register(buildStubStrategy(decisions, opts.nextState ?? NEXT_STATE));

  const profile = {
    operatorId: OPERATOR,
    accountId: ACCOUNT,
    profileId: PROFILE,
    scope: { operatorId: OPERATOR, accountId: ACCOUNT, profileId: PROFILE },
    symbol: SYMBOL,
    strategyName: 'stub-rearm',
    strategyVersion: '1.0.0',
    config: {},
    bundleProvider: async () => ({ bundle: {} }),
    binanceMode: 'test',
    quoteAsset: 'USDT',
    weightLimit1m: 1200,
    candleInterval: '1h',
    technicalsConfig: { useOnlyWithinMin: 2, ifExpires: 'do-not-buy', intervals: [] },
    needsAccountDeployedQuote: false,
    reserveBaseQuantity: null,
  } as unknown as ProfileTickContext;

  const deps = {
    redis,
    registry,
    executor: {
      // Mirrors the real `applyAll`: any failed ORDER decision breaks the chain and
      // every decision behind it is stamped SKIPPED (never transmitted).
      applyAll: async (_ctx: unknown, _accountId: unknown, ds: readonly unknown[]) => {
        let broken = false;
        return ds.map((decision) => {
          const type = (decision as { type: string }).type;
          if (broken) return { decision, result: SKIPPED };
          const result: OrderResult =
            type === 'place-order'
              ? opts.orderResult
              : type === 'cancel-order'
                ? (opts.cancelResult ?? { ok: true })
                : { ok: true };
          if (result.ok === false && (type === 'place-order' || type === 'cancel-order')) {
            broken = true;
          }
          return { decision, result };
        });
      },
    },
    chain: createChainByKey(),
    logger: {
      debug: () => undefined,
      info: () => undefined,
      warn: (ctx: unknown, msg: string) => {
        warnings.push({ ctx, msg });
      },
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
      loadForTick: async () => ({ state: { schemaVersion: '1.0.0' }, commit }),
    },
    marketDataPort: { loadWindow: async () => [] } as unknown as MarketDataPort,
    resolveProfile: async () => profile,
    auditShipper: {
      publish: async (entry: AuditEntry) => {
        audits.push(entry);
      },
    },
    notifyOrderFailed,
    ...(opts.clock ? { clock: opts.clock } : {}),
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

  const result = await createTickHandler(deps)(job);

  const rearms = setCalls.filter((c) => c[0] === REARM_KEY);
  const auditPayload = (audits[0]?.payload ?? {}) as {
    rearmed?: boolean;
    results?: { type: string; ok: boolean; reason?: string; phase?: string; retryable?: boolean }[];
  };
  const metaWrites = setCalls.filter((c) => c[0] === META_KEY);
  return {
    commit,
    rearms,
    delCalls,
    metaWrites,
    notifyOrderFailed,
    auditPayload,
    warnings,
    result,
    recordedConditions: recordSpy.mock.calls.map((c) => c[0]),
  };
};

describe('tick handler — a failed order is re-issued by NOT advancing the state', () => {
  it('does not commit the state when a recoverable order failure means the next tick must re-issue', async () => {
    // Refused before any Binance call, for a cause that clears (the weight
    // throttle). Committing here would leave the strategy believing its stop is
    // armed when nothing was ever sent.
    const { commit, rearms } = await run({
      orderResult: {
        ok: false,
        retryable: true,
        phase: 'pre-call',
        reason: 'weight-limit-throttle',
      },
    });
    expect(commit).not.toHaveBeenCalled();
    expect(rearms).toHaveLength(1);
    // NX so a flag another tick already set is not extended forever.
    expect(rearms[0]).toEqual([REARM_KEY, '1', 'PX', expect.any(Number), 'NX']);
  });

  it('re-issues a transient Binance rejection too — a parsed code proves nothing executed', async () => {
    const { commit, rearms } = await run({
      orderResult: {
        ok: false,
        retryable: true,
        phase: 'rejected',
        reason: '-1003 too many requests',
      },
    });
    expect(commit).not.toHaveBeenCalled();
    expect(rearms).toHaveLength(1);
  });

  it('NEVER withholds the commit on an ambiguous failure — the order may be live', async () => {
    // The response never arrived. Re-issuing could double the position, so the
    // state must advance exactly as if the order landed, and nothing re-arms.
    const { commit, rearms } = await run({
      orderResult: { ok: false, retryable: true, phase: 'ambiguous', reason: 'socket hang up' },
    });
    expect(commit).toHaveBeenCalledOnce();
    expect(rearms).toHaveLength(0);
  });

  it('NEVER withholds the commit on an accepted failure — the order IS live', async () => {
    const { commit, rearms } = await run({
      orderResult: { ok: false, retryable: false, phase: 'accepted', reason: 'bookkeeping failed' },
    });
    expect(commit).toHaveBeenCalledOnce();
    expect(rearms).toHaveLength(0);
  });

  it('withholds the commit on a PERMANENT rejection too — retryable is not what makes the state a lie', async () => {
    // -2010 insufficient balance never clears on its own, so nothing useful will
    // come of re-issuing. That does NOT make it safe to commit: `nextState` was
    // computed on the assumption the order landed, and a rejected order provably
    // did not. Momentum's exit is the case that bites — it emits [cancel(stop),
    // MARKET SELL] and a FLAT nextState — so committing here would leave the bot
    // believing it holds nothing while it holds the coin AND its stop is cancelled.
    // Safety turns on `phase` alone; `retryable` only shapes the alert wording.
    const { commit, rearms, notifyOrderFailed } = await run({
      orderResult: {
        ok: false,
        retryable: false,
        phase: 'rejected',
        reason: '-2010 insufficient balance',
      },
    });
    expect(commit).not.toHaveBeenCalled();
    expect(rearms).toHaveLength(1);
    // ...and the operator is still told nothing will re-issue it on its own.
    expect(notifyOrderFailed.mock.calls[0]?.[0]).toMatchObject({ willRetry: false });
  });

  it('withholds the commit when a broken CANCEL skipped the placement — the gate reads the PLACEMENT, not the first failure', async () => {
    // REGRESSION. Momentum's exit emits [cancel(protective stop), MARKET SELL] with a
    // FLAT nextState. The cancel dies on a transport error (`ambiguous` — it may or
    // may not have cleared), the chain breaks, and the SELL is stamped SKIPPED: never
    // transmitted. Reading the FIRST failed order (the cancel) would see `ambiguous`
    // ⇒ "may be live" ⇒ COMMIT — and the bot would record itself flat while the coin
    // is still in the wallet and the stop may still be resting. The question the state
    // hangs on is whether THE PLACEMENT was placed. It was not.
    const CANCEL: Decision = { type: 'cancel-order', orderId: 42, reason: 'replace-stop' };
    const { commit, rearms } = await run({
      decisions: [CANCEL, STOP],
      cancelResult: { ok: false, retryable: true, phase: 'ambiguous', reason: 'socket hang up' },
      // Unused: the SELL never runs. `applyAll` stamps it SKIPPED.
      orderResult: { ok: true },
    });
    expect(commit).not.toHaveBeenCalled();
    expect(rearms).toHaveLength(1);
  });

  it('clears the re-arm flag once every order in the tick lands', async () => {
    const { commit, delCalls } = await run({ orderResult: { ok: true } });
    expect(commit).toHaveBeenCalledOnce();
    expect(delCalls).toContain(REARM_KEY);
  });

  it('does NOT clear the flag while an order is still failing', async () => {
    const { delCalls } = await run({
      orderResult: { ok: false, retryable: false, phase: 'accepted', reason: 'bookkeeping failed' },
    });
    expect(delCalls).not.toContain(REARM_KEY);
  });
});

describe('tick handler — a withheld commit still records OPEN blockers, never a clear', () => {
  /** Provably never executed: the shape that withholds the commit. */
  const WITHHELD: OrderFailure = {
    ok: false,
    retryable: true,
    phase: 'pre-call',
    reason: 'weight-limit-throttle',
  };

  it('records an open protective-stop blocker even though the body was thrown away', async () => {
    // The refusal is a fact about the position regardless of whether the body
    // persisted, and it is what dates the span the persistence alert measures.
    const { commit, recordedConditions } = await run({
      orderResult: WITHHELD,
      nextState: {
        schemaVersion: '1.0.0',
        protectiveStopBlocker: {
          reason: 'price-outside-exchange-band',
          detail: { bound: 'floor', guarded: false, terminal: true },
        },
      },
    });

    expect(commit).not.toHaveBeenCalled();
    expect(recordedConditions).toContainEqual(
      expect.objectContaining({
        condition: 'protective-stop-blocked',
        code: 'price-outside-exchange-band',
      }),
    );
  });

  it('records NO clear when the discarded body nulled the blocker — the position is still held', async () => {
    // REGRESSION. A strategy nulls its blocker fields the moment it emits an
    // exit, before the SELL is known to have landed. When that SELL is deferred
    // or rejected the body is discarded, so writing the clear would delete the
    // condition row and log "protective stop can be placed again" for a coin
    // that is still held with nothing under it.
    const { commit, recordedConditions } = await run({
      orderResult: WITHHELD,
      nextState: {
        schemaVersion: '1.0.0',
        protectiveStopBlocker: null,
        exitBlocker: null,
        entryBlocker: null,
      },
    });

    expect(commit).not.toHaveBeenCalled();
    expect(recordedConditions).not.toContainEqual(
      expect.objectContaining({ condition: 'protective-stop-blocked', code: null }),
    );
  });
});

describe('tick handler — the audit tells the operator why', () => {
  it('stamps rearmed:true when this tick is itself the retry of an earlier failed order', async () => {
    const { auditPayload } = await run({ orderResult: { ok: true }, rearmFlagSet: true });
    expect(auditPayload.rearmed).toBe(true);
  });

  it('omits rearmed on an ordinary tick', async () => {
    const { auditPayload } = await run({ orderResult: { ok: true } });
    expect(auditPayload.rearmed).toBeUndefined();
  });

  it('carries phase AND retryable on every failed decision — the two facts that decide the retry', async () => {
    // Without them the audit cannot explain why the bot did (or did not) re-issue.
    const { auditPayload } = await run({
      orderResult: {
        ok: false,
        retryable: true,
        phase: 'pre-call',
        reason: 'weight-limit-throttle',
      },
    });
    expect(auditPayload.results?.[0]).toEqual({
      type: 'place-order',
      ok: false,
      reason: 'weight-limit-throttle',
      phase: 'pre-call',
      retryable: true,
    });
  });
});

describe('tick handler — the operator is told the order failed', () => {
  it('notifies with willRetry=true when the bot will re-issue it', async () => {
    const { notifyOrderFailed } = await run({
      orderResult: {
        ok: false,
        retryable: true,
        phase: 'pre-call',
        reason: 'weight-limit-throttle',
      },
    });
    expect(notifyOrderFailed).toHaveBeenCalledOnce();
    expect(notifyOrderFailed.mock.calls[0]?.[0]).toMatchObject({
      symbol: SYMBOL,
      decisionType: 'place-order',
      willRetry: true,
    });
  });

  it('notifies with willRetry=false when nothing will re-issue it — the position may be unguarded', async () => {
    const { notifyOrderFailed } = await run({
      orderResult: {
        ok: false,
        retryable: false,
        phase: 'rejected',
        reason: '-2010 insufficient balance',
      },
    });
    expect(notifyOrderFailed.mock.calls[0]?.[0]).toMatchObject({ willRetry: false });
  });

  it('stays quiet when every order lands', async () => {
    const { notifyOrderFailed } = await run({ orderResult: { ok: true } });
    expect(notifyOrderFailed).not.toHaveBeenCalled();
  });

  // A shed is the feature's designed steady state under a saturated order budget,
  // and it recurs every tick for as long as the budget stays saturated. Alerting
  // on it would bury the real order failures this channel exists to carry — and
  // it fails the same way (`ok:false`, `phase:'pre-call'`, retryable) as the
  // genuine throttle two tests above, so only `deferred` separates them.
  it('stays quiet on a deferred reprice — the resting stop is still protecting', async () => {
    const { notifyOrderFailed, commit } = await run({
      orderResult: {
        ok: false,
        retryable: true,
        phase: 'pre-call',
        deferred: true,
        reason: 'deferred: no Binance order-rate headroom',
      },
    });
    expect(notifyOrderFailed).not.toHaveBeenCalled();
    // Still un-committed: the strategy must re-emit the reprice next tick.
    expect(commit).not.toHaveBeenCalled();
  });

  it('resolves and warns when the notify throws synchronously', async () => {
    const boom = new Error('notifier exploded');
    // Deliberately NOT async: the trailing `.catch` only ever receives the promise
    // the dep RETURNED, so a throw raised before that promise exists is the one
    // shape that can escape it, straight out of a tick that already acted.
    const notifyOrderFailed = vi.fn(() => {
      throw boom;
    });

    const outcome = run({
      orderResult: {
        ok: false,
        retryable: true,
        phase: 'pre-call',
        reason: 'weight-limit-throttle',
      },
      notifyOrderFailed,
    });

    await expect(outcome).resolves.toMatchObject({
      result: { profileId: PROFILE, symbol: SYMBOL, decisionCount: 1, throttled: false },
    });

    const { warnings } = await outcome;
    // Fire-and-forget, so the warn lands independently of the tick's own return.
    // Poll for it rather than draining a fixed number of microtasks, which would
    // couple the assertion to the wrapper's internal scheduling.
    const failed = await waitForWarn(warnings, 'could not notify the operator');
    expect(failed.ctx).toMatchObject({ err: boom });
    expect(notifyOrderFailed).toHaveBeenCalledOnce();
  });

  it('resolves and warns when the notify rejects', async () => {
    // The sync throw above and this rejection reach the SAME handler, so both are
    // pinned: with only one asserted, a regression on the other hides behind it.
    const boom = new Error('notifier rejected');
    const notifyOrderFailed = vi.fn(() => Promise.reject(boom));

    const outcome = run({
      orderResult: {
        ok: false,
        retryable: true,
        phase: 'pre-call',
        reason: 'weight-limit-throttle',
      },
      notifyOrderFailed,
    });

    await expect(outcome).resolves.toMatchObject({
      result: { profileId: PROFILE, symbol: SYMBOL, decisionCount: 1, throttled: false },
    });

    const { warnings } = await outcome;
    const failed = await waitForWarn(warnings, 'could not notify the operator');
    expect(failed.ctx).toMatchObject({ err: boom });
    expect(notifyOrderFailed).toHaveBeenCalledOnce();
  });

  it('does not wait on the notify — a hung notifier must not hold the tick', async () => {
    // A notify that never settles is the ONLY shape that separates fire-and-forget
    // from `await`: every other stub settles immediately, so awaiting the call
    // would leave the rest of this suite green while the tick holds the
    // per-(profile, symbol) chain lock across a Postgres + N-webhook fan-out.
    const notifyOrderFailed = vi.fn(() => new Promise<void>(() => {}));

    await expect(
      run({
        orderResult: {
          ok: false,
          retryable: true,
          phase: 'pre-call',
          reason: 'weight-limit-throttle',
        },
        notifyOrderFailed,
      }),
    ).resolves.toMatchObject({
      result: { profileId: PROFILE, symbol: SYMBOL, decisionCount: 1, throttled: false },
    });

    expect(notifyOrderFailed).toHaveBeenCalledOnce();
  }, 2_000); // An awaited notify never returns, so fail fast instead of stalling CI.
});

describe('tick handler — a broken best-effort Redis write never fails the tick', () => {
  // The re-arm flag and the tick-meta stamp are both VISIBILITY, never correctness:
  // the retry itself is the withheld commit, and tick-meta only feeds a dashboard
  // chip. Both are deadline-bounded for that reason. But the bound only covers the
  // promise the client RETURNS, so an `ioredis` client that throws before returning
  // one (a closed connection, an argument the command builder refuses) escapes the
  // guard entirely and fails a tick that has already placed or cancelled orders.
  // Every case below therefore asserts the tick's NORMAL return value, not just that
  // it settled, plus the warn that proves the failure was seen rather than swallowed.

  /** Provably never executed and worth re-issuing: the shape that arms the re-arm flag. */
  const RETRYABLE_FAILURE: OrderFailure = {
    ok: false,
    retryable: true,
    phase: 'pre-call',
    reason: 'weight-limit-throttle',
  };

  const NORMAL_RETURN = { profileId: PROFILE, symbol: SYMBOL, throttled: false };

  it('resolves and warns when the re-arm SET throws synchronously', async () => {
    const boom = new Error('SET exploded before returning a promise');
    // Scoped to the re-arm key: the tick-meta stamp rides the SAME stub, and breaking
    // both would leave it ambiguous which write the warn came from.
    const { result, warnings, rearms } = await run({
      orderResult: RETRYABLE_FAILURE,
      redisSet: (...argv: unknown[]) => {
        if (argv[0] === REARM_KEY) throw boom;
        return Promise.resolve('OK');
      },
    });

    expect(result).toMatchObject(NORMAL_RETURN);
    expect(rearms).toHaveLength(1);
    expect(findWarn(warnings, 'could not flag the order re-arm').ctx).toMatchObject({ err: boom });
  });

  it('resolves and warns when the re-arm SET rejects', async () => {
    const boom = new Error('SET rejected');
    const { result, warnings } = await run({
      orderResult: RETRYABLE_FAILURE,
      redisSet: (...argv: unknown[]) =>
        argv[0] === REARM_KEY ? Promise.reject(boom) : Promise.resolve('OK'),
    });

    expect(result).toMatchObject(NORMAL_RETURN);
    expect(findWarn(warnings, 'could not flag the order re-arm').ctx).toMatchObject({ err: boom });
  });

  it('resolves and warns when the re-arm DEL throws synchronously', async () => {
    const boom = new Error('DEL exploded before returning a promise');
    // Every order landed, so this tick takes the CLEAR path, not the arm path.
    const { result, warnings, delCalls } = await run({
      orderResult: { ok: true },
      redisDel: () => {
        throw boom;
      },
    });

    expect(result).toMatchObject(NORMAL_RETURN);
    expect(delCalls).toContain(REARM_KEY);
    expect(findWarn(warnings, 'could not clear the order re-arm flag').ctx).toMatchObject({
      err: boom,
    });
  });

  it('resolves and warns when the re-arm DEL rejects', async () => {
    const boom = new Error('DEL rejected');
    const { result, warnings } = await run({
      orderResult: { ok: true },
      redisDel: () => Promise.reject(boom),
    });

    expect(result).toMatchObject(NORMAL_RETURN);
    expect(findWarn(warnings, 'could not clear the order re-arm flag').ctx).toMatchObject({
      err: boom,
    });
  });

  it('resolves and warns when the tick-meta SET throws synchronously', async () => {
    const boom = new Error('SET exploded before returning a promise');
    const { result, warnings, metaWrites } = await run({
      orderResult: { ok: true },
      redisSet: (...argv: unknown[]) => {
        if (argv[0] === META_KEY) throw boom;
        return Promise.resolve('OK');
      },
    });

    expect(result).toMatchObject(NORMAL_RETURN);
    expect(metaWrites).toHaveLength(1);
    // Fire-and-forget on the success path, so the warn lands independently of the
    // tick's own return. Polling beats draining a fixed number of microtasks, which
    // would couple the assertion to the helper's internal scheduling.
    const warn = await waitForWarn(warnings, 'stampTickMeta failed');
    expect(warn.ctx).toMatchObject({ err: boom });
  });

  it('resolves and warns when the tick-meta SET rejects', async () => {
    const boom = new Error('SET rejected');
    const { result, warnings } = await run({
      orderResult: { ok: true },
      redisSet: (...argv: unknown[]) =>
        argv[0] === META_KEY ? Promise.reject(boom) : Promise.resolve('OK'),
    });

    expect(result).toMatchObject(NORMAL_RETURN);
    const warn = await waitForWarn(warnings, 'stampTickMeta failed');
    expect(warn.ctx).toMatchObject({ err: boom });
  });

  it('does not wait on the tick-meta write', async () => {
    // A stamp that never settles is the ONLY shape separating fire-and-forget from
    // `await` on the success path. FAKE timers are load-bearing: the stamp carries a
    // ~100ms deadline, so under real timers an accidental `await` still resolves when
    // that deadline fires and this test would pass while the tick held the
    // per-(profile, symbol) chain lock for the full 100ms.
    vi.useFakeTimers();
    try {
      const { result, metaWrites } = await run({
        orderResult: { ok: true },
        redisSet: (...argv: unknown[]) =>
          argv[0] === META_KEY ? new Promise<'OK'>(() => {}) : Promise.resolve('OK'),
      });

      expect(result).toMatchObject(NORMAL_RETURN);
      // Without this the never-settling branch might simply never be reached, and a
      // tick that skipped the stamp entirely would look identical.
      expect(metaWrites).toHaveLength(1);
    } finally {
      vi.useRealTimers();
    }
  }, 2_000); // An awaited stamp never returns, so fail fast instead of stalling CI.

  it('routes a payload-build throw to the same handler', async () => {
    // The stamp is not just a `redis.set` call: it reads the clock, formats an ISO
    // timestamp, serialises JSON and builds the key. All of that must sit INSIDE the
    // guard, so the assertion breaks the clock rather than the client.
    //
    // The clock is read many times before the stamp, and hard-coding the stamp's index
    // would rot on any reordering, so the count comes from a clean probe tick. The
    // stamp is the last read: `compensate()` returns before touching `elapsedMs` when
    // no override was armed.
    let probeReads = 0;
    await run({
      orderResult: { ok: true },
      clock: {
        nowMs: () => {
          probeReads += 1;
          return 0;
        },
      },
    });
    expect(probeReads).toBeGreaterThan(0);

    const boom = new Error('clock read exploded');
    let reads = 0;
    const { result, warnings, metaWrites } = await run({
      orderResult: { ok: true },
      clock: {
        nowMs: () => {
          reads += 1;
          if (reads === probeReads) throw boom;
          return 0;
        },
      },
    });

    expect(result).toMatchObject(NORMAL_RETURN);
    // Proves the throwing read was actually reached. A reordering that leaves the
    // count short would otherwise run a clean tick and pass for the wrong reason.
    expect(reads).toBe(probeReads);
    // ...and that the throw pre-empted the write rather than following it.
    expect(metaWrites).toHaveLength(0);
    const warn = await waitForWarn(warnings, 'stampTickMeta failed');
    expect(warn.ctx).toMatchObject({ err: boom });
  });
});
