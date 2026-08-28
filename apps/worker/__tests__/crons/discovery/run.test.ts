import { describe, expect, it, vi } from 'vitest';
import { DiscoveryConfigSchema, type StoredDiscoveryConfig } from '@app/contracts';
import type { Ticker24hrDto } from '@app/binance';
import type { Candle } from '@app/strategy-core';
import {
  runDiscoveryForProfile,
  type DiscoveryProfilePort,
} from '../../../src/crons/discovery/run.js';
import type { SiblingConflict } from '../../../src/crons/sibling-conflict.js';
import type { SymbolAdmission } from '../../../src/crons/discovery/symbol-admission.js';
import type { DiscoveryProfileContext } from '../../../src/crons/discovery/run.js';

const NOW = 1_700_000_000_000;
const HOUR = 3_600_000;

// Every reap outcome a cycle can tally, at zero. Two of them never reach the repo at all: the wallet guard refuses before `reapSymbol` is called, and its bare `continue` is why a coin that stopped rotating because the balance read failed looked identical to one nothing wanted to rotate. Literal keys rather than an import from src so this file loads and fails on its assertions.
const REAP_TALLY_ZERO = {
  removed: 0,
  pinned: 0,
  held: 0,
  'not-found': 0,
  'wallet-held': 0,
  'hold-unproven': 0,
} as const;

type ReapTally = Record<keyof typeof REAP_TALLY_ZERO, number>;

/** The zeroed tally with only the named outcomes raised, so every assertion states the whole record and a stray count elsewhere fails. */
const reapTally = (over: Partial<ReapTally> = {}): ReapTally => ({ ...REAP_TALLY_ZERO, ...over });

/** Outcomes handed to the sink, in decision order. The sink is fed per decision, so this is what survives a cycle that never returns. */
const recorded = (port: DiscoveryProfilePort): string[] =>
  (port.recordReapOutcome as ReturnType<typeof vi.fn>).mock.calls.map((c) => c[0] as string);

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

/**
 * Split a FIXTURE symbol into base and quote. Production never does this — it reads exchangeInfo, which is exactly why the admission map is required — but a fixture has to state the split somewhere, and the symbols here are all `<BASE><QUOTE>` with a quote drawn from this short list.
 */
const splitFixtureSymbol = (symbol: string): { baseAsset: string; quoteAsset: string } => {
  for (const q of ['USDT', 'XYZ', 'BTC']) {
    if (symbol.endsWith(q) && symbol.length > q.length) {
      return { baseAsset: symbol.slice(0, -q.length), quoteAsset: q };
    }
  }
  return { baseAsset: symbol, quoteAsset: 'USDT' };
};

/** Symbols every wake context admits on top of whatever the port's feed carries, so an empty-universe fixture still has a primed exchangeInfo map (an unprimed one is now a hard abort, tested on its own). */
const BASELINE_SYMBOLS = ['AAAUSDT', 'BTCUSDT'] as const;

/**
 * Run one cycle with the exchange facts a wake supplies, derived from the port's own feed so the product/exchangeInfo completeness check passes and the only thing a test can move is what it overrides. Calls `getAllTickers` once more than production would; no assertion in this file counts that call.
 *
 * @param port - The cycle's injected I/O.
 * @param stored - The profile's stored discovery settings.
 * @param quoteAsset - The profile's settlement asset.
 * @param over - Fields of the wake context to replace, for tests about the context itself.
 * @returns The cycle's add/remove counts plus its per-outcome rotation tally.
 */
const runCycle = async (
  port: DiscoveryProfilePort,
  stored: StoredDiscoveryConfig,
  quoteAsset = 'USDT',
  over: Partial<DiscoveryProfileContext> = {},
): Promise<{ added: number; removed: number; reapOutcomes: ReapTally }> => {
  const symbols = [
    ...new Set([...BASELINE_SYMBOLS, ...(await port.getAllTickers()).map((t) => t.symbol)]),
  ];
  const admissionBySymbol = new Map<string, SymbolAdmission>(
    symbols.map((sym) => [sym, { status: 'TRADING', ...splitFixtureSymbol(sym) }]),
  );
  return runDiscoveryForProfile(port, stored, quoteAsset, NOW, {
    admissionBySymbol,
    liveAdmission: admissionBySymbol,
    assetPolicy: {
      // Both routes live, so the classification is accepted as usable; no fixture
      // symbol carries either base, so the stage is inert everywhere except where
      // a test overrides the context.
      stablecoinOrFiatBases: new Set(['PEG', 'ZWL']),
      taggedStablecoinBases: new Set(['PEG']),
      fiatQuoteAssets: new Set(['ZWL']),
      tradingSymbols: new Set(symbols),
    },
    ...over,
  });
};

