import { describe, expect, it, vi, beforeEach } from 'vitest';
import { pino } from 'pino';
import type { Redis } from 'ioredis';
import { asAccountId, asProfileId, asUserId } from '@app/contracts';
import { SiblingQuoteConflictError, SymbolOwnershipConflictError } from '@app/db';
// The real strategy, not a lookalike: the clientOrderId scheme and `attributeOrder`
// are trailing-trade's own, so minting the id from the package is the only way the
// fixture stays true the day the hash or a suffix changes.
import {
  firstBuyClientOrderId,
  gridBuyClientOrderId,
  protectiveStopClientOrderId,
  trailingTrade,
} from '@app/strategy-trailing-trade';

const profileRepo = vi.hoisted(() => vi.fn());
// The handoff runs inside ONE db.transaction, re-binding each already-proven scope
// onto the transaction handle. The doubles mirror that: `profileRepoFromScope`
// resolves back to the same repo double the scope names, so the test exercises the
// real transaction boundary (including its rollback) rather than routing around it.
const profileRepoFromScope = vi.hoisted(() => vi.fn());
vi.mock('@app/db', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@app/db')>()),
  profileRepo,
  profileRepoFromScope,
  withTx: (scope: unknown) => scope,
}));

const { handleDisposeProfile, selectConfirmActions, selectDisposalTargets } =
  await import('../../src/queues/pipeline-handlers/dispose-profile.js');
const { parseDisposeProfileJob } = await import('../../src/queues/pipeline-worker.js');
type DisposeDeps = Parameters<typeof handleDisposeProfile>[0];
type DisposePayload = Parameters<typeof handleDisposeProfile>[1];

const USER = asUserId('00000000-0000-0000-0000-0000000000aa');
const ACCOUNT = asAccountId('00000000-0000-0000-0000-0000000000cc');
const PROFILE = asProfileId('00000000-0000-0000-0000-0000000000bb');
const TARGET = asProfileId('00000000-0000-0000-0000-0000000000dd');

const order = (over: Record<string, unknown> = {}) => ({
  id: 'row-1',
  symbol: 'ENAUSDT',
  binanceOrderId: 4242n,
  ...over,
});

const position = (over: Record<string, unknown> = {}) => ({
  symbol: 'ENAUSDT',
  baseAsset: 'ENA',
  avgEntryPrice: '0.30',
  quantity: '189.87',
  overrideConfig: null,
  source: 'auto' as const,
  pinned: false,
  pinnedAt: null,
  ...over,
});

describe('selectDisposalTargets', () => {
  it('plans every resting order for cancel and every touched symbol for re-verification', () => {
    const plan = selectDisposalTargets(
      [order(), order({ id: 'row-2', symbol: 'BTCUSDT', binanceOrderId: 7n })],
      [position()],
      'cancel-orders',
    );
    expect(plan.cancels).toHaveLength(2);
    expect(plan.symbols).toEqual(['BTCUSDT', 'ENAUSDT']);
    // cancel-orders never re-points a position: the coins simply stay in the wallet.
    expect(plan.handoffs).toEqual([]);
  });

  it('a handoff moves only positions that actually hold something', () => {
    const plan = selectDisposalTargets(
      [],
      [position(), position({ symbol: 'BTCUSDT', baseAsset: 'BTC', quantity: '0' })],
      'handoff',
    );
    // A flat binding is not worth re-pointing — and handing the target a
    // zero-quantity position would have it try to protect a phantom.
    expect(plan.handoffs.map((h) => h.symbol)).toEqual(['ENAUSDT']);
  });
});

describe('selectConfirmActions', () => {
  const open = (over: Record<string, unknown> = {}) => ({
    orderId: 1,
    clientOrderId: 'c-1',
    symbol: 'ENAUSDT',
    side: 'SELL',
    status: 'NEW',
    ...over,
  });

  it('splits the account-wide book three ways: still-resting, provably ours, residual', () => {
    const actions = selectConfirmActions(
      [
        open({ orderId: 1 }), // an order we cancelled — still on the book
        open({ orderId: 2, clientOrderId: 'ours', symbol: 'BTCUSDT' }), // untracked, provably ours
        open({ orderId: 3, clientOrderId: 'theirs' }), // unattributable, on OUR symbol
      ],
      new Set(['ENAUSDT:1']),
      new Set(['ENAUSDT']),
      (o) => o.clientOrderId === 'ours',
    );

    expect(actions.stillResting.map((o) => o.orderId)).toEqual([1]);
    expect(actions.cancels.map((o) => o.orderId)).toEqual([2]);
    expect([...actions.residualBySymbol.get('ENAUSDT')!].map((o) => o.orderId)).toEqual([3]);
  });

  it('matches a cancelled order by SYMBOL + id — a Binance orderId is unique per symbol only', () => {
    // The account-wide book can hold two DIFFERENT orders sharing one numeric id on two
    // symbols. Matching the bare id would call a stranger's order "our cancel that never
    // landed", throw on every attempt, and DLQ the delete — leaving the ghost resting.
    const actions = selectConfirmActions(
      [
        open({ orderId: 4242, symbol: 'ENAUSDT' }), // ours, cancelled, still on the book
        open({ orderId: 4242, symbol: 'SOLUSDT', clientOrderId: 'someone-else' }), // same id, other symbol
      ],
      new Set(['ENAUSDT:4242']),
      new Set(['ENAUSDT']),
      () => false,
    );

    expect(actions.stillResting.map((o) => o.symbol)).toEqual(['ENAUSDT']);
    // The stranger is neither blocked on nor announced: it is not on a symbol we keep.
    expect([...actions.residualBySymbol]).toEqual([]);
  });

  it('a resting BUY NO proof claims is a residual — it locks cash, not coins', () => {
    // The honest residual gap. `isOurs` carries BOTH proofs (the strategy can re-derive
    // the id, or the DB holds a row for it); when neither fires — a crash between the
    // placement and the DB write leaves no proof at all — the order is announced, never
    // cancelled. We do not invent ownership. An abandoned resting BUY holds the
    // operator's quote asset just as a SELL holds their base, so silence is the same
    // fault.
    const actions = selectConfirmActions(
      [open({ orderId: 7, clientOrderId: 'unclaimable', side: 'BUY' })],
      new Set(),
      new Set(['ENAUSDT']),
      () => false,
    );

    expect(actions.residualBySymbol.get('ENAUSDT')?.map((o) => o.side)).toEqual(['BUY']);
  });

  it('claims a resting BUY the moment a proof DOES fire — a DB row is a proof', () => {
    // The twin of the case above, and the whole bug: an id the strategy cannot enumerate
    // (momentum folds a candle close time into its hash) but that our own DB recorded is
    // ours, and must be cancelled rather than announced. It reaches the confirm through
    // the same `isOurs` seam, so the split stays pure and its signature unchanged.
    const actions = selectConfirmActions(
      [open({ orderId: 7, clientOrderId: 'unclaimable-but-recorded', side: 'BUY' })],
      new Set(),
      new Set(['ENAUSDT']),
      (o) => o.orderId === 7,
    );

    expect(actions.cancels.map((o) => o.orderId)).toEqual([7]);
    expect([...actions.residualBySymbol]).toEqual([]);
  });

  it('never announces a residual on a symbol the handoff just gave away', () => {
    // The target armed its own protective stop there seconds ago (the disposal
    // reconfigured it), and that order attributes to the TARGET, not to us. Announcing
    // "the bot has no record of placing them" about it would simply be false.
    const actions = selectConfirmActions(
      [open({ orderId: 11, clientOrderId: 'the-targets-fresh-stop' })],
      new Set(),
      new Set(), // ENAUSDT was handed off, so it is not in the residual scope
      () => false,
    );

    expect([...actions.residualBySymbol]).toEqual([]);
  });

  it("never counts a sibling's resting SELL on a symbol we do not own as our residual", () => {
    // Account-wide enumeration returns every profile's orders. Announcing another
    // profile's live stop as "left behind by the deleted profile" is a false alarm.
    const actions = selectConfirmActions(
      [open({ orderId: 9, clientOrderId: 'siblings', symbol: 'SOLUSDT' })],
      new Set(),
      new Set(['ENAUSDT']),
      () => false,
    );

    expect(actions.cancels).toEqual([]);
    expect([...actions.residualBySymbol]).toEqual([]);
  });
});

