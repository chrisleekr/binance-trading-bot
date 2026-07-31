import { describe, expect, it } from 'vitest';
import { Decimal } from '@app/money';
import type { PreviewInput, PreviewRow } from '../src/contract.js';

// Exercises the drift gate the replay path calls to cross-check preview vs tick.
import { assertPreviewTickAgreement } from '../src/preview-drift.js';

// A single actionable entry row: fires when currentPrice is at/above `price`.
const entryRow = (over: Partial<PreviewRow> = {}): PreviewRow => ({
  code: 'entry',
  tone: 'entry',
  price: '100',
  trigger: true,
  triggerWhen: 'above',
  ...over,
});

// Minimal fake Strategy: only the surface the gate reads (position + previewLevels).
const mkStrategy = (previewRows: readonly PreviewRow[]) =>
  ({
    name: 'fake',
    position: { readPosition: () => ({ avgEntryPrice: null, heldQuantity: null }) },
    previewLevels: () => ({ sections: [{ title: 'levels', rows: previewRows }] }),
  }) as never;

const mkInput = (currentPrice: string) =>
  ({
    market: {
      symbol: 'BTCUSDT',
      currentPrice,
      candlesByInterval: {},
      indicatorsByInterval: {},
    },
    state: { schemaVersion: '1.0.0' },
    account: { balances: {} },
    openOrders: [],
  }) as never;

const ENTRY_DECISION = {
  type: 'place-order',
  intent: { symbol: 'BTCUSDT', side: 'BUY', reason: 'entry', clientOrderId: 'x' },
  params: { type: 'MARKET', quantity: '1' },
};
const mkOutput = (decisions: readonly unknown[]) =>
  ({ nextState: { schemaVersion: '1.0.0' }, decisions, logs: [], metrics: [] }) as never;

