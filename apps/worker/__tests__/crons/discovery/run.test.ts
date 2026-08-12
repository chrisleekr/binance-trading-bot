import { describe, expect, it, vi } from 'vitest';
import { DiscoveryConfigSchema } from '@app/contracts';
import type { Ticker24hrDto } from '@app/binance';
import type { Candle } from '@app/strategy-core';
import {
  runDiscoveryForProfile,
  type DiscoveryProfilePort,
} from '../../../src/crons/discovery/run.js';
import type { SiblingConflict } from '../../../src/crons/sibling-conflict.js';

const NOW = 1_700_000_000_000;
const HOUR = 3_600_000;

const ticker = (over: Partial<Ticker24hrDto>): Ticker24hrDto => ({
  symbol: 'AAAUSDT',
  lastPrice: '1',
  priceChange: '0',
  priceChangePercent: '10',
  highPrice: '1',
  lowPrice: '1',
  openPrice: '1',
  volume: '1',
  quoteVolume: '1',
  bidPrice: '1',
  askPrice: '1',
  ...over,
});

// A short rising window, old enough for minAgeDays:1, that confirms under the
// permissive trend-confirm config below (adxMin 0, volMultiple 0).
const eligibleKlines = (): Candle[] =>
  Array.from({ length: 6 }, (_, i) => ({
    openTimeMs: NOW - 5 * 24 * HOUR + i * HOUR,
    closeTimeMs: NOW - 5 * 24 * HOUR + (i + 1) * HOUR,
    open: String(100 + i * 4 - 2),
    high: String(100 + i * 4 + 1),
    low: String(100 + i * 4 - 3),
    close: String(100 + i * 4),
    volume: '10',
    isClosed: true,
  }));

const permissiveConfig = () =>
  DiscoveryConfigSchema.parse({
    enabled: true,
    minAgeDays: 1,
    maxAutoSymbols: 5,
    minHoldMinutes: 60,
    min24hPairVolumeUsd: '1',
    min24hAssetVolumeUsd: '1',
    maxSpreadRatio: '1',
    changeMinPercent: '0',
    rankTopPercent: 100,
    rankExcludeTopPercent: 0,
    trendConfirm: {
      adxPeriod: 2,
      adxMin: '0',
      emaPeriod: 2,
      volSmaPeriod: 2,
      volMultiple: '0.0001',
    },
  });

const fakePort = (over: Partial<DiscoveryProfilePort> = {}): DiscoveryProfilePort => ({
  getAllTickers: async () => [ticker({ symbol: 'AAAUSDT' })],
  getKlines: async () => eligibleKlines(),
  listAutoSymbols: async () => [],
  listManualSymbols: async () => [],
  lastFlattenBySymbol: async () => ({}),
  addedAtBySymbol: async () => ({}),
  addSymbol: vi.fn(async () => ({ outcome: 'created' as const })),
  siblingConflict: vi.fn(async () => null), // default: no sibling conflict
  refreshEntryHint: vi.fn(async () => undefined),
  heldOnExchange: vi.fn(async () => false), // default: wallet flat, reap allowed
  reapSymbol: vi.fn(async () => true),
  emit: vi.fn(async () => undefined),
  emitReadd: vi.fn(async () => undefined),
  emitMembershipLost: vi.fn(async () => undefined),
  cleanupOrphanedAdded: vi.fn(async () => undefined),
  notify: vi.fn(async () => undefined),
  enqueueResync: vi.fn(async () => undefined),
  persistExplain: vi.fn(async () => undefined),
  persistSnapshot: vi.fn(async () => undefined),
  ...over,
});

// Sibling account-level conflict (#661). Sibling profiles under one account share
// a wallet, so a candidate whose base asset is the QUOTE of a sibling (C1) or is
// already TRADED by a sibling (C2) cannot be sized/stop-armed independently and
// must be suppressed with an operator-visible reason. The structured
// `siblingConflict(symbol)` verdict threads into the persisted explain so the
// dashboard shows WHY.
const stubSiblingConflict = (port: DiscoveryProfilePort, reason: SiblingConflict): void => {
  port.siblingConflict = vi.fn(async () => reason);
};