const fakePort = (over: Partial<DiscoveryProfilePort> = {}): DiscoveryProfilePort => ({
  logger: { warn: vi.fn() },
  getAllTickers: async () => [ticker({ symbol: 'AAAUSDT' })],
  getKlines: async () => eligibleKlines(),
  listRotatableSymbols: async () => [],
  listPinnedSymbols: async () => [],
  lastFlattenBySymbol: async () => ({}),
  addedAtBySymbol: async () => ({}),
  addSymbol: vi.fn(async () => ({ outcome: 'created' as const })),
  siblingConflict: vi.fn(async () => null), // default: no sibling conflict
  refreshEntryHint: vi.fn(async () => undefined),
  heldOnExchange: vi.fn(async () => false), // default: wallet flat, reap allowed
  reapSymbol: vi.fn(async () => 'removed' as const),
  recordReapOutcome: vi.fn(),
  emit: vi.fn(async () => undefined),
  emitReadd: vi.fn(async () => undefined),
  emitMembershipLost: vi.fn(async () => undefined),
  cleanupOrphanedAdded: vi.fn(async () => undefined),
  notify: vi.fn(async () => undefined),
  enqueueResync: vi.fn(async () => undefined),
  persistExplain: vi.fn(async () => undefined),
  persistSnapshot: vi.fn<DiscoveryProfilePort['persistSnapshot']>(async () => undefined),
  ...over,
});

// The port's `persistSnapshot` is a `vi.fn`, but the DiscoveryProfilePort type says nothing about mocks, so reading `.mock.calls` needs the cast back to the spy type it was built with.
const snapshotFor = (
  port: DiscoveryProfilePort,
): Parameters<DiscoveryProfilePort['persistSnapshot']>[0] => {
  const persistSnapshot = port.persistSnapshot as ReturnType<
    typeof vi.fn<DiscoveryProfilePort['persistSnapshot']>
  >;
  const snapshot = persistSnapshot.mock.calls[0]?.[0];
  if (!snapshot) throw new Error('expected a persisted discovery snapshot');
  return snapshot;
};

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
    const r = await runCycle(port, permissiveConfig(), 'USDT');
    expect(r).toEqual({ added: 0, removed: 0, reapOutcomes: reapTally() });
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
    const r = await runCycle(port, permissiveConfig(), 'USDT');
    expect(r).toEqual({ added: 0, removed: 0, reapOutcomes: reapTally() });
    expect(port.addSymbol).not.toHaveBeenCalled();
    expect(explainRowFor(port, 'AAAUSDT')?.disposition).toBe('sibling-owns-base');
  });

  it('C3: a sibling-suppressed candidate carries an operator-visible reason in the persisted explain, never a misleading added/kept', async () => {
    const port = fakePort();
    stubSiblingConflict(port, 'sibling-owns-base');
    await runCycle(port, permissiveConfig(), 'USDT');
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
    const r = await runCycle(port, permissiveConfig(), 'USDT');
    expect(r).toEqual({ added: 1, removed: 0, reapOutcomes: reapTally() });
    expect(port.addSymbol).toHaveBeenCalledWith('AAAUSDT', NOW);
    expect(port.emit).toHaveBeenCalledWith('AAAUSDT', 'add');
    expect(explainRowFor(port, 'AAAUSDT')?.disposition).toBe('added');
  });
});

