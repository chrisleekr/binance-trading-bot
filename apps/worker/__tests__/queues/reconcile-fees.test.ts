import { describe, expect, it, vi, beforeEach } from 'vitest';
import type { Logger } from 'pino';
import type { BinanceRestClient } from '@app/binance';

const repoMocks = vi.hoisted(() => ({
  listWithUnvaluedFees: vi.fn(),
  updateFees: vi.fn(async () => true),
  profileRepo: vi.fn(),
}));

vi.mock('@app/db', async (importOriginal) => {
  const orig = await importOriginal<typeof import('@app/db')>();
  return { ...orig, profileRepo: repoMocks.profileRepo };
});

const { handleReconcileFees } =
  await import('../../src/queues/pipeline-handlers/reconcile-fees.js');

const logWarn = vi.fn();
const logger = { warn: logWarn, info: vi.fn() } as unknown as Logger;
const warnEvents = (): string[] => logWarn.mock.calls.map((c) => c[1] as string);
const IDS = { userId: 'u1' as never, profileId: 'p1' as never };

const fakeClient = (trades: unknown[], ticker = { lastPrice: '0' }): BinanceRestClient =>
  ({
    getMyTrades: vi.fn(async () => trades),
    getTicker24hr: vi.fn(async () => ticker),
  }) as unknown as BinanceRestClient;

const myTrade = (orderId: number, commission: string, commissionAsset: string, price = '100') =>
  ({ orderId, commission, commissionAsset, price }) as never;

const row = (orders: unknown[]) => ({
  id: 'a1',
  symbol: 'BTCUSDT',
  baseAsset: 'BTC',
  quoteAsset: 'USDT',
  orders,
});

const deps = (client: BinanceRestClient | null) => ({
  db: {} as never,
  logger,
  resolveBinanceClient: vi.fn(async () => client),
});

beforeEach(() => {
  logWarn.mockClear();
  repoMocks.listWithUnvaluedFees.mockReset();
  repoMocks.updateFees.mockClear().mockResolvedValue(true);
  repoMocks.profileRepo.mockResolvedValue({
    tradeArchive: {
      listWithUnvaluedFees: repoMocks.listWithUnvaluedFees,
      updateFees: repoMocks.updateFees,
    },
  });
});

describe('handleReconcileFees', () => {
  it('does nothing when there are no unvalued rows', async () => {
    repoMocks.listWithUnvaluedFees.mockResolvedValue([]);
    await handleReconcileFees(deps(fakeClient([])), IDS);
    expect(repoMocks.updateFees).not.toHaveBeenCalled();
  });

  it('returns without updating when the Binance client is unavailable', async () => {
    repoMocks.listWithUnvaluedFees.mockResolvedValue([row([{ binanceOrderId: '101' }])]);
    await handleReconcileFees(deps(null), IDS);
    expect(repoMocks.updateFees).not.toHaveBeenCalled();
  });

  it('backfills matched commission into the archive row', async () => {
    repoMocks.listWithUnvaluedFees.mockResolvedValue([row([{ binanceOrderId: '101' }])]);
    await handleReconcileFees(deps(fakeClient([myTrade(101, '0.5', 'USDT')])), IDS);
    expect(repoMocks.updateFees).toHaveBeenCalledWith('a1', { USDT: '0.5' }, '0.5');
  });

  it('leaves a row untouched when no recent trade matches its orders (too old)', async () => {
    repoMocks.listWithUnvaluedFees.mockResolvedValue([row([{ binanceOrderId: '999' }])]);
    await handleReconcileFees(deps(fakeClient([myTrade(101, '0.5', 'USDT')])), IDS);
    expect(repoMocks.updateFees).not.toHaveBeenCalled();
  });

  it('skips a row whose orders carry no Binance order id', async () => {
    repoMocks.listWithUnvaluedFees.mockResolvedValue([row([])]);
    await handleReconcileFees(deps(fakeClient([])), IDS);
    expect(repoMocks.updateFees).not.toHaveBeenCalled();
  });

  it('warns on a partial match (some orders missing from the page) but still updates', async () => {
    repoMocks.listWithUnvaluedFees.mockResolvedValue([
      row([{ binanceOrderId: '101' }, { binanceOrderId: '102' }]),
    ]);
    await handleReconcileFees(deps(fakeClient([myTrade(101, '0.5', 'USDT')])), IDS);
    expect(repoMocks.updateFees).toHaveBeenCalledWith('a1', { USDT: '0.5' }, '0.5');
    expect(warnEvents()).toContain('pipeline_reconcile_fees_partial');
  });

  it('values a base-asset commission at the fill price', async () => {
    repoMocks.listWithUnvaluedFees.mockResolvedValue([row([{ binanceOrderId: '101' }])]);
    // 0.001 BTC commission at price 60000 → 60 USDT.
    await handleReconcileFees(deps(fakeClient([myTrade(101, '0.001', 'BTC', '60000')])), IDS);
    expect(repoMocks.updateFees).toHaveBeenCalledWith('a1', { BTC: '0.001' }, '60');
  });

  it('keeps an unpriceable commission in fees but out of feesQuote, and warns', async () => {
    repoMocks.listWithUnvaluedFees.mockResolvedValue([row([{ binanceOrderId: '101' }])]);
    const client = {
      getMyTrades: vi.fn(async () => [myTrade(101, '0.01', 'DOGE')]),
      getTicker24hr: vi.fn(async () => {
        throw new Error('no DOGEUSDT ticker');
      }),
    } as unknown as BinanceRestClient;
    await handleReconcileFees(deps(client), IDS);
    expect(repoMocks.updateFees).toHaveBeenCalledWith('a1', { DOGE: '0.01' }, '0');
    expect(warnEvents()).toContain('pipeline_reconcile_fees_unpriced');
  });

  it('warns and skips a row when its symbol trade fetch fails', async () => {
    repoMocks.listWithUnvaluedFees.mockResolvedValue([row([{ binanceOrderId: '101' }])]);
    const client = {
      getMyTrades: vi.fn(async () => {
        throw new Error('rate limited');
      }),
    } as unknown as BinanceRestClient;
    await handleReconcileFees(deps(client), IDS);
    expect(repoMocks.updateFees).not.toHaveBeenCalled();
    expect(warnEvents()).toContain('pipeline_reconcile_fees_fetch_failed');
  });

  it('fetches myTrades once per symbol across rows (cache hit)', async () => {
    repoMocks.listWithUnvaluedFees.mockResolvedValue([
      { ...row([{ binanceOrderId: '101' }]), id: 'a1' },
      { ...row([{ binanceOrderId: '102' }]), id: 'a2' },
    ]);
    const client = fakeClient([myTrade(101, '0.5', 'USDT'), myTrade(102, '0.7', 'USDT')]);
    await handleReconcileFees(deps(client), IDS);
    expect(client.getMyTrades).toHaveBeenCalledTimes(1);
    expect(repoMocks.updateFees).toHaveBeenCalledTimes(2);
  });
});
