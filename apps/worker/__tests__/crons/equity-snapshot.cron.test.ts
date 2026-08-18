import { describe, expect, it, vi } from 'vitest';
import pino from 'pino';
import type { Job } from 'bullmq';
import type { EquitySnapshotPayload } from '@app/db';
import type { AccountId, ProfileId, UserId } from '@app/contracts';

import { computeEquitySnapshot } from '../../src/crons/equity-snapshot.js';
import {
  equitySnapshotHandler,
  type EquitySnapshotDeps,
} from '../../src/crons/equity-snapshot.cron.js';

const silent = pino({ level: 'silent' });
const U = 'u1' as unknown as UserId;
const A = 'a1' as unknown as AccountId;
const P = 'p1' as unknown as ProfileId;
const job = {} as Job;

describe('computeEquitySnapshot', () => {
  it('marks positions to market and folds realised + unrealised into net P/L', () => {
    const out = computeEquitySnapshot({
      quoteAsset: 'USDT',
      positions: [
        { symbol: 'BTCUSDT', avgEntryPrice: '100', quantity: '2' },
        { symbol: 'ETHUSDT', avgEntryPrice: '50', quantity: '4' },
      ],
      priceOf: (s) => (s === 'BTCUSDT' ? '120' : '40'),
      realizedNetQuote: '30',
      benchmarkAsset: 'BTC',
      benchmarkPriceQuote: '120',
    });
    // cost = 100*2 + 50*4 = 400; value = 120*2 + 40*4 = 400; unrealised = 0.
    expect(out.positionCostQuote).toBe('400');
    expect(out.positionValueQuote).toBe('400');
    // net = realised 30 + unrealised 0 = 30.
    expect(out.netPnlQuote).toBe('30');
    expect(out.realizedNetQuote).toBe('30');
    expect(out.benchmarkPriceQuote).toBe('120');
    // Per-symbol marks captured for the basket-hold benchmark.
    expect(out.benchmarkPrices).toEqual({ BTCUSDT: '120', ETHUSDT: '40' });
  });

  it('excludes a holding that settles in another quote rather than converting it', () => {
    // The live shape after a quote change: the switch deliberately does not force-sell, so the old-quote holding stays in the ledger and keeps marking in its own currency. Adding its USDT-scale value into a BTC-denominated row is the cross-currency defect this snapshot exists to report, not commit.
    const out = computeEquitySnapshot({
      quoteAsset: 'BTC',
      positions: [
        { symbol: 'ETHBTC', avgEntryPrice: '0.03', quantity: '2' },
        { symbol: 'ETHUSDT', avgEntryPrice: '2000', quantity: '5' },
      ],
      priceOf: (s) => (s === 'ETHBTC' ? '0.04' : '2500'),
      realizedNetQuote: '0',
      benchmarkAsset: 'BTC',
      benchmarkPriceQuote: '0',
    });
    // Only the BTC leg counts: cost 0.03*2 = 0.06, value 0.04*2 = 0.08.
    expect(out.positionCostQuote).toBe('0.06');
    expect(out.positionValueQuote).toBe('0.08');
    // Were the USDT leg admitted, net would be ~2500 rather than 0.02.
    expect(out.netPnlQuote).toBe('0.02');
    // The excluded leg contributes no basket mark either, or the benchmark index would carry a foreign-currency price.
    expect(out.benchmarkPrices).toEqual({ ETHBTC: '0.04' });
  });

  it('marks a position with no cached ticker at cost (zero unrealised for that leg)', () => {
    const out = computeEquitySnapshot({
      quoteAsset: 'USDT',
      positions: [{ symbol: 'BTCUSDT', avgEntryPrice: '100', quantity: '2' }],
      priceOf: () => null,
      realizedNetQuote: '0',
      benchmarkAsset: 'BTC',
      benchmarkPriceQuote: null,
    });
    expect(out.positionValueQuote).toBe('200');
    expect(out.positionCostQuote).toBe('200');
    expect(out.netPnlQuote).toBe('0');
    // No benchmark ticker → 0, so the chart's hold line stays flat.
    expect(out.benchmarkPriceQuote).toBe('0');
    // A leg marked at cost (no ticker) is excluded from the basket index.
    expect(out.benchmarkPrices).toEqual({});
  });

  it('skips positions missing avg/qty or with non-positive quantity', () => {
    const out = computeEquitySnapshot({
      quoteAsset: 'USDT',
      // Real pair names, not bare letters: the ledger only ever holds symbols, and a leg is now admitted only when its symbol settles in `quoteAsset`.
      positions: [
        { symbol: 'AUSDT', avgEntryPrice: null, quantity: '2' },
        { symbol: 'BUSDT', avgEntryPrice: '10', quantity: null },
        { symbol: 'CUSDT', avgEntryPrice: '10', quantity: '0' },
        { symbol: 'DUSDT', avgEntryPrice: '10', quantity: '5' },
      ],
      priceOf: () => '12',
      realizedNetQuote: '0',
      benchmarkAsset: 'BTC',
      benchmarkPriceQuote: '1',
    });
    // Only DUSDT contributes: cost 50, value 60, unrealised 10.
    expect(out.positionCostQuote).toBe('50');
    expect(out.positionValueQuote).toBe('60');
    expect(out.netPnlQuote).toBe('10');
    // Only the contributing leg with a real price reaches the basket index.
    expect(out.benchmarkPrices).toEqual({ DUSDT: '12' });
  });
});

const deps = (over: Partial<EquitySnapshotDeps> = {}): EquitySnapshotDeps => ({
  logger: silent,
  listActive: () => [{ operatorId: U, accountId: A, profileId: P } as never],
  load: vi.fn(async () => ({
    quoteAsset: 'USDT',
    positions: [{ symbol: 'BTCUSDT', avgEntryPrice: '100', quantity: '1' }],
    realizedNetQuote: '5',
  })),
  pricesOf: vi.fn(async () => new Map([['BTCUSDT', '110']])),
  record: vi.fn(async () => undefined),
  ...over,
});

describe('equitySnapshotHandler', () => {
  it('records one snapshot per active profile', async () => {
    const record = vi.fn(async () => undefined);
    await equitySnapshotHandler(deps({ record }))(job);
    expect(record).toHaveBeenCalledTimes(1);
    const [, , , payload] = record.mock.calls[0] as [
      UserId,
      AccountId,
      ProfileId,
      EquitySnapshotPayload,
    ];
    // unrealised = (110-100)*1 = 10; net = realised 5 + 10 = 15.
    expect(payload.netPnlQuote).toBe('15');
    expect(payload.benchmarkAsset).toBe('BTC');
  });

  it('asks for the held symbols plus the BTC benchmark price', async () => {
    const pricesOf = vi.fn(async () => new Map<string, string>());
    await equitySnapshotHandler(deps({ pricesOf }))(job);
    expect(pricesOf).toHaveBeenCalledWith(['BTCUSDT', 'BTCUSDT']);
  });

  it('skips a profile that has gone (load returns null) without recording', async () => {
    const record = vi.fn(async () => undefined);
    await equitySnapshotHandler(deps({ load: async () => null, record }))(job);
    expect(record).not.toHaveBeenCalled();
  });

  it('collects a per-profile failure without throwing (next tick retries)', async () => {
    const record = vi.fn(async () => {
      throw new Error('insert failed');
    });
    await expect(equitySnapshotHandler(deps({ record }))(job)).resolves.toBeUndefined();
  });
});
