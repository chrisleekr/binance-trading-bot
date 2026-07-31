// Verifies the WeightGovernor wiring on createBinanceRest. Every call
// path must reserve its documented weight before issuing the request.
// Cost values come from the WEIGHT table in src/binance-rest.ts.

import { describe, expect, it, vi } from 'vitest';

import { createBinanceRest, createWeightGovernor } from '../src/index.js';

const credentials = { apiKey: 'pub', secretKey: 'sec' } as const;
const clock = { nowMs: () => 1_700_000_000_000 };

const makeFetch = (body: unknown = {}): typeof globalThis.fetch =>
  (async () =>
    new Response(JSON.stringify(body), {
      status: 200,
      headers: { 'content-type': 'application/json' },
    })) as unknown as typeof globalThis.fetch;

describe('createBinanceRest × WeightGovernor', () => {
  const buildClient = (governor: ReturnType<typeof createWeightGovernor>) =>
    createBinanceRest({
      mode: 'test',
      credentials,
      clock,
      fetchImpl: makeFetch([]),
      weightGovernor: governor,
    });

  it.each([
    [
      'getKlines',
      2,
      (c: ReturnType<typeof buildClient>) => c.getKlines({ symbol: 'BTCUSDT', interval: '1h' }),
    ],
    ['getAccount', 20, (c: ReturnType<typeof buildClient>) => c.getAccount()],
    ['getTicker24hr', 2, (c: ReturnType<typeof buildClient>) => c.getTicker24hr('BTCUSDT')],
    ['getAllTickers24hr', 80, (c: ReturnType<typeof buildClient>) => c.getAllTickers24hr()],
    [
      'getRecentTrades',
      25,
      (c: ReturnType<typeof buildClient>) => c.getRecentTrades('BTCUSDT', 100),
    ],
    ['getDepth', 5, (c: ReturnType<typeof buildClient>) => c.getDepth('BTCUSDT', 50)],
    ['getOpenOrders', 6, (c: ReturnType<typeof buildClient>) => c.getOpenOrders('BTCUSDT')],
    ['getDustBtc', 1, (c: ReturnType<typeof buildClient>) => c.getDustBtc()],
    [
      'cancelOrder',
      1,
      (c: ReturnType<typeof buildClient>) => c.cancelOrder({ symbol: 'BTCUSDT', orderId: 1 }),
    ],
  ] as const)('%s reserves weight %i before the REST call', async (_name, cost, callFn) => {
    const governor = createWeightGovernor({ budget: 1200, targetUtilisation: 1 });
    const spy = vi.spyOn(governor, 'reserve');
    const client = buildClient(governor);
    await callFn(client);
    expect(spy).toHaveBeenCalledTimes(1);
    expect(spy.mock.calls[0]?.[0]).toBe(cost);
  });

  it('placeOrder reserves weight 1', async () => {
    const governor = createWeightGovernor({ budget: 1200, targetUtilisation: 1 });
    const spy = vi.spyOn(governor, 'reserve');
    const client = buildClient(governor);
    await client.placeOrder({
      symbol: 'BTCUSDT',
      side: 'BUY',
      type: 'MARKET',
      quantity: '1',
    } as Parameters<typeof client.placeOrder>[0]);
    expect(spy).toHaveBeenCalledTimes(1);
    expect(spy.mock.calls[0]?.[0]).toBe(1);
  });

  it('convertDust reserves weight 1 (and rejects empty asset list before reserving)', async () => {
    const governor = createWeightGovernor({ budget: 1200, targetUtilisation: 1 });
    const spy = vi.spyOn(governor, 'reserve');
    const client = buildClient(governor);
    await expect(client.convertDust([])).rejects.toThrow(/non-empty/);
    expect(spy).not.toHaveBeenCalled();

    await client.convertDust(['BNB']);
    expect(spy).toHaveBeenCalledTimes(1);
    expect(spy.mock.calls[0]?.[0]).toBe(1);
  });

  it('no governor — calls succeed unchanged (backwards-compatible)', async () => {
    const client = createBinanceRest({
      mode: 'test',
      credentials,
      clock,
      fetchImpl: makeFetch([]),
    });
    await expect(client.getKlines({ symbol: 'BTCUSDT', interval: '1h' })).resolves.toEqual([]);
  });
});
