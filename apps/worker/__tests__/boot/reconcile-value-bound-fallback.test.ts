// Where the boot sweep's dust VALUE bounds get their price from, and what happens when they cannot get one.
//
// The bounds only ever REMOVE a position, so a missing price disarms them rather than guessing. That rule is right and stays. What is wrong is the only source: the miniTicker cache key carries a 60s TTL and is written by the live market stream alone, so at cold boot — the exact moment this sweep runs — it is empty for every symbol. The bounds are therefore disarmed on the pass that matters most, which is how a sub-notional residue survives a restart and gets re-seeded as a position no sell can close.
//
// A disarmed bound is also silent today: the sweep reports the same no-op it would report for a healthy converged position, so nothing distinguishes "checked, and the holding is real" from "could not check".

import { describe, expect, it, vi } from 'vitest';
import type { Logger } from 'pino';
import type { Redis } from 'ioredis';
import type { AccountId, ProfileId, UserId } from '@app/contracts';
import { BinanceApiError } from '@app/binance';

const repoMocks = vi.hoisted(() => ({
  profileFindById: vi.fn(),
  avgEntryPricesFindBySymbol: vi.fn(),
  avgEntryPricesRemove: vi.fn(),
  avgEntryPricesUpsert: vi.fn(),
  symbolStatesFindBySymbol: vi.fn(),
  profileSymbolsListForProfile: vi.fn(),
  binanceModeById: vi.fn(),
}));

vi.mock('@app/db', async (importOriginal) => {
  const orig = await importOriginal<typeof import('@app/db')>();
  return {
    ...orig,
    profileRepo: vi.fn(
      async (_db: unknown, operatorId: UserId, accountId: AccountId, profileId: ProfileId) => ({
        scope: { userId: operatorId, accountId, profileId },
        profile: { findById: repoMocks.profileFindById },
        avgEntryPrices: {
          findBySymbol: repoMocks.avgEntryPricesFindBySymbol,
          remove: repoMocks.avgEntryPricesRemove,
          upsert: repoMocks.avgEntryPricesUpsert,
        },
        symbolStates: { findBySymbol: repoMocks.symbolStatesFindBySymbol },
        profileSymbols: { listForProfile: repoMocks.profileSymbolsListForProfile },
      }),
    ),
    repo: {
      ...orig.repo,
      accounts: { ...orig.repo.accounts, binanceModeById: repoMocks.binanceModeById },
    },
  };
});

import { GLOBAL_KEYS } from '@app/db';
import { createMetricsRegistry } from '@app/observability';
import { createWorkerMetricsSink } from '../../src/boot/metrics-sink.js';
import {
  runHeldQuantityReconciliation,
  valueBoundDisarmReason,
  type ReconcileOrchestratorDeps,
} from '../../src/boot/reconcile-held-quantity.js';
import { buildSymbolInfoKey } from '../../src/executor/redis-namespace.js';
import { createChainByKey } from '../../src/lib/chain-by-key.js';
import type { SymbolStateStrategyShape } from '../../src/state/version-aware-mutate.js';
import { trailingTradePositionAdapter } from '@app/strategy-trailing-trade';

const USER_ID = 'u1' as unknown as UserId;
const ACCOUNT_ID = 'a1' as unknown as AccountId;
const PROFILE_ID = 'p1' as unknown as ProfileId;
const SYMBOL = 'ENAUSDT';

// The live strand's own numbers: a holding one LOT_SIZE step wide and worth a fraction of one minimum order.
const WALLET_QTY = '0.01184';
const STEP_SIZE = '0.01';
const MIN_NOTIONAL = '5';
// 0.01184 x 0.1094 = 0.0013 quote, far under the 5 floor.
const DUST_PRICE = '0.1094';
// 0.01184 x 5000 = 59.2 quote, comfortably over it. The bound is consulted and PASSES.
const REAL_PRICE = '5000';

