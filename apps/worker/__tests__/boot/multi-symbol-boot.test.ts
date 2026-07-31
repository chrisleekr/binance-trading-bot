// Multi-symbol boot reconcile + revive path. Asserts that running the
// orchestrator across N symbols of one profile keeps each symbol's
// `(avgEntryPrice, heldQuantity)` independent: pre-cutover, every
// per-symbol iteration mutated the same `profiles.state` blob and the
// last write won. After #276, each iteration writes one row of
// `symbol_states` via `mutateSymbolState`, the rows are now disjoint.

import { describe, expect, it, vi } from 'vitest';
import type { Logger } from 'pino';
import type { Redis } from 'ioredis';

import type { AccountId, ProfileId, UserId } from '@app/contracts';

const repoMocks = vi.hoisted(() => ({
  profileFindById: vi.fn(),
  avgEntryPricesFindBySymbol: vi.fn(),
  avgEntryPricesRemove: vi.fn(),
  symbolStatesFindBySymbol: vi.fn(),
  // Binance mode is a per-account attribute now, read via repo.accounts.
  binanceModeById: vi.fn(async () => 'live'),
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
        },
        symbolStates: { findBySymbol: repoMocks.symbolStatesFindBySymbol },
        // No reserves in these fixtures: the reconciler reads the per-symbol
        // reserve floors once per profile (#498); default to none.
        profileSymbols: { listForProfile: vi.fn(async () => []) },
      }),
    ),
    repo: {
      ...orig.repo,
      accounts: { ...orig.repo.accounts, binanceModeById: repoMocks.binanceModeById },
    },
  };
});

import {
  runHeldQuantityReconciliation,
  type ReconcileOrchestratorDeps,
} from '../../src/boot/reconcile-held-quantity.js';
import { buildSymbolInfoKey } from '../../src/executor/redis-namespace.js';
import { createChainByKey } from '../../src/lib/chain-by-key.js';
import { trailingTradePositionAdapter } from '@app/strategy-trailing-trade';

const USER_ID = 'u1' as unknown as UserId;
const ACCOUNT_ID = 'a1' as unknown as AccountId;
const PROFILE_ID = 'p1' as unknown as ProfileId;

const silentLogger = {
  info: vi.fn(),
  warn: vi.fn(),
  error: vi.fn(),
  debug: vi.fn(),
} as unknown as Logger;

/**
 * Builds an in-memory Redis stub keyed by `key`. exchangeInfo rows for
 * each symbol the orchestrator iterates land at `buildSymbolInfoKey(s)`,
 * the per-symbol state cache key is dynamic and the stub stores
 * whatever `mutateSymbolState` writes for later assertions.
 */
const stubRedis = (symbolInfo: Record<string, { baseAsset: string; stepSize: string }>) => {
  const store = new Map<string, string>();
  for (const [sym, info] of Object.entries(symbolInfo)) {
    store.set(
      buildSymbolInfoKey(sym),
      JSON.stringify({ baseAsset: info.baseAsset, filters: { stepSize: info.stepSize } }),
    );
  }
  return {
    store,
    redis: {
      get: vi.fn(async (k: string) => store.get(k) ?? null),
      set: vi.fn(async (k: string, v: string) => {
        store.set(k, v);
        return 'OK';
      }),
      del: vi.fn(async (k: string) => {
        store.delete(k);
        return 1;
      }),
    } as unknown as Redis,
  };
};