describe('runDiscoveryForProfile', () => {
  it('adds a fresh eligible symbol and enqueues one resync', async () => {
    const port = fakePort();
    const r = await runCycle(port, permissiveConfig(), 'USDT');
    expect(r).toEqual({ added: 1, removed: 0, reapOutcomes: reapTally() });
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
    const r = await runCycle(port, trendCfg(), 'USDT');
    expect(r).toEqual({ added: 1, removed: 0, reapOutcomes: reapTally() });
    expect(port.addSymbol).toHaveBeenCalledWith('AAAUSDT', NOW);
  });

  it('keeps a final candle that is already closed (trims by close time, not position)', async () => {
    const port = fakePort({ getKlines: async () => [...fiveRisingClosed(), badBar(NOW - HOUR)] });
    const r = await runCycle(port, trendCfg(), 'USDT');
    expect(r).toEqual({ added: 0, removed: 0, reapOutcomes: reapTally() });
    expect(port.addSymbol).not.toHaveBeenCalled();
  });

  it('refreshes the entry-hint for every desired symbol each cycle with the enterOnAdd flag + fresh 24h high + guard params (#486)', async () => {
    const port = fakePort({ getAllTickers: async () => [ticker({ highPrice: '123.45' })] });
    const cfg = DiscoveryConfigSchema.parse({
      ...permissiveConfig(),
      enterOnAdd: true,
      entryGuard: { maxDistanceFrom24hHighPercent: '3', knifeCandles: 3, knifeDropPercent: '5' },
    });
    await runCycle(port, cfg, 'USDT');
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
    await runCycle(port, cfg, 'USDT');
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
      listRotatableSymbols: async () => ['AAAUSDT'],
      getAllTickers: async () => [ticker({ symbol: 'AAAUSDT', highPrice: '999' })],
    });
    await runCycle(port, permissiveConfig(), 'USDT');
    expect(port.addSymbol).not.toHaveBeenCalled();
    const call = (port.refreshEntryHint as ReturnType<typeof vi.fn>).mock.calls.find(
      (c) => c[0] === 'AAAUSDT',
    );
    expect(call).toBeDefined();
    expect(JSON.parse(call?.[1] as string)).toMatchObject({ high24h: '999' });
  });

  it('a created add emits the INFO add line and not the re-add warn (#454)', async () => {
    const port = fakePort();
    await runCycle(port, permissiveConfig(), 'USDT');
    expect(port.emit).toHaveBeenCalledWith('AAAUSDT', 'add');
    expect(port.emitReadd).not.toHaveBeenCalled();
  });

  it('a re-added symbol emits the re-add warn carrying prevAddedAt, not the INFO add (#454)', async () => {
    const T0 = NOW - HOUR;
    const port = fakePort({
      addSymbol: vi.fn(async () => ({ outcome: 'readded' as const, prevAddedAt: T0 })),
    });
    const r = await runCycle(port, permissiveConfig(), 'USDT');
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
      listRotatableSymbols: async () => [],
      lastFlattenBySymbol: async () => ({}),
    });
    await runCycle(port, permissiveConfig(), 'USDT');
    expect(port.emitMembershipLost).toHaveBeenCalledTimes(1);
    expect(port.emitMembershipLost).toHaveBeenCalledWith('GHOSTUSDT', T0);
    expect(port.cleanupOrphanedAdded).toHaveBeenCalledWith('GHOSTUSDT');
  });

  it('does not report a legit reap (flatten stamp at/after added-at) as a lost membership (#454)', async () => {
    const T0 = NOW - 2 * HOUR;
    const port = fakePort({
      addedAtBySymbol: async () => ({ GHOSTUSDT: T0 }),
      listRotatableSymbols: async () => [],
      lastFlattenBySymbol: async () => ({ GHOSTUSDT: T0 + HOUR }), // reaped after add
    });
    await runCycle(port, permissiveConfig(), 'USDT');
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
      listRotatableSymbols: async () => [],
      lastFlattenBySymbol: async () => ({}),
      addSymbol: vi.fn(async () => ({ outcome: 'readded' as const, prevAddedAt: T0 })),
    });
    const r = await runCycle(port, permissiveConfig(), 'USDT');
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
    const r = await runCycle(port, permissiveConfig(), 'USDT');
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
      listRotatableSymbols: async () => ['KEEPUSDT'],
      lastFlattenBySymbol: async () => ({}),
    });
    await runCycle(port, permissiveConfig(), 'USDT');
    expect(port.emitMembershipLost).not.toHaveBeenCalled();
    expect(port.cleanupOrphanedAdded).not.toHaveBeenCalled();
  });

  it('persists the universe breakdown even when nothing rotates', async () => {
    const port = fakePort({ getAllTickers: async () => [] }); // empty universe, no changes
    await runCycle(port, permissiveConfig(), 'USDT');
    expect(port.persistExplain).toHaveBeenCalledTimes(1);
    expect(port.enqueueResync).not.toHaveBeenCalled();
  });

  it('logs a point-in-time universe snapshot every cycle with the expected shape (#436)', async () => {
    const cfg = permissiveConfig();
    const port = fakePort();
    await runCycle(port, cfg, 'USDT');
    expect(port.persistSnapshot).toHaveBeenCalledTimes(1);
    const snap = snapshotFor(port);
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
    await runCycle(port, permissiveConfig(), 'USDT');
    expect(port.persistSnapshot).toHaveBeenCalledTimes(1);
    const snap = snapshotFor(port);
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

  it('counts only the candidates a window was actually fetched for as probed', async () => {
    // ZZZUSDT is held but has fallen out of the ticker feed, so it is a
    // candidate (the explain unions the shortlist with the held set) that
    // `selectKlineTargets` never walked. Counting it as probed inflates the
    // candidate ladder's own denominator, and `largestDrop` then charges the
    // whole gap to the age cut below it — pointing the operator at a filter
    // that never ran instead of at the missing price history.
    const port = fakePort({ listRotatableSymbols: async () => ['ZZZUSDT'] });
    await runCycle(port, permissiveConfig(), 'USDT');
    const snap = snapshotFor(port);
    expect(snap.funnel?.probed).toBe(1);
  });

  it('persists a snapshot even on a no-op (empty universe) cycle (#436)', async () => {
    const port = fakePort({ getAllTickers: async () => [] });
    await runCycle(port, permissiveConfig(), 'USDT');
    expect(port.persistSnapshot).toHaveBeenCalledTimes(1);
    const snap = snapshotFor(port);
    expect(snap.universe).toEqual([]);
    expect(snap.add).toEqual([]);
    expect(snap.desired).toEqual([]);
    // The funnel is still present on a no-op cycle, zeroed out.
    expect(snap.funnel).toMatchObject({ universe: 0, eligible: 0, added: 0, kept: 0, removed: 0 });
  });

  it('threads manual members so a pinned, still-qualifying symbol is not re-added (issue #435)', async () => {
    // The only ticker (AAAUSDT) qualifies, but the operator pinned it to manual.
    const port = fakePort({ listPinnedSymbols: async () => ['AAAUSDT'] });
    const r = await runCycle(port, permissiveConfig(), 'USDT');
    expect(r).toEqual({ added: 0, removed: 0, reapOutcomes: reapTally() });
    expect(port.addSymbol).not.toHaveBeenCalled();
    expect(port.enqueueResync).not.toHaveBeenCalled();
  });

  it('reaps a faded auto symbol past its min-hold', async () => {
    const port = fakePort({ listRotatableSymbols: async () => ['OLDUSDT'] }); // not in the shortlist
    const r = await runCycle(port, permissiveConfig(), 'USDT');
    expect(r.removed).toBe(1);
    expect(port.reapSymbol).toHaveBeenCalledWith('OLDUSDT', NOW);
    expect(port.emit).toHaveBeenCalledWith('OLDUSDT', 'remove');
    // A success has to land on the same counter as the refusals, or the refusal share has no denominator and an operator reading the metric cannot tell "one refusal out of a hundred rotations" from "nothing rotates any more".
    expect(r.reapOutcomes).toEqual(reapTally({ removed: 1 }));
    expect(recorded(port)).toEqual(['removed']);
  });

  it('does not emit/notify a remove the repo flat-guard vetoes (still held)', async () => {
    const port = fakePort({
      listRotatableSymbols: async () => ['OLDUSDT'],
      reapSymbol: vi.fn(async () => 'held' as const), // flat-guard refused
    });
    const r = await runCycle(port, permissiveConfig(), 'USDT');
    expect(r.removed).toBe(0);
    expect(port.emit).not.toHaveBeenCalledWith('OLDUSDT', 'remove');
    expect(port.notify).not.toHaveBeenCalledWith('removed', 'OLDUSDT');
    expect(r.reapOutcomes).toEqual(reapTally({ held: 1 }));
    expect(recorded(port)).toEqual(['held']);
  });

  // The repo names three distinct refusals and they have three different remedies: a pin is the operator's own choice and needs nothing, an open order or position is a cycle that has not closed, and a missing row means discovery and the bindings table disagree about what is bound. Collapsed to one boolean they were indistinguishable, so none of them could be alerted on.
  it.each(['pinned', 'held', 'not-found'] as const)(
    'tallies the %s refusal under its own outcome and removes nothing',
    async (outcome) => {
      const port = fakePort({
        listRotatableSymbols: async () => ['OLDUSDT'],
        reapSymbol: vi.fn(async () => outcome),
      });
      const r = await runCycle(port, permissiveConfig(), 'USDT');
      expect(r.removed).toBe(0);
      expect(r.reapOutcomes).toEqual(reapTally({ [outcome]: 1 }));
      expect(recorded(port)).toEqual([outcome]);
      expect(port.emit).not.toHaveBeenCalledWith('OLDUSDT', 'remove');
    },
  );

  it('never reaps a symbol the exchange wallet still holds (adoption-lag guard)', async () => {
    // The faded auto symbol qualifies for removal, but the wallet still holds a
    // sellable position — a real buy whose fill has not yet been adopted. Reaping
    // would orphan a live position, so the reap must be skipped entirely.
    const port = fakePort({
      listRotatableSymbols: async () => ['OLDUSDT'],
      heldOnExchange: vi.fn(async () => true),
    });
    const r = await runCycle(port, permissiveConfig(), 'USDT');
    expect(r.removed).toBe(0);
    expect(port.reapSymbol).not.toHaveBeenCalled();
    expect(port.emit).not.toHaveBeenCalledWith('OLDUSDT', 'remove');
    // This refusal never reaches the repo, so the repo's own four outcomes can never describe it. Left uncounted, the most common reason a coin stops rotating is the one reason the metric cannot show.
    expect(r.reapOutcomes).toEqual(reapTally({ 'wallet-held': 1 }));
    expect(recorded(port)).toEqual(['wallet-held']);
  });

  it('defers the reap when the wallet balance is unreadable (fail-safe)', async () => {
    // A null held result (no credentials / API error) must be treated as held:
    // never abandon a symbol we cannot prove is flat.
    const port = fakePort({
      listRotatableSymbols: async () => ['OLDUSDT'],
      heldOnExchange: vi.fn(async () => null),
    });
    const r = await runCycle(port, permissiveConfig(), 'USDT');
    expect(r.removed).toBe(0);
    expect(port.reapSymbol).not.toHaveBeenCalled();
    // Separated from `wallet-held` because they are opposite facts. One is the guard working — a real position kept safe. The other is the guard blind, and a run of them is a credential or API fault that stops rotation entirely while looking exactly like a healthy hold.
    expect(r.reapOutcomes).toEqual(reapTally({ 'hold-unproven': 1 }));
    expect(recorded(port)).toEqual(['hold-unproven']);
  });

  it('tallies every outcome a single cycle produced, keeping emit/notify on the removals only', async () => {
    // One cycle can hit all six at once, and the tally is per-cycle rather than per-symbol on purpose: the outcome is what an operator acts on, and labelling the counter by symbol would make its cardinality the size of the tradable universe.
    const byOutcome: Record<string, 'removed' | 'pinned' | 'held' | 'not-found'> = {
      GONEUSDT: 'removed',
      PINUSDT: 'pinned',
      BUSYUSDT: 'held',
      MISSUSDT: 'not-found',
    };
    const port = fakePort({
      listRotatableSymbols: async () => [
        'GONEUSDT',
        'PINUSDT',
        'BUSYUSDT',
        'MISSUSDT',
        'WALLETUSDT',
        'BLINDUSDT',
      ],
      heldOnExchange: vi.fn(async (symbol: string) => {
        if (symbol === 'WALLETUSDT') return true;
        if (symbol === 'BLINDUSDT') return null;
        return false;
      }),
      reapSymbol: vi.fn(async (symbol: string) => byOutcome[symbol] ?? 'not-found'),
    });
    const r = await runCycle(port, permissiveConfig(), 'USDT');
    expect(r.removed).toBe(1);
    expect(r.reapOutcomes).toEqual({
      removed: 1,
      pinned: 1,
      held: 1,
      'not-found': 1,
      'wallet-held': 1,
      'hold-unproven': 1,
    });
    // The wallet guard still short-circuits before the repo call.
    expect(port.reapSymbol).not.toHaveBeenCalledWith('WALLETUSDT', NOW);
    expect(port.reapSymbol).not.toHaveBeenCalledWith('BLINDUSDT', NOW);
    // Exactly one symbol actually left, so exactly one remove is announced.
    const removeEmits = (port.emit as ReturnType<typeof vi.fn>).mock.calls.filter(
      (c) => c[1] === 'remove',
    );
    expect(removeEmits).toEqual([['GONEUSDT', 'remove']]);
    expect([...recorded(port)].sort()).toEqual(
      ['hold-unproven', 'not-found', 'held', 'pinned', 'removed', 'wallet-held'].sort(),
    );
    const removeNotifies = (port.notify as ReturnType<typeof vi.fn>).mock.calls.filter(
      (c) => c[0] === 'removed',
    );
    expect(removeNotifies).toEqual([['removed', 'GONEUSDT']]);
  });

  it('keeps the outcomes it already decided when the reap loop dies partway', async () => {
    // The whole reason the sink is fed per decision. `reapSymbol` runs a Postgres transaction and the wallet read resolves a Binance client; either can reject, and the caller's per-profile catch then throws the cycle's return value away. A profile failing here every wake would report nothing at all, which reads identically to a profile with nothing to rotate — the exact case this counting exists to distinguish.
    const port = fakePort({
      // Faded symbols only: none is in the ticker feed, so all three are reap candidates rather than kept members.
      listRotatableSymbols: async () => ['OLDAUSDT', 'OLDBUSDT', 'OLDCUSDT'],
      reapSymbol: vi.fn(async (symbol: string) => {
        if (symbol === 'OLDCUSDT') throw new Error('reap transaction rolled back');
        return symbol === 'OLDAUSDT' ? 'removed' : 'pinned';
      }),
    });
    await expect(runCycle(port, permissiveConfig(), 'USDT')).rejects.toThrow(
      'reap transaction rolled back',
    );
    // The first two verdicts survive the throw; the third never reached a verdict, so it is absent rather than guessed at.
    expect(recorded(port)).toEqual(['removed', 'pinned']);
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
      listRotatableSymbols: async () => ['OLDUSDT'],
      heldOnExchange: vi.fn(async (symbol) => symbol === 'OLDUSDT'),
    });
    const r = await runCycle(port, permissiveConfig(), 'BTC');
    expect(r.removed).toBe(0);
    expect(port.reapSymbol).not.toHaveBeenCalled();
    expect(port.emit).not.toHaveBeenCalledWith('OLDUSDT', 'remove');
  });

  it('throws rather than scanning a quote asset it cannot price in USD', async () => {
    // With no XYZUSDT reference row, every USD volume floor would compare against
    // an unknown scale and silently reject the universe. Fail loudly instead; the
    // caller's per-profile catch then leaves the symbol set untouched.
    const port = fakePort({ getAllTickers: async () => [ticker({ symbol: 'AAAXYZ' })] });
    await expect(runCycle(port, permissiveConfig(), 'XYZ')).rejects.toThrow(
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
      listRotatableSymbols: async () => ['AAAUSDT'], // held auto, past min-hold
      addedAtBySymbol: async () => ({ AAAUSDT: T0 }),
      getKlines: vi.fn(async () => {
        throw new Error('kline boom');
      }),
    });
    await expect(runCycle(port, permissiveConfig(), 'USDT')).rejects.toThrow('kline boom');
    expect(port.reapSymbol).not.toHaveBeenCalled();
    expect(port.addSymbol).not.toHaveBeenCalled();
    expect(port.enqueueResync).not.toHaveBeenCalled();
  });

  it('enqueues no resync when nothing changes', async () => {
    const port = fakePort({ getAllTickers: async () => [] }); // empty universe
    const r = await runCycle(port, permissiveConfig(), 'USDT');
    expect(r).toEqual({ added: 0, removed: 0, reapOutcomes: reapTally() });
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
      listRotatableSymbols: async () => ['HELDUSDT'],
      getKlines: async (symbol) => {
        fetched.push(symbol);
        return eligibleKlines();
      },
    });
    await runCycle(port, permissiveConfig(), 'USDT');
    // 3 * maxAutoSymbols(5) = 15 top non-held candidates + the 1 held symbol.
    expect(fetched).toHaveLength(16);
    expect(fetched).toContain('S00USDT'); // top-ranked candidate fetched
    expect(fetched).toContain('HELDUSDT'); // held symbol fetched despite last rank
    expect(fetched).not.toContain('S20USDT'); // beyond the cap → skipped this cycle
    // 41 candidates but 16 windows: the segment's denominator is the windows the
    // cap allowed, not the candidate count, or a cap would read as a filter.
    const snapshot = snapshotFor(port);
    expect(snapshot.funnel?.probed).toBe(16);
  });
});