/** A current-schema TT body carrying a priced position, so the cost-basis step short-circuits and the reconciler is the only thing under test. */
const heldBody = (): Record<string, unknown> => ({
  schemaVersion: '2.0.0',
  avgEntryPrice: '0.5',
  heldQuantity: WALLET_QTY,
  triggers: { override: null },
  highSinceBuy: null,
  currentGridTradeIndex: null,
  autoTriggerBuyAtMs: null,
  disabledUntilMs: null,
});

/** In-memory redis for `mutateSymbolState`'s own cache reconciliation; kept separate from the sweep's read stub so a test's key expectations stay readable. */
const stateRedis = (): Redis => {
  const store = new Map<string, string>();
  return {
    get: vi.fn(async (k: string) => store.get(k) ?? null),
    set: vi.fn(async (k: string, v: string) => {
      store.set(k, v);
      return 'OK';
    }),
    del: vi.fn(async (k: string) => {
      store.delete(k);
      return 1;
    }),
  } as unknown as Redis;
};

interface Harness {
  deps: ReconcileOrchestratorDeps;
  getPriceTickers: ReturnType<typeof vi.fn>;
  records: { name: string; value: number; tags: Record<string, string> | undefined }[];
  warns: { ctx: Record<string, unknown>; msg: string }[];
}

/**
 * One profile, one symbol, wallet holding sub-notional residue that the strategy state also claims.
 *
 * @param opts.cachedPrice - Price to seed the miniTicker key the sweep reads first, or null to leave the cache cold so the REST fallback is the only source.
 * @param opts.priceTickers - What the REST fallback resolves to: a row list, an Error it rejects with, or a function of the requested symbols so a case can fail the batch and answer the per-symbol retry differently. Omitted means an empty answer, i.e. the exchange knows the symbol but priced nothing.
 * @param opts.walletQuantity - Free base-asset balance Binance reports, defaulting to the strand's own residue. '0' makes the wallet empty without removing the balance row.
 * @param opts.stateBody - The durable strategy body the pass starts from, defaulting to a priced position claiming the whole residue.
 * @param opts.ledgerRow - Tri-state, and the distinction matters: OMITTED installs the default cost-basis row so a flatten has something to delete, `null` means no ledger row exists at all, and an object installs that specific row.
 * @returns The assembled orchestrator deps plus the spies each assertion reads.
 */
