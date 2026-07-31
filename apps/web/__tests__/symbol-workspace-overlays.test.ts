// Unit cover for `deriveOverlays`, the pure chart-overlay projector exported
// from the workspace. It is exported (not inlined) so its mapping from symbol
// state to ENTRY price line + buy/sell markers can be asserted directly without
// mounting the chart; these tests justify keeping that export.

import { describe, expect, it } from 'vitest';

import { deriveOverlays } from '@/features/symbol/components/symbol-workspace';

import type { OrderResponse, SymbolStateResponse } from '@app/contracts';

// The strategy's PreviewModel contributes extra lines; the generic default is "none".
const noLines: readonly never[] = [];

const order = (overrides: Partial<OrderResponse> & { side: 'BUY' | 'SELL' }): OrderResponse =>
  ({
    id: '00000000-0000-4000-8000-000000000001',
    symbol: 'BTCUSDT',
    intent: 'grid-buy',
    binanceOrderId: '1',
    clientOrderId: 'c1',
    status: 'NEW',
    currentGridTradeIndex: 0,
    raw: { price: '100.00' },
    createdAt: '2026-05-10T05:00:00.000Z',
    updatedAt: '2026-05-10T05:00:00.000Z',
    closedAt: null,
    ...overrides,
  }) as OrderResponse;

const baseState = (overrides: Partial<SymbolStateResponse>): SymbolStateResponse =>
  ({
    strategy: { name: 'trailing-trade', operatorActions: [], config: {}, state: {} },
    avgEntryPrice: null,
    openOrders: [],
    disable: null,
    entryBlocker: null,
    ...overrides,
  }) as SymbolStateResponse;

describe('deriveOverlays', () => {
  it('returns an empty object when state is undefined', () => {
    expect(deriveOverlays(undefined, noLines)).toEqual({});
  });

  it('draws an ENTRY price line from avgEntryPrice', () => {
    const overlays = deriveOverlays(
      baseState({
        avgEntryPrice: {
          avgEntryPrice: '49000.00',
          quantity: '0.01',
          updatedAt: '2026-05-10T04:55:00.000Z',
        },
      }),
      noLines,
    );
    expect(overlays.priceLines).toContainEqual({
      price: '49000.00',
      label: 'ENTRY',
      tone: 'entry',
    });
  });

  it('projects open BUY/SELL orders with a raw price into side markers', () => {
    const overlays = deriveOverlays(
      baseState({
        openOrders: [
          order({ side: 'BUY', raw: { price: '48000.00' }, createdAt: '2026-05-10T05:00:00.000Z' }),
          order({
            side: 'SELL',
            raw: { price: '52000.00' },
            createdAt: '2026-05-10T05:01:00.000Z',
          }),
        ],
      }),
      noLines,
    );
    expect(overlays.buyMarkers).toEqual([{ time: '2026-05-10T05:00:00.000Z', price: '48000.00' }]);
    expect(overlays.sellMarkers).toEqual([{ time: '2026-05-10T05:01:00.000Z', price: '52000.00' }]);
  });
});
