// reset-grid-trade handler: cancels live grid BUYs first, then clears the
// strategy's grid cycle through the per-(profile, symbol) StatePort (the same
// `symbol_states` store the tick reads), applying the strategy's position
// capability `clearPosition({ resetGridIndex: true })` — never naming a strategy
// field, never the dead profiles.state store. The clear is gated on the
// strategy declaring the `reset-grid` operator action (what the API enforces).
// Postgres is mocked via `profileRepo`; the reconcile/migrate/defer logic lives
// in the StatePort spine, so here the port is a spy and we assert routing.

import { describe, it, expect, vi, beforeEach } from 'vitest';
import type { AccountId, ProfileId, UserId } from '@app/contracts';
import type { PositionStateAdapter, StrategyRegistry } from '@app/strategy-core';
import type { StatePort } from '../../src/state/state-port.js';

const { profileRepoSpy } = vi.hoisted(() => ({ profileRepoSpy: vi.fn() }));
vi.mock('@app/db', async (importOriginal) => {
  const orig = await importOriginal<typeof import('@app/db')>();
  return { ...orig, profileRepo: profileRepoSpy };
});

const { handleResetGridTrade } =
  await import('../../src/queues/pipeline-handlers/reset-grid-trade.js');

const userId = 'u-1' as UserId;
const accountId = 'a-1' as AccountId;
const profileId = 'p-1' as ProfileId;
const payload = { userId, accountId, profileId, symbol: 'BTCUSDT' };

const listLiveForSymbol = vi.fn();
const removeAvgEntryPrice = vi.fn();
const findById = vi.fn();

const repo = {
  orders: { listLiveForSymbol },
  avgEntryPrices: { remove: removeAvgEntryPrice },
  profile: { findById },
};

const applySpy = vi.fn(async () => ({ ok: true as const }));
const mutate = vi.fn<StatePort['mutate']>(async () => undefined);

// Fake position capability: `clearPosition` clears the grid index only when
// asked (resetGridIndex), returns null for a body it does not recognise — same
// contract as the real TT adapter. Only `clearPosition` is exercised here.
const clearPosition = vi.fn((state: unknown, opts?: { resetGridIndex?: boolean }) =>
  state && typeof state === 'object' && (state as Record<string, unknown>)['schemaVersion'] === 'ok'
    ? { schemaVersion: 'ok', currentGridTradeIndex: opts?.resetGridIndex ? null : 4 }
    : null,
);
const position = { clearPosition } as unknown as PositionStateAdapter;

// `withResetGrid` toggles the `reset-grid` operator action, NOT the position
// adapter: the false case still has a position adapter (a momentum-like
// strategy) but does not declare `reset-grid`, so the handler must skip it —
// the authoritative capability gate, matching what the API enforces.
const makeStrategies = (withResetGrid: boolean): StrategyRegistry =>
  ({
    get: (name: string) =>
      name === 'trailing-trade'
        ? { position, capabilities: { operatorActions: withResetGrid ? ['reset-grid'] : [] } }
        : undefined,
  }) as unknown as StrategyRegistry;

const makeDeps = (withCapability = true) => ({
  db: {} as never,
  redis: {} as never,
  executor: { apply: applySpy } as never,
  clock: { nowMs: () => 1000 } as never,
  logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn() } as never,
  strategies: makeStrategies(withCapability),
  statePort: { mutate } as never,
});

beforeEach(() => {
  vi.clearAllMocks();
  profileRepoSpy.mockResolvedValue(repo);
  listLiveForSymbol.mockResolvedValue([]);
  findById.mockResolvedValue({ strategyName: 'trailing-trade', state: { schemaVersion: 'ok' } });
});

describe('handleResetGridTrade', () => {
  it('cancels live grid BUYs before clearing state', async () => {
    listLiveForSymbol.mockResolvedValue([
      { binanceOrderId: 123n, side: 'BUY', intent: 'grid-buy' },
      { binanceOrderId: 999n, side: 'SELL', intent: 'grid-sell' },
    ]);
    await handleResetGridTrade(makeDeps(), payload);
    expect(applySpy).toHaveBeenCalledOnce();
    expect(applySpy).toHaveBeenCalledWith(expect.anything(), accountId, {
      type: 'cancel-order',
      orderId: 123,
      reason: 'reset-grid-trade',
    });
    expect(removeAvgEntryPrice).toHaveBeenCalledWith('BTCUSDT');
  });

  it('clears the grid cycle through the symbol_states StatePort, not the dead profile store', async () => {
    await handleResetGridTrade(makeDeps(), payload);
    // Routed through statePort.mutate for this (profile, symbol) so the next
    // tick loads the reset symbol_states row. The old handler wrote
    // profiles.state, which the tick never reads — this assertion is the
    // red→green pin for that bug.
    expect(mutate).toHaveBeenCalledOnce();
    expect(mutate).toHaveBeenCalledWith(repo, 'BTCUSDT', expect.any(Function));
    // The mutator applies the strategy's grid-reset to the body the port hands
    // it (already reconciled to the current schema).
    const mutator = mutate.mock.calls[0]?.[2];
    expect(mutator).toBeDefined();
    expect(mutator?.({ schemaVersion: 'ok', currentGridTradeIndex: 4 })).toEqual({
      schemaVersion: 'ok',
      currentGridTradeIndex: null,
    });
    // The handler drives the grid-index reset specifically.
    expect(clearPosition).toHaveBeenCalledOnce();
    expect(clearPosition).toHaveBeenCalledWith(expect.anything(), { resetGridIndex: true });
  });

  it('skips the state clear for a strategy that does not declare the reset-grid action', async () => {
    // Momentum-like: has a position adapter but no `reset-grid` operator action,
    // so the gate must skip the state clear (only the generic ledger cleanup runs).
    await handleResetGridTrade(makeDeps(false), payload);
    expect(removeAvgEntryPrice).toHaveBeenCalledOnce();
    expect(mutate).not.toHaveBeenCalled();
  });

  it('returns early when the profile is gone', async () => {
    findById.mockResolvedValue(null);
    await handleResetGridTrade(makeDeps(), payload);
    expect(mutate).not.toHaveBeenCalled();
  });
});