const harness = (opts: {
  cachedPrice: string | null;
  priceTickers?:
    | readonly { symbol: string; price: string }[]
    | Error
    | ((symbols: readonly string[]) => Promise<readonly { symbol: string; price: string }[]>);
  walletQuantity?: string;
  stateBody?: Record<string, unknown>;
  ledgerRow?: { avgEntryPrice: string; quantity: string } | null;
}): Harness => {
  for (const m of Object.values(repoMocks)) m.mockReset();
  repoMocks.binanceModeById.mockResolvedValue('live');
  repoMocks.profileSymbolsListForProfile.mockResolvedValue([]);
  const body = opts.stateBody ?? heldBody();
  repoMocks.profileFindById.mockResolvedValue({
    binanceMode: 'live',
    state: body,
    strategyName: 'trailing-trade',
    strategyVersion: '2.0.0',
    config: {},
  });
  repoMocks.symbolStatesFindBySymbol.mockResolvedValue({
    symbol: SYMBOL,
    strategyVersion: '2.0.0',
    state: body,
  });
  // A durable cost-basis row, so a flatten has something observable to delete.
  repoMocks.avgEntryPricesFindBySymbol.mockResolvedValue(
    opts.ledgerRow === undefined ? { avgEntryPrice: '0.5', quantity: WALLET_QTY } : opts.ledgerRow,
  );

  const records: Harness['records'] = [];
  const warns: Harness['warns'] = [];
  const getPriceTickers = vi.fn(async (symbols: readonly string[]) => {
    if (typeof opts.priceTickers === 'function') return opts.priceTickers(symbols);
    if (opts.priceTickers instanceof Error) throw opts.priceTickers;
    return opts.priceTickers ?? [];
  });

  const redis = {
    get: vi.fn(async (key: string) => {
      if (key === buildSymbolInfoKey(SYMBOL, 'live')) {
        return JSON.stringify({
          baseAsset: 'ENA',
          filters: { stepSize: STEP_SIZE, minNotional: MIN_NOTIONAL },
        });
      }
      if (key === GLOBAL_KEYS.ticker(SYMBOL)) {
        return opts.cachedPrice === null ? null : JSON.stringify({ price: opts.cachedPrice });
      }
      return null;
    }),
  } as unknown as Redis;

  const logger = {
    info: vi.fn(),
    debug: vi.fn(),
    error: vi.fn(),
    warn: vi.fn((ctx: Record<string, unknown>, msg: string) => {
      warns.push({ ctx, msg });
    }),
  } as unknown as Logger;

  const deps: ReconcileOrchestratorDeps = {
    db: {} as never,
    redis,
    logger,
    listActive: () =>
      [
        {
          userId: USER_ID,
          operatorId: USER_ID,
          accountId: ACCOUNT_ID,
          profileId: PROFILE_ID,
          symbols: [SYMBOL],
        },
      ] as unknown as ReturnType<ReconcileOrchestratorDeps['listActive']>,
    resolveBinance: async () => ({
      getAccount: vi.fn(async () => ({
        balances: [{ asset: 'ENA', free: opts.walletQuantity ?? WALLET_QTY, locked: '0' }],
      })),
      getMyTrades: vi.fn(async () => []),
      getPriceTickers,
    }),
    strategies: {
      get: () => ({
        name: 'trailing-trade',
        version: '2.0.0',
        position: trailingTradePositionAdapter,
      }),
    },
    persistMigratedState: vi.fn(async () => undefined),
    symbolStateDeps: {
      redis: stateRedis(),
      logger,
      registry: {
        get: (): SymbolStateStrategyShape => ({
          name: 'trailing-trade',
          version: '2.0.0',
          initialState: () => body,
        }),
      },
      persistSymbolState: async (): Promise<boolean> => true,
    },
    chain: createChainByKey(),
    metrics: {
      record: (name, value, tags) => {
        records.push({ name, value, tags: tags as Record<string, string> | undefined });
      },
      forget: () => undefined,
    },
  };

  return { deps, getPriceTickers, records, warns };
};

/** The records for `name` that actually REPORT something, i.e. everything the zero-seed did not write. */
const positive = (h: Harness, name: string): Harness['records'] =>
  h.records.filter((r) => r.name === name && r.value > 0);

/** Exposition lines for `name`, dropping the HELP/TYPE header rows so a comparison is over samples alone. */
const samplesFor = (body: string, name: string): string[] =>
  body.split('\n').filter((l) => l.startsWith(`${name}{`));

/** The zero-seed writes for `name`, which is what has to exist before an increment can read as a rise. */
const zeroSeeds = (h: Harness, name: string): Harness['records'] =>
  h.records.filter((r) => r.name === name && r.value === 0);