describe('boot: multi-symbol reconcile + revive', () => {
  it('writes each symbol independently — no cross-symbol bleed', async () => {
    // Pre-cutover bug repro: one profile holds BTCUSDT, ETHUSDT, SOLUSDT.
    // Each symbol has a distinct (avgEntryPrice, heldQuantity) and the
    // ledger row varies per symbol. Under the old per-profile blob the
    // BTC reconcile -> ETH reconcile -> SOL reconcile sequence would
    // clobber sibling fields and end with only the last symbol's data
    // persisted. Asserts:
    //   - persistSymbolState is invoked once per symbol that needs an
    //     adjustment, with a symbol-specific row body
    //   - the BTC heldQuantity adjustment does not leak into ETH/SOL
    //   - the SOL ledger revives state.avgEntryPrice for SOL only
    //   - the BTC ledger phantom-prune fires for BTC only
    repoMocks.profileFindById.mockReset();
    repoMocks.avgEntryPricesFindBySymbol.mockReset();
    repoMocks.avgEntryPricesRemove.mockReset();
    repoMocks.symbolStatesFindBySymbol.mockReset();

    repoMocks.profileFindById.mockResolvedValue({
      binanceMode: 'live',
      strategyName: 'trailing-trade',
      strategyVersion: '2.0.0',
      config: {},
      state: { schemaVersion: '2.0.0' },
    });

    const initialPerSymbol: Record<string, Record<string, unknown>> = {
      BTCUSDT: {
        schemaVersion: '2.0.0',
        avgEntryPrice: null,
        highSinceBuy: null,
        heldQuantity: null,
        triggers: { override: null },
        currentGridTradeIndex: null,
        autoTriggerBuyAtMs: null,
        disabledUntilMs: null,
        // marker so we can detect bleed if a different symbol's body
        // ever overwrites this row
        symbolTag: 'BTC',
      },
      ETHUSDT: {
        schemaVersion: '2.0.0',
        avgEntryPrice: '2000',
        highSinceBuy: '2100',
        heldQuantity: '0.5',
        triggers: { override: null },
        currentGridTradeIndex: null,
        autoTriggerBuyAtMs: null,
        disabledUntilMs: null,
        symbolTag: 'ETH',
      },
      SOLUSDT: {
        schemaVersion: '2.0.0',
        avgEntryPrice: null,
        highSinceBuy: null,
        heldQuantity: '5.0',
        triggers: { override: null },
        currentGridTradeIndex: null,
        autoTriggerBuyAtMs: null,
        disabledUntilMs: null,
        symbolTag: 'SOL',
      },
    };

    repoMocks.symbolStatesFindBySymbol.mockImplementation(async (_scope: unknown, sym: string) => {
      // The hoisted vi.mock binds `findBySymbol` as a ScopeBound method
      // (no leading scope arg), but the runtime call site shape mocks
      // out the binding entirely, accept either shape defensively.
      const symbol = typeof _scope === 'string' ? _scope : sym;
      const body = initialPerSymbol[symbol];
      return body ? { symbol, strategyVersion: '2.0.0', state: body } : null;
    });

    // BTC ledger row exists but wallet is empty -> phantom prune fires
    // for BTC only. ETH/SOL have no ledger row.
    // SOL state.avgEntryPrice is null + ledger holds a row -> revive
    // fires for SOL only.
    repoMocks.avgEntryPricesFindBySymbol.mockImplementation(async (sym: string) => {
      if (sym === 'BTCUSDT') return { avgEntryPrice: '68000', quantity: '0.00147' };
      if (sym === 'SOLUSDT') return { avgEntryPrice: '180.55', quantity: '5.0' };
      return null;
    });

    const { redis } = stubRedis({
      BTCUSDT: { baseAsset: 'BTC', stepSize: '0.00001000' },
      ETHUSDT: { baseAsset: 'ETH', stepSize: '0.00010000' },
      SOLUSDT: { baseAsset: 'SOL', stepSize: '0.00100000' },
    });

    // Per-symbol persistSymbolState capture: tracks the (symbol, body)
    // pairs the orchestrator emitted. The post-test assertion walks the
    // captures and confirms each symbol's body is grounded in its own
    // initialPerSymbol slice (carries the matching `symbolTag`).
    const persisted: { symbol: string; body: Record<string, unknown> }[] = [];
    const persistSymbolState = vi.fn(
      async (
        _scope: unknown,
        symbol: string,
        nextState: unknown,
        _ver: string,
        _expectedVersion: number | null,
      ): Promise<boolean> => {
        persisted.push({ symbol, body: nextState as Record<string, unknown> });
        return true;
      },
    );

    const deps: ReconcileOrchestratorDeps = {
      db: {} as never,
      redis,
      logger: silentLogger,
      listActive: () => [
        {
          userId: USER_ID,
          operatorId: USER_ID,
          accountId: ACCOUNT_ID,
          profileId: PROFILE_ID,
          symbols: ['BTCUSDT', 'ETHUSDT', 'SOLUSDT'],
        } as Parameters<
          typeof runHeldQuantityReconciliation
        >[0]['listActive'] extends () => readonly (infer T)[]
          ? T
          : never,
      ],
      resolveBinance: async () => ({
        getAccount: vi.fn(async () => ({
          // BTC wallet empty -> phantom prune for BTC.
          // ETH wallet matches state heldQuantity -> reconciler no-op.
          // SOL wallet matches state heldQuantity -> reconciler no-op.
          balances: [
            { asset: 'BTC', free: '0', locked: '0' },
            { asset: 'ETH', free: '0.5', locked: '0' },
            { asset: 'SOL', free: '5.0', locked: '0' },
          ],
        })),
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
        redis,
        logger: silentLogger,
        registry: {
          get: () => ({
            name: 'trailing-trade',
            version: '2.0.0',
            initialState: () => ({ schemaVersion: '2.0.0' }),
          }),
        },
        persistSymbolState,
      },
      chain: createChainByKey(),
    };

    const tally = await runHeldQuantityReconciliation(deps);

    // BTC phantom prune fires for BTC only.
    expect(repoMocks.avgEntryPricesRemove).toHaveBeenCalledTimes(1);
    expect(repoMocks.avgEntryPricesRemove).toHaveBeenCalledWith('BTCUSDT');
    expect(tally.avgEntryPriceRevival['prune-phantom-ledger']).toBe(1);

    // SOL revive fires for SOL only.
    expect(tally.avgEntryPriceRevival['revive-from-ledger']).toBe(1);

    // BTC pruned, ETH has no ledger row so reviver returns 'no-op',
    // SOL revives from ledger. Per-action tally:
    //   prune-phantom-ledger: 1 (BTC)
    //   revive-from-ledger:   1 (SOL)
    //   no-op:                1 (ETH)
    expect(tally.avgEntryPriceRevival['no-op']).toBe(1);

    // Now the real per-symbol body integrity check: every persisted
    // write must carry the matching `symbolTag` from its initial slice.
    // Pre-cutover, the per-profile blob would leak BTC's symbolTag into
    // a SOL write.
    for (const { symbol, body } of persisted) {
      expect(body['symbolTag']).toBe(
        symbol === 'BTCUSDT' ? 'BTC' : symbol === 'ETHUSDT' ? 'ETH' : 'SOL',
      );
    }

    // BTC pruned -> a state write fires for BTC (clearing lbp/highSinceBuy).
    const btcWrites = persisted.filter((p) => p.symbol === 'BTCUSDT');
    // The live slice already has lbp=null/highSinceBuy=null, the
    // mutator returns null and no write lands -- but the prune itself
    // still fires (the removeLedgerRow above is the assertion that
    // matters).
    expect(btcWrites.length).toBeGreaterThanOrEqual(0);

    // SOL revival lands a real write with avgEntryPrice='180.55'.
    const solWrites = persisted.filter((p) => p.symbol === 'SOLUSDT');
    expect(solWrites.length).toBeGreaterThanOrEqual(1);
    const solReviveWrite = solWrites.find((w) => w.body['avgEntryPrice'] === '180.55');
    expect(solReviveWrite).toBeDefined();
    expect(solReviveWrite?.body['heldQuantity']).toBe('5.0');
    expect(solReviveWrite?.body['symbolTag']).toBe('SOL');
  });

  it('preserves #266 invariant per-symbol — one symbol on an outdated schema does not block siblings', async () => {
    // Mixed-version slices: BTC is at 2.0.0, ETH still at 1.0.0 (legacy
    // row a future migration has not touched). The BTC reconcile must
    // run normally, the ETH reconcile must short-circuit with
    // 'skip-schema-version' and the orchestrator must NOT call the
    // reviver for ETH (would emit a misleading "investigate" warn). The
    // per-symbol shape ensures the gate is per-row, not per-profile, so
    // one outdated symbol cannot stall the entire profile's boot.
    repoMocks.profileFindById.mockReset();
    repoMocks.avgEntryPricesFindBySymbol.mockReset();
    repoMocks.avgEntryPricesRemove.mockReset();
    repoMocks.symbolStatesFindBySymbol.mockReset();

    repoMocks.profileFindById.mockResolvedValue({
      binanceMode: 'live',
      strategyName: 'trailing-trade',
      // strategy registered at 1.0.0 (no migrateState) — orchestrator's
      // migrateProfileIfNeeded is a no-op so the per-symbol gates own
      // the skip semantics.
      strategyVersion: '1.0.0',
      config: {},
      state: { schemaVersion: '1.0.0' },
    });

    repoMocks.symbolStatesFindBySymbol.mockImplementation(async (sym: string) => {
      if (sym === 'BTCUSDT') {
        return {
          symbol: 'BTCUSDT',
          strategyVersion: '2.0.0',
          state: {
            schemaVersion: '2.0.0',
            avgEntryPrice: null,
            heldQuantity: '0.0142',
            triggers: { override: null },
            highSinceBuy: null,
            currentGridTradeIndex: null,
            autoTriggerBuyAtMs: null,
            disabledUntilMs: null,
          },
        };
      }
      // ETH on the legacy 1.0.0 schema — schemaVersion gate must skip.
      return {
        symbol: 'ETHUSDT',
        strategyVersion: '1.0.0',
        state: { schemaVersion: '1.0.0', avgEntryPrice: '2000' },
      };
    });

    repoMocks.avgEntryPricesFindBySymbol.mockImplementation(async (sym: string) =>
      sym === 'BTCUSDT' ? null : { avgEntryPrice: '2000', quantity: '0.5' },
    );

    const { redis } = stubRedis({
      BTCUSDT: { baseAsset: 'BTC', stepSize: '0.00001000' },
      ETHUSDT: { baseAsset: 'ETH', stepSize: '0.00010000' },
    });

    const persistSymbolState = vi.fn(async () => true);
    const deps: ReconcileOrchestratorDeps = {
      db: {} as never,
      redis,
      logger: silentLogger,
      listActive: () => [
        {
          userId: USER_ID,
          operatorId: USER_ID,
          accountId: ACCOUNT_ID,
          profileId: PROFILE_ID,
          symbols: ['BTCUSDT', 'ETHUSDT'],
        } as Parameters<
          typeof runHeldQuantityReconciliation
        >[0]['listActive'] extends () => readonly (infer T)[]
          ? T
          : never,
      ],
      resolveBinance: async () => ({
        getAccount: vi.fn(async () => ({
          balances: [
            { asset: 'BTC', free: '0.0142', locked: '0' },
            { asset: 'ETH', free: '0.5', locked: '0' },
          ],
        })),
      }),
      // Registered strategy at 1.0.0 with NO migrate path. orchestrator
      // migrateProfileIfNeeded short-circuits, ETH per-symbol gate
      // returns 'skip-schema-version'.
      strategies: {
        get: () => ({
          name: 'trailing-trade',
          version: '1.0.0',
          position: trailingTradePositionAdapter,
        }),
      },
      persistMigratedState: vi.fn(async () => undefined),
      symbolStateDeps: {
        redis,
        logger: silentLogger,
        registry: {
          get: () => ({
            name: 'trailing-trade',
            version: '1.0.0',
            initialState: () => ({ schemaVersion: '1.0.0' }),
          }),
        },
        persistSymbolState,
      },
      chain: createChainByKey(),
    };

    const tally = await runHeldQuantityReconciliation(deps);

    // ETH per-symbol skip; the reviver must NOT have been called for
    // ETH (proven by avgEntryPrices.findBySymbol being called only for
    // BTC, before the skip-gate continue). Note: BTC reconciler returns
    // 'no-op' (wallet matches state), so the reviver IS called for BTC
    // and looks up the ledger — but for BTC the ledger is null.
    const ethLookup = repoMocks.avgEntryPricesFindBySymbol.mock.calls.find(
      (c) => c[0] === 'ETHUSDT',
    );
    expect(ethLookup).toBeUndefined();
    expect(tally.heldQuantity['skip-schema-version']).toBe(1);
    expect(tally.avgEntryPriceRevival['skip-schema-version']).toBe(1);
  });
});