describe('runDiscoveryForProfile — an untrustworthy asset classification aborts the cycle', () => {
  // The classification's failure mode is silent and total: every degraded form
  // of it reads as "no asset is a stablecoin", which looks exactly like a
  // healthy policy while admitting every one of them. So the cycle refuses to
  // run rather than run without it — and refusing must cost nothing, meaning no
  // add, no reap, no resync, and no kline weight spent finding that out.
  const heldPort = (): DiscoveryProfilePort =>
    fakePort({
      getAllTickers: async () => [ticker({ symbol: 'AAAUSDT' })],
      listRotatableSymbols: async () => ['OLDUSDT'],
      getKlines: vi.fn(async () => eligibleKlines()),
    });

  const expectUntouched = (port: DiscoveryProfilePort): void => {
    expect(port.addSymbol).not.toHaveBeenCalled();
    expect(port.reapSymbol).not.toHaveBeenCalled();
    expect(port.enqueueResync).not.toHaveBeenCalled();
    // Before ranking AND before the kline walk: an abort that had already spent
    // per-symbol request weight would make a broken feed expensive as well as
    // useless.
    expect(port.getKlines).not.toHaveBeenCalled();
  };

  it('aborts when the stablecoin tag route classified nothing, even with the fiat route full', async () => {
    // The merged veto set is NON-empty here — a dozen national currencies still
    // in it — so a "did we classify anything" floor would pass while every
    // stablecoin on the exchange became admissible. Each route is checked alone.
    const port = heldPort();
    await expect(
      runCycle(port, permissiveConfig(), 'USDT', {
        assetPolicy: {
          stablecoinOrFiatBases: new Set(['EUR', 'TRY']),
          taggedStablecoinBases: new Set(),
          fiatQuoteAssets: new Set(['EUR', 'TRY']),
          tradingSymbols: new Set(['AAAUSDT', 'BTCUSDT']),
        },
      }),
    ).rejects.toThrow(/stablecoin tag route classified nothing/i);
    expectUntouched(port);
  });

  it('aborts when the fiat route classified nothing, even with the tag route full', async () => {
    const port = heldPort();
    await expect(
      runCycle(port, permissiveConfig(), 'USDT', {
        assetPolicy: {
          stablecoinOrFiatBases: new Set(['PEG']),
          taggedStablecoinBases: new Set(['PEG']),
          fiatQuoteAssets: new Set(),
          tradingSymbols: new Set(['AAAUSDT', 'BTCUSDT']),
        },
      }),
    ).rejects.toThrow(/fiat parent-market route classified nothing/i);
    expectUntouched(port);
  });

  it('aborts when the feed and exchangeInfo disagree in bulk', async () => {
    // Half the live set unlisted is the gutted-feed shape, not a listing event. The bound is a share, and with two live symbols one missing is already half.
    const port = heldPort();
    await expect(
      runCycle(port, permissiveConfig(), 'USDT', {
        assetPolicy: {
          stablecoinOrFiatBases: new Set(['PEG', 'ZWL']),
          taggedStablecoinBases: new Set(['PEG']),
          fiatQuoteAssets: new Set(['ZWL']),
          tradingSymbols: new Set(['AAAUSDT']), // BTCUSDT is trading but unlisted
        },
      }),
    ).rejects.toThrow(/gap 1\/2 exceeds/i);
    expectUntouched(port);
  });

  it('validates the classification against the LIVE map, never the profile mode map', async () => {
    // A testnet profile checked against its own small universe would pass while the live feed was gutted. The two maps are the same object everywhere else in this file, so only a case where they genuinely differ can tell the two arguments apart.
    const port = heldPort();
    const liveAdmission = new Map<string, SymbolAdmission>([
      ['AAAUSDT', { status: 'TRADING', baseAsset: 'AAA', quoteAsset: 'USDT' }],
      ['BTCUSDT', { status: 'TRADING', baseAsset: 'BTC', quoteAsset: 'USDT' }],
      // Live-only, and absent from both the mode map and the feed. Checking against the mode map would never see it.
      ['SOLUSDT', { status: 'TRADING', baseAsset: 'SOL', quoteAsset: 'USDT' }],
      ['XRPUSDT', { status: 'TRADING', baseAsset: 'XRP', quoteAsset: 'USDT' }],
    ]);
    await expect(
      runCycle(port, permissiveConfig(), 'USDT', {
        liveAdmission,
        assetPolicy: {
          stablecoinOrFiatBases: new Set(['PEG', 'ZWL']),
          taggedStablecoinBases: new Set(['PEG']),
          fiatQuoteAssets: new Set(['ZWL']),
          tradingSymbols: new Set(['AAAUSDT', 'BTCUSDT']),
        },
      }),
    ).rejects.toThrow(/gap 2\/4 exceeds/i);
    expectUntouched(port);
  });

  it('aborts when the exchangeInfo map is unprimed, rather than scoring an unfiltered universe', async () => {
    const port = heldPort();
    await expect(
      runCycle(port, permissiveConfig(), 'USDT', {
        admissionBySymbol: new Map(),
        liveAdmission: new Map(),
      }),
    ).rejects.toThrow(/symbol-admission/i);
    expectUntouched(port);
  });
});