describe('boot reconcile — reference price at a cold cache', () => {
  it('falls back to REST when no ticker is cached, and the bound acts on that price', async () => {
    // The whole point of the fallback. At cold boot the miniTicker cache is empty for every symbol, so today this pass reads no price, disarms the value bound, and converges the strand instead of flattening it.
    const h = harness({ cachedPrice: null, priceTickers: [{ symbol: SYMBOL, price: DUST_PRICE }] });
    const tally = await runHeldQuantityReconciliation(h.deps);

    expect(h.getPriceTickers).toHaveBeenCalledTimes(1);
    expect(h.getPriceTickers.mock.calls[0]?.[0]).toEqual(expect.arrayContaining([SYMBOL]));
    expect(tally.heldQuantity['flatten-sub-notional-dust']).toBe(1);
    expect(repoMocks.avgEntryPricesRemove).toHaveBeenCalledWith(SYMBOL);
  });

  it('counts the removal so a destructive convergence is alertable rather than a log line', async () => {
    // A flatten deletes a cost basis and empties a position. That is delete-grade, and the only record of it today is one warn among a boot's worth of them — invisible unless someone is already looking.
    const h = harness({ cachedPrice: null, priceTickers: [{ symbol: SYMBOL, price: DUST_PRICE }] });
    await runHeldQuantityReconciliation(h.deps);

    expect(
      h.records.some(
        (r) =>
          r.name === 'reconcile_position_removed_total' &&
          r.tags?.['symbol'] === SYMBOL &&
          r.tags?.['action'] === 'flatten-sub-notional-dust' &&
          // Bucketed, and this is the bucket that matters: the strategy WAS claiming a quantity, so the bot deleted a position it believed it held rather than converging an already-empty row. An alert that cannot separate the two fires on routine convergence and gets muted.
          r.tags?.['heldBefore'] === 'nonzero',
      ),
    ).toBe(true);
  });

  it('stands the bound down when neither the batch nor the per-symbol retry can price it', async () => {
    // Fail-safe direction is fixed: these bounds only ever delete, so an unavailable price must mean "do not act", never "act on whatever is nearest". A pass that cannot price the holding leaves it exactly as it found it.
    const h = harness({ cachedPrice: null, priceTickers: new Error('binance 503') });
    const tally = await runHeldQuantityReconciliation(h.deps);

    // Two calls: the batch, then the singular retry for the one symbol it covered.
    expect(h.getPriceTickers).toHaveBeenCalledTimes(2);
    expect(h.getPriceTickers.mock.calls[1]?.[0]).toEqual([SYMBOL]);
    expect(tally.heldQuantity['flatten-sub-notional-dust']).toBe(0);
    expect(tally.heldQuantity['no-op']).toBe(1);
    expect(repoMocks.avgEntryPricesRemove).not.toHaveBeenCalled();
  });

  it('retries per symbol when the batch throws, so one bad pair cannot disarm the rest', async () => {
    // Binance does not document what the batch form does with a member it does not list, and this repo can hold one: a delisted pair stays bound because the tick self-heals rather than unbinding. If an unknown member rejects the whole request, a single such pair would leave EVERY symbol on the profile unpriced on every pass — the disarmed-bound strand this resolver exists to repair, made permanent and profile-wide. Rather than depend on an undocumented behaviour, the resolver degrades: the batch is the happy path, and on any throw each symbol is asked for on its own.
    const h = harness({
      cachedPrice: null,
      priceTickers: async (symbols) => {
        if (symbols.length > 1) throw new Error('-1121 Invalid symbol');
        return [{ symbol: symbols[0] ?? '', price: DUST_PRICE }];
      },
    });
    const tally = await runHeldQuantityReconciliation(h.deps);

    // The bound ARMED off the retry: without the degrade this symbol would have gone unpriced and the strand would have survived the pass.
    expect(tally.heldQuantity['flatten-sub-notional-dust']).toBe(1);
    expect(repoMocks.avgEntryPricesRemove).toHaveBeenCalledWith(SYMBOL);
  });

  it('abandons the per-symbol retry when the batch was rate limited', async () => {
    // The fan-out repairs one failure shape, an unlisted member poisoning the batch, and `catch` cannot tell that from a throttle. On a 429 the retry is the harm: a profile that just spent its weight budget on one batched call would follow it with one weight-4 call per missing symbol. Standing the bounds down for a single pass is the cheaper error.
    const calls: (readonly string[])[] = [];
    const h = harness({
      cachedPrice: null,
      priceTickers: async (symbols) => {
        calls.push(symbols);
        throw new BinanceApiError(
          { status: 429, code: -1003, msg: 'Too many requests' },
          true,
          'rejected',
        );
      },
    });
    const tally = await runHeldQuantityReconciliation(h.deps);

    // One attempt only: the batch. No per-symbol follow-up.
    expect(calls).toHaveLength(1);
    expect(calls[0]?.length).toBeGreaterThan(0);
    // Unpriced, so the destructive bound stood down rather than acting on a guess.
    expect(tally.heldQuantity['flatten-sub-notional-dust']).toBe(0);
    expect(repoMocks.avgEntryPricesRemove).not.toHaveBeenCalled();
  });

  it('still fans out on an error that is not a throttle', async () => {
    // The bail is scoped to rate limits; every other failure keeps the repair the fallback exists for.
    const calls: (readonly string[])[] = [];
    const h = harness({
      cachedPrice: null,
      priceTickers: async (symbols) => {
        calls.push(symbols);
        // First attempt is the batch and fails on an unlisted member; the retry that follows is the repair.
        if (calls.length === 1) throw new Error('-1121 Invalid symbol');
        return [{ symbol: symbols[0] ?? '', price: DUST_PRICE }];
      },
    });
    const tally = await runHeldQuantityReconciliation(h.deps);

    expect(calls).toHaveLength(2);
    expect(tally.heldQuantity['flatten-sub-notional-dust']).toBe(1);
  });

  it('does not consult REST when every symbol is already cached', async () => {
    // The fallback is a cold-start repair, not a second price source. Calling it on a warm cache spends per-IP weight on every boot and every periodic sweep for an answer Redis already held.
    const h = harness({ cachedPrice: DUST_PRICE });
    const tally = await runHeldQuantityReconciliation(h.deps);

    expect(h.getPriceTickers).not.toHaveBeenCalled();
    // The cached price still reached the bound, so this is not "skipped the fallback by skipping the work".
    expect(tally.heldQuantity['flatten-sub-notional-dust']).toBe(1);
  });
});

