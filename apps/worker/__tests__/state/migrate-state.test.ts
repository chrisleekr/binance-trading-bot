// Unit tests for `runStateMigration` — the per-hop migration walker that
// both `migrateProfileIfNeeded` (boot reconciler) and `mutateProfileState`
// (out-of-band mutation primitive) delegate to.
//
// The divergence-detection cases are the GitLab #264 regression: when the
// caller-supplied `fromVersion` (the durable column/cache stamp) lies
// about the body's actual `schemaVersion`, the function MUST trust the
// body and re-migrate so the next atomic persister write heals the drift.

import { describe, expect, it, vi } from 'vitest';
import type { Logger } from 'pino';

import { runStateMigration, type MigrationStrategyShape } from '../../src/state/migrate-state.js';

const fakeLogger = (): Logger =>
  ({
    info: vi.fn(),
    warn: vi.fn(),
    error: vi.fn(),
    debug: vi.fn(),
  }) as unknown as Logger;

describe('runStateMigration', () => {
  it('returns migrated:false when caller fromVersion matches strategy version and state has no schemaVersion', async () => {
    const migrate = vi.fn();
    const strategy: MigrationStrategyShape = {
      name: 'trailing-trade',
      version: '1.1.0',
      migrateState: migrate,
    };
    const result = await runStateMigration({
      strategy,
      fromVersion: '1.1.0',
      state: { lastBuyPrice: '50000' }, // no schemaVersion field
      logger: fakeLogger(),
      logContext: {},
    });
    expect(result).toEqual({ migrated: false });
    expect(migrate).not.toHaveBeenCalled();
  });

  it('GitLab #264 inverse: state body already at-version but column lags — returns migrated:true with body unchanged so caller heals the column', async () => {
    const migrate = vi.fn();
    const strategy: MigrationStrategyShape = {
      name: 'trailing-trade',
      version: '1.1.0',
      migrateState: migrate,
    };
    const warn = vi.fn();
    const body = { schemaVersion: '1.1.0', heldQuantity: '0.5' };
    const result = await runStateMigration({
      strategy,
      fromVersion: '1.0.0',
      state: body,
      logger: { ...fakeLogger(), warn } as unknown as Logger,
      logContext: {},
    });
    // Body is already current — no migrate hop needed — but the result
    // is still `migrated:true` so the caller's atomic persister writes
    // the corrected version stamp. Body is the exact same object;
    // strategies are not invoked.
    expect(migrate).not.toHaveBeenCalled();
    expect(result).toEqual({ migrated: true, state: body, version: '1.1.0' });
    expect(warn).toHaveBeenCalledWith(
      expect.objectContaining({ suppliedFromVersion: '1.0.0', stateSchemaVersion: '1.1.0' }),
      expect.stringContaining('state.schemaVersion diverges from supplied fromVersion'),
    );
  });

  it('GitLab #264: prefers state.schemaVersion over caller fromVersion and migrates from the state stamp', async () => {
    const warn = vi.fn();
    const migrate = vi.fn(({ state }: { state: unknown }) => ({
      ...(state as Record<string, unknown>),
      schemaVersion: '1.1.0',
      heldQuantity: null,
    }));
    const strategy: MigrationStrategyShape = {
      name: 'trailing-trade',
      version: '1.1.0',
      migrateState: migrate,
    };
    const result = await runStateMigration({
      strategy,
      fromVersion: '1.1.0', // column lies
      state: { schemaVersion: '1.0.0', lastBuyPrice: '2083.6' }, // body is the truth
      logger: { ...fakeLogger(), warn } as unknown as Logger,
      logContext: { userId: 'u1', profileId: 'p1' },
    });
    expect(migrate).toHaveBeenCalledOnce();
    expect(migrate).toHaveBeenCalledWith({
      fromVersion: '1.0.0',
      state: expect.objectContaining({ schemaVersion: '1.0.0' }),
    });
    expect(result).toEqual({
      migrated: true,
      state: expect.objectContaining({ schemaVersion: '1.1.0', heldQuantity: null }),
      version: '1.1.0',
    });
    expect(warn).toHaveBeenCalledWith(
      expect.objectContaining({
        userId: 'u1',
        profileId: 'p1',
        suppliedFromVersion: '1.1.0',
        stateSchemaVersion: '1.0.0',
      }),
      expect.stringContaining('state.schemaVersion diverges from supplied fromVersion'),
    );
  });

  it('falls back to caller fromVersion when state.schemaVersion is missing', async () => {
    const warn = vi.fn();
    const migrate = vi.fn(({ state }: { state: unknown }) => ({
      ...(state as Record<string, unknown>),
      schemaVersion: '1.1.0',
    }));
    const strategy: MigrationStrategyShape = {
      name: 'trailing-trade',
      version: '1.1.0',
      migrateState: migrate,
    };
    const result = await runStateMigration({
      strategy,
      fromVersion: '1.0.0',
      state: { lastBuyPrice: '50000' }, // no schemaVersion field at all
      logger: { ...fakeLogger(), warn } as unknown as Logger,
      logContext: {},
    });
    expect(migrate).toHaveBeenCalledWith({ fromVersion: '1.0.0', state: expect.any(Object) });
    expect((result as { migrated: true; version: string }).version).toBe('1.1.0');
    expect(warn).not.toHaveBeenCalled(); // no divergence to log
  });

  it('falls back to caller fromVersion when state.schemaVersion is non-string (treats body as untyped)', async () => {
    const migrate = vi.fn(({ state }: { state: unknown }) => ({
      ...(state as Record<string, unknown>),
      schemaVersion: '1.1.0',
    }));
    const strategy: MigrationStrategyShape = {
      name: 'trailing-trade',
      version: '1.1.0',
      migrateState: migrate,
    };
    const result = await runStateMigration({
      strategy,
      fromVersion: '1.0.0',
      state: { schemaVersion: 42, lastBuyPrice: '50000' }, // numeric — should not be trusted
      logger: fakeLogger(),
      logContext: {},
    });
    expect(migrate).toHaveBeenCalledWith({ fromVersion: '1.0.0', state: expect.any(Object) });
    expect((result as { migrated: true; version: string }).version).toBe('1.1.0');
  });
});
