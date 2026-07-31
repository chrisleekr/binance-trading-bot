// usePreviewModel's compute-error fallback: a defensive strategy should never
// throw, but a preview must never crash the page it decorates. A throwing
// previewLevels falls back to an empty model and surfaces the error through the
// same channel as a load failure, so a broken preview is never silently blank.

import type { ReactNode } from 'react';
import { QueryClientProvider } from '@tanstack/react-query';
import { renderHook, waitFor } from '@testing-library/react';
import { beforeEach, describe, expect, it, vi } from 'vitest';

import type { PreviewModel, SymbolInfo } from '@app/strategy-core';

import { createQueryClient } from '../src/shared/lib/query-client.js';
import { usePreviewModel } from '../src/features/symbol/preview/use-preview-model.js';

// The mock module delegates previewLevels to a mutable holder so one test can
// make it throw (the compute-error path) and another can echo its threaded
// input (the filters-threading path). `mock`-prefixed so vi.mock's hoist
// allows the closure reference.
let mockPreviewLevels: (input: { filters?: SymbolInfo['filters'] }) => PreviewModel = () => {
  throw new Error('boom');
};

vi.mock('../src/features/symbol/preview/preview-modules.js', () => ({
  hasPreviewModule: () => true,
  loadPreviewModule: () =>
    Promise.resolve({
      previewLevels: (input: { filters?: SymbolInfo['filters'] }) => mockPreviewLevels(input),
      previewDataNeeds: () => [],
    }),
}));

const FILTERS: SymbolInfo['filters'] = {
  minNotional: '10',
  tickSize: '0.01',
  stepSize: '0.001',
  minQty: '0.001',
  maxQty: '100000',
  minPrice: '0.01',
  maxPrice: '1000000',
};

beforeEach(() => {
  mockPreviewLevels = () => {
    throw new Error('boom');
  };
});

const wrapper = ({ children }: { children: ReactNode }): React.JSX.Element => (
  <QueryClientProvider client={createQueryClient()}>{children}</QueryClientProvider>
);

describe('usePreviewModel — compute-error path', () => {
  it('falls back to an empty model and surfaces the thrown error', async () => {
    // symbol undefined keeps the candle query disabled, so the only work is the
    // module load followed by the throwing previewLevels.
    const { result } = renderHook(
      () =>
        usePreviewModel({
          strategyName: 'trailing-trade',
          profileId: 'p1',
          symbol: undefined,
          config: {},
          state: null,
          entryPrice: '100',
          currentPrice: '100',
        }),
      { wrapper },
    );

    await waitFor(() => expect(result.current.error).toBeInstanceOf(Error));
    expect(result.current.model).toEqual({ sections: [] });
    expect((result.current.error as Error).message).toBe('boom');
  });
});

describe('usePreviewModel — filters threading', () => {
  it('threads the SymbolFilters into previewLevels so the momentum entry row is sized', async () => {
    // Echo the threaded filters' stepSize into the entry quantity: a concrete
    // quantity string appears only if usePreviewModel forwarded `filters`.
    // Today it never does, so the entry row stays unsized (RED).
    mockPreviewLevels = (input) => ({
      sections: [
        {
          title: 'Entry',
          rows: [
            {
              code: 'entry',
              tone: 'entry',
              ...(input.filters ? { quantity: input.filters.stepSize } : {}),
            },
          ],
        },
      ],
    });

    const { result } = renderHook(
      () =>
        usePreviewModel({
          strategyName: 'momentum',
          profileId: 'p1',
          symbol: undefined,
          config: {},
          state: null,
          entryPrice: '100',
          currentPrice: '100',
          account: { balances: { USDT: { free: '100000', locked: '0' } } },
          quoteAsset: 'USDT',
          // Intended new arg: the full SymbolFilters the live mounts will supply.
          filters: FILTERS,
        }),
      { wrapper },
    );

    await waitFor(() => expect(result.current.model.sections.length).toBeGreaterThan(0));
    const entry = result.current.model.sections[0]?.rows[0];
    expect(entry?.quantity).toBe(FILTERS.stepSize);
  });
});
