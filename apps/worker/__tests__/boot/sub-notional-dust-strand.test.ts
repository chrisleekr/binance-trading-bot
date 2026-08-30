import { describe, expect, it, vi } from 'vitest';
import type { Logger } from 'pino';
import type { Redis } from 'ioredis';

import type { MyTradeDto } from '@app/binance';
import type { AccountId, ProfileId, UserId } from '@app/contracts';
import type { ProfileScope } from '@app/db';
import { TTStateSchema, trailingTradePositionAdapter } from '@app/strategy-trailing-trade';

import {
  ensureCostBasisFromTrades,
  reconcileHeldQuantity,
  resolveWalletFields,
  type BinanceAccountClient,
  type ReconcileOrchestratorDeps,
  type ReconcileSymbolTarget,
} from '../../src/boot/reconcile-held-quantity.js';
import { isPhantomLedgerRow } from '../../src/boot/revive-avg-entry-price.js';
import { openPositionFromFills } from '../../src/queues/pipeline-handlers/open-position-from-fills.js';

// The live ENAUSDT strand, in the exchange's own numbers. The wallet holds 0.01184 ENA of untracked dust that predates the cycle: 1.18 LOT_SIZE steps wide, so every increment-only bound waves it through, and worth USD 0.00137 against a USD 5 NOTIONAL floor, so no sell can ever be placed for it.
const ENA = {
  symbol: 'ENAUSDT',
  baseAsset: 'ENA',
  wallet: '0.01184',
  stepSize: '0.01',
  minNotional: '5',
  referencePrice: '0.1158',
} as const;

const USER_ID = 'u1' as unknown as UserId;
const ACCOUNT_ID = 'a1' as unknown as AccountId;
const PROFILE_ID = 'p1' as unknown as ProfileId;
const SCOPE = {
  userId: USER_ID,
  accountId: ACCOUNT_ID,
  profileId: PROFILE_ID,
} as unknown as ProfileScope;

const fakeLogger = {
  info: vi.fn(),
  warn: vi.fn(),
  error: vi.fn(),
  debug: vi.fn(),
} as unknown as Logger;

describe('sub-notional dust strand: the converged row no pass can clear', () => {
  it('flattens a tracked position that has converged onto sub-notional dust', () => {
    // Held and wallet agree exactly, which is what makes this unrecoverable rather than merely wrong: the difference band short-circuits before either dust bound is consulted, so the row survives every reconcile pass forever while the strategy claims a position worth USD 0.00137 that no exit order can close.
    const result = reconcileHeldQuantity({
      heldQuantity: ENA.wallet,
      walletFree: ENA.wallet,
      walletLocked: '0',
      stepSize: ENA.stepSize,
      minNotional: ENA.minNotional,
      referencePrice: ENA.referencePrice,
    });
    expect(result.nextHeldQuantity).toBeNull();
    expect(result.action).not.toBe('no-op');
  });

  it('prunes a position claim the wallet backs only with sub-notional dust', () => {
    // The prune's wallet test is increment-only, so 1.18 steps reads as a real holding and the ledger row plus the state claim both survive. Valuing the same balance is the only thing that separates the smallest LEGAL position from a crumb that is 1.18 steps wide and worth a tenth of a cent.
    const input = {
      ledgerAvgEntryPrice: '0.4587',
      stateAvgEntryPrice: '0.4587',
      walletQuantity: ENA.wallet,
      stepSize: ENA.stepSize,
      minNotional: ENA.minNotional,
      referencePrice: ENA.referencePrice,
      preReconcileHeldQuantity: ENA.wallet,
    };
    expect(isPhantomLedgerRow(input)).toBe(true);
  });

  it('refuses to reconstruct a position out of pure base-asset commission', () => {
    // Every buy paid its Binance fee in ENA, so the account received 0.29 ENA less than each fill's `qty` line claims. The walk sums the GROSS qty and the sells can only ever return what was actually received, leaving a 0.87 ENA residue that the wallet never held. Reconstructing a cost basis from it invents a position out of fee accounting.
    const fills = [
      fill({
        id: 1,
        time: 1000,
        qty: '100',
        quoteQty: '45.87',
        isBuyer: true,
        commission: '0.29',
        commissionAsset: 'ENA',
      }),
      fill({
        id: 2,
        time: 2000,
        qty: '100',
        quoteQty: '45.87',
        isBuyer: true,
        commission: '0.29',
        commissionAsset: 'ENA',
      }),
      fill({
        id: 3,
        time: 3000,
        qty: '100',
        quoteQty: '45.87',
        isBuyer: true,
        commission: '0.29',
        commissionAsset: 'ENA',
      }),
      // The exit sold everything the account actually received: 300 gross minus 0.87 of base-asset commission.
      fill({ id: 4, time: 4000, qty: '299.13', quoteQty: '150', isBuyer: false }),
    ];
    expect(openPositionFromFills(fills, ENA.baseAsset)).toBeNull();
  });

  it('refuses to adopt a sub-notional wallet balance as a fresh position', async () => {
    // The adoption gate gives the wallet only the increment test, so a balance that clears one step is reconstructed and written to the ledger even when it is worth a fraction of one minimum order. That write is what re-creates the strand after the cycle archive already closed it.
    const persisted: { symbol: string; state: unknown }[] = [];
    const { scope, upsert } = makeScope(null, null);
    const getMyTrades = vi.fn(async () => [
      fill({ id: 1, time: 1000, qty: '0.87', quoteQty: '0.399', isBuyer: true }),
    ]);

    const action = await ensureCostBasisFromTrades(
      { logger: fakeLogger, symbolStateDeps: symbolStateDeps(persisted) },
      scope,
      trailingTradePositionAdapter,
      client(getMyTrades),
      enaTarget(),
    );

    expect(action).toBe('no-op');
    expect(upsert).not.toHaveBeenCalled();
    expect(persisted).toHaveLength(0);
  });
});