describe('boot reconcile — a disarmed value bound is reported', () => {
  it('warns and counts when a bound is reached with no price at all', async () => {
    // "Could not check" and "checked, nothing to do" both tally as no-op today. They call for opposite responses — one is a healthy position, the other is a bound that silently stopped protecting anything — so they must not share a signal.
    const h = harness({ cachedPrice: null, priceTickers: new Error('binance 503') });
    await runHeldQuantityReconciliation(h.deps);

    expect(
      h.records.some(
        (r) =>
          r.name === 'reconcile_value_bound_disarmed_total' &&
          r.tags?.['symbol'] === SYMBOL &&
          r.tags?.['reason'] === 'no-reference-price',
      ),
    ).toBe(true);
    // The operator-facing half: the warn has to name the symbol and why the bound stood down, or the counter has nothing to point at.
    expect(
      h.warns.some((w) => w.ctx['symbol'] === SYMBOL && w.ctx['reason'] === 'no-reference-price'),
    ).toBe(true);
  });

  it('stays silent when the bound had its inputs and passed', async () => {
    // The discriminating half. A counter that also fires on a healthy priced pass is one per symbol per boot, which buries the case it exists to surface.
    const h = harness({ cachedPrice: REAL_PRICE });
    const tally = await runHeldQuantityReconciliation(h.deps);

    expect(tally.heldQuantity['no-op']).toBe(1);
    // Every reason IS written on this pass, at 0, by the zero-seed. The property under test is that none of them REPORTS: a seed carries no incident, an increment does. Asserting the name is absent would now assert the seed away.
    expect(positive(h, 'reconcile_value_bound_disarmed_total')).toEqual([]);
    expect(repoMocks.avgEntryPricesRemove).not.toHaveBeenCalled();
  });
});