describe('handleDisposeProfile', () => {
  /**
   * The `orders` repo double. `listRecordedAmong` is the SECOND proof of ownership:
   * given the Binance orderIds actually on the open book, which `(symbol, orderId)` did
   * THIS profile record? It mirrors the real query — filter by orderId, return the row's
   * symbol, no `closed_at` filter, never reaching outside the profile — so a test that
   * seeds `recorded` with `symbol:orderId` keys is stating "the DB holds a row for these,
   * closed or not". The symbol comes off the DB row, not the argument, which is exactly
   * why the same orderId on two symbols cannot cross-claim.
   */
  const ordersDouble = (over: Record<string, unknown> = {}, recorded: readonly string[] = []) => ({
    listLiveForProfile: vi.fn(async () => []),
    listRecordedAmong: vi.fn(async (ids: readonly bigint[]) =>
      recorded
        .map((k) => {
          const [symbol, id] = k.split(':');
          return { symbol: symbol!, binanceOrderId: BigInt(id!) };
        })
        .filter((r) => ids.includes(r.binanceOrderId)),
    ),
    ...over,
  });

  const mkRepo = (over: Record<string, unknown> = {}, profileId: string = PROFILE) => ({
    scope: { profileId },
    profileNotifiers: { listForProfile: vi.fn(async () => []) },
    profile: {
      findById: vi.fn(async () => ({ id: PROFILE, name: 'momentum', quoteAsset: 'USDT' })),
      setEnabled: vi.fn(async () => undefined),
      deleteById: vi.fn(async () => true),
    },
    orders: ordersDouble(),
    profileSymbols: {
      listForProfile: vi.fn(async () => []),
      remove: vi.fn(async () => undefined),
      upsert: vi.fn(async () => undefined),
    },
    avgEntryPrices: {
      listForProfile: vi.fn(async () => []),
      findBySymbol: vi.fn(async () => null),
      remove: vi.fn(async () => undefined),
      upsert: vi.fn(async () => undefined),
    },
    // The seeding verification reads the target's state body through the strategy's
    // position adapter. By default the target is seeded (a priced body), so the happy
    // paths below assert the handoff, not the verification.
    symbolStates: {
      findBySymbol: vi.fn(async () => ({ state: { avgEntryPrice: '0.30' } })),
    },
    ...over,
  });

  const fakeRedis = (): Redis =>
    ({
      scan: vi.fn(async () => ['0', []] as [string, string[]]),
      del: vi.fn(async () => 0),
    }) as unknown as Redis;

  const mkDeps = (over: Partial<DisposeDeps> = {}): DisposeDeps =>
    ({
      db: {
        // A real transaction: the body's writes commit together, and a throw inside
        // it rolls the whole thing back.
        transaction: async (fn: (tx: unknown) => Promise<void>) => fn({}),
      } as unknown as DisposeDeps['db'],
      redis: fakeRedis(),
      executor: { apply: vi.fn(async () => ({ ok: true })) } as unknown as DisposeDeps['executor'],
      clock: { nowMs: () => 1_700_000_000_000 },
      logger: pino({ level: 'silent' }),
      resolveBinanceClient: vi.fn(async () => ({
        getOpenOrders: vi.fn(async () => []),
      })),
      notifyRegistry: { get: () => undefined, list: () => [] },
      strategies: {
        get: () => ({
          position: {
            readPosition: (state: { avgEntryPrice?: string } | null) =>
              state?.avgEntryPrice == null ? null : { avgEntryPrice: state.avgEntryPrice },
          },
        }),
      },
      unsubscribe: vi.fn(async () => undefined),
      reconfigure: vi.fn(async () => undefined),
      ...over,
    }) as DisposeDeps;

  const payload = (over: Partial<DisposePayload> = {}): DisposePayload =>
    ({
      userId: USER,
      accountId: ACCOUNT,
      profileId: PROFILE,
      disposition: 'cancel-orders',
      ...over,
    }) as DisposePayload;

  /** Bind a (source, target) pair to both repo entry points, keyed by profile id. */
  const wire = (source: ReturnType<typeof mkRepo>, target: ReturnType<typeof mkRepo>): void => {
    const byId = new Map<string, unknown>([
      [PROFILE, source],
      [TARGET, target],
    ]);
    profileRepo.mockImplementation(async (_db, _u, _a, pid: string) => byId.get(pid));
    profileRepoFromScope.mockImplementation((scope: { profileId: string }) =>
      byId.get(scope.profileId),
    );
  };

  beforeEach(() => {
    profileRepo.mockReset();
    profileRepoFromScope.mockReset();
  });

  it('disables and unsubscribes BEFORE cancelling — a live tick would re-place what we cancel', async () => {
    const calls: string[] = [];
    const repo = mkRepo({
      profile: {
        findById: vi.fn(async () => ({ id: PROFILE, quoteAsset: 'USDT' })),
        setEnabled: vi.fn(async () => {
          calls.push('disable');
        }),
        deleteById: vi.fn(async () => {
          calls.push('delete');
          return true;
        }),
      },
      orders: ordersDouble({
        listLiveForProfile: vi
          .fn()
          .mockResolvedValueOnce([order()])
          // The post-cancel re-read: the executor closed the row.
          .mockResolvedValueOnce([]),
      }),
    });
    profileRepo.mockResolvedValue(repo);
    const apply = vi.fn(async () => {
      calls.push('cancel');
      return { ok: true } as const;
    });
    const deps = mkDeps({
      executor: { apply } as unknown as DisposeDeps['executor'],
      unsubscribe: vi.fn(async () => {
        calls.push('unsubscribe');
      }),
    });

    await handleDisposeProfile(deps, payload());

    expect(calls).toEqual(['disable', 'unsubscribe', 'cancel', 'delete']);
    expect(apply).toHaveBeenCalledWith(
      expect.anything(),
      ACCOUNT,
      expect.objectContaining({ type: 'cancel-order', orderId: 4242 }),
    );
  });

  it('refuses to delete while an order is still live locally (the retry is the safety net)', async () => {
    const repo = mkRepo({
      orders: ordersDouble({ listLiveForProfile: vi.fn(async () => [order()]) }),
    });
    profileRepo.mockResolvedValue(repo);
    // A non-retryable cancel result does NOT license the delete: only DB + Binance
    // truth does. The row survives, BullMQ retries.
    const deps = mkDeps({
      executor: {
        apply: vi.fn(async () => ({ ok: false, retryable: false, reason: 'gone' })),
      } as unknown as DisposeDeps['executor'],
    });

    await expect(handleDisposeProfile(deps, payload())).rejects.toThrow(/still live locally/);
    expect(repo.profile.deleteById).not.toHaveBeenCalled();
  });

  it('refuses to delete while the cancelled order is STILL resting on Binance', async () => {
    const repo = mkRepo({
      orders: ordersDouble({
        listLiveForProfile: vi.fn().mockResolvedValueOnce([order()]).mockResolvedValueOnce([]),
      }),
    });
    profileRepo.mockResolvedValue(repo);
    const deps = mkDeps({
      resolveBinanceClient: vi.fn(async () => ({
        // Our cancelled id is still on the book: the cancel never landed.
        getOpenOrders: vi.fn(async () => [
          { orderId: 4242, clientOrderId: 'x', symbol: 'ENAUSDT', side: 'SELL', status: 'NEW' },
        ]),
      })) as unknown as DisposeDeps['resolveBinanceClient'],
    });

    await expect(handleDisposeProfile(deps, payload())).rejects.toThrow(/still resting on Binance/);
    expect(repo.profile.deleteById).not.toHaveBeenCalled();
  });

  it('an order the operator placed by hand is not ours and must not block the delete', async () => {
    const repo = mkRepo({
      orders: ordersDouble(),
      profileSymbols: {
        listForProfile: vi.fn(async () => [
          { symbol: 'ENAUSDT', baseAsset: 'ENA', overrideConfig: null },
        ]),
        remove: vi.fn(),
        upsert: vi.fn(),
      },
      avgEntryPrices: {
        listForProfile: vi.fn(async () => [
          { symbol: 'ENAUSDT', avgEntryPrice: '0.3', quantity: '10' },
        ]),
        remove: vi.fn(),
        upsert: vi.fn(),
      },
    });
    profileRepo.mockResolvedValue(repo);
    const deps = mkDeps({
      resolveBinanceClient: vi.fn(async () => ({
        getOpenOrders: vi.fn(async () => [
          { orderId: 999_999, clientOrderId: 'operator-own', side: 'BUY', status: 'NEW' },
        ]),
      })) as unknown as DisposeDeps['resolveBinanceClient'],
    });

    await handleDisposeProfile(deps, payload());

    expect(repo.profile.deleteById).toHaveBeenCalledOnce();
  });

  it('a handoff re-points the POSITION to the target — the source binding is released first', async () => {
    const calls: string[] = [];
    const source = mkRepo({
      profileSymbols: {
        listForProfile: vi.fn(async () => [
          { symbol: 'ENAUSDT', baseAsset: 'ENA', overrideConfig: null },
        ]),
        remove: vi.fn(async () => {
          calls.push('source.unbind');
        }),
        upsert: vi.fn(),
      },
      avgEntryPrices: {
        listForProfile: vi.fn(async () => [
          { symbol: 'ENAUSDT', avgEntryPrice: '0.30', quantity: '189.87' },
        ]),
        remove: vi.fn(async () => {
          calls.push('source.drop-position');
        }),
        upsert: vi.fn(),
      },
    });
    const target = mkRepo(
      {
        profileSymbols: {
          listForProfile: vi.fn(async () => []),
          remove: vi.fn(),
          upsert: vi.fn(async () => {
            calls.push('target.bind');
          }),
        },
        avgEntryPrices: {
          listForProfile: vi.fn(async () => []),
          remove: vi.fn(),
          upsert: vi.fn(async () => {
            calls.push('target.take-position');
          }),
        },
      },
      TARGET,
    );
    wire(source, target);
    const deps = mkDeps();

    await handleDisposeProfile(
      deps,
      payload({ disposition: 'handoff', toProfileId: TARGET } as Partial<DisposePayload>),
    );

    // Unbind before bind: base-asset exclusivity is per account, so the source
    // would otherwise be the conflicting owner of its own handoff.
    expect(calls).toEqual(['source.unbind', 'target.bind', 'target.take-position']);
    // The source's cost basis goes with its binding, so the handoff no longer
    // drops it by hand. Doing both would be a second teardown that the unbind
    // already performed.
    expect(source.avgEntryPrices.remove).not.toHaveBeenCalled();
    // And the teardown is the SOURCE's alone: it is scoped to the profile that
    // unbound, so the row the target was just seeded with survives.
    expect(target.profileSymbols.remove).not.toHaveBeenCalled();
    expect(target.avgEntryPrices.remove).not.toHaveBeenCalled();
    // The ORDERS are never re-pointed: their clientOrderIds encode the SOURCE
    // profile, so the target's strategy could never recognise them.
    expect(target.orders.listLiveForProfile).not.toHaveBeenCalled();
    expect(source.profile.deleteById).toHaveBeenCalledOnce();
  });

  it("a handoff carries the source binding's provenance and pin verbatim", async () => {
    // A handoff re-points a position between profiles; it does not re-author the binding. Re-stamping it `manual`/pinned (the old behaviour) both credited the operator with a coin discovery chose and silently granted a rotation exemption the source never had.
    const at = new Date('2026-08-20T00:00:00.000Z');
    const source = mkRepo({
      profileSymbols: {
        listForProfile: vi.fn(async () => [
          {
            symbol: 'ENAUSDT',
            baseAsset: 'ENA',
            overrideConfig: null,
            source: 'auto',
            pinned: true,
            pinnedAt: at,
          },
        ]),
        remove: vi.fn(),
        upsert: vi.fn(),
      },
      avgEntryPrices: {
        listForProfile: vi.fn(async () => [
          { symbol: 'ENAUSDT', avgEntryPrice: '0.30', quantity: '189.87' },
        ]),
        remove: vi.fn(),
        upsert: vi.fn(),
      },
    });
    const target = mkRepo(
      {
        profileSymbols: { listForProfile: vi.fn(async () => []), remove: vi.fn(), upsert: vi.fn() },
        avgEntryPrices: { listForProfile: vi.fn(async () => []), remove: vi.fn(), upsert: vi.fn() },
      },
      TARGET,
    );
    wire(source, target);

    await handleDisposeProfile(
      mkDeps(),
      payload({ disposition: 'handoff', toProfileId: TARGET } as Partial<DisposePayload>),
    );

    expect(target.profileSymbols.upsert).toHaveBeenCalledWith(
      'ENAUSDT',
      'ENA',
      expect.objectContaining({ source: 'auto', pinned: true, pinnedAt: at }),
    );
  });

  it('a handoff of a position whose binding is already gone lands UNKNOWN and unpinned', async () => {
    // No binding row means no provenance left to read and nobody to credit. Unpinned is the safe half: the target rotates the coin like any other rather than inheriting a protection nobody granted.
    const source = mkRepo({
      profileSymbols: { listForProfile: vi.fn(async () => []), remove: vi.fn(), upsert: vi.fn() },
      avgEntryPrices: {
        listForProfile: vi.fn(async () => [
          { symbol: 'ENAUSDT', avgEntryPrice: '0.30', quantity: '189.87' },
        ]),
        remove: vi.fn(),
        upsert: vi.fn(),
      },
    });
    const target = mkRepo(
      {
        profileSymbols: { listForProfile: vi.fn(async () => []), remove: vi.fn(), upsert: vi.fn() },
        avgEntryPrices: { listForProfile: vi.fn(async () => []), remove: vi.fn(), upsert: vi.fn() },
      },
      TARGET,
    );
    wire(source, target);

    await handleDisposeProfile(
      mkDeps(),
      payload({ disposition: 'handoff', toProfileId: TARGET } as Partial<DisposePayload>),
    );

    expect(target.profileSymbols.upsert).toHaveBeenCalledWith(
      'ENAUSDT',
      'ENA',
      expect.objectContaining({ source: 'unknown', pinned: false, pinnedAt: null }),
    );
  });

  it('a handoff with no target refuses rather than delete the exposure into the void', async () => {
    profileRepo.mockResolvedValue(mkRepo());
    await expect(
      handleDisposeProfile(mkDeps(), payload({ disposition: 'handoff' })),
    ).rejects.toThrow(/requires toProfileId/);
  });

  it('is idempotent: a retry after the row is gone acks', async () => {
    const repo = mkRepo({
      profile: {
        findById: vi.fn(async () => null),
        setEnabled: vi.fn(),
        deleteById: vi.fn(),
      },
    });
    profileRepo.mockResolvedValue(repo);

    await handleDisposeProfile(mkDeps(), payload());

    expect(repo.profile.setEnabled).not.toHaveBeenCalled();
  });

  it('a retryable cancel failure throws so BullMQ retries — the profile outlives a failed cancel', async () => {
    profileRepo.mockResolvedValue(
      mkRepo({ orders: ordersDouble({ listLiveForProfile: vi.fn(async () => [order()]) }) }),
    );
    const deps = mkDeps({
      executor: {
        apply: vi.fn(async () => ({ ok: false, retryable: true, reason: 'binance down' })),
      } as unknown as DisposeDeps['executor'],
    });

    await expect(handleDisposeProfile(deps, payload())).rejects.toThrow(/retryable cancel failure/);
  });

  it('an unresolvable Binance client is a RETRYABLE failure, not a clean bill of health', async () => {
    // "I could not ask the exchange" must never read as "the exchange is clear":
    // that is how a resting order outlives the profile that placed it.
    profileRepo.mockResolvedValue(
      mkRepo({
        orders: ordersDouble({
          listLiveForProfile: vi.fn().mockResolvedValueOnce([order()]).mockResolvedValueOnce([]),
        }),
      }),
    );
    const deps = mkDeps({ resolveBinanceClient: vi.fn(async () => null) as never });

    await expect(handleDisposeProfile(deps, payload())).rejects.toThrow(/no Binance client/);
  });

  it('a keyless account with nothing ever placed still deletes', async () => {
    // The other side of the same coin: refusing here would leave a profile that can
    // never be deleted because its account has no api key to ask with.
    const repo = mkRepo();
    profileRepo.mockResolvedValue(repo);
    const deps = mkDeps({ resolveBinanceClient: vi.fn(async () => null) as never });

    await handleDisposeProfile(deps, payload());

    expect(repo.profile.deleteById).toHaveBeenCalledOnce();
  });

  it('announces a resting SELL it did not place and never cancels it', async () => {
    // The residual: an order Binance holds and our books never recorded (the
    // bookkeeping-failure path). It survives the delete and keeps holding the coins,
    // so the operator hears about it NOW rather than from a position that will not
    // sell weeks later. Cancelling it is not ours to do.
    const send = vi.fn(async () => undefined);
    const repo = mkRepo({
      profileSymbols: {
        listForProfile: vi.fn(async () => [
          { symbol: 'ENAUSDT', baseAsset: 'ENA', overrideConfig: null },
        ]),
        remove: vi.fn(),
        upsert: vi.fn(),
      },
      avgEntryPrices: {
        listForProfile: vi.fn(async () => [
          { symbol: 'ENAUSDT', avgEntryPrice: '0.3', quantity: '10' },
        ]),
        remove: vi.fn(),
        upsert: vi.fn(),
      },
      profileNotifiers: {
        listForProfile: vi.fn(async () => [
          { provider: 'slack', config: {}, secrets: {}, enabled: true },
        ]),
      },
    });
    profileRepo.mockResolvedValue(repo);
    const cancelOrder = vi.fn();
    const deps = mkDeps({
      notifyRegistry: {
        get: (n: string) => (n === 'slack' ? { name: 'slack', send } : undefined),
        list: () => [{ name: 'slack', send }],
      } as unknown as DisposeDeps['notifyRegistry'],
      resolveBinanceClient: vi.fn(async () => ({
        getOpenOrders: vi.fn(async () => [
          {
            orderId: 555,
            clientOrderId: 'never-recorded',
            symbol: 'ENAUSDT',
            side: 'SELL',
            status: 'NEW',
          },
        ]),
        cancelOrder,
      })) as unknown as DisposeDeps['resolveBinanceClient'],
    });

    await handleDisposeProfile(deps, payload());

    expect(send).toHaveBeenCalledOnce();
    expect((send.mock.calls[0] as unknown[])[0]).toMatchObject({
      message: { topic: 'profile-disposal-residual', symbol: 'ENAUSDT' },
    });
    expect(cancelOrder).not.toHaveBeenCalled();
    // Announced, not blocked: the profile still goes.
    expect(repo.profile.deleteById).toHaveBeenCalledOnce();
  });

  it('does NOT announce the residual under LIVE_DEMO — dispatch is suppressed at the chokepoint', async () => {
    // Same residual scenario as above, but on a demo box: announceResidual runs
    // through the dispatch chokepoint, which no-ops under liveDemo, so no send
    // reaches the operator's seeded webhook. The delete still proceeds.
    const send = vi.fn(async () => undefined);
    const repo = mkRepo({
      profileSymbols: {
        listForProfile: vi.fn(async () => [
          { symbol: 'ENAUSDT', baseAsset: 'ENA', overrideConfig: null },
        ]),
        remove: vi.fn(),
        upsert: vi.fn(),
      },
      avgEntryPrices: {
        listForProfile: vi.fn(async () => [
          { symbol: 'ENAUSDT', avgEntryPrice: '0.3', quantity: '10' },
        ]),
        remove: vi.fn(),
        upsert: vi.fn(),
      },
      profileNotifiers: {
        listForProfile: vi.fn(async () => [
          { provider: 'slack', config: {}, secrets: {}, enabled: true },
        ]),
      },
    });
    profileRepo.mockResolvedValue(repo);
    const deps = mkDeps({
      liveDemo: true,
      notifyRegistry: {
        get: (n: string) => (n === 'slack' ? { name: 'slack', send } : undefined),
        list: () => [{ name: 'slack', send }],
      } as unknown as DisposeDeps['notifyRegistry'],
      resolveBinanceClient: vi.fn(async () => ({
        getOpenOrders: vi.fn(async () => [
          {
            orderId: 555,
            clientOrderId: 'never-recorded',
            symbol: 'ENAUSDT',
            side: 'SELL',
            status: 'NEW',
          },
        ]),
        cancelOrder: vi.fn(),
      })) as unknown as DisposeDeps['resolveBinanceClient'],
    });

    await handleDisposeProfile(deps, payload());

    expect(send).not.toHaveBeenCalled();
    // The delete still proceeds — suppression silences the alert, not the disposal.
    expect(repo.profile.deleteById).toHaveBeenCalledOnce();
  });

  it('an untracked order on an unbound symbol is invisible to the confirm and is abandoned by the delete', async () => {
    // The #612 ghost-order class, one step further out than the residual above.
    // `plan.symbols` is derived from DB truth ONLY (live-order rows ∪ symbol
    // bindings ∪ cost-basis ledger), so an order Binance holds on a symbol with NO
    // row of any kind is never even looked at: the confirm loop never asks about
    // that symbol. The bookkeeping-failure paths in `place-order.ts` leave exactly
    // that — a live order with zero DB rows — and a later unbind removes the last
    // symbol that would have made the confirm ask.
    //
    // This one IS ours: its clientOrderId is the id trailing-trade itself would mint
    // for (this profile, BTCUSDT), so `attributeOrder` PROVES ownership. It must be
    // cancelled, not merely announced.
    const ghostId = protectiveStopClientOrderId(PROFILE, 'BTCUSDT');
    const repo = mkRepo({
      profile: {
        findById: vi.fn(async () => ({
          id: PROFILE,
          name: 'tt',
          quoteAsset: 'USDT',
          strategyName: 'trailing-trade',
          config: trailingTrade.defaultConfig,
        })),
        setEnabled: vi.fn(async () => undefined),
        deleteById: vi.fn(async () => true),
      },
      // The tracked order cancels normally: the existing path is fully satisfied.
      orders: ordersDouble({
        listLiveForProfile: vi.fn().mockResolvedValueOnce([order()]).mockResolvedValueOnce([]),
      }),
      // ENAUSDT is the only symbol the DB knows about. BTCUSDT appears nowhere.
      profileSymbols: {
        listForProfile: vi.fn(async () => [
          { symbol: 'ENAUSDT', baseAsset: 'ENA', overrideConfig: null },
        ]),
        remove: vi.fn(),
        upsert: vi.fn(),
      },
      avgEntryPrices: {
        listForProfile: vi.fn(async () => [
          { symbol: 'ENAUSDT', avgEntryPrice: '0.3', quantity: '10' },
        ]),
        remove: vi.fn(),
        upsert: vi.fn(),
      },
    });
    profileRepo.mockResolvedValue(repo);
    const cancelOrder = vi.fn(async () => undefined);
    // Answers a per-symbol probe AND an account-wide (`undefined`) one, so the test
    // does not dictate HOW the fix widens its view — only that it sees the order.
    const getOpenOrders = vi.fn(async (symbol?: string) =>
      symbol === undefined || symbol === 'BTCUSDT'
        ? [
            {
              orderId: 8888,
              clientOrderId: ghostId,
              symbol: 'BTCUSDT',
              side: 'SELL',
              status: 'NEW',
              type: 'STOP_LOSS_LIMIT',
            },
          ]
        : [],
    );
    const apply = vi.fn<DisposeDeps['executor']['apply']>(async () => ({ ok: true }) as const);
    const deps = mkDeps({
      executor: { apply } as unknown as DisposeDeps['executor'],
      strategies: { get: () => trailingTrade } as unknown as DisposeDeps['strategies'],
      resolveBinanceClient: vi.fn(async () => ({
        getOpenOrders,
        cancelOrder,
      })) as unknown as DisposeDeps['resolveBinanceClient'],
    });

    await handleDisposeProfile(deps, payload());

    // Cancelled by whichever path the fix uses — the exchange client directly, or a
    // `cancel-order` decision through the executor. What is NOT acceptable is the
    // order outliving the profile with nothing left in the system pointing at it.
    const cancelledDirectly = cancelOrder.mock.calls.some((c) =>
      JSON.stringify(c).includes('8888'),
    );
    const cancelledViaExecutor = apply.mock.calls.some((c) =>
      c.some(
        (arg) =>
          typeof arg === 'object' &&
          arg !== null &&
          (arg as { type?: string }).type === 'cancel-order' &&
          (arg as { orderId?: number }).orderId === 8888,
      ),
    );
    expect(cancelledDirectly || cancelledViaExecutor).toBe(true);
  });

  /**
   * A disposing profile that runs the real trailing-trade plugin, so attribution is real.
   * `recorded` is the set of `symbol:orderId` keys the DB holds a row for under THIS
   * profile — closed or not, which is the point.
   */
  const mkTtRepo = (
    config: unknown = trailingTrade.defaultConfig,
    recorded: readonly string[] = [],
  ) =>
    mkRepo({
      orders: ordersDouble({}, recorded),
      profile: {
        findById: vi.fn(async () => ({
          id: PROFILE,
          name: 'tt',
          quoteAsset: 'USDT',
          strategyName: 'trailing-trade',
          config,
        })),
        setEnabled: vi.fn(async () => undefined),
        deleteById: vi.fn(async () => true),
      },
      profileSymbols: {
        listForProfile: vi.fn(async () => [
          { symbol: 'ENAUSDT', baseAsset: 'ENA', overrideConfig: null },
        ]),
        remove: vi.fn(),
        upsert: vi.fn(),
      },
      avgEntryPrices: {
        listForProfile: vi.fn(async () => [
          { symbol: 'ENAUSDT', avgEntryPrice: '0.3', quantity: '10' },
        ]),
        remove: vi.fn(),
        upsert: vi.fn(),
      },
    });

  const ttDeps = (
    open: readonly Record<string, unknown>[],
    apply: DisposeDeps['executor']['apply'] = vi.fn<DisposeDeps['executor']['apply']>(
      async () => ({ ok: true }) as const,
    ),
    over: Partial<DisposeDeps> = {},
  ): DisposeDeps =>
    mkDeps({
      executor: { apply } as unknown as DisposeDeps['executor'],
      strategies: { get: () => trailingTrade } as unknown as DisposeDeps['strategies'],
      resolveBinanceClient: vi.fn(async () => ({
        getOpenOrders: vi.fn(async () => open),
      })) as unknown as DisposeDeps['resolveBinanceClient'],
      ...over,
    });

  const cancelledIds = (apply: ReturnType<typeof vi.fn>): unknown[] =>
    apply.mock.calls
      .map((c) => c[2] as { type?: string; orderId?: number })
      .filter((d) => d?.type === 'cancel-order')
      .map((d) => d.orderId);

  it('an untracked order another PROFILE emitted is never cancelled by this delete', async () => {
    // Account-wide enumeration now sees every profile's orders. Attribution is what
    // keeps that safe: this id hashes the TARGET profile, so the disposing profile
    // cannot prove it emitted it — and cancelling a sibling's protective stop would
    // strip a live position of its protection.
    const repo = mkTtRepo();
    profileRepo.mockResolvedValue(repo);
    const apply = vi.fn<DisposeDeps['executor']['apply']>(async () => ({ ok: true }) as const);
    const deps = ttDeps(
      [
        {
          orderId: 8888,
          clientOrderId: protectiveStopClientOrderId(TARGET, 'BTCUSDT'),
          symbol: 'BTCUSDT',
          side: 'SELL',
          status: 'NEW',
        },
      ],
      apply,
    );

    await handleDisposeProfile(deps, payload());

    expect(cancelledIds(apply)).toEqual([]);
    // ...and it does not block the delete either: it is not ours to wait on.
    expect(repo.profile.deleteById).toHaveBeenCalledOnce();
  });

  it('an untracked BUY this profile emitted is cancelled too — the side is not the point', async () => {
    // Attribution is by clientOrderId, not by side. An abandoned resting BUY locks the
    // quote asset instead of the base, but it is the same ghost: live on Binance with
    // nothing left in the system pointing at it.
    const repo = mkTtRepo();
    profileRepo.mockResolvedValue(repo);
    const apply = vi.fn<DisposeDeps['executor']['apply']>(async () => ({ ok: true }) as const);
    const deps = ttDeps(
      [
        {
          orderId: 4321,
          clientOrderId: firstBuyClientOrderId(PROFILE, 'BTCUSDT'),
          symbol: 'BTCUSDT',
          side: 'BUY',
          status: 'NEW',
        },
      ],
      apply,
    );

    await handleDisposeProfile(deps, payload());

    expect(cancelledIds(apply)).toEqual([4321]);
    expect(repo.profile.deleteById).toHaveBeenCalledOnce();
  });

  // An id no strategy can enumerate: momentum folds the candle close time into its hash,
  // so `attributeOrder` returns null for it by design. The DB row is the only proof left.
  const UNENUMERABLE = 'mom-e-ENAUSDT-1721001600000-9f3a1c';

  const slackDeps = (send: ReturnType<typeof vi.fn>): Partial<DisposeDeps> => ({
    notifyRegistry: {
      get: (n: string) => (n === 'slack' ? { name: 'slack', send } : undefined),
      list: () => [{ name: 'slack', send }],
    } as unknown as DisposeDeps['notifyRegistry'],
  });

  const withSlack = (repo: ReturnType<typeof mkRepo>): ReturnType<typeof mkRepo> => {
    repo.profileNotifiers.listForProfile = vi.fn(async () => [
      { provider: 'slack', config: {}, secrets: {}, enabled: true },
    ]) as never;
    return repo;
  };

  it('cancels a resting BUY our own DB recorded, even though its row was already CLOSED', async () => {
    // The bug. `upsertLive`'s closePrevious stamps the previous (profile, symbol, intent)
    // row CLOSED the moment the next candle's order takes the slot — while the old BUY is
    // still RESTING on Binance, locking the operator's CASH. `listLiveForProfile` (closed_at
    // IS NULL) therefore never plans it for cancel, and its id is unenumerable, so
    // attribution cannot claim it either. A DB row is proof of ownership that does not
    // depend on the id being re-derivable: claim it, and cancel it.
    const send = vi.fn(async () => undefined);
    const repo = withSlack(mkTtRepo(trailingTrade.defaultConfig, ['ENAUSDT:777']));
    profileRepo.mockResolvedValue(repo);
    const apply = vi.fn(async () => ({ ok: true }) as const);
    const deps = ttDeps(
      [
        {
          orderId: 777,
          clientOrderId: UNENUMERABLE,
          symbol: 'ENAUSDT',
          side: 'BUY',
          status: 'NEW',
        },
      ],
      apply,
      slackDeps(send),
    );

    await handleDisposeProfile(deps, payload());

    // The lookup is driven by the ids actually ON THE BOOK: the on-book orderId is what
    // the profile is asked about, and the symbol comes back off the matched DB row.
    expect(repo.orders.listRecordedAmong).toHaveBeenCalledWith(expect.arrayContaining([777n]));
    expect(cancelledIds(apply)).toEqual([777]);
    // Proven ours ⇒ cancelled, not handed to the operator as "the bot has no record of
    // placing them" — the bot has a record of placing it. That record IS the proof.
    expect(send).not.toHaveBeenCalled();
    expect(repo.profile.deleteById).toHaveBeenCalledOnce();
  });

  it('the same resting BUY, never recorded, stays a residual — we never invent ownership', async () => {
    // The honest gap, and the twin of the test above: a crash between the placement and
    // the DB write leaves NO row and an id nothing can re-derive. Neither proof fires, so
    // the order is announced and left alone. Over-claiming is the worse failure.
    const send = vi.fn(async () => undefined);
    const repo = withSlack(mkTtRepo());
    profileRepo.mockResolvedValue(repo);
    const apply = vi.fn(async () => ({ ok: true }) as const);
    const deps = ttDeps(
      [
        {
          orderId: 777,
          clientOrderId: UNENUMERABLE,
          symbol: 'ENAUSDT',
          side: 'BUY',
          status: 'NEW',
        },
      ],
      apply,
      slackDeps(send),
    );

    await handleDisposeProfile(deps, payload());

    expect(cancelledIds(apply)).toEqual([]);
    expect(send).toHaveBeenCalledOnce();
    expect(repo.profile.deleteById).toHaveBeenCalledOnce();
  });

  it('the DB proof is keyed on SYMBOL + orderId — the same id on another symbol is another order', async () => {
    // A Binance orderId is unique per SYMBOL, not per account, so the account-wide book
    // holds two DIFFERENT orders sharing one numeric id. Keying the proof set on the bare
    // id would cancel a stranger's order on the strength of OUR row.
    const repo = withSlack(mkTtRepo(trailingTrade.defaultConfig, ['ENAUSDT:8888']));
    profileRepo.mockResolvedValue(repo);
    const apply = vi.fn<DisposeDeps['executor']['apply']>(async () => ({ ok: true }) as const);
    const deps = ttDeps(
      [
        {
          orderId: 8888,
          clientOrderId: UNENUMERABLE,
          symbol: 'ENAUSDT',
          side: 'BUY',
          status: 'NEW',
        },
        {
          orderId: 8888,
          clientOrderId: 'a-strangers',
          symbol: 'SOLUSDT',
          side: 'SELL',
          status: 'NEW',
        },
      ],
      apply,
      slackDeps(vi.fn(async () => undefined)),
    );

    await handleDisposeProfile(deps, payload());

    const cancelled = apply.mock.calls
      .map((c) => c[2] as { type?: string; symbol?: string; orderId?: number })
      .filter((d) => d?.type === 'cancel-order');
    expect(cancelled).toEqual([expect.objectContaining({ symbol: 'ENAUSDT', orderId: 8888 })]);
  });

  it('either proof suffices: attribution alone claims an order the DB never recorded', async () => {
    // The DB lookup is an ADDITION, not a replacement. A protective stop whose id
    // trailing-trade can re-derive is ours even with no row at all — the bookkeeping-failure
    // path leaves exactly that.
    const repo = mkTtRepo(trailingTrade.defaultConfig, []);
    profileRepo.mockResolvedValue(repo);
    const apply = vi.fn(async () => ({ ok: true }) as const);
    const deps = ttDeps(
      [
        {
          orderId: 4242,
          clientOrderId: protectiveStopClientOrderId(PROFILE, 'ENAUSDT'),
          symbol: 'ENAUSDT',
          side: 'SELL',
          status: 'NEW',
        },
      ],
      apply,
    );

    await handleDisposeProfile(deps, payload());

    // Consulted (the DB is asked about every id on the book) and empty — the strategy's
    // own fingerprint is what claims this one.
    expect(repo.orders.listRecordedAmong).toHaveBeenCalled();
    expect(cancelledIds(apply)).toEqual([4242]);
  });

  it('a still-resting cancel is caught BEFORE the ownership check and still throws', async () => {
    // Ordering, not attribution: an order we cancelled in step 2 that Binance still shows
    // means the cancel never landed. It is trivially "ours" (we have a row for it), and
    // routing it into the cancel bucket would silently retry the cancel and then DELETE the
    // profile on a book we never re-read. It must throw so BullMQ retries the whole job.
    const repo = mkTtRepo(trailingTrade.defaultConfig, ['ENAUSDT:4242']);
    repo.orders.listLiveForProfile = vi
      .fn()
      .mockResolvedValueOnce([order()])
      .mockResolvedValueOnce([]) as never;
    profileRepo.mockResolvedValue(repo);
    const apply = vi.fn(async () => ({ ok: true }) as const);
    const deps = ttDeps(
      [
        {
          orderId: 4242,
          clientOrderId: UNENUMERABLE,
          symbol: 'ENAUSDT',
          side: 'SELL',
          status: 'NEW',
        },
      ],
      apply,
    );

    await expect(handleDisposeProfile(deps, payload())).rejects.toThrow(/still resting on Binance/);
    expect(repo.profile.deleteById).not.toHaveBeenCalled();
  });

  it('a stored config that no longer parses proves nothing: announce, never cancel', async () => {
    // Fail CLOSED. Attribution needs the profile's config to re-derive the id; if the
    // config no longer satisfies the strategy's schema we cannot prove the order is
    // ours, and an unproven order is never cancelled — only announced.
    const send = vi.fn(async () => undefined);
    const repo = mkTtRepo({ notAValidTrailingTradeConfig: true });
    repo.profileNotifiers.listForProfile = vi.fn(async () => [
      { provider: 'slack', config: {}, secrets: {}, enabled: true },
    ]) as never;
    profileRepo.mockResolvedValue(repo);
    const apply = vi.fn(async () => ({ ok: true }) as const);
    const deps = ttDeps(
      [
        {
          orderId: 8888,
          clientOrderId: protectiveStopClientOrderId(PROFILE, 'ENAUSDT'),
          symbol: 'ENAUSDT',
          side: 'SELL',
          status: 'NEW',
        },
      ],
      apply,
      {
        notifyRegistry: {
          get: (n: string) => (n === 'slack' ? { name: 'slack', send } : undefined),
          list: () => [{ name: 'slack', send }],
        } as unknown as DisposeDeps['notifyRegistry'],
      },
    );

    await handleDisposeProfile(deps, payload());

    expect(cancelledIds(apply)).toEqual([]);
    expect(send).toHaveBeenCalledOnce();
    expect(repo.profile.deleteById).toHaveBeenCalledOnce();
  });

  it('announces the residual even when cancelling an attributed ghost then fails', async () => {
    // The announce runs BEFORE the cancels: a transient Binance error on one cancel
    // throws (BullMQ retries, correctly), and a residual alert must not be collateral
    // damage of that — it is a pure notification that depends on nothing the cancels do.
    const send = vi.fn(async () => undefined);
    const repo = mkTtRepo();
    repo.profileNotifiers.listForProfile = vi.fn(async () => [
      { provider: 'slack', config: {}, secrets: {}, enabled: true },
    ]) as never;
    profileRepo.mockResolvedValue(repo);
    const apply = vi.fn(
      async () => ({ ok: false, retryable: true, reason: 'binance down' }) as const,
    );
    const deps = ttDeps(
      [
        {
          orderId: 8888,
          clientOrderId: protectiveStopClientOrderId(PROFILE, 'BTCUSDT'),
          symbol: 'BTCUSDT',
          side: 'SELL',
          status: 'NEW',
        },
        {
          orderId: 555,
          clientOrderId: 'never-recorded',
          symbol: 'ENAUSDT',
          side: 'SELL',
          status: 'NEW',
        },
      ],
      apply as never,
      {
        notifyRegistry: {
          get: (n: string) => (n === 'slack' ? { name: 'slack', send } : undefined),
          list: () => [{ name: 'slack', send }],
        } as unknown as DisposeDeps['notifyRegistry'],
      },
    );

    await expect(handleDisposeProfile(deps, payload())).rejects.toThrow(/retryable cancel failure/);

    expect(send).toHaveBeenCalledOnce();
    // The profile has no tracked live orders, so the cancel that failed IS the ghost —
    // and a ghost we PROVED is ours, left resting, is the whole incident. It must keep
    // the profile alive for the retry, exactly as a tracked order does.
    expect(cancelledIds(apply as never)).toEqual([8888]);
    expect(repo.profile.deleteById).not.toHaveBeenCalled();
  });

  it('a notifier outage never aborts a disposal that has already cancelled real orders', async () => {
    // The announce is best-effort by construction: by the time it runs we may have
    // cancelled orders on the exchange, and throwing here would DLQ a disposal whose
    // side effects are already live — for a Slack outage.
    const send = vi.fn(async () => {
      throw new Error('slack is down');
    });
    const repo = mkTtRepo();
    repo.profileNotifiers.listForProfile = vi.fn(async () => [
      { provider: 'slack', config: {}, secrets: {}, enabled: true },
    ]) as never;
    profileRepo.mockResolvedValue(repo);
    const deps = ttDeps(
      [
        {
          orderId: 555,
          clientOrderId: 'never-recorded',
          symbol: 'ENAUSDT',
          side: 'SELL',
          status: 'NEW',
        },
      ],
      vi.fn(async () => ({ ok: true }) as const),
      {
        notifyRegistry: {
          get: (n: string) => (n === 'slack' ? { name: 'slack', send } : undefined),
          list: () => [{ name: 'slack', send }],
        } as unknown as DisposeDeps['notifyRegistry'],
      },
    );

    await handleDisposeProfile(deps, payload());

    expect(send).toHaveBeenCalledOnce();
    expect(repo.profile.deleteById).toHaveBeenCalledOnce();
  });

  it('attributes against the MERGED config — an override that widens the grid still claims its own orders', async () => {
    // The order was MINTED from mergeConfig(profile.config, symbolRow.overrideConfig),
    // and TT enumerates its grid ids from `buy.gridLevels.length`. Attributing against
    // the bare profile config would fail to claim exactly the orders the override
    // created — and an unclaimed order of ours is an abandoned ghost.
    // The profile's own ladder is empty (TT's default), so it enumerates NO grid ids.
    // The per-symbol override adds a rung — and with it, one more claimable id.
    const widened = {
      buy: { gridLevels: [{ triggerPercentage: '1', maxPurchaseAmount: '100' }] },
    };
    expect(trailingTrade.defaultConfig.buy.gridLevels).toHaveLength(0);
    const repo = mkTtRepo();
    repo.profileSymbols.listForProfile = vi.fn(async () => [
      { symbol: 'ENAUSDT', baseAsset: 'ENA', overrideConfig: widened },
    ]) as never;
    profileRepo.mockResolvedValue(repo);
    const apply = vi.fn(async () => ({ ok: true }) as const);
    // Level 0 exists only under the MERGED config: unclaimable against the bare one.
    const deps = ttDeps(
      [
        {
          orderId: 606,
          clientOrderId: gridBuyClientOrderId(PROFILE, 'ENAUSDT', 0),
          symbol: 'ENAUSDT',
          side: 'BUY',
          status: 'NEW',
        },
      ],
      apply,
    );

    await handleDisposeProfile(deps, payload());

    expect(cancelledIds(apply)).toEqual([606]);
  });

  it("never announces the handoff TARGET's fresh stop as a residual of this delete", async () => {
    // Step 3 reconfigured the target, which armed its own protective stop on the
    // inherited symbol seconds ago. It attributes to the TARGET, so it is not ours to
    // cancel — but telling the operator "the bot has no record of placing them" about an
    // order the bot just placed is simply false.
    const send = vi.fn(async () => undefined);
    const source = mkTtRepo();
    source.profileNotifiers.listForProfile = vi.fn(async () => [
      { provider: 'slack', config: {}, secrets: {}, enabled: true },
    ]) as never;
    const target = mkRepo({}, TARGET);
    wire(source, target);
    const apply = vi.fn(async () => ({ ok: true }) as const);
    const positionStub = {
      position: {
        readPosition: (state: { avgEntryPrice?: string } | null) =>
          state?.avgEntryPrice == null ? null : { avgEntryPrice: state.avgEntryPrice },
      },
    };
    const deps = ttDeps(
      [
        {
          orderId: 4141,
          clientOrderId: protectiveStopClientOrderId(TARGET, 'ENAUSDT'),
          symbol: 'ENAUSDT',
          side: 'SELL',
          status: 'NEW',
        },
      ],
      apply,
      {
        strategies: {
          get: (n: string) => (n === 'trailing-trade' ? trailingTrade : positionStub),
        } as unknown as DisposeDeps['strategies'],
        notifyRegistry: {
          get: (n: string) => (n === 'slack' ? { name: 'slack', send } : undefined),
          list: () => [{ name: 'slack', send }],
        } as unknown as DisposeDeps['notifyRegistry'],
      },
    );

    await handleDisposeProfile(
      deps,
      payload({ disposition: 'handoff', toProfileId: TARGET } as Partial<DisposePayload>),
    );

    expect(send).not.toHaveBeenCalled();
    expect(cancelledIds(apply)).toEqual([]);
    expect(source.profile.deleteById).toHaveBeenCalledOnce();
  });

  it('a handoff reconfigures the TARGET — otherwise it never ticks the symbol, and re-enters on top of it', async () => {
    const target = mkRepo({}, TARGET);
    const source = mkRepo({
      profileSymbols: {
        listForProfile: vi.fn(async () => [
          { symbol: 'ENAUSDT', baseAsset: 'ENA', overrideConfig: null },
        ]),
        remove: vi.fn(),
        upsert: vi.fn(),
      },
      avgEntryPrices: {
        listForProfile: vi.fn(async () => [
          { symbol: 'ENAUSDT', avgEntryPrice: '0.30', quantity: '189.87' },
        ]),
        remove: vi.fn(),
        upsert: vi.fn(),
      },
    });
    wire(source, target);
    const reconfigure = vi.fn(async () => undefined);
    const deps = mkDeps({ reconfigure });

    await handleDisposeProfile(
      deps,
      payload({ disposition: 'handoff', toProfileId: TARGET } as Partial<DisposePayload>),
    );

    // Without this the target's ProfileManager snapshot never learns the symbol (no
    // tick is ever enqueued for it) and its strategy state is never seeded from the
    // moved cost-basis row (it would believe itself flat and buy again).
    expect(reconfigure).toHaveBeenCalledWith(
      expect.objectContaining({ profileId: TARGET, accountId: ACCOUNT }),
    );
  });

  it('rejects an order id Binance could never have issued rather than cancelling the wrong order', async () => {
    profileRepo.mockResolvedValue(
      mkRepo({
        orders: ordersDouble({
          listLiveForProfile: vi.fn(async () => [
            order({ binanceOrderId: 2n ** 63n }), // uint64, beyond a safe JS integer
          ]),
        }),
      }),
    );

    await expect(handleDisposeProfile(mkDeps(), payload())).rejects.toThrow(/safe integer/);
  });

  it('a vanished handoff target throws rather than strand the position', async () => {
    const target = mkRepo(
      { profile: { findById: vi.fn(async () => null), setEnabled: vi.fn(), deleteById: vi.fn() } },
      TARGET,
    );
    wire(mkRepo(), target);

    await expect(
      handleDisposeProfile(
        mkDeps(),
        payload({ disposition: 'handoff', toProfileId: TARGET } as Partial<DisposePayload>),
      ),
    ).rejects.toThrow(/target no longer exists/);
  });

  it('wipes every Redis key under the profile prefix', async () => {
    profileRepo.mockResolvedValue(mkRepo());
    const del = vi.fn(async () => 2);
    const redis = {
      // A real SCAN pages: a non-zero cursor first, then the terminal '0'.
      scan: vi
        .fn()
        .mockResolvedValueOnce(['7', ['k1', 'k2']])
        .mockResolvedValueOnce(['0', ['k3']]),
      del,
    } as unknown as DisposeDeps['redis'];

    await handleDisposeProfile(mkDeps({ redis }), payload());

    expect(del).toHaveBeenCalledTimes(2);
    expect(del).toHaveBeenCalledWith('k1', 'k2');
    expect(del).toHaveBeenCalledWith('k3');
  });

  it('a delete that matched no row is logged, not thrown (a concurrent disposal won)', async () => {
    const repo = mkRepo({
      profile: {
        findById: vi.fn(async () => ({ id: PROFILE, quoteAsset: 'USDT' })),
        setEnabled: vi.fn(async () => undefined),
        deleteById: vi.fn(async () => false),
      },
    });
    profileRepo.mockResolvedValue(repo);

    await expect(handleDisposeProfile(mkDeps(), payload())).resolves.toBeUndefined();
  });

  it('a crash mid-handoff rolls the whole thing back: the source keeps its position', async () => {
    // The atomicity assertion. The unbind MUST precede the bind (base-asset
    // exclusivity), so a non-transactional handoff that died in between would have
    // destroyed the very row the retry rebuilds its plan from: the retry would find
    // nothing to hand off, confirm the exchange clear, delete the profile, and
    // cascade the cost basis away — coins in the wallet, owned by nobody.
    const source = mkRepo({
      profileSymbols: {
        listForProfile: vi.fn(async () => [
          { symbol: 'ENAUSDT', baseAsset: 'ENA', overrideConfig: null },
        ]),
        remove: vi.fn(async () => undefined),
        upsert: vi.fn(),
      },
      avgEntryPrices: {
        listForProfile: vi.fn(async () => [
          { symbol: 'ENAUSDT', avgEntryPrice: '0.30', quantity: '189.87' },
        ]),
        remove: vi.fn(async () => undefined),
        upsert: vi.fn(),
      },
    });
    const target = mkRepo(
      {
        profileSymbols: {
          listForProfile: vi.fn(async () => []),
          remove: vi.fn(),
          // The bind dies: pg is gone, the pod is killed — whatever it is, it lands
          // between the source's unbind and the target's take.
          upsert: vi.fn(async () => {
            throw new Error('pg connection lost');
          }),
        },
        avgEntryPrices: { listForProfile: vi.fn(async () => []), remove: vi.fn(), upsert: vi.fn() },
      },
      TARGET,
    );
    wire(source, target);

    // A transaction that ROLLS BACK on a throw, like the real one: nothing the body
    // wrote is visible afterwards.
    const committed: string[] = [];
    const deps = mkDeps({
      db: {
        transaction: async (fn: (tx: unknown) => Promise<void>) => {
          try {
            await fn({});
            committed.push('commit');
          } catch (err) {
            committed.push('rollback');
            throw err;
          }
        },
      } as unknown as DisposeDeps['db'],
    });

    await expect(
      handleDisposeProfile(
        deps,
        payload({ disposition: 'handoff', toProfileId: TARGET } as Partial<DisposePayload>),
      ),
    ).rejects.toThrow(/pg connection lost/);

    expect(committed).toEqual(['rollback']);
    // The profile is still here, so the retry re-derives the whole plan from an
    // intact source. Nothing was deleted, nothing was stranded.
    expect(source.profile.deleteById).not.toHaveBeenCalled();
  });

  // A shared-wallet collision during the handoff: the base asset the position would bind
  // to is already owned by ANOTHER sibling — trading it (`SymbolOwnershipConflictError`)
  // or settling in it (`SiblingQuoteConflictError`). The target's `profileSymbols.upsert`
  // raises it, and its finders EXCLUDE the target, so the real owner is a THIRD profile
  // carried on the error (`ownerName`/`siblingName`), NOT the handoff target. No retry
  // clears it, so rethrowing dead-letters forever while the source can never be deleted.
  // The fix CATCHES both classes, names the REAL OWNER + base asset, states plainly that
  // the source was stopped and its orders cancelled so the position is unprotected, and
  // ACKS cleanly — the tx rolls back so the source keeps its position and its row is left
  // undeleted. A plain (non-conflict) throw is the boundary: it still propagates.
  const handoffConflict = (thrown: Error, targetName: string) => {
    const send = vi.fn(async () => undefined);
    const source = withSlack(
      mkRepo({
        profileSymbols: {
          listForProfile: vi.fn(async () => [
            { symbol: 'ENAUSDT', baseAsset: 'ENA', overrideConfig: null },
          ]),
          remove: vi.fn(async () => undefined),
          upsert: vi.fn(),
        },
        avgEntryPrices: {
          listForProfile: vi.fn(async () => [
            { symbol: 'ENAUSDT', avgEntryPrice: '0.30', quantity: '189.87' },
          ]),
          remove: vi.fn(async () => undefined),
          upsert: vi.fn(),
        },
      }),
    );
    const target = mkRepo(
      {
        profile: {
          // The handoff DESTINATION. Its name is deliberately DIFFERENT from the conflict
          // owner's name (baked into `thrown`), so a message that names the target instead
          // of the real owner — the bug — is caught.
          findById: vi.fn(async () => ({ id: TARGET, name: targetName, quoteAsset: 'USDT' })),
          setEnabled: vi.fn(),
          deleteById: vi.fn(),
        },
        profileSymbols: {
          listForProfile: vi.fn(async () => []),
          remove: vi.fn(),
          upsert: vi.fn(async () => {
            throw thrown;
          }),
        },
        avgEntryPrices: { listForProfile: vi.fn(async () => []), remove: vi.fn(), upsert: vi.fn() },
      },
      TARGET,
    );
    wire(source, target);
    const committed: string[] = [];
    const deps = mkDeps({
      db: {
        transaction: async (fn: (tx: unknown) => Promise<void>) => {
          try {
            await fn({});
            committed.push('commit');
          } catch (err) {
            committed.push('rollback');
            throw err;
          }
        },
      } as unknown as DisposeDeps['db'],
      ...slackDeps(send),
    });
    return { source, deps, committed, send };
  };

  const runHandoff = (deps: DisposeDeps) =>
    handleDisposeProfile(
      deps,
      payload({ disposition: 'handoff', toProfileId: TARGET } as Partial<DisposePayload>),
    );

  it('a base-asset collision on the handoff target is announced and ACKED, never dead-lettered', async () => {
    // Owner name ("gamma-owner") differs from the handoff target ("delta-target"): the
    // message must name the REAL owner from the error, not the target.
    const { source, deps, committed, send } = handoffConflict(
      new SymbolOwnershipConflictError('ENA', 'gamma-id', 'gamma-owner'),
      'delta-target',
    );

    // No throw: the conflict is a terminal, un-retryable state, so the job ACKS.
    await expect(runHandoff(deps)).resolves.toBeUndefined();

    // The tx rolled back and the source is intact and undeleted — its position stays.
    expect(committed).toEqual(['rollback']);
    expect(source.profile.deleteById).not.toHaveBeenCalled();
    // The operator hears the base asset, the REAL owner (not the target), the destination,
    // the owns-base wording, and the truth that the position is now unprotected.
    expect(send).toHaveBeenCalledOnce();
    const sent = JSON.stringify(send.mock.calls[0]);
    expect(sent).toContain('ENA');
    expect(sent).toContain('gamma-owner');
    expect(sent).toContain('delta-target');
    expect(sent).toContain('already trades ENA');
    expect(sent).toContain('unprotected');
  });

  it('a sibling-quote collision on the handoff target is announced and ACKED, never dead-lettered', async () => {
    const { source, deps, committed, send } = handoffConflict(
      new SiblingQuoteConflictError('ENA', 'gamma-id', 'gamma-quoter'),
      'delta-target',
    );

    await expect(runHandoff(deps)).resolves.toBeUndefined();

    expect(committed).toEqual(['rollback']);
    expect(source.profile.deleteById).not.toHaveBeenCalled();
    expect(send).toHaveBeenCalledOnce();
    const sent = JSON.stringify(send.mock.calls[0]);
    expect(sent).toContain('ENA');
    expect(sent).toContain('gamma-quoter');
    // Sibling-quote wording is distinct from the owns-base branch, and still truthful.
    expect(sent).toContain('funds its trades with ENA');
    expect(sent).toContain('unprotected');
  });

  it('a NON-conflict throw in the handoff still rolls back AND dead-letters — the boundary', async () => {
    // Only the two shared-wallet conflict classes ACK. Every other failure (a dropped
    // pg connection here) is transient or unknown, so it MUST propagate for BullMQ to
    // retry, and it MUST NOT fire the conflict announce.
    const { source, deps, committed, send } = handoffConflict(
      new Error('pg connection lost'),
      'irrelevant',
    );

    await expect(runHandoff(deps)).rejects.toThrow(/pg connection lost/);

    expect(committed).toEqual(['rollback']);
    expect(source.profile.deleteById).not.toHaveBeenCalled();
    expect(send).not.toHaveBeenCalled();
  });

  it('a position whose symbol binding is missing is still handed off, never silently dropped', async () => {
    // Dropping it from the plan would hand it to nobody and then cascade its cost
    // basis away on the delete. The base asset is re-derivable from the profile's
    // own quote asset, so derive it rather than lose the position.
    const source = mkRepo({
      profileSymbols: { listForProfile: vi.fn(async () => []), remove: vi.fn(), upsert: vi.fn() },
      avgEntryPrices: {
        listForProfile: vi.fn(async () => [
          { symbol: 'ENAUSDT', avgEntryPrice: '0.30', quantity: '189.87' },
        ]),
        remove: vi.fn(async () => undefined),
        upsert: vi.fn(),
      },
    });
    const target = mkRepo({}, TARGET);
    wire(source, target);

    await handleDisposeProfile(
      mkDeps(),
      payload({ disposition: 'handoff', toProfileId: TARGET } as Partial<DisposePayload>),
    );

    expect(target.profileSymbols.upsert).toHaveBeenCalledWith(
      'ENAUSDT',
      'ENA', // ENAUSDT minus the profile's USDT quote
      expect.anything(),
    );
    expect(target.avgEntryPrices.upsert).toHaveBeenCalledWith(
      'ENAUSDT',
      expect.objectContaining({ quantity: '189.87' }),
    );
  });

  it('a handoff whose seeding did NOT land keeps the source alive and throws — the retry seeds it', async () => {
    // `reconfigure`'s reconcile is fail-soft by design: a `getAccount` blip seeds
    // nothing and still returns. Deleting the source on the strength of that leaves
    // the target holding the coins while reading FLAT — no protective stop, a
    // duplicate entry BUY on the next signal — and with the source row gone, NO retry
    // can re-derive it. This is the one step whose failure is unrecoverable.
    const source = mkRepo({
      profileSymbols: {
        listForProfile: vi.fn(async () => [
          { symbol: 'ENAUSDT', baseAsset: 'ENA', overrideConfig: null },
        ]),
        remove: vi.fn(async () => undefined),
        upsert: vi.fn(),
      },
      avgEntryPrices: {
        listForProfile: vi.fn(async () => [
          { symbol: 'ENAUSDT', avgEntryPrice: '0.30', quantity: '189.87' },
        ]),
        findBySymbol: vi.fn(async () => null),
        remove: vi.fn(async () => undefined),
        upsert: vi.fn(),
      },
    });
    // The target now owns the cost basis (the handoff committed) but its state body
    // was never seeded — precisely the state a swallowed reconcile failure leaves.
    const unseeded = {
      listForProfile: vi.fn(async () => [{ symbol: 'ENAUSDT', avgEntryPrice: '0.30' }]),
      findBySymbol: vi.fn(async () => ({ symbol: 'ENAUSDT', avgEntryPrice: '0.30' })),
      remove: vi.fn(),
      upsert: vi.fn(async () => undefined),
    };
    const target = mkRepo(
      {
        avgEntryPrices: unseeded,
        symbolStates: { findBySymbol: vi.fn(async () => null) },
      },
      TARGET,
    );
    wire(source, target);

    await expect(
      handleDisposeProfile(
        mkDeps(),
        payload({ disposition: 'handoff', toProfileId: TARGET } as Partial<DisposePayload>),
      ),
    ).rejects.toThrow(/no priced position/);
    expect(source.profile.deleteById).not.toHaveBeenCalled();

    // The retry: the source is already stripped (so the plan is empty), reconfigure
    // runs again and this time the state IS seeded — the disposal completes.
    const strippedSource = mkRepo({
      profileSymbols: { listForProfile: vi.fn(async () => []), remove: vi.fn(), upsert: vi.fn() },
      avgEntryPrices: {
        listForProfile: vi.fn(async () => []),
        findBySymbol: vi.fn(async () => null),
        remove: vi.fn(),
        upsert: vi.fn(),
      },
    });
    const seededTarget = mkRepo({ avgEntryPrices: unseeded }, TARGET);
    wire(strippedSource, seededTarget);

    await handleDisposeProfile(
      mkDeps(),
      payload({ disposition: 'handoff', toProfileId: TARGET } as Partial<DisposePayload>),
    );

    expect(strippedSource.profile.deleteById).toHaveBeenCalledOnce();
  });

  it('hands off a HELD BUT UNPRICED symbol — a binding with no cost basis still owns coins', async () => {
    // The mirror of the missing-binding case. Cost-basis reconstruction can fail (a
    // throwing `getMyTrades`), leaving a bound symbol whose coins nothing prices.
    // Dropping it from the plan would cascade the binding away on delete and leave
    // the coins owned by nobody — the original incident.
    const source = mkRepo({
      profileSymbols: {
        listForProfile: vi.fn(async () => [
          { symbol: 'ENAUSDT', baseAsset: 'ENA', overrideConfig: null },
        ]),
        remove: vi.fn(async () => undefined),
        upsert: vi.fn(),
      },
      avgEntryPrices: {
        listForProfile: vi.fn(async () => []),
        findBySymbol: vi.fn(async () => null),
        remove: vi.fn(async () => undefined),
        upsert: vi.fn(),
      },
    });
    const target = mkRepo({}, TARGET);
    wire(source, target);

    await handleDisposeProfile(
      mkDeps(),
      payload({ disposition: 'handoff', toProfileId: TARGET } as Partial<DisposePayload>),
    );

    // The binding moves, so the coins are owned; there is no ledger row to move, and
    // the target's own reconcile prices it from trade history.
    expect(target.profileSymbols.upsert).toHaveBeenCalledWith('ENAUSDT', 'ENA', expect.anything());
    expect(target.avgEntryPrices.upsert).not.toHaveBeenCalled();
    expect(source.profile.deleteById).toHaveBeenCalledOnce();
  });

  it('an undecomposable symbol blocks a HANDOFF but never a cancel-orders delete', async () => {
    // `cancel-orders` is documented as "the coins become plain holdings" — abandoning
    // the position is what the operator explicitly asked for, and the base asset is
    // only ever needed to BIND the symbol to a target. Refusing there would
    // permanently DLQ a delete they chose, and protect nothing.
    const mkOddRepo = () =>
      mkRepo({
        profileSymbols: { listForProfile: vi.fn(async () => []), remove: vi.fn(), upsert: vi.fn() },
        avgEntryPrices: {
          // A symbol that does not end with the profile's USDT quote asset.
          listForProfile: vi.fn(async () => [
            { symbol: 'ETHBTC', avgEntryPrice: '0.05', quantity: '1' },
          ]),
          findBySymbol: vi.fn(async () => null),
          remove: vi.fn(),
          upsert: vi.fn(),
        },
      });

    const cancelSource = mkOddRepo();
    wire(cancelSource, mkRepo({}, TARGET));
    await handleDisposeProfile(mkDeps(), payload());
    expect(cancelSource.profile.deleteById).toHaveBeenCalledOnce();

    const handoffSource = mkOddRepo();
    wire(handoffSource, mkRepo({}, TARGET));
    await expect(
      handleDisposeProfile(
        mkDeps(),
        payload({ disposition: 'handoff', toProfileId: TARGET } as Partial<DisposePayload>),
      ),
    ).rejects.toThrow(/cannot resolve the base asset/);
    expect(handoffSource.profile.deleteById).not.toHaveBeenCalled();
  });
});

// The api enqueues this job from another package. A rename on either side of the
// seam would leave a profile that can never be deleted — and nothing would fail.
describe('parseDisposeProfileJob — the api→worker payload seam', () => {
  it('parses the exact payload the api enqueues', () => {
    const enqueuedByApi = {
      userId: USER,
      accountId: ACCOUNT,
      profileId: PROFILE,
      disposition: 'handoff',
      toProfileId: TARGET,
    };
    expect(parseDisposeProfileJob(enqueuedByApi)).toEqual({
      userId: USER,
      accountId: ACCOUNT,
      profileId: PROFILE,
      disposition: 'handoff',
      toProfileId: TARGET,
    });
  });

  it('refuses a payload with no (or an unknown) disposition rather than guess one', () => {
    const base = { userId: USER, accountId: ACCOUNT, profileId: PROFILE };
    expect(parseDisposeProfileJob(base)).toBeNull();
    expect(parseDisposeProfileJob({ ...base, disposition: 'delete-everything' })).toBeNull();
    expect(parseDisposeProfileJob({ ...base, disposition: 'cancel-orders' })).toMatchObject({
      disposition: 'cancel-orders',
    });
  });
});
