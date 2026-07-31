import { describe, expect, it, vi } from 'vitest';
import type { Logger } from 'pino';

import { trailingTradePositionAdapter } from '@app/strategy-trailing-trade';

import {
  isPhantomLedgerRow,
  reviveAvgEntryPrice,
  reviveAvgEntryPriceForTarget,
} from '../../src/boot/revive-avg-entry-price.js';

const silentLogger = {
  info: vi.fn(),
  warn: vi.fn(),
  error: vi.fn(),
  debug: vi.fn(),
} as unknown as Logger;

describe('reviveAvgEntryPrice (pure core)', () => {
  it('no-ops when the ledger has no row', () => {
    const result = reviveAvgEntryPrice({
      stateAvgEntryPrice: null,
      ledgerAvgEntryPrice: null,
    });
    expect(result).toEqual({ action: 'no-op', nextAvgEntryPrice: null });
  });

  it('no-ops when state already carries a value (never overwrites a live state with a stale ledger snapshot)', () => {
    const result = reviveAvgEntryPrice({
      stateAvgEntryPrice: '50000.0',
      ledgerAvgEntryPrice: '76710.286591784951732000',
    });
    expect(result).toEqual({ action: 'no-op', nextAvgEntryPrice: null });
  });

  it('revives state from the ledger when state is null and the ledger has a row', () => {
    const result = reviveAvgEntryPrice({
      stateAvgEntryPrice: null,
      ledgerAvgEntryPrice: '76710.286591784951732000',
    });
    expect(result).toEqual({
      action: 'revive-from-ledger',
      nextAvgEntryPrice: '76710.286591784951732000',
    });
  });
});