describe('boot reconcile — counters exist at zero before they can move', () => {
  // Without this the two rules over these counters are structurally unable to fire, and read exactly like rules that have simply not tripped. A prom-client child does not exist until its first write and is BORN holding that write's value, so an unseeded counter's first incident is a series that has always read 1 — a level, not a rise, and `increase()` reports 0. The flatten makes that permanent rather than merely slow: it leaves `heldQuantity` null over a sub-notional residue, so every later pass takes the no-op arm and no second increment ever arrives to expose the step.

  it('records every label set at zero on a pass where nothing is removed and no bound is missing', async () => {
    const h = harness({ cachedPrice: REAL_PRICE });
    await runHeldQuantityReconciliation(h.deps);

    // Both destructive actions, not just the one this pass could have taken: either may be the first this symbol ever reaches, and a child seeded only on the pass that increments it is not seeded at all.
    expect(
      zeroSeeds(h, 'reconcile_position_removed_total')
        .map((r) => r.tags?.['action'])
        .sort(),
    ).toEqual(['flatten-sub-notional-dust', 'prune-phantom-ledger']);
    // Every reason in the union, because each routes a different operator remedy and a reason that never seeds is a reason that can never alert.
    expect(
      zeroSeeds(h, 'reconcile_value_bound_disarmed_total')
        .map((r) => r.tags?.['reason'])
        .sort(),
    ).toEqual(['no-min-notional', 'no-reference-price', 'no-unreserved-total']);
    // The whole point: these label sets never increment on this pass, so the seed is the only thing that brings them into existence.
    expect(positive(h, 'reconcile_position_removed_total')).toEqual([]);
    expect(positive(h, 'reconcile_value_bound_disarmed_total')).toEqual([]);
  });

  it('exports a deleted position as a series BORN at 1, which is why its rule reads the raw counter', async () => {
    // The observable property, taken from a real prom-client registry rather than from the in-process call order. Call order proves nothing here: the seed and the increment share one synchronous block with no await between them, so the `/metrics` handler physically cannot run in the gap and Prometheus never samples the child at 0. An assertion on the order of `record()` calls looks identical in the working and the broken world, which is the very defect class this suite exists for.
    //
    // What that means for alerting is the whole point: the first sample Prometheus ever sees for a freshly-deleted position is a LEVEL, not a rise, so `increase()` reads it as zero. `ReconcilePositionRemoved` therefore reads the raw counter. If this ever exports a 0 before the 1 — because a scrape boundary was introduced — that rule may go back to a rate form, and this test is where that is noticed.
    const registry = createMetricsRegistry({ service: 'worker-test', version: 'test' });
    const sink = createWorkerMetricsSink(registry);
    const h = harness({ cachedPrice: DUST_PRICE });

    // Nothing pre-creates children: before the pass the metric has no series at all.
    expect(await registry.metrics()).not.toContain('reconcile_position_removed_total{');

    await runHeldQuantityReconciliation({ ...h.deps, metrics: sink });

    const removed = samplesFor(await registry.metrics(), 'reconcile_position_removed_total');
    const flatten = removed.filter((l) => l.includes('action="flatten-sub-notional-dust"'));
    // Exactly one sample for this child, and it reads 1. Prometheus has no earlier observation to subtract, so there is no rise for `increase()` to find.
    expect(flatten).toHaveLength(1);
    expect(flatten[0]).toContain(`symbol="${SYMBOL}"`);
    expect(flatten[0]).toContain('heldBefore="nonzero"');
    expect(flatten[0]?.endsWith(' 1')).toBe(true);
  });

  it('exports the seeded label sets at zero on a pass that removes nothing', async () => {
    // Where the zero-seed genuinely earns its place. On a pass with no incident the child exists and the scrape carries an explicit 0, so an operator graphing a symbol sees "checked, armed" instead of a gap that is indistinguishable from "never swept".
    const registry = createMetricsRegistry({ service: 'worker-test', version: 'test' });
    const sink = createWorkerMetricsSink(registry);
    const h = harness({ cachedPrice: REAL_PRICE });

    await runHeldQuantityReconciliation({ ...h.deps, metrics: sink });

    const body = await registry.metrics();
    const removed = samplesFor(body, 'reconcile_position_removed_total');
    // Both destructive actions, both at 0, so neither child is born by its own first incident.
    expect(removed.map((l) => l.match(/action="([^"]+)"/)?.[1]).sort()).toEqual([
      'flatten-sub-notional-dust',
      'prune-phantom-ledger',
    ]);
    expect(removed.every((l) => l.endsWith(' 0'))).toBe(true);
    const disarmed = samplesFor(body, 'reconcile_value_bound_disarmed_total');
    expect(disarmed.map((l) => l.match(/reason="([^"]+)"/)?.[1]).sort()).toEqual([
      'no-min-notional',
      'no-reference-price',
      'no-unreserved-total',
    ]);
    expect(disarmed.every((l) => l.endsWith(' 0'))).toBe(true);
  });
});