describe('sub-notional dust strand: what the value bound must never touch', () => {
  // One LOT_SIZE step of a high-priced asset is worth USD 10 against a USD 5 floor. On many alts `minQty == stepSize`, so this is the smallest position that can legally be bought, and every predicate the fix touches has to leave it alone.
  const SMALLEST_LEGAL = {
    wallet: '0.001',
    stepSize: '0.001',
    minNotional: '5',
    referencePrice: '10000',
  } as const;

  it('leaves the smallest legally-tradeable position alone', () => {
    const converged = reconcileHeldQuantity({
      heldQuantity: SMALLEST_LEGAL.wallet,
      walletFree: SMALLEST_LEGAL.wallet,
      walletLocked: '0',
      stepSize: SMALLEST_LEGAL.stepSize,
      minNotional: SMALLEST_LEGAL.minNotional,
      referencePrice: SMALLEST_LEGAL.referencePrice,
    });
    expect(converged.nextHeldQuantity).toBe(SMALLEST_LEGAL.wallet);

    expect(
      isPhantomLedgerRow({
        preReconcileHeldQuantity: null,
        ledgerAvgEntryPrice: '10000',
        stateAvgEntryPrice: '10000',
        walletQuantity: SMALLEST_LEGAL.wallet,
        stepSize: SMALLEST_LEGAL.stepSize,
        minNotional: SMALLEST_LEGAL.minNotional,
        referencePrice: SMALLEST_LEGAL.referencePrice,
      }),
    ).toBe(false);

    const seeded = reconcileHeldQuantity({
      heldQuantity: null,
      walletFree: SMALLEST_LEGAL.wallet,
      walletLocked: '0',
      stepSize: SMALLEST_LEGAL.stepSize,
      minNotional: SMALLEST_LEGAL.minNotional,
      referencePrice: SMALLEST_LEGAL.referencePrice,
    });
    expect(seeded.action).toBe('seed-from-wallet');
  });

  it('leaves an idle zero-quantity claim to the no-op band', () => {
    // `isValuelessResidue(0, …)` is trivially true, so a claim of exactly zero satisfies the flatten's value test on its own. Nothing here is a position: no cost basis to drop, no ledger row worth a DELETE, and no reason to emit the "dropping its cost basis" warn or a `reconcile_position_removed_total` increment. `valueBoundDisarmReason` already reads a zero claim as not-a-claim and the two must agree.
    expect(
      reconcileHeldQuantity({
        heldQuantity: '0',
        walletFree: '0',
        walletLocked: '0',
        stepSize: '0.01',
        minNotional: '5',
        referencePrice: '0.11',
      }),
    ).toEqual({ action: 'no-op', nextHeldQuantity: '0' });
  });

  it('does not null a real position because the FREE leg alone reads as a crumb', () => {
    // 0.5 free of a 100-unit holding worth 100 against a floor of 5, the rest resting on the book as an exit order. Asked of `free` alone the crumb share is 0.5% and the value 0.5, so the dust rule would fire and delete the claim. Both halves read `free + locked`, where the holding is the whole 100 and no bound applies.
    expect(
      reconcileHeldQuantity({
        ...resolveWalletFields({ free: '0.5', locked: '99.5' }),
        heldQuantity: '100',
        stepSize: '0.01',
        minNotional: '5',
        referencePrice: '1',
      }),
    ).toEqual({ action: 'no-op', nextHeldQuantity: '100' });

    // The genuine crumb is still caught: with nothing locked, `free + locked` IS the crumb.
    expect(
      reconcileHeldQuantity({
        ...resolveWalletFields({ free: ENA.wallet, locked: '0' }),
        heldQuantity: '421.30',
        stepSize: ENA.stepSize,
        minNotional: ENA.minNotional,
        referencePrice: ENA.referencePrice,
      }).nextHeldQuantity,
    ).toBeNull();
  });

  it('treats a non-finite minNotional as no floor at all', () => {
    // `decimal.js` parses `Infinity` rather than throwing, and every finite holding is below an infinite floor. Parsing it as a value would arm the delete against a real position, so it has to disarm like any other missing input.
    expect(
      reconcileHeldQuantity({
        heldQuantity: '100',
        walletFree: '100',
        walletLocked: '0',
        stepSize: '0.01',
        minNotional: 'Infinity',
        referencePrice: '1',
      }),
    ).toEqual({ action: 'no-op', nextHeldQuantity: '100' });
  });

  it('disarms every value bound when no price is cached', async () => {
    // A null `referencePrice` is the honest "no ticker to trust" answer, and the bound only ever REMOVES a position, so guessing a price here could delete a real one. With no price the increment bound decides alone, which is the historical behaviour these four assertions pin: a later change that starts inferring a price fails here.
    const converged = reconcileHeldQuantity({
      heldQuantity: ENA.wallet,
      walletFree: ENA.wallet,
      walletLocked: '0',
      stepSize: ENA.stepSize,
      minNotional: ENA.minNotional,
      referencePrice: null,
    });
    expect(converged).toEqual({ action: 'no-op', nextHeldQuantity: ENA.wallet });

    expect(
      isPhantomLedgerRow({
        preReconcileHeldQuantity: null,
        ledgerAvgEntryPrice: '0.4587',
        stateAvgEntryPrice: '0.4587',
        walletQuantity: ENA.wallet,
        stepSize: ENA.stepSize,
        minNotional: ENA.minNotional,
        referencePrice: null,
      }),
    ).toBe(false);

    const seeded = reconcileHeldQuantity({
      heldQuantity: null,
      walletFree: ENA.wallet,
      walletLocked: '0',
      stepSize: ENA.stepSize,
      minNotional: ENA.minNotional,
      referencePrice: null,
    });
    expect(seeded).toEqual({ action: 'seed-from-wallet', nextHeldQuantity: ENA.wallet });

    const persisted: { symbol: string; state: unknown }[] = [];
    const { scope, upsert } = makeScope(null, null);
    const action = await ensureCostBasisFromTrades(
      { logger: fakeLogger, symbolStateDeps: symbolStateDeps(persisted) },
      scope,
      trailingTradePositionAdapter,
      client(
        vi.fn(async () => [
          fill({ id: 1, time: 1000, qty: '0.87', quoteQty: '0.399', isBuyer: true }),
        ]),
      ),
      enaTarget({ referencePrice: null }),
    );
    expect(action).toBe('reconstructed-from-trades');
    expect(upsert).toHaveBeenCalledTimes(1);
  });
});