describe('reviveAvgEntryPriceForTarget (persist-side wrapper)', () => {
  /**
   * Fake `mutate` that invokes the wrapper's mutator immediately with
   * the target's state snapshot, mirroring what `mutateSymbolState`
   * does in production (call the mutator on the post-migration live
   * body). The captured `next` is the projected mutator output.
   */
  const buildDeps = (liveState?: unknown) => {
    const written: unknown[] = [];
    const mutate = vi.fn(async (_sym: string, mutator: (s: unknown) => unknown | null) => {
      const next = mutator(liveState ?? null);
      if (next !== null) written.push(next);
    });
    const removeLedgerRow = vi.fn(async (_u: string, _p: string, _s: string) => undefined);
    return {
      mutate,
      removeLedgerRow,
      written,
      deps: {
        logger: silentLogger,
        mutate,
        removeLedgerRow,
        position: trailingTradePositionAdapter,
      },
    };
  };

  const target = (overrides: Partial<Parameters<typeof reviveAvgEntryPriceForTarget>[1]> = {}) => ({
    userId: 'u1',
    profileId: 'p1',
    symbol: 'BTCUSDT',
    state: { schemaVersion: '2.0.0', avgEntryPrice: null, heldQuantity: '0.5' },
    ledgerAvgEntryPrice: null as string | null,
    ledgerQuantity: null as string | null,
    // Default: the wallet BACKS the position, so the phantom prune never fires and
    // these cases exercise the revive path they are about.
    walletQuantity: '0.5' as string | null,
    stepSize: '0.00001000',
    ...overrides,
  });

  it('writes the revived state via mutate when state is null and ledger has a row', async () => {
    const state = {
      schemaVersion: '2.0.0',
      avgEntryPrice: null,
      highSinceBuy: null,
      heldQuantity: '0.0142',
      currentGridTradeIndex: null,
      extraField: 'preserved',
    };
    const { mutate, written, deps } = buildDeps(state);
    const action = await reviveAvgEntryPriceForTarget(
      deps,
      target({
        state,
        ledgerAvgEntryPrice: '76710.286591784951732000',
        ledgerQuantity: null,
      }),
    );
    expect(action).toBe('revive-from-ledger');
    expect(mutate).toHaveBeenCalledTimes(1);
    expect(mutate.mock.calls[0]?.[0]).toBe('BTCUSDT');
    const next = written[0] as Record<string, unknown>;
    expect(next['avgEntryPrice']).toBe('76710.286591784951732000');
    expect(next['highSinceBuy']).toBe(null);
    expect(next['heldQuantity']).toBe('0.0142');
    expect(next['extraField']).toBe('preserved');
  });

  it('logs the ledger-vs-state qty divergence at warn during revive', async () => {
    const warn = vi.fn();
    const state = {
      schemaVersion: '2.0.0',
      avgEntryPrice: null,
      heldQuantity: '0.0142',
    };
    const { mutate, written, deps } = buildDeps(state);
    const action = await reviveAvgEntryPriceForTarget(
      { ...deps, logger: { ...silentLogger, warn } as unknown as Logger },
      target({
        state,
        ledgerAvgEntryPrice: '76710.286591784951732000',
        ledgerQuantity: '0.019210590000000000',
      }),
    );
    expect(action).toBe('revive-from-ledger');
    expect(mutate).toHaveBeenCalledTimes(1);
    const next = written[0] as Record<string, unknown>;
    expect(next['avgEntryPrice']).toBe('76710.286591784951732000');
    expect(next['heldQuantity']).toBe('0.0142');
    const divergenceWarn = warn.mock.calls.find(
      (call) => typeof call[1] === 'string' && call[1].includes('ledger quantity diverges'),
    );
    expect(divergenceWarn).toBeDefined();
    expect(divergenceWarn?.[0]).toMatchObject({
      ledgerQuantity: '0.019210590000000000',
      stateHeldQuantity: '0.0142',
    });
  });

  it('skips mutate on a no-op outcome (state already populated, ledger absent)', async () => {
    const { mutate, removeLedgerRow, deps } = buildDeps();
    const action = await reviveAvgEntryPriceForTarget(
      deps,
      target({
        state: { schemaVersion: '2.0.0', avgEntryPrice: '50000.0', heldQuantity: '0.5' },
        ledgerAvgEntryPrice: null,
      }),
    );
    expect(action).toBe('no-op');
    expect(mutate).not.toHaveBeenCalled();
    expect(removeLedgerRow).not.toHaveBeenCalled();
  });

  it('skips on a non-2.0.0 schemaVersion and warns to investigate (orchestrator already migrated)', async () => {
    const { mutate, removeLedgerRow, deps } = buildDeps();
    const action = await reviveAvgEntryPriceForTarget(
      deps,
      target({
        state: { schemaVersion: '1.0.0', avgEntryPrice: null },
        ledgerAvgEntryPrice: '40000.0',
      }),
    );
    expect(action).toBe('skip-schema-version');
    expect(mutate).not.toHaveBeenCalled();
    expect(removeLedgerRow).not.toHaveBeenCalled();
  });

  it('logs and skips a non-object state row', async () => {
    const { mutate, deps } = buildDeps();
    const action = await reviveAvgEntryPriceForTarget(
      deps,
      target({ state: null, ledgerAvgEntryPrice: '40000.0' }),
    );
    expect(action).toBe('no-op');
    expect(mutate).not.toHaveBeenCalled();
  });

  it('KEEPS the ledger row and the state for a wallet-backed position of exactly one stepSize', async () => {
    // End-to-end regression for the money-destroying prune. On many alts
    // `minQty == stepSize`, so wallet == step is a REAL minimum-size position:
    // the reconciler seeds heldQuantity from the wallet (it fires at
    // `wallet >= step`), and the prune must then leave both the strategy state and
    // the avg_entry_prices row alone. Pruning here would disarm the protective
    // stop, blind the sell ladder, and let the entry gate re-buy a symbol it
    // already holds — while ensureCostBasisFromTrades rebuilt the row on the next
    // boot (it admits at `wallet >= step`, the opposite verdict) for the prune to
    // delete again, every boot, forever.
    const state = { schemaVersion: '2.0.0', avgEntryPrice: '213.1', heldQuantity: '1' };
    const { mutate, removeLedgerRow, deps } = buildDeps(state);

    const action = await reviveAvgEntryPriceForTarget(
      deps,
      target({
        state,
        ledgerAvgEntryPrice: '213.1',
        ledgerQuantity: '1',
        walletQuantity: '1',
        stepSize: '1',
      }),
    );

    expect(action).toBe('no-op');
    expect(removeLedgerRow).not.toHaveBeenCalled();
    expect(mutate).not.toHaveBeenCalled();
  });

  it('PRUNES the same claim when the wallet is empty (the phantom this gate exists for)', async () => {
    // Identical claim, empty wallet — the verdict must flip. Together with the test
    // above this pins that the predicate reads the WALLET, not the claim.
    const state = { schemaVersion: '2.0.0', avgEntryPrice: '213.1', heldQuantity: '1' };
    const { mutate, removeLedgerRow, deps } = buildDeps(state);

    const action = await reviveAvgEntryPriceForTarget(
      deps,
      target({
        state,
        ledgerAvgEntryPrice: '213.1',
        ledgerQuantity: '1',
        walletQuantity: '0',
        stepSize: '1',
      }),
    );

    expect(action).toBe('prune-phantom-ledger');
    expect(removeLedgerRow).toHaveBeenCalledTimes(1);
    expect(mutate).toHaveBeenCalledTimes(1);
  });

  it('defers a current-schema body whose avgEntryPrice is malformed (readPosition null)', async () => {
    // The position adapter owns field-shape validation: a 2.0.0 body with
    // a non-string/non-null avgEntryPrice reads back as `null`, so the
    // reviver defers the row (skip-schema-version) rather than reviving
    // against garbage. The malformed-shape detail is asserted in the TT
    // adapter's own tests.
    const { mutate, deps } = buildDeps();
    const action = await reviveAvgEntryPriceForTarget(
      deps,
      target({
        state: {
          schemaVersion: '2.0.0',
          avgEntryPrice: 42 as unknown as string,
          heldQuantity: '0.5',
        },
        ledgerAvgEntryPrice: '40000.0',
      }),
    );
    expect(action).toBe('skip-schema-version');
    expect(mutate).not.toHaveBeenCalled();
  });
});