describe('boot reconcile — the other destructive route and the other bucket', () => {
  it('counts a phantom-ledger prune, bucketed as zero when the strategy claimed nothing', async () => {
    // The second delete-grade action. A cost-basis row with no wallet behind it is dropped by the reviver, not the reconciler, and the alert names both actions — so a record emitted for only one of them makes the rule half-blind.
    //
    // `heldBefore: 'zero'` is the other half. If the bucketing ever inverted, the alert's `heldBefore="nonzero"` gate would match routine convergence instead of a real delete and page on every boot until someone muted it, which is indistinguishable from correct behaviour unless a test pins the zero side too.
    const h = harness({
      cachedPrice: REAL_PRICE,
      walletQuantity: '0',
      stateBody: { ...heldBody(), avgEntryPrice: null, heldQuantity: null },
      ledgerRow: { avgEntryPrice: '0.5', quantity: WALLET_QTY },
    });
    await runHeldQuantityReconciliation(h.deps);

    expect(
      positive(h, 'reconcile_position_removed_total').map((r) => ({
        action: r.tags?.['action'],
        heldBefore: r.tags?.['heldBefore'],
      })),
    ).toEqual([{ action: 'prune-phantom-ledger', heldBefore: 'zero' }]);
    expect(repoMocks.avgEntryPricesRemove).toHaveBeenCalledWith(SYMBOL);
  });

  it('buckets an UNPARSEABLE claim as nonzero, because the reconciler deletes over one', async () => {
    // `reconcileHeldQuantity` treats a corrupt `heldQuantity` as valueless so it cannot protect the row, which means a body like this really is a position being deleted. Bucketing it as `zero` would label that delete routine convergence and drop it from the alert's `heldBefore="nonzero"` gate — the one filter standing between a real delete and silence. It would also put this function at odds with `valueBoundDisarmReason`, which reads the identical field and deliberately treats garbage as a live claim.
    const h = harness({
      cachedPrice: DUST_PRICE,
      stateBody: { ...heldBody(), heldQuantity: 'not-a-number' },
    });
    await runHeldQuantityReconciliation(h.deps);

    // Both destructive routes fire on this input — the flatten empties the body, then the reviver prunes the ledger row it left behind — and BOTH must carry the nonzero bucket.
    const removed = positive(h, 'reconcile_position_removed_total');
    expect(removed.map((r) => r.tags?.['action']).sort()).toEqual([
      'flatten-sub-notional-dust',
      'prune-phantom-ledger',
    ]);
    expect(removed.every((r) => r.tags?.['heldBefore'] === 'nonzero')).toBe(true);
  });
});

