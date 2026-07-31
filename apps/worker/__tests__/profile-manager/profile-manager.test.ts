import { describe, it, expect, beforeEach, vi } from 'vitest';
import { asProfileId, asUserId } from '@app/contracts';
import {
  createProfileManager,
  type MarketSubscriberHooks,
  type ProfileManager,
} from '../../src/profile-manager/profile-manager.js';

const u = asUserId;
const p = asProfileId;

const stubMarket = (): MarketSubscriberHooks & {
  addCalls: { symbols: readonly string[]; candleInterval: string }[];
  removeCalls: { symbols: readonly string[]; candleInterval: string }[];
} => {
  const addCalls: { symbols: readonly string[]; candleInterval: string }[] = [];
  const removeCalls: { symbols: readonly string[]; candleInterval: string }[] = [];
  return {
    addCalls,
    removeCalls,
    addSymbols: vi.fn(async (symbols, candleInterval) => {
      addCalls.push({ symbols: [...symbols], candleInterval });
    }),
    removeSymbols: vi.fn(async (symbols, candleInterval) => {
      removeCalls.push({ symbols: [...symbols], candleInterval });
    }),
  };
};

describe('ProfileManager', () => {
  let market = stubMarket();

  beforeEach(() => {
    market = stubMarket();
  });

  // Mirror the boot back-edge wire: construct the manager, then inject the
  // market back-edge before start(). The account user-data stream is driven by
  // subscription-ownership, not the manager, so there is no stream back-edge.
  const makePm = (deps: Parameters<typeof createProfileManager>[0]): ProfileManager => {
    const pm = createProfileManager(deps);
    pm.setMarket(market);
    return pm;
  };

  it('starts with seed profiles and builds profilesUsing', async () => {
    const pm = makePm({
      loadEnabledProfiles: async () => [
        {
          userId: u('u1'),
          profileId: p('p1'),
          symbols: ['BTCUSDT', 'ETHUSDT'],
          candleInterval: '1h',
          technicalsIntervals: [],
        },
        {
          userId: u('u1'),
          profileId: p('p2'),
          symbols: ['BTCUSDT'],
          candleInterval: '1h',
          technicalsIntervals: [],
        },
      ],
    });
    await pm.start();
    expect([...pm.profilesUsing('BTCUSDT')].sort()).toEqual(['p1', 'p2']);
    expect(pm.profilesUsing('ETHUSDT')).toEqual(['p1']);
    // Each profile forwards its FULL symbol set with its interval; the
    // subscriptions-manager refcounts the shared BTCUSDT WS streams.
    expect(market.addCalls).toHaveLength(2);
    expect(market.addCalls[0]).toEqual({ symbols: ['BTCUSDT', 'ETHUSDT'], candleInterval: '1h' });
    expect(market.addCalls[1]).toEqual({ symbols: ['BTCUSDT'], candleInterval: '1h' });
  });

  it('disable forwards the full symbol set with the interval and updates profilesUsing', async () => {
    const pm = makePm({
      loadEnabledProfiles: async () => [
        {
          userId: u('u1'),
          profileId: p('p1'),
          symbols: ['BTCUSDT', 'ETHUSDT'],
          candleInterval: '1h',
          technicalsIntervals: [],
        },
        {
          userId: u('u1'),
          profileId: p('p2'),
          symbols: ['BTCUSDT'],
          candleInterval: '1h',
          technicalsIntervals: [],
        },
      ],
    });
    await pm.start();
    await pm.disable(p('p1'));
    expect(pm.profilesUsing('BTCUSDT')).toEqual(['p2']);
    expect(pm.profilesUsing('ETHUSDT')).toEqual([]);
    // ProfileManager forwards p1's full symbol set with its interval; the
    // orphan/refcount dedup (keep BTCUSDT for p2) lives in subscriptions-manager.
    expect(market.removeCalls).toContainEqual({
      symbols: ['BTCUSDT', 'ETHUSDT'],
      candleInterval: '1h',
    });
  });

  it('two profiles on the same symbol, different intervals: each interval is forwarded', async () => {
    const pm = makePm({
      loadEnabledProfiles: async () => [
        {
          userId: u('u1'),
          profileId: p('p1'),
          symbols: ['BTCUSDT'],
          candleInterval: '5m',
          technicalsIntervals: [],
        },
        {
          userId: u('u1'),
          profileId: p('p2'),
          symbols: ['BTCUSDT'],
          candleInterval: '1h',
          technicalsIntervals: [],
        },
      ],
    });
    await pm.start();
    expect(market.addCalls).toContainEqual({ symbols: ['BTCUSDT'], candleInterval: '5m' });
    expect(market.addCalls).toContainEqual({ symbols: ['BTCUSDT'], candleInterval: '1h' });
    await pm.disable(p('p1'));
    expect(market.removeCalls).toContainEqual({ symbols: ['BTCUSDT'], candleInterval: '5m' });
    expect(pm.profilesUsing('BTCUSDT')).toEqual(['p2']);
  });

  it('setSymbols diffs add/remove correctly', async () => {
    const pm = makePm({
      loadEnabledProfiles: async () => [
        {
          userId: u('u1'),
          profileId: p('p1'),
          symbols: ['BTCUSDT'],
          candleInterval: '1h',
          technicalsIntervals: [],
        },
      ],
    });
    await pm.start();
    await pm.setSymbols(p('p1'), ['ETHUSDT', 'SOLUSDT']);
    expect(pm.profilesUsing('BTCUSDT')).toEqual([]);
    expect(pm.profilesUsing('ETHUSDT')).toEqual(['p1']);
    expect(pm.profilesUsing('SOLUSDT')).toEqual(['p1']);
  });

  it('setSymbols re-subscribes the new interval and drops the old when the candle interval changes', async () => {
    const pm = makePm({
      loadEnabledProfiles: async () => [
        {
          userId: u('u1'),
          profileId: p('p1'),
          symbols: ['BTCUSDT'],
          candleInterval: '5m',
          technicalsIntervals: [],
        },
      ],
    });
    await pm.start();
    expect(market.addCalls).toContainEqual({ symbols: ['BTCUSDT'], candleInterval: '5m' });

    // 3rd arg is the new interval. A hot interval change on a LIVE profile
    // must add the new interval's streams and drop the old, with no manual
    // stop->start.
    await pm.setSymbols(p('p1'), ['BTCUSDT'], '1h');
    expect(market.addCalls).toContainEqual({ symbols: ['BTCUSDT'], candleInterval: '1h' });
    expect(market.removeCalls).toContainEqual({ symbols: ['BTCUSDT'], candleInterval: '5m' });
  });

  it('setSymbols is a no-op for the market when the interval is unchanged', async () => {
    const pm = makePm({
      loadEnabledProfiles: async () => [
        {
          userId: u('u1'),
          profileId: p('p1'),
          symbols: ['BTCUSDT'],
          candleInterval: '5m',
          technicalsIntervals: [],
        },
      ],
    });
    await pm.start();
    const addsAfterStart = market.addCalls.length;
    const removesAfterStart = market.removeCalls.length;

    // Same symbol set, interval omitted: no extra subscribe churn.
    await pm.setSymbols(p('p1'), ['BTCUSDT']);
    // Same symbol set, interval explicitly equal to the current one: same.
    await pm.setSymbols(p('p1'), ['BTCUSDT'], '5m');
    expect(market.addCalls).toHaveLength(addsAfterStart);
    expect(market.removeCalls).toHaveLength(removesAfterStart);
  });

  it('setSymbols applies an interval change and a symbol diff in one call', async () => {
    const pm = makePm({
      loadEnabledProfiles: async () => [
        {
          userId: u('u1'),
          profileId: p('p1'),
          symbols: ['BTCUSDT', 'ETHUSDT'],
          candleInterval: '5m',
          technicalsIntervals: [],
        },
      ],
    });
    await pm.start();

    await pm.setSymbols(p('p1'), ['BTCUSDT', 'SOLUSDT'], '1h');
    // BTC retained: re-subscribed onto the new interval, dropped from the old.
    expect(market.addCalls).toContainEqual({ symbols: ['BTCUSDT'], candleInterval: '1h' });
    expect(market.removeCalls).toContainEqual({ symbols: ['BTCUSDT'], candleInterval: '5m' });
    // SOL added: claims the new interval.
    expect(market.addCalls).toContainEqual({ symbols: ['SOLUSDT'], candleInterval: '1h' });
    // ETH removed: released on the interval it was subscribed on (the old one).
    expect(market.removeCalls).toContainEqual({ symbols: ['ETHUSDT'], candleInterval: '5m' });
    expect([...pm.profilesUsing('BTCUSDT')]).toEqual(['p1']);
    expect(pm.profilesUsing('ETHUSDT')).toEqual([]);
    expect([...pm.profilesUsing('SOLUSDT')]).toEqual(['p1']);
  });

  it('listActive enumerates every active profile with its user, interval, and symbols', async () => {
    const pm = makePm({
      loadEnabledProfiles: async () => [
        {
          userId: u('u1'),
          profileId: p('p1'),
          symbols: ['BTCUSDT', 'ETHUSDT'],
          candleInterval: '1h',
          technicalsIntervals: [],
        },
        {
          userId: u('u2'),
          profileId: p('p2'),
          symbols: ['SOLUSDT'],
          candleInterval: '5m',
          technicalsIntervals: [],
        },
      ],
    });
    await pm.start();
    const active = [...pm.listActive()].sort((a, b) => (a.profileId < b.profileId ? -1 : 1));
    expect(active).toEqual([
      {
        profileId: 'p1',
        userId: 'u1',
        candleInterval: '1h',
        symbols: ['BTCUSDT', 'ETHUSDT'],
        technicalsIntervals: [],
      },
      {
        profileId: 'p2',
        userId: 'u2',
        candleInterval: '5m',
        symbols: ['SOLUSDT'],
        technicalsIntervals: [],
      },
    ]);
  });

  it('listActive drops a profile once it is disabled', async () => {
    const pm = makePm({
      loadEnabledProfiles: async () => [
        {
          userId: u('u1'),
          profileId: p('p1'),
          symbols: ['BTCUSDT'],
          candleInterval: '1h',
          technicalsIntervals: [],
        },
        {
          userId: u('u1'),
          profileId: p('p2'),
          symbols: ['ETHUSDT'],
          candleInterval: '1h',
          technicalsIntervals: [],
        },
      ],
    });
    await pm.start();
    await pm.disable(p('p1'));
    expect(pm.listActive().map((a) => a.profileId)).toEqual(['p2']);
  });

  it('setTechnicalsIntervals updates the cached intervals for an active profile', async () => {
    const pm = makePm({
      loadEnabledProfiles: async () => [
        {
          userId: u('u1'),
          profileId: p('p1'),
          symbols: ['BTCUSDT'],
          candleInterval: '1h',
          technicalsIntervals: ['1h'],
        },
      ],
    });
    await pm.start();
    expect(pm.listActive()[0]?.technicalsIntervals).toEqual(['1h']);

    const updated = pm.setTechnicalsIntervals(p('p1'), ['1h', '4h', '1d']);
    expect(updated).toBe(true);
    expect(pm.listActive()[0]?.technicalsIntervals).toEqual(['1h', '4h', '1d']);
  });

  it('setTechnicalsIntervals returns false for an unknown profile', async () => {
    const pm = makePm({
      loadEnabledProfiles: async () => [],
    });
    await pm.start();
    expect(pm.setTechnicalsIntervals(p('does-not-exist'), ['1h'])).toBe(false);
  });

  it('shutdown drops all profiles from the active set', async () => {
    const pm = makePm({
      loadEnabledProfiles: async () => [
        {
          userId: u('u1'),
          profileId: p('p1'),
          symbols: ['BTCUSDT'],
          candleInterval: '1h',
          technicalsIntervals: [],
        },
        {
          userId: u('u1'),
          profileId: p('p2'),
          symbols: ['ETHUSDT'],
          candleInterval: '1h',
          technicalsIntervals: [],
        },
      ],
    });
    await pm.start();
    await pm.shutdown();
    expect(pm.listActive()).toEqual([]);
  });

  it('enable() converges an already-active profile to the new symbol set', async () => {
    // The bug: a stale unsubscribe followed by a subscribe (or churn) leaves
    // the DB enabled while ProfileManager already holds the profile. enable()
    // must CONVERGE the live symbol set + interval (not early-return) so an
    // operator's symbol/interval edit applied via re-subscribe takes effect.
    const pm = makePm({
      loadEnabledProfiles: async () => [
        {
          userId: u('u1'),
          profileId: p('p1'),
          symbols: ['BTCUSDT', 'ETHUSDT'],
          candleInterval: '5m',
          technicalsIntervals: ['5m'],
        },
      ],
    });
    await pm.start();

    await pm.enable({
      userId: u('u1'),
      profileId: p('p1'),
      symbols: ['BTCUSDT', 'SOLUSDT'],
      candleInterval: '1h',
      technicalsIntervals: ['1h', '4h'],
    });

    // Symbol set converged: ETH dropped, SOL added, BTC retained on the new interval.
    expect([...pm.profilesUsing('BTCUSDT')]).toEqual(['p1']);
    expect(pm.profilesUsing('ETHUSDT')).toEqual([]);
    expect([...pm.profilesUsing('SOLUSDT')]).toEqual(['p1']);
    // Interval change applied add-before-remove on retained BTC.
    expect(market.addCalls).toContainEqual({ symbols: ['BTCUSDT'], candleInterval: '1h' });
    expect(market.removeCalls).toContainEqual({ symbols: ['BTCUSDT'], candleInterval: '5m' });
    expect(market.addCalls).toContainEqual({ symbols: ['SOLUSDT'], candleInterval: '1h' });
    expect(market.removeCalls).toContainEqual({ symbols: ['ETHUSDT'], candleInterval: '5m' });
    // Technicals intervals updated.
    expect(pm.listActive()[0]?.technicalsIntervals).toEqual(['1h', '4h']);
  });

  it('enable() converge on a technicals-only re-enable: no market churn for retained symbols, technicals updated', async () => {
    // A re-enable that changes only technicalsIntervals (symbols + interval
    // unchanged) must converge with zero add/remove churn on the retained
    // symbols and surface the new technicals intervals via listActive.
    const pm = makePm({
      loadEnabledProfiles: async () => [
        {
          userId: u('u1'),
          profileId: p('p1'),
          symbols: ['BTCUSDT'],
          candleInterval: '1h',
          technicalsIntervals: ['1h'],
        },
      ],
    });
    await pm.start();
    const addsAfterStart = market.addCalls.length;
    const removesAfterStart = market.removeCalls.length;

    await pm.enable({
      userId: u('u1'),
      profileId: p('p1'),
      symbols: ['BTCUSDT'],
      candleInterval: '1h',
      technicalsIntervals: ['1h', '4h', '1d'],
    });

    // No market churn: same symbol set + same interval => setSymbols is a no-op.
    expect(market.addCalls).toHaveLength(addsAfterStart);
    expect(market.removeCalls).toHaveLength(removesAfterStart);
    // Technicals intervals converged.
    expect(pm.listActive()[0]?.technicalsIntervals).toEqual(['1h', '4h', '1d']);
  });

  it('throws loudly when a back-edge is used before its setter is wired', async () => {
    // Construct without wiring setMarket — the sentinel must throw rather
    // than silently no-op (the failure mode the old ref-optional-chain had).
    const pm = createProfileManager({
      loadEnabledProfiles: async () => [],
    });
    await expect(
      pm.enable({
        userId: u('u1'),
        profileId: p('p1'),
        symbols: ['BTCUSDT'],
        candleInterval: '1h',
        technicalsIntervals: [],
      }),
    ).rejects.toThrow(/Market hook not wired/);
  });

  it('reconcile() converges membership to the given enabled set (add, drop, keep)', async () => {
    const row = (profileId: string, symbols: string[], candleInterval = '1h') => ({
      userId: u('u1'),
      profileId: p(profileId),
      symbols,
      candleInterval,
      technicalsIntervals: [],
    });
    const pm = makePm({
      loadEnabledProfiles: async () => [row('p1', ['BTCUSDT']), row('p2', ['ETHUSDT'])],
    });
    await pm.start();
    expect(
      pm
        .listActive()
        .map((a) => a.profileId as unknown as string)
        .sort(),
    ).toEqual(['p1', 'p2']);

    // Fleet-global truth: p2 gone, p3 new, p1 keeps a converged symbol set.
    await pm.reconcile([row('p1', ['BTCUSDT', 'SOLUSDT']), row('p3', ['XRPUSDT'])]);

    expect(
      pm
        .listActive()
        .map((a) => a.profileId as unknown as string)
        .sort(),
    ).toEqual(['p1', 'p3']);
    expect([...pm.profilesUsing('SOLUSDT')]).toEqual(['p1']);
    expect(pm.profilesUsing('ETHUSDT')).toEqual([]); // p2 dropped
    expect([...pm.profilesUsing('XRPUSDT')]).toEqual(['p3']);
  });

  it('reconcile() with no changes makes zero market churn (single-replica no-op)', async () => {
    const row = {
      userId: u('u1'),
      profileId: p('p1'),
      symbols: ['BTCUSDT'],
      candleInterval: '1h',
      technicalsIntervals: [],
    };
    const pm = makePm({ loadEnabledProfiles: async () => [row] });
    await pm.start();
    const addsAfterStart = market.addCalls.length;
    const removesAfterStart = market.removeCalls.length;

    await pm.reconcile([row]);

    expect(market.addCalls.length).toBe(addsAfterStart);
    expect(market.removeCalls.length).toBe(removesAfterStart);
  });
});