describe('runDiscoveryForProfile — the permission cut explains itself', () => {
  // Drives the real per-profile path, not `toDiscoveryTickers` directly. The
  // cut is silent (the symbol simply stops appearing), so the warn is the
  // operator's only explanation — and the logger it lands on has to be the one
  // production threads through the port, not one a test invents.
  const admissionBySymbol = new Map<string, SymbolAdmission>([
    [
      'AAAUSDT',
      { status: 'TRADING', baseAsset: 'AAA', quoteAsset: 'USDT', permissionSets: [['SPOT']] },
    ],
    [
      'CRCLBUSDT',
      {
        status: 'TRADING',
        baseAsset: 'CRCLB',
        quoteAsset: 'USDT',
        permissionSets: [['TRD_GRP_005']],
      },
    ],
  ]);
  const permissionWake: Partial<DiscoveryProfileContext> = {
    admissionBySymbol,
    liveAdmission: admissionBySymbol,
    assetPolicy: {
      stablecoinOrFiatBases: new Set(['PEG', 'ZWL']),
      taggedStablecoinBases: new Set(['PEG']),
      fiatQuoteAssets: new Set(['ZWL']),
      tradingSymbols: new Set(admissionBySymbol.keys()),
    },
    accountPermissions: ['SPOT'],
  };

  it('warns on the port’s logger, naming how many symbols the account may not trade', async () => {
    const warn = vi.fn();
    const port = fakePort({
      logger: { warn },
      getAllTickers: async () => [ticker({ symbol: 'AAAUSDT' }), ticker({ symbol: 'CRCLBUSDT' })],
    });
    await runCycle(port, permissiveConfig(), 'USDT', permissionWake);
    // CRCLBUSDT never reaches the funnel, so the explain cannot mention it.
    expect(explainRowFor(port, 'CRCLBUSDT')).toBeUndefined();
    expect(explainRowFor(port, 'AAAUSDT')).toBeDefined();
    expect(warn).toHaveBeenCalledWith(
      expect.objectContaining({ notPermitted: 1, quoteAsset: 'USDT' }),
      expect.stringContaining('lacks a required Binance permission'),
    );
  });

  it('stays quiet when the account may trade every candidate', async () => {
    const warn = vi.fn();
    const port = fakePort({
      logger: { warn },
      getAllTickers: async () => [ticker({ symbol: 'AAAUSDT' })],
    });
    await runCycle(port, permissiveConfig(), 'USDT', permissionWake);
    expect(warn).not.toHaveBeenCalled();
  });
});