describe('assertPreviewTickAgreement — emitted ⟹ consistent preview row', () => {
  it('passes when the emitted entry decision is on the actionable side of its preview row', () => {
    // currentPrice 105 >= band 100 (above) -> the entry decision agrees with the row.
    expect(() =>
      assertPreviewTickAgreement(
        mkStrategy([entryRow()]),
        mkInput('105'),
        mkOutput([ENTRY_DECISION]),
      ),
    ).not.toThrow();
  });

  it('throws when the tick emits an entry the preview row says cannot fire there', () => {
    // Preview claims entry acts only at/above 110, yet currentPrice is 105 and the
    // tick still emitted the entry: the preview lied about where entry acts.
    expect(() =>
      assertPreviewTickAgreement(
        mkStrategy([entryRow({ price: '110' })]),
        mkInput('105'),
        mkOutput([ENTRY_DECISION]),
      ),
    ).toThrow(/entry/i);
  });

  it('is vacuous when the tick emitted no decisions', () => {
    expect(() =>
      assertPreviewTickAgreement(
        mkStrategy([entryRow()]),
        mkInput('105'),
        mkOutput([{ type: 'noop' }]),
      ),
    ).not.toThrow();
  });

  it('reads entryPrice as null when the strategy has no position adapter', () => {
    const noPosition = {
      name: 'fake',
      previewLevels: () => ({ sections: [{ title: 'levels', rows: [entryRow()] }] }),
    } as never;
    expect(() =>
      assertPreviewTickAgreement(noPosition, mkInput('105'), mkOutput([ENTRY_DECISION])),
    ).not.toThrow();
  });

  it('threads candles, filters, and quoteAsset into the preview input when present', () => {
    const fullInput = {
      config: { candleInterval: '1h' },
      market: {
        symbol: 'BTCUSDT',
        currentPrice: '105',
        candlesByInterval: {
          '1h': [
            {
              openTimeMs: 0,
              closeTimeMs: 1,
              open: '1',
              high: '1',
              low: '1',
              close: '1',
              volume: '1',
              isClosed: true,
            },
          ],
        },
        indicatorsByInterval: {},
        symbolInfo: {
          quoteAsset: 'USDT',
          filters: {
            minNotional: '10',
            tickSize: '0.01',
            stepSize: '0.001',
            minQty: '0.001',
            maxQty: '1',
            minPrice: '0.01',
            maxPrice: '1',
          },
        },
      },
      state: { schemaVersion: '1.0.0' },
      account: { balances: {} },
      openOrders: [],
    } as never;
    expect(() =>
      assertPreviewTickAgreement(mkStrategy([entryRow()]), fullInput, mkOutput([ENTRY_DECISION])),
    ).not.toThrow();
  });

  it('exempts a decision whose reason has no priced trigger row', () => {
    // The row matches the reason but is not an actionable priced trigger, so the
    // gate finds nothing to check and leaves the decision alone (rebalance-shaped).
    expect(() =>
      assertPreviewTickAgreement(
        mkStrategy([
          entryRow({ trigger: false }),
          entryRow({ price: undefined, triggerWhen: undefined }),
        ]),
        mkInput('105'),
        mkOutput([ENTRY_DECISION]),
      ),
    ).not.toThrow();
  });

  it('ignores a non-object decision', () => {
    expect(() =>
      assertPreviewTickAgreement(
        mkStrategy([entryRow()]),
        mkInput('105'),
        mkOutput([null, 'noop']),
      ),
    ).not.toThrow();
  });

  it('recomputes preview rows once across multiple reason-bearing decisions', () => {
    // Two entry decisions in one tick: the second reuses the cached rows.
    expect(() =>
      assertPreviewTickAgreement(
        mkStrategy([entryRow()]),
        mkInput('105'),
        mkOutput([ENTRY_DECISION, ENTRY_DECISION]),
      ),
    ).not.toThrow();
  });

  it('converts the Decimal-balance tick account to a wire account for previewLevels', () => {
    let seen: unknown;
    const capture = {
      name: 'fake',
      position: { readPosition: () => ({ avgEntryPrice: null, heldQuantity: null }) },
      previewLevels: (pin: PreviewInput<unknown, unknown>) => {
        seen = pin.account;
        return { sections: [{ title: 'levels', rows: [entryRow()] }] };
      },
    } as never;
    const input = {
      config: {},
      market: {
        symbol: 'BTCUSDT',
        currentPrice: '105',
        candlesByInterval: {},
        indicatorsByInterval: {},
      },
      state: { schemaVersion: '1.0.0' },
      account: {
        balances: {
          USDT: { asset: 'USDT', free: new Decimal('100000'), locked: new Decimal('5') },
        },
        deployedQuoteAcrossProfiles: '250',
      },
      openOrders: [],
    } as never;
    assertPreviewTickAgreement(capture, input, mkOutput([ENTRY_DECISION]));
    // The gate serialises the Decimal balances to wire strings the SPA could build.
    expect(seen).toEqual({
      balances: { USDT: { free: '100000', locked: '5' } },
      deployedQuoteAcrossProfiles: '250',
    });
  });

  it('keys a cancel-order decision on its reason', () => {
    const cancel = { type: 'cancel-order', orderId: 'o1', reason: 'stop-loss', symbol: 'BTCUSDT' };
    const stopRow = entryRow({
      code: 'stop-loss',
      tone: 'stop',
      price: '90',
      triggerWhen: 'below',
    });
    // currentPrice 85 <= 90 (below) -> the cancel agrees with its stop row.
    expect(() =>
      assertPreviewTickAgreement(mkStrategy([stopRow]), mkInput('85'), mkOutput([cancel])),
    ).not.toThrow();
    // currentPrice 95 > 90 -> not on the below side -> the preview disagrees.
    expect(() =>
      assertPreviewTickAgreement(mkStrategy([stopRow]), mkInput('95'), mkOutput([cancel])),
    ).toThrow(/stop-loss/i);
  });
});