describe('isPhantomLedgerRow (pure decision)', () => {
  it('prunes when the LEDGER ROW IS GONE but the strategy still claims the position', () => {
    // The wedged shape observed in production. The prune's two writes are not
    // atomic: a previous pass deleted the ledger row and lost the state clear (a
    // CAS conflict, a crash). Gating the next pass on the ledger row's existence
    // answers "no phantom", the state is never converged, and the strategy spends
    // the rest of its life managing a position it does not hold — arming a stop the
    // wallet cannot fund, rejected by Binance every tick. Driving the decision from
    // the CLAIM instead makes the recovery total.
    expect(
      isPhantomLedgerRow({
        ledgerAvgEntryPrice: null,
        stateAvgEntryPrice: '213.1',
        walletQuantity: '0',
        stepSize: '0.001',
      }),
    ).toBe(true);
  });

  it('returns false when nothing claims a position at all', () => {
    // Neither the ledger nor the state says anything — there is no phantom to
    // prune, whatever the wallet reads.
    expect(
      isPhantomLedgerRow({
        ledgerAvgEntryPrice: null,
        stateAvgEntryPrice: null,
        walletQuantity: '0',
        stepSize: '0.001',
      }),
    ).toBe(false);
  });

  it('does not prune a state claim the wallet DOES back', () => {
    expect(
      isPhantomLedgerRow({
        ledgerAvgEntryPrice: null,
        stateAvgEntryPrice: '213.1',
        walletQuantity: '0.5',
        stepSize: '0.001',
      }),
    ).toBe(false);
  });

  it('does NOT prune a wallet holding exactly one stepSize — the smallest LEGAL position', () => {
    // The money-path guard. On many alts `LOT_SIZE.minQty == stepSize`, so a wallet
    // of exactly one step is the smallest position that can legally be bought: it is
    // real and tradable. Pruning it would clear the strategy state AND delete the
    // avg_entry_prices row, which disarms the protective stop and leaves the entry
    // gate seeing a FLAT symbol — so the next tick buys again and doubles exposure.
    // The threshold must stay STRICT (`wallet.lt(step)`).
    expect(
      isPhantomLedgerRow({
        ledgerAvgEntryPrice: '213.1',
        stateAvgEntryPrice: '213.1',
        walletQuantity: '1',
        stepSize: '1',
      }),
    ).toBe(false);
  });

  it('DOES prune when the wallet is empty and the state still claims one stepSize', () => {
    // The mirror, and the shape we were actually chasing. Same magnitude in the
    // claim, opposite verdict — which is precisely why the predicate must read the
    // WALLET and not the strategy's reconciled heldQuantity: that value is pinned
    // FROM the wallet, so it cannot tell these two cases apart.
    expect(
      isPhantomLedgerRow({
        ledgerAvgEntryPrice: '213.1',
        stateAvgEntryPrice: '213.1',
        walletQuantity: '0',
        stepSize: '1',
      }),
    ).toBe(true);
  });

  it('prunes a wallet JUST below one stepSize (dust the strategy can never sell)', () => {
    expect(
      isPhantomLedgerRow({
        ledgerAvgEntryPrice: '213.1',
        stateAvgEntryPrice: '213.1',
        walletQuantity: '0.999',
        stepSize: '1',
      }),
    ).toBe(true);
  });

  it('returns false when the ledger has no row', () => {
    expect(
      isPhantomLedgerRow({
        ledgerAvgEntryPrice: null,
        stateAvgEntryPrice: null,
        walletQuantity: '0',
        stepSize: '0.00001',
      }),
    ).toBe(false);
  });

  it('returns true when the base asset is ABSENT from the wallet (definite phantom)', () => {
    expect(
      isPhantomLedgerRow({
        ledgerAvgEntryPrice: '68000',
        stateAvgEntryPrice: null,
        walletQuantity: null,
        stepSize: '0.00001',
      }),
    ).toBe(true);
  });

  it('returns true when the wallet is below stepSize (dust)', () => {
    expect(
      isPhantomLedgerRow({
        ledgerAvgEntryPrice: '68000',
        stateAvgEntryPrice: null,
        walletQuantity: '0.000001',
        stepSize: '0.00001',
      }),
    ).toBe(true);
  });

  it('returns false when the wallet is at or above stepSize (real position)', () => {
    expect(
      isPhantomLedgerRow({
        ledgerAvgEntryPrice: '68000',
        stateAvgEntryPrice: null,
        walletQuantity: '0.0142',
        stepSize: '0.00001',
      }),
    ).toBe(false);
    // AT one step, not merely above it. Restored: this boundary is what stops a
    // minimum-size position from having its cost basis deleted.
    expect(
      isPhantomLedgerRow({
        ledgerAvgEntryPrice: '68000',
        stateAvgEntryPrice: null,
        walletQuantity: '0.00001',
        stepSize: '0.00001',
      }),
    ).toBe(false);
  });

  it('returns false when stepSize is null — cannot compare, must not prune', () => {
    expect(
      isPhantomLedgerRow({
        ledgerAvgEntryPrice: '68000',
        stateAvgEntryPrice: null,
        walletQuantity: '0.0142',
        stepSize: null,
      }),
    ).toBe(false);
  });

  it('returns false on malformed Decimal inputs (refuses to delete on parse failure)', () => {
    expect(
      isPhantomLedgerRow({
        ledgerAvgEntryPrice: '68000',
        stateAvgEntryPrice: null,
        walletQuantity: 'nope',
        stepSize: '0.00001',
      }),
    ).toBe(false);
  });
});

