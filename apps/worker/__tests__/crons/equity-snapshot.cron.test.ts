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
      positions: [
        { symbol: 'A', avgEntryPrice: null, quantity: '2' },
        { symbol: 'B', avgEntryPrice: '10', quantity: null },
        { symbol: 'C', avgEntryPrice: '10', quantity: '0' },
        { symbol: 'D', avgEntryPrice: '10', quantity: '5' },
      ],
      priceOf: () => '12',
      realizedNetQuote: '0',
      benchmarkAsset: 'BTC',
      benchmarkPriceQuote: '1',
    });
    // Only D contributes: cost 50, value 60, unrealised 10.
    expect(out.positionCostQuote).toBe('50');
    expect(out.positionValueQuote).toBe('60');
    expect(out.netPnlQuote).toBe('10');
    // Only the contributing leg with a real price reaches the basket index.
    expect(out.benchmarkPrices).toEqual({ D: '12' });
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