// The persisted explain row for a symbol from the single persistExplain call.
const explainRowFor = (
  port: DiscoveryProfilePort,
  symbol: string,
): { symbol: string; disposition: string } | undefined => {
  const candidates = (port.persistExplain as ReturnType<typeof vi.fn>).mock.calls[0]?.[0] as
    ReadonlyArray<{ symbol: string; disposition: string }> | undefined;
  return candidates?.find((c) => c.symbol === symbol);
};

describe('runDiscoveryForProfile — sibling account-level conflict (#661)', () => {
  it('C1: a candidate whose base asset is a sibling profile’s quote asset is not admitted, disposition sibling-quotes-base', async () => {
    // AAAUSDT (base AAA) while a sibling TrailingTrade profile settles in AAA (e.g.
    // it trades XXXAAA). No sibling OWNS the base, but the quote collision must
    // still suppress the add and surface the reason.
    const port = fakePort();
    stubSiblingConflict(port, 'sibling-quotes-base');
    const r = await runDiscoveryForProfile(port, permissiveConfig(), 'USDT', NOW);
    expect(r).toEqual({ added: 0, removed: 0 });
    expect(port.addSymbol).not.toHaveBeenCalled();
    expect(port.emit).not.toHaveBeenCalledWith('AAAUSDT', 'add');
    expect(port.enqueueResync).not.toHaveBeenCalled();
    expect(explainRowFor(port, 'AAAUSDT')?.disposition).toBe('sibling-quotes-base');
  });

  it('C2: a candidate whose base asset a sibling already trades is not admitted, disposition sibling-owns-base', async () => {
    // AAAUSDT while a sibling trades AAABTC (same base AAA). The candidate is not
    // bound, and the explain records the structured reason, not a misleading 'added'.
    const port = fakePort();
    stubSiblingConflict(port, 'sibling-owns-base');
    const r = await runDiscoveryForProfile(port, permissiveConfig(), 'USDT', NOW);
    expect(r).toEqual({ added: 0, removed: 0 });
    expect(port.addSymbol).not.toHaveBeenCalled();
    expect(explainRowFor(port, 'AAAUSDT')?.disposition).toBe('sibling-owns-base');
  });

  it('C3: a sibling-suppressed candidate carries an operator-visible reason in the persisted explain, never a misleading added/kept', async () => {
    const port = fakePort();
    stubSiblingConflict(port, 'sibling-owns-base');
    await runDiscoveryForProfile(port, permissiveConfig(), 'USDT', NOW);
    const disposition = explainRowFor(port, 'AAAUSDT')?.disposition;
    expect(disposition).not.toBe('added');
    expect(disposition).not.toBe('kept');
    expect(['sibling-owns-base', 'sibling-quotes-base']).toContain(disposition);
  });

  it('C4 (regression guard): no sibling conflict still admits and records disposition added', async () => {
    // False-positive guard: the new suppression must not swallow a clean candidate.
    // GREEN today and must stay GREEN after Phase B.
    const port = fakePort();
    stubSiblingConflict(port, null);
    const r = await runDiscoveryForProfile(port, permissiveConfig(), 'USDT', NOW);
    expect(r).toEqual({ added: 1, removed: 0 });
    expect(port.addSymbol).toHaveBeenCalledWith('AAAUSDT', NOW);
    expect(port.emit).toHaveBeenCalledWith('AAAUSDT', 'add');
    expect(explainRowFor(port, 'AAAUSDT')?.disposition).toBe('added');
  });
});