describe('reviveAvgEntryPriceForTarget — phantom-ledger prune (#262)', () => {
  const buildDeps = (liveState?: unknown) => {
    const written: unknown[] = [];
    const mutate = vi.fn(async (_sym: string, mutator: (s: unknown) => unknown | null) => {
      const next = mutator(liveState ?? null);
      if (next !== null) written.push(next);
    });
    const removeLedgerRow = vi.fn(async (_u: string, _p: string, _s: string) => undefined);
    return {
      mutate,
      removeLedgerRow,
      written,
      deps: {
        logger: silentLogger,
        mutate,
        removeLedgerRow,
        position: trailingTradePositionAdapter,
      },
    };
  };

  it('DELETEs the ledger row when the base asset is absent from the wallet', async () => {
    const state = { schemaVersion: '2.0.0', avgEntryPrice: null, heldQuantity: null };
    const { mutate, removeLedgerRow, written, deps } = buildDeps(state);
    const action = await reviveAvgEntryPriceForTarget(deps, {
      userId: 'u1',
      profileId: 'p1',
      symbol: 'BTCUSDT',
      state,
      ledgerAvgEntryPrice: '68000',
      ledgerQuantity: '0.001470590000000000',
      walletQuantity: null,
      stepSize: '0.00001000',
    });
    expect(action).toBe('prune-phantom-ledger');
    expect(removeLedgerRow).toHaveBeenCalledWith('u1', 'p1', 'BTCUSDT');
    // Snapshot's avgEntryPrice is null; the wrapper skips the per-symbol
    // mutate entirely and lets the ledger DELETE be the sole side effect.
    expect(mutate).not.toHaveBeenCalled();
    expect(written).toHaveLength(0);
  });

  it('clears state.avgEntryPrice if it was somehow populated against the phantom row', async () => {
    const state = {
      schemaVersion: '2.0.0',
      avgEntryPrice: '68000',
      highSinceBuy: '70000',
      heldQuantity: null,
    };
    const { mutate, removeLedgerRow, written, deps } = buildDeps(state);
    const action = await reviveAvgEntryPriceForTarget(deps, {
      userId: 'u1',
      profileId: 'p1',
      symbol: 'BTCUSDT',
      state,
      ledgerAvgEntryPrice: '68000',
      ledgerQuantity: '0.001470590000000000',
      walletQuantity: null,
      stepSize: '0.00001000',
    });
    expect(action).toBe('prune-phantom-ledger');
    expect(removeLedgerRow).toHaveBeenCalledOnce();
    expect(mutate).toHaveBeenCalledOnce();
    const next = written[0] as Record<string, unknown>;
    expect(next['avgEntryPrice']).toBeNull();
    expect(next['highSinceBuy']).toBeNull();
  });

  it('does NOT prune a real position (heldQuantity ≥ stepSize)', async () => {
    const state = { schemaVersion: '2.0.0', avgEntryPrice: null, heldQuantity: '0.0142' };
    const { mutate, removeLedgerRow, written, deps } = buildDeps(state);
    const action = await reviveAvgEntryPriceForTarget(deps, {
      userId: 'u1',
      profileId: 'p1',
      symbol: 'BTCUSDT',
      state,
      ledgerAvgEntryPrice: '68000',
      ledgerQuantity: '0.0142',
      stepSize: '0.00001000',
    });
    expect(action).toBe('revive-from-ledger');
    expect(removeLedgerRow).not.toHaveBeenCalled();
    expect(mutate).toHaveBeenCalledOnce();
    const next = written[0] as Record<string, unknown>;
    expect(next['avgEntryPrice']).toBe('68000');
  });

  it('does NOT prune when the ledger has no row to begin with', async () => {
    const { removeLedgerRow, deps } = buildDeps();
    const action = await reviveAvgEntryPriceForTarget(deps, {
      userId: 'u1',
      profileId: 'p1',
      symbol: 'BTCUSDT',
      state: { schemaVersion: '2.0.0', avgEntryPrice: null, heldQuantity: null },
      ledgerAvgEntryPrice: null,
      ledgerQuantity: null,
      stepSize: '0.00001000',
    });
    expect(action).toBe('no-op');
    expect(removeLedgerRow).not.toHaveBeenCalled();
  });

  it('does NOT prune when stepSize is null — refuses to act without a comparison threshold', async () => {
    const state = { schemaVersion: '2.0.0', avgEntryPrice: null, heldQuantity: '0.0142' };
    const { removeLedgerRow, deps } = buildDeps(state);
    const action = await reviveAvgEntryPriceForTarget(deps, {
      userId: 'u1',
      profileId: 'p1',
      symbol: 'BTCUSDT',
      state,
      ledgerAvgEntryPrice: '68000',
      ledgerQuantity: '0.0142',
      stepSize: null,
    });
    expect(action).toBe('revive-from-ledger');
    expect(removeLedgerRow).not.toHaveBeenCalled();
  });

  it('finishes a PARTIAL previous prune: ledger row already gone, state still claiming', async () => {
    // The exact production shape (TAO/SEI/BIO): heldQuantity 0, avg_entry_prices row
    // deleted, state.avgEntryPrice still set. Under the old ledger-gated decision
    // this returned no-op forever and the profile stayed wedged. It must converge.
    const state = { schemaVersion: '2.0.0', avgEntryPrice: '213.1', heldQuantity: '0' };
    const { mutate, removeLedgerRow, written, deps } = buildDeps(state);
    const action = await reviveAvgEntryPriceForTarget(deps, {
      userId: 'u1',
      profileId: 'p1',
      symbol: 'TAOUSDT',
      state,
      ledgerAvgEntryPrice: null,
      ledgerQuantity: null,
      walletQuantity: '0',
      stepSize: '0.00100000',
    });

    expect(action).toBe('prune-phantom-ledger');
    expect(mutate).toHaveBeenCalledOnce();
    expect((written[0] as Record<string, unknown>)['avgEntryPrice']).toBeNull();
    // The DELETE re-runs harmlessly — deleting an absent row is a no-op, and
    // conditioning it on the row's presence is what created the wedge.
    expect(removeLedgerRow).toHaveBeenCalledWith('u1', 'p1', 'TAOUSDT');
  });

  it('is idempotent: a second pass over the converged symbol is a no-op', async () => {
    // Running the prune twice must converge, not oscillate. After the first pass the
    // state carries no claim and the ledger has no row, so the second pass has
    // nothing to act on.
    const cleared = { schemaVersion: '2.0.0', avgEntryPrice: null, heldQuantity: '0' };
    const { mutate, removeLedgerRow, deps } = buildDeps(cleared);
    const action = await reviveAvgEntryPriceForTarget(deps, {
      userId: 'u1',
      profileId: 'p1',
      symbol: 'TAOUSDT',
      state: cleared,
      ledgerAvgEntryPrice: null,
      ledgerQuantity: null,
      stepSize: '0.00100000',
    });

    expect(action).toBe('no-op');
    expect(mutate).not.toHaveBeenCalled();
    expect(removeLedgerRow).not.toHaveBeenCalled();
  });
});