/** Minimal fill factory mirroring the one the `openPositionFromFills` suite uses: only the fields the average-cost walk reads matter, the rest carry inert defaults so each case names just what it varies. */
const fill = (
  over: Partial<MyTradeDto> & Pick<MyTradeDto, 'id' | 'time' | 'qty' | 'isBuyer'>,
): MyTradeDto => ({
  orderId: over.id,
  symbol: ENA.symbol,
  price: '0',
  quoteQty: '0',
  commission: '0',
  commissionAsset: 'USDT',
  isMaker: false,
  ...over,
});

const enaTarget = (o?: Partial<ReconcileSymbolTarget>): ReconcileSymbolTarget => ({
  userId: USER_ID,
  profileId: PROFILE_ID,
  symbol: ENA.symbol,
  baseAsset: ENA.baseAsset,
  stepSize: ENA.stepSize,
  minNotional: ENA.minNotional,
  referencePrice: ENA.referencePrice,
  walletFree: ENA.wallet,
  walletLocked: '0',
  ...o,
});

const client = (getMyTrades: BinanceAccountClient['getMyTrades']): BinanceAccountClient =>
  ({ getAccount: vi.fn(), getMyTrades }) as unknown as BinanceAccountClient;

const stubRedis = (): Redis => {
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

/** Records every state body the mutate path persists, so "no state mutate" is asserted on the write itself rather than on a proxy for it. */
const symbolStateDeps = (
  persisted: { symbol: string; state: unknown }[],
): ReconcileOrchestratorDeps['symbolStateDeps'] =>
  ({
    redis: stubRedis(),
    logger: fakeLogger,
    registry: {
      get: () => ({
        name: 'trailing-trade',
        version: '2.0.0',
        initialState: () => TTStateSchema.parse({ schemaVersion: '2.0.0' }),
      }),
    },
    persistSymbolState: vi.fn(async (_scope: unknown, symbol: string, state: unknown) => {
      persisted.push({ symbol, state });
      return true;
    }),
  }) as unknown as ReconcileOrchestratorDeps['symbolStateDeps'];

type Scope = Awaited<ReturnType<typeof import('@app/db').profileRepo>>;

const makeScope = (
  row: { state: unknown } | null,
  ledger: { avgEntryPrice: string; quantity: string } | null,
): { scope: Scope; upsert: ReturnType<typeof vi.fn> } => {
  const upsert = vi.fn(async () => undefined);
  const scope = {
    scope: SCOPE,
    profile: { findById: vi.fn(async () => ({ strategyName: 'trailing-trade', config: {} })) },
    avgEntryPrices: { findBySymbol: vi.fn(async () => ledger), upsert },
    symbolStates: { findBySymbol: vi.fn(async () => row) },
  } as unknown as Scope;
  return { scope, upsert };
};