describe('runDiscoveryForProfile', () => {
  it('adds a fresh eligible symbol and enqueues one resync', async () => {
    const port = fakePort();
    const r = await runDiscoveryForProfile(port, permissiveConfig(), 'USDT', NOW);
    expect(r).toEqual({ added: 1, removed: 0 });
    // The add binds the row; the per-cycle refresh pass owns the hint hash.
    expect(port.addSymbol).toHaveBeenCalledWith('AAAUSDT', NOW);
    expect(port.emit).toHaveBeenCalledWith('AAAUSDT', 'add');
    expect(port.notify).toHaveBeenCalledTimes(1);
    expect(port.enqueueResync).toHaveBeenCalledTimes(1);
    expect(port.persistExplain).toHaveBeenCalledTimes(1);
  });

  // The still-forming candle guard. getKlines returns the current, not-yet-closed
  // hour as the last row; its partial volume/price must not feed trend-confirm.
  const fiveRisingClosed = (): Candle[] =>
    Array.from({ length: 5 }, (_, i) => ({
      openTimeMs: NOW - 5 * 24 * HOUR + i * HOUR,
      closeTimeMs: NOW - 5 * 24 * HOUR + (i + 1) * HOUR,
      open: String(100 + i * 4 - 2),
      high: String(100 + i * 4 + 1),
      low: String(100 + i * 4 - 3),
      close: String(100 + i * 4),
      volume: '10',
      isClosed: true,
    }));
  // A collapsing, low-volume bar that fails trend-confirm if it reaches the chain.
  const badBar = (closeTimeMs: number): Candle => ({
    openTimeMs: NOW - HOUR,
    closeTimeMs,
    open: '120',
    high: '121',
    low: '70',
    close: '72',
    volume: '1',
    isClosed: true, // klineToCandle mislabels the forming bar this way in prod
  });
  const trendCfg = () =>
    DiscoveryConfigSchema.parse({
      enabled: true,
      minAgeDays: 1,
      maxAutoSymbols: 5,
      minHoldMinutes: 60,
      min24hPairVolumeUsd: '1',
      min24hAssetVolumeUsd: '1',
      maxSpreadRatio: '1',
      changeMinPercent: '0',
      rankTopPercent: 100,
      rankExcludeTopPercent: 0,
      trendConfirm: {
        adxPeriod: 2,
        adxMin: '0',
        emaPeriod: 2,
        volSmaPeriod: 2,
        volMultiple: '0.5',
      },
    });

  it('drops the still-forming final candle so trend-confirm reads closed bars only', async () => {
    const port = fakePort({ getKlines: async () => [...fiveRisingClosed(), badBar(NOW + HOUR)] });
    const r = await runDiscoveryForProfile(port, trendCfg(), 'USDT', NOW);
    expect(r).toEqual({ added: 1, removed: 0 });
    expect(port.addSymbol).toHaveBeenCalledWith('AAAUSDT', NOW);
  });

  it('keeps a final candle that is already closed (trims by close time, not position)', async () => {
    const port = fakePort({ getKlines: async () => [...fiveRisingClosed(), badBar(NOW - HOUR)] });
    const r = await runDiscoveryForProfile(port, trendCfg(), 'USDT', NOW);
    expect(r).toEqual({ added: 0, removed: 0 });
    expect(port.addSymbol).not.toHaveBeenCalled();
  });

  it('refreshes the entry-hint for every desired symbol each cycle with the enterOnAdd flag + fresh 24h high + guard params (#486)', async () => {
    const port = fakePort({ getAllTickers: async () => [ticker({ highPrice: '123.45' })] });
    const cfg = DiscoveryConfigSchema.parse({
      ...permissiveConfig(),
      enterOnAdd: true,
      entryGuard: { maxDistanceFrom24hHighPercent: '3', knifeCandles: 3, knifeDropPercent: '5' },
    });
    await runDiscoveryForProfile(port, cfg, 'USDT', NOW);
    const call = (port.refreshEntryHint as ReturnType<typeof vi.fn>).mock.calls[0];
    expect(call?.[0]).toBe('AAAUSDT');
    expect(JSON.parse(call?.[1] as string)).toEqual({
      at: NOW,
      enterOnAdd: true,
      high24h: '123.45',
      maxDistanceFrom24hHighPercent: '3',
      knifeCandles: 3,
      knifeDropPercent: '5',
    });
  });

  it('arms the guards for a non-enterOnAdd profile too — the hint carries enterOnAdd:false (#486)', async () => {
    const port = fakePort({ getAllTickers: async () => [ticker({ highPrice: '123.45' })] });
    const cfg = DiscoveryConfigSchema.parse({
      ...permissiveConfig(),
      enterOnAdd: false,
      entryGuard: { maxDistanceFrom24hHighPercent: '3', knifeCandles: 0, knifeDropPercent: '0' },
    });
    await runDiscoveryForProfile(port, cfg, 'USDT', NOW);
    const call = (port.refreshEntryHint as ReturnType<typeof vi.fn>).mock.calls[0];
    expect(call?.[0]).toBe('AAAUSDT');
    expect(JSON.parse(call?.[1] as string)).toMatchObject({
      enterOnAdd: false,
      high24h: '123.45',
      maxDistanceFrom24hHighPercent: '3',
    });
  });

  it('refreshes the hint for a retained (already-auto) symbol so its 24h high is not frozen at add (#486)', async () => {
    // AAAUSDT is already an auto member and stays desired this cycle — no add,
    // but the refresh pass must still re-stamp its current 24h high.
    const port = fakePort({
      listAutoSymbols: async () => ['AAAUSDT'],
      getAllTickers: async () => [ticker({ symbol: 'AAAUSDT', highPrice: '999' })],
    });
    await runDiscoveryForProfile(port, permissiveConfig(), 'USDT', NOW);
    expect(port.addSymbol).not.toHaveBeenCalled();
    const call = (port.refreshEntryHint as ReturnType<typeof vi.fn>).mock.calls.find(
      (c) => c[0] === 'AAAUSDT',
    );
    expect(call).toBeDefined();
    expect(JSON.parse(call?.[1] as string)).toMatchObject({ high24h: '999' });
  });

  it('a created add emits the INFO add line and not the re-add warn (#454)', async () => {
    const port = fakePort();
    await runDiscoveryForProfile(port, permissiveConfig(), 'USDT', NOW);
    expect(port.emit).toHaveBeenCalledWith('AAAUSDT', 'add');
    expect(port.emitReadd).not.toHaveBeenCalled();
  });

  it('a re-added symbol emits the re-add warn carrying prevAddedAt, not the INFO add (#454)', async () => {
    const T0 = NOW - HOUR;
    const port = fakePort({
      addSymbol: vi.fn(async () => ({ outcome: 'readded' as const, prevAddedAt: T0 })),
    });
    const r = await runDiscoveryForProfile(port, permissiveConfig(), 'USDT', NOW);
    expect(r.added).toBe(1);
    expect(port.emitReadd).toHaveBeenCalledWith('AAAUSDT', T0);
    expect(port.emit).not.toHaveBeenCalledWith('AAAUSDT', 'add');
    // a re-add still notifies (operator-visible rotation)
    expect(port.notify).toHaveBeenCalledTimes(1);
  });

  it('reports a silently lost membership once and cleans the orphaned hash (#454)', async () => {
    // GHOSTUSDT is in the added-at hash (discovery once added it) but is no longer
    // a current auto member and never recorded a flatten stamp — it vanished
    // without a reap. The sweep must warn once and clean the orphaned entry.
    const T0 = NOW - 2 * HOUR;
    const port = fakePort({
      addedAtBySymbol: async () => ({ GHOSTUSDT: T0 }),
      listAutoSymbols: async () => [],
      lastFlattenBySymbol: async () => ({}),
    });
    await runDiscoveryForProfile(port, permissiveConfig(), 'USDT', NOW);
    expect(port.emitMembershipLost).toHaveBeenCalledTimes(1);
    expect(port.emitMembershipLost).toHaveBeenCalledWith('GHOSTUSDT', T0);
    expect(port.cleanupOrphanedAdded).toHaveBeenCalledWith('GHOSTUSDT');
  });

  it('does not report a legit reap (flatten stamp at/after added-at) as a lost membership (#454)', async () => {
    const T0 = NOW - 2 * HOUR;
    const port = fakePort({
      addedAtBySymbol: async () => ({ GHOSTUSDT: T0 }),
      listAutoSymbols: async () => [],
      lastFlattenBySymbol: async () => ({ GHOSTUSDT: T0 + HOUR }), // reaped after add
    });
    await runDiscoveryForProfile(port, permissiveConfig(), 'USDT', NOW);
    expect(port.emitMembershipLost).not.toHaveBeenCalled();
    expect(port.cleanupOrphanedAdded).not.toHaveBeenCalled();
  });

  it('a lost-then-re-added symbol reports a single re-add, not a contradictory membership loss (#454)', async () => {
    // AAAUSDT is the default eligible ticker, so it lands in diff.add this cycle.
    // It is also in the added-at hash, NOT a current auto member, and has no
    // flatten stamp — the pre-fix sweep would have falsely reported it lost AND
    // hdel'd the hash (then the add loop would misclassify it `created`). The
    // add-set skip means it heals as exactly one `readded` via the add loop.
    const T0 = NOW - 2 * HOUR;
    const port = fakePort({
      addedAtBySymbol: async () => ({ AAAUSDT: T0 }),
      listAutoSymbols: async () => [],
      lastFlattenBySymbol: async () => ({}),
      addSymbol: vi.fn(async () => ({ outcome: 'readded' as const, prevAddedAt: T0 })),
    });
    const r = await runDiscoveryForProfile(port, permissiveConfig(), 'USDT', NOW);
    expect(r.added).toBe(1);
    expect(port.emitReadd).toHaveBeenCalledTimes(1);
    expect(port.emitReadd).toHaveBeenCalledWith('AAAUSDT', T0);
    expect(port.emitMembershipLost).not.toHaveBeenCalled();
    expect(port.cleanupOrphanedAdded).not.toHaveBeenCalled();
  });

  it('an "existing" add emits nothing, notifies nothing, and counts zero (#454)', async () => {
    // The eligible AAAUSDT is already bound (row present) — the add is a no-op.
    const port = fakePort({
      addSymbol: vi.fn(async () => ({ outcome: 'existing' as const })),
    });
    const r = await runDiscoveryForProfile(port, permissiveConfig(), 'USDT', NOW);
    expect(r.added).toBe(0);
    expect(port.emit).not.toHaveBeenCalledWith('AAAUSDT', 'add');
    expect(port.emitReadd).not.toHaveBeenCalled();
    expect(port.notify).not.toHaveBeenCalled();
  });

  it('does not flag a still-current auto member as a lost membership (#454)', async () => {
    // KEEPUSDT is in BOTH the added-at hash and the current auto set, so the
    // autoSet.has skip applies — it is a live member, not a loss.
    const T0 = NOW - 2 * HOUR;
    const port = fakePort({
      addedAtBySymbol: async () => ({ KEEPUSDT: T0 }),
      listAutoSymbols: async () => ['KEEPUSDT'],
      lastFlattenBySymbol: async () => ({}),
    });
    await runDiscoveryForProfile(port, permissiveConfig(), 'USDT', NOW);
    expect(port.emitMembershipLost).not.toHaveBeenCalled();
    expect(port.cleanupOrphanedAdded).not.toHaveBeenCalled();
  });

  it('persists the universe breakdown even when nothing rotates', async () => {
    const port = fakePort({ getAllTickers: async () => [] }); // empty universe, no changes
    await runDiscoveryForProfile(port, permissiveConfig(), 'USDT', NOW);
    expect(port.persistExplain).toHaveBeenCalledTimes(1);
    expect(port.enqueueResync).not.toHaveBeenCalled();
  });

  it('logs a point-in-time universe snapshot every cycle with the expected shape (#436)', async () => {
    const cfg = permissiveConfig();
    const port = fakePort();
    await runDiscoveryForProfile(port, cfg, 'USDT', NOW);
    expect(port.persistSnapshot).toHaveBeenCalledTimes(1);
    const snap = (port.persistSnapshot as ReturnType<typeof vi.fn>).mock.calls[0][0];
    // Universe is the full quote-matched ranked ticker set, decimal-strings kept.
    expect(snap.universe).toEqual([
      { symbol: 'AAAUSDT', priceChangePercent: '10', quoteVolume: '1' },
    ]);
    // Shortlist + resolved diff reflect the eligible add.
    expect(snap.shortlist).toEqual(['AAAUSDT']);
    expect(snap.add).toEqual(['AAAUSDT']);
    expect(snap.remove).toEqual([]);
    expect(snap.desired).toEqual(['AAAUSDT']);
    // The threshold digest in force at t.
    expect(snap.configDigest).toEqual({
      quoteAsset: 'USDT', // threaded from the profile column, no longer on cfg
      maxAutoSymbols: cfg.maxAutoSymbols,
      changeMinPercent: cfg.changeMinPercent,
      rankTopPercent: cfg.rankTopPercent,
      rankExcludeTopPercent: cfg.rankExcludeTopPercent,
      marketBreadthMinPercent: cfg.marketBreadthMinPercent,
    });
  });

  it('persists a per-cycle filter funnel on the snapshot (#629)', async () => {
    const port = fakePort();
    await runDiscoveryForProfile(port, permissiveConfig(), 'USDT', NOW);
    expect(port.persistSnapshot).toHaveBeenCalledTimes(1);
    const snap = (port.persistSnapshot as ReturnType<typeof vi.fn>).mock.calls[0][0];
    expect(snap.funnel).toBeDefined();
    expect(snap.funnel).toMatchObject({
      universe: expect.any(Number),
      quote: expect.any(Number),
      blacklist: expect.any(Number),
      liquidity: expect.any(Number),
      activity: expect.any(Number),
      spread: expect.any(Number),
      changeBand: expect.any(Number),
      age: expect.any(Number),
      trend: expect.any(Number),
      eligible: expect.any(Number),
      added: expect.any(Number),
      kept: expect.any(Number),
      removed: expect.any(Number),
      breadthOk: expect.any(Boolean),
    });
  });

  it('persists a snapshot even on a no-op (empty universe) cycle (#436)', async () => {
    const port = fakePort({ getAllTickers: async () => [] });
    await runDiscoveryForProfile(port, permissiveConfig(), 'USDT', NOW);
    expect(port.persistSnapshot).toHaveBeenCalledTimes(1);
    const snap = (port.persistSnapshot as ReturnType<typeof vi.fn>).mock.calls[0][0];
    expect(snap.universe).toEqual([]);
    expect(snap.add).toEqual([]);
    expect(snap.desired).toEqual([]);
    // The funnel is still present on a no-op cycle, zeroed out.
    expect(snap.funnel).toMatchObject({ universe: 0, eligible: 0, added: 0, kept: 0, removed: 0 });
  });

  it('threads manual members so a pinned, still-qualifying symbol is not re-added (issue #435)', async () => {
    // The only ticker (AAAUSDT) qualifies, but the operator pinned it to manual.
    const port = fakePort({ listManualSymbols: async () => ['AAAUSDT'] });
    const r = await runDiscoveryForProfile(port, permissiveConfig(), 'USDT', NOW);
    expect(r).toEqual({ added: 0, removed: 0 });
    expect(port.addSymbol).not.toHaveBeenCalled();
    expect(port.enqueueResync).not.toHaveBeenCalled();
  });

  it('reaps a faded auto symbol past its min-hold', async () => {
    const port = fakePort({ listAutoSymbols: async () => ['OLDUSDT'] }); // not in the shortlist
    const r = await runDiscoveryForProfile(port, permissiveConfig(), 'USDT', NOW);
    expect(r.removed).toBe(1);
    expect(port.reapSymbol).toHaveBeenCalledWith('OLDUSDT', NOW);
    expect(port.emit).toHaveBeenCalledWith('OLDUSDT', 'remove');
  });

  it('does not emit/notify a remove the repo flat-guard vetoes (still held)', async () => {
    const port = fakePort({
      listAutoSymbols: async () => ['OLDUSDT'],
      reapSymbol: vi.fn(async () => false), // held — flat-guard refused
    });
    const r = await runDiscoveryForProfile(port, permissiveConfig(), 'USDT', NOW);
    expect(r.removed).toBe(0);
    expect(port.emit).not.toHaveBeenCalledWith('OLDUSDT', 'remove');
  });

  it('never reaps a symbol the exchange wallet still holds (adoption-lag guard)', async () => {
    // The faded auto symbol qualifies for removal, but the wallet still holds a
    // sellable position — a real buy whose fill has not yet been adopted. Reaping
    // would orphan a live position, so the reap must be skipped entirely.
    const port = fakePort({
      listAutoSymbols: async () => ['OLDUSDT'],
      heldOnExchange: vi.fn(async () => true),
    });
    const r = await runDiscoveryForProfile(port, permissiveConfig(), 'USDT', NOW);
    expect(r.removed).toBe(0);
    expect(port.reapSymbol).not.toHaveBeenCalled();
    expect(port.emit).not.toHaveBeenCalledWith('OLDUSDT', 'remove');
  });

  it('defers the reap when the wallet balance is unreadable (fail-safe)', async () => {
    // A null held result (no credentials / API error) must be treated as held:
    // never abandon a symbol we cannot prove is flat.
    const port = fakePort({
      listAutoSymbols: async () => ['OLDUSDT'],
      heldOnExchange: vi.fn(async () => null),
    });
    const r = await runDiscoveryForProfile(port, permissiveConfig(), 'USDT', NOW);
    expect(r.removed).toBe(0);
    expect(port.reapSymbol).not.toHaveBeenCalled();
  });

  it('a quote change never reaps a still-held old-quote symbol', async () => {
    // After the operator changes the profile quote (USDT -> BTC), a coin bought
    // under the old quote no longer matches the new universe, so it fades from
    // the shortlist and becomes a reap candidate. The held-guard must still see
    // the wallet position and skip the reap, so the position is kept until it
    // exits on its own — a quote change never force-abandons a held coin.
    const port = fakePort({
      // New BTC universe; the old-quote OLDUSDT holding is no longer a candidate.
      // BTCUSDT is the reference row that prices the new quote in USD.
      getAllTickers: async () => [
        ticker({ symbol: 'BTCUSDT', lastPrice: '100000' }),
        ticker({ symbol: 'NEWBTC' }),
      ],
      listAutoSymbols: async () => ['OLDUSDT'],
      heldOnExchange: vi.fn(async (symbol) => symbol === 'OLDUSDT'),
    });
    const r = await runDiscoveryForProfile(port, permissiveConfig(), 'BTC', NOW);
    expect(r.removed).toBe(0);
    expect(port.reapSymbol).not.toHaveBeenCalled();
    expect(port.emit).not.toHaveBeenCalledWith('OLDUSDT', 'remove');
  });

  it('throws rather than scanning a quote asset it cannot price in USD', async () => {
    // With no XYZUSDT reference row, every USD volume floor would compare against
    // an unknown scale and silently reject the universe. Fail loudly instead; the
    // caller's per-profile catch then leaves the symbol set untouched.
    const port = fakePort({ getAllTickers: async () => [ticker({ symbol: 'AAAXYZ' })] });
    await expect(runDiscoveryForProfile(port, permissiveConfig(), 'XYZ', NOW)).rejects.toThrow(
      /cannot price quote asset XYZ/,
    );
    expect(port.reapSymbol).not.toHaveBeenCalled();
  });

  it('a kline fetch error aborts the cycle without reaping a held symbol (fail-fast)', async () => {
    // Klines are fetched with bounded concurrency under `fail-fast`, preserving
    // the old serial loop's semantics: any fetch error rejects the whole cycle
    // (the outer handler then leaves the symbol set untouched). This guards a
    // regression — a partial-result (collect) fetch would drop the failed held
    // symbol from `klinesBySymbol`, the chain would read it as faded, and a
    // transient network blip would reap a live position.
    const T0 = NOW - 2 * HOUR; // past minHoldMinutes:60 → a genuine reap candidate
    const port = fakePort({
      listAutoSymbols: async () => ['AAAUSDT'], // held auto, past min-hold
      addedAtBySymbol: async () => ({ AAAUSDT: T0 }),
      getKlines: vi.fn(async () => {
        throw new Error('kline boom');
      }),
    });
    await expect(runDiscoveryForProfile(port, permissiveConfig(), 'USDT', NOW)).rejects.toThrow(
      'kline boom',
    );
    expect(port.reapSymbol).not.toHaveBeenCalled();
    expect(port.addSymbol).not.toHaveBeenCalled();
    expect(port.enqueueResync).not.toHaveBeenCalled();
  });

  it('enqueues no resync when nothing changes', async () => {
    const port = fakePort({ getAllTickers: async () => [] }); // empty universe
    const r = await runDiscoveryForProfile(port, permissiveConfig(), 'USDT', NOW);
    expect(r).toEqual({ added: 0, removed: 0 });
    expect(port.enqueueResync).not.toHaveBeenCalled();
  });

  it('caps the kline walk at 3x maxAutoSymbols but always fetches held symbols', async () => {
    // 40 ranked candidates (gain 40..1) all clear the permissive ticker filters,
    // plus a held auto symbol ranked dead last (gain 0.1).
    const tickers: Ticker24hrDto[] = Array.from({ length: 40 }, (_, i) =>
      ticker({ symbol: `S${String(i).padStart(2, '0')}USDT`, priceChangePercent: String(40 - i) }),
    );
    tickers.push(ticker({ symbol: 'HELDUSDT', priceChangePercent: '0.1' }));
    const fetched: string[] = [];
    const port = fakePort({
      getAllTickers: async () => tickers,
      listAutoSymbols: async () => ['HELDUSDT'],
      getKlines: async (symbol) => {
        fetched.push(symbol);
        return eligibleKlines();
      },
    });
    await runDiscoveryForProfile(port, permissiveConfig(), 'USDT', NOW);
    // 3 * maxAutoSymbols(5) = 15 top non-held candidates + the 1 held symbol.
    expect(fetched).toHaveLength(16);
    expect(fetched).toContain('S00USDT'); // top-ranked candidate fetched
    expect(fetched).toContain('HELDUSDT'); // held symbol fetched despite last rank
    expect(fetched).not.toContain('S20USDT'); // beyond the cap → skipped this cycle
  });
});
