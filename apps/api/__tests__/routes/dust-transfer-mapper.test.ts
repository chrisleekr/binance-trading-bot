import { describe, expect, it } from 'vitest';

import { toDustConversionRecord } from '../../src/routes/dust-transfer.js';

// Unit coverage for the dust-history row mapper: it reads opaque jsonb
// (`payload`, `result`) defensively and folds the override-action lifecycle
// into operator-facing status. Each branch is exercised here without the DB.

const baseRow = {
  id: '11111111-1111-4111-8111-111111111111',
  payload: { assets: ['XRP', 'ADA'] },
  result: null as unknown,
  processingAt: null as Date | null,
  consumedAt: null as Date | null,
  createdAt: new Date('2026-07-09T00:00:00.000Z'),
};

describe('toDustConversionRecord', () => {
  it('tolerates an override-outcome payload in the shared `result` column', () => {
    // `override_actions.result` is shared: the symbol-override flow writes an
    // OverrideOutcome ({status, reason, at}) into the same jsonb column this
    // mapper reads for Binance's convertDust response. A dust row can never
    // legitimately hold one, but a mapper that CRASHED on the foreign shape
    // would take the whole conversion history down with it.
    const rec = toDustConversionRecord({
      ...baseRow,
      result: { status: 'rejected', reason: 'nope', at: '2026-07-11T00:00:00.000Z' },
      consumedAt: new Date('2026-07-11T01:00:00.000Z'),
    });
    expect(rec.status).toBe('done');
    expect(rec.convertedAssets).toBeNull();
    expect(rec.bnbReceived).toBeNull();
  });

  it('maps a finalised conversion with its result outcome (status done)', () => {
    const rec = toDustConversionRecord({
      ...baseRow,
      result: {
        totalTransfered: '0.5',
        totalServiceCharge: '0.001',
        transferResult: [{ fromAsset: 'XRP' }, { fromAsset: 'ADA' }],
      },
      consumedAt: new Date('2026-07-09T01:00:00.000Z'),
    });
    expect(rec.status).toBe('done');
    expect(rec.requestedAssets).toEqual(['XRP', 'ADA']);
    expect(rec.convertedAssets).toEqual(['XRP', 'ADA']);
    expect(rec.bnbReceived).toBe('0.5');
    expect(rec.consumedAt).toBe('2026-07-09T01:00:00.000Z');
  });

  it('derives pending status and null outcome before finalisation', () => {
    const rec = toDustConversionRecord(baseRow);
    expect(rec.status).toBe('pending');
    expect(rec.convertedAssets).toBeNull();
    expect(rec.bnbReceived).toBeNull();
    expect(rec.consumedAt).toBeNull();
  });

  it('derives processing status while a claim is in flight', () => {
    const rec = toDustConversionRecord({
      ...baseRow,
      processingAt: new Date('2026-07-09T00:30:00.000Z'),
    });
    expect(rec.status).toBe('processing');
  });

  it('dedups a source asset Binance reports across multiple lots', () => {
    const rec = toDustConversionRecord({
      ...baseRow,
      result: {
        totalTransfered: '0.5',
        transferResult: [{ fromAsset: 'XRP' }, { fromAsset: 'XRP' }, { fromAsset: 'ADA' }],
      },
      consumedAt: new Date('2026-07-09T01:00:00.000Z'),
    });
    expect(rec.convertedAssets).toEqual(['XRP', 'ADA']);
  });

  it('degrades a malformed payload to an empty requested list', () => {
    const rec = toDustConversionRecord({ ...baseRow, payload: 'not-an-object' });
    expect(rec.requestedAssets).toEqual([]);
  });

  it('leaves bnbReceived null when the result total is not a decimal string', () => {
    const rec = toDustConversionRecord({
      ...baseRow,
      result: { totalTransfered: 42, transferResult: [{ fromAsset: 'XRP' }] },
      consumedAt: new Date('2026-07-09T01:00:00.000Z'),
    });
    expect(rec.bnbReceived).toBeNull();
    expect(rec.convertedAssets).toEqual(['XRP']);
  });
});