describe('boot reconcile — an unusable REST price is not a price', () => {
  // Delete-grade in the opposite direction from every other case here. A zero price does not DISARM a bound, it ARMS one that values every holding at nothing, so accepting it would flatten a real position and delete its cost basis. `resolveSweepPrices` therefore applies the same positivity bar to the REST answer that the cache read applies, and these pin the two ways Binance could hand back something unusable.
  it.each([
    ['zero', '0'],
    ['unparseable', 'not-a-number'],
  ])('refuses a %s price and stands the bound down instead', async (_label, price) => {
    const h = harness({ cachedPrice: null, priceTickers: [{ symbol: SYMBOL, price }] });
    const tally = await runHeldQuantityReconciliation(h.deps);

    expect(tally.heldQuantity['flatten-sub-notional-dust']).toBe(0);
    expect(repoMocks.avgEntryPricesRemove).not.toHaveBeenCalled();
    expect(
      positive(h, 'reconcile_value_bound_disarmed_total').map((r) => r.tags?.['reason']),
    ).toEqual(['no-reference-price']);
  });
});

describe('valueBoundDisarmReason', () => {
  const base = {
    heldQuantity: WALLET_QTY,
    walletFree: WALLET_QTY,
    walletLocked: '0',
    minNotional: MIN_NOTIONAL,
    referencePrice: DUST_PRICE,
    unreservedWalletTotal: WALLET_QTY,
  };

  // Named per input because each routes a different remedy, and only `no-reference-price` is reachable through the orchestrator harness above — the other two need a malformed target the sweep does not build. Untested, either could be misspelt or unreachable and the alert's `reason` label would route an operator to the wrong fix.
  it.each([
    ['no-reference-price', { referencePrice: null }],
    ['no-min-notional', { minNotional: null }],
    ['no-unreserved-total', { unreservedWalletTotal: null }],
  ])('reports %s when that input is the missing one', (reason, missing) => {
    expect(valueBoundDisarmReason({ ...base, ...missing })).toBe(reason);
  });

  it('reports nothing when every input is present', () => {
    expect(valueBoundDisarmReason(base)).toBeNull();
  });

  // Present but unusable is the same silence as absent, and harder to see. `safe` rejects a non-finite string and `isBelowMinNotional` skips a non-positive price or floor, so each of these stands every value bound down while the pass reports a clean `no-op` — the exact state this counter exists to surface.
  it.each([
    ['no-reference-price', { referencePrice: 'Infinity' }],
    ['no-reference-price', { referencePrice: '0' }],
    ['no-reference-price', { referencePrice: 'not-a-number' }],
    ['no-min-notional', { minNotional: 'Infinity' }],
    ['no-min-notional', { minNotional: '0' }],
    ['no-unreserved-total', { unreservedWalletTotal: 'Infinity' }],
  ])('reports %s when that input is present but unusable: %o', (reason, bad) => {
    expect(valueBoundDisarmReason({ ...base, ...bad })).toBe(reason);
  });

  it('does not report a zero unreserved total, which is a real answer the bound acts on', () => {
    // An empty wallet is not a missing input: `isValuelessResidue(0, …)` is a verdict, not a stand-down.
    expect(valueBoundDisarmReason({ ...base, unreservedWalletTotal: '0' })).toBeNull();
  });

  it('reports nothing for an idle symbol whose claim is the STRING zero', () => {
    // A body storing `heldQuantity: '0'` is a shape this repo really produces, and `heldQuantity !== null` reads it as a live position. That would report a disarm and warn for every idle symbol on any pass without a price — one series and one warn per symbol per boot, burying the case the counter exists to surface.
    expect(
      valueBoundDisarmReason({
        ...base,
        heldQuantity: '0',
        walletFree: '0',
        walletLocked: '0',
        referencePrice: null,
      }),
    ).toBeNull();
  });

  it('still reports when the claim is present but unparseable', () => {
    // The opposite direction, and the reason the test above is by VALUE rather than by "is it zero-ish". A bound could not judge garbage either, and treating it as absent would hide a corrupt body behind the same silence as an idle one.
    expect(
      valueBoundDisarmReason({
        ...base,
        heldQuantity: 'not-a-number',
        walletFree: '0',
        walletLocked: '0',
        referencePrice: null,
      }),
    ).toBe('no-reference-price');
  });
});
