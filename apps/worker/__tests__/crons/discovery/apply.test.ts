import { describe, expect, it, vi } from 'vitest';
import { applyDiscoveryAdd, applyDiscoveryReap } from '../../../src/crons/discovery/apply.js';
import { type DiscoveryStorageKeys } from '../../../src/crons/discovery-reap.js';

const NOW = 1_700_000_000_000;
const HOUR = 3_600_000;

describe('applyDiscoveryAdd / applyDiscoveryReap — storage mutations + enter-on-add hint', () => {
  const KEYS: DiscoveryStorageKeys = {
    addedKey: 'discovery:added:p1',
    flatKey: 'discovery:flat:p1',
    enterOnAddKey: 'discovery:enter-on-add:p1',
  };

  const fakes = (
    opts: {
      removeOutcome?: 'removed' | 'not-found' | 'held';
      rowPresent?: boolean;
      hashVal?: string | null;
    } = {},
  ) => {
    const { removeOutcome = 'removed', rowPresent = false, hashVal = null } = opts;
    const hset = vi.fn(async () => 1);
    const hdel = vi.fn(async () => 1);
    const hget = vi.fn(async () => hashVal);
    const symbols = {
      upsert: vi.fn(async () => undefined),
      setSource: vi.fn(async () => undefined),
      findForSymbol: vi.fn(async () => (rowPresent ? { symbol: 'AAAUSDT' } : null)),
      removeAutoIfFlat: vi.fn(async () => removeOutcome),
    } as unknown as Parameters<typeof applyDiscoveryAdd>[0];
    return { hset, hdel, hget, redis: { hset, hdel, hget }, symbols };
  };

  it('binds the symbol to auto, stamps added-at, and clears the flat cooldown', async () => {
    const { hset, hdel, redis, symbols } = fakes();
    await applyDiscoveryAdd(symbols, redis, KEYS, 'AAAUSDT', 'AAA', NOW);
    expect(symbols.upsert).toHaveBeenCalledWith('AAAUSDT', 'AAA', { overrideConfig: null });
    expect(symbols.setSource).toHaveBeenCalledWith('AAAUSDT', 'auto');
    expect(hset).toHaveBeenCalledWith(KEYS.addedKey, 'AAAUSDT', String(NOW));
    expect(hdel).toHaveBeenCalledWith(KEYS.flatKey, 'AAAUSDT');
  });

  it('does not touch the entry-hint hash — the per-cycle refresh pass owns it (#486)', async () => {
    const { hset, hdel, redis, symbols } = fakes();
    await applyDiscoveryAdd(symbols, redis, KEYS, 'AAAUSDT', 'AAA', NOW);
    expect(hset).not.toHaveBeenCalledWith(KEYS.enterOnAddKey, 'AAAUSDT', expect.anything());
    expect(hdel).not.toHaveBeenCalledWith(KEYS.enterOnAddKey, 'AAAUSDT');
  });

  it('clears the hint (and added) on a successful reap', async () => {
    const { hset, hdel, redis, symbols } = fakes({ removeOutcome: 'removed' });
    const ok = await applyDiscoveryReap(symbols, redis, KEYS, 'OLDUSDT', NOW);
    expect(ok).toBe(true);
    expect(hset).toHaveBeenCalledWith(KEYS.flatKey, 'OLDUSDT', String(NOW));
    expect(hdel).toHaveBeenCalledWith(KEYS.addedKey, 'OLDUSDT');
    expect(hdel).toHaveBeenCalledWith(KEYS.enterOnAddKey, 'OLDUSDT');
  });

  it('mutates nothing when the flat-guard refuses the reap (held symbol)', async () => {
    const { hset, hdel, redis, symbols } = fakes({ removeOutcome: 'held' });
    const ok = await applyDiscoveryReap(symbols, redis, KEYS, 'OLDUSDT', NOW);
    expect(ok).toBe(false);
    expect(hset).not.toHaveBeenCalled();
    expect(hdel).not.toHaveBeenCalled();
  });

  it('returns outcome "existing" when the profile_symbols row already exists (#454)', async () => {
    const { redis, symbols } = fakes({ rowPresent: true });
    const res = await applyDiscoveryAdd(symbols, redis, KEYS, 'AAAUSDT', 'AAA', NOW);
    expect(res.outcome).toBe('existing');
  });

  it('returns outcome "readded" carrying prevAddedAt when the added-at hash knows a row-missing symbol (#454)', async () => {
    const T0 = NOW - HOUR;
    const { redis, symbols } = fakes({ rowPresent: false, hashVal: String(T0) });
    const res = await applyDiscoveryAdd(symbols, redis, KEYS, 'AAAUSDT', 'AAA', NOW);
    expect(res.outcome).toBe('readded');
    expect(res.outcome === 'readded' ? res.prevAddedAt : null).toBe(T0);
  });

  it('returns outcome "created" for a brand-new symbol (no row, no hash entry) (#454)', async () => {
    const { redis, symbols } = fakes({ rowPresent: false, hashVal: null });
    const res = await applyDiscoveryAdd(symbols, redis, KEYS, 'AAAUSDT', 'AAA', NOW);
    expect(res.outcome).toBe('created');
  });
});
