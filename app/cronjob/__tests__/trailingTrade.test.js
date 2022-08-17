/* eslint-disable max-classes-per-file */
/* eslint-disable global-require */
const { logger } = require('../../helpers');

describe('trailingTrade', () => {
  let mockCacheHget;
  let mockCacheHset;
  let mockCacheHdel;

  let mockLoggerInfo;
  let mockSlackSendMessage;
  let mockConfigGet;

  let mockGetAccountInfo;
  let mockLockSymbol;
  let mockIsSymbolLocked;
  let mockUnlockSymbol;

  let mockGetSymbolConfiguration;
  let mockGetSymbolInfo;
  let mockGetOverrideAction;
  let mockEnsureManualOrder;
  let mockEnsureGridTradeOrderExecuted;
  let mockGetBalances;
  let mockGetOpenOrders;
  let mockGetIndicators;
  let mockHandleOpenOrders;
  let mockDetermineAction;
  let mockPlaceManualTrade;
  let mockCancelOrder;
  let mockPlaceBuyOrder;
  let mockPlaceSellOrder;
  let mockPlaceSellStopLossOrder;
  let mockRemoveLastBuyPrice;
  let mockSaveDataToCache;
  let mockErrorHandlerWrapper;

  jest.useFakeTimers();

  beforeEach(() => {
    jest.clearAllMocks().resetModules();

    mockLockSymbol = jest.fn().mockResolvedValue(true);
    mockUnlockSymbol = jest.fn().mockResolvedValue(true);

    mockLoggerInfo = jest.fn();
    mockSlackSendMessage = jest.fn().mockResolvedValue(true);

    mockCacheHget = jest.fn().mockResolvedValue(null);
    mockCacheHset = jest.fn().mockResolvedValue(true);
    mockCacheHdel = jest.fn().mockResolvedValue(true);

    logger.info = mockLoggerInfo;
    jest.mock('../../helpers', () => ({
      logger: {
        info: mockLoggerInfo,
        error: jest.fn(),
        warn: jest.fn(),
        debug: jest.fn(),
        child: jest.fn()
      },
      slack: { sendMessage: mockSlackSendMessage },
      cache: { hget: mockCacheHget, hset: mockCacheHset, hdel: mockCacheHdel }
    }));

    mockErrorHandlerWrapper = jest
      .fn()
      .mockImplementation((_logger, _job, callback) =>
        Promise.resolve(callback())
      );

    jest.mock('../../error-handler', () => ({
      errorHandlerWrapper: mockErrorHandlerWrapper
    }));
  });

  describe('without any error', () => {
    beforeEach(() => {
      mockConfigGet = jest.fn(key => {
        if (key === 'featureToggle') {
          return {
            feature1Enabled: true
          };
        }
        return null;
      });

      jest.mock('config', () => ({
        get: mockConfigGet
      }));

      mockIsSymbolLocked = jest.fn().mockResolvedValue(false);

      mockGetAccountInfo = jest.fn().mockResolvedValue({
        account: 'info'
      });

      mockGetSymbolConfiguration = jest
        .fn()
        .mockImplementation((_logger, rawData) => ({
          ...rawData,
          ...{
            symbolConfiguration: {
              symbol: 'configuration data'
            }
          }
        }));

      mockGetSymbolInfo = jest.fn().mockImplementation((_logger, rawData) => ({
        ...rawData,
        ...{
          symbolInfo: {
            symbol: 'info'
          }
        }
      }));

      mockGetOverrideAction = jest
        .fn()
        .mockImplementation((_logger, rawData) => ({
          ...rawData,
          ...{
            overrideAction: {
              action: 'override-action'
            }
          }
        }));

      mockEnsureManualOrder = jest
        .fn()
        .mockImplementation((_logger, rawData) => ({
          ...rawData,
          ...{
            ensureManualOrder: {
              ensured: 'manual-buy-order'
            }
          }
        }));

      mockEnsureGridTradeOrderExecuted = jest
        .fn()
        .mockImplementation((_logger, rawData) => ({
          ...rawData,
          ensureGridTradeOrder: {
            ensured: 'grid-trade'
          }
        }));

      mockGetBalances = jest.fn().mockImplementation((_logger, rawData) => ({
        ...rawData,
        ...{
          baseAssetBalance: { baseAsset: 'balance' },
          quoteAssetBalance: { quoteAsset: 'balance' }
        }
      }));

      mockGetOpenOrders = jest.fn().mockImplementation((_logger, rawData) => ({
        ...rawData,
        ...{
          openOrders: [
            {
              orderId: `order-id-${rawData.symbol}`,
              symbol: rawData.symbol
            }
          ]
        }
      }));

      mockGetIndicators = jest.fn().mockImplementation((_logger, rawData) => ({
        ...rawData,
        ...{
          lastCandle: {
            got: 'lowest value'
          },
          indicators: {
            some: 'value'
          },
          buy: {
            should: 'buy?'
          },
          sell: {
            should: 'sell?'
          }
        }
      }));

      mockHandleOpenOrders = jest
        .fn()
        .mockImplementation((_logger, rawData) => ({
          ...rawData,
          ...{
            handled: 'open-orders'
          }
        }));

      mockDetermineAction = jest
        .fn()
        .mockImplementation((_logger, rawData) => ({
          ...rawData,
          ...{ action: 'determined' }
        }));

      mockPlaceManualTrade = jest
        .fn()
        .mockImplementation((_logger, rawData) => ({
          ...rawData,
          ...{
            placeManualTrade: {
              placed: 'manual-trade'
            }
          }
        }));

      mockCancelOrder = jest.fn().mockImplementation((_logger, rawData) => ({
        ...rawData,
        ...{
          cancelOrder: {
            cancelled: 'existing-order'
          }
        }
      }));

      mockPlaceBuyOrder = jest.fn().mockImplementation((_logger, rawData) => ({
        ...rawData,
        ...{
          buy: {
            should: 'buy?',
            actioned: 'yes'
          }
        }
      }));

      mockPlaceSellOrder = jest.fn().mockImplementation((_logger, rawData) => ({
        ...rawData,
        ...{
          sell: {
            should: 'sell?',
            actioned: 'yes'
          }
        }
      }));

      mockPlaceSellStopLossOrder = jest
        .fn()
        .mockImplementation((_logger, rawData) => ({
          ...rawData,
          ...{
            stopLoss: 'processed'
          }
        }));

      mockRemoveLastBuyPrice = jest
        .fn()
        .mockImplementation((_logger, rawData) => ({
          ...rawData,
          ...{
            removed: 'last-buy-price'
          }
        }));

      mockSaveDataToCache = jest
        .fn()
        .mockImplementation((_logger, rawData) => ({
          ...rawData,
          ...{
            saved: 'data-to-cache'
          }
        }));

      jest.mock('../trailingTradeHelper/common', () => ({
        getAccountInfo: mockGetAccountInfo,
        lockSymbol: mockLockSymbol,
        isSymbolLocked: mockIsSymbolLocked,
        unlockSymbol: mockUnlockSymbol
      }));

      jest.mock('../trailingTrade/steps', () => ({
        getSymbolConfiguration: mockGetSymbolConfiguration,
        getSymbolInfo: mockGetSymbolInfo,
        getOverrideAction: mockGetOverrideAction,
        ensureManualOrder: mockEnsureManualOrder,
        ensureGridTradeOrderExecuted: mockEnsureGridTradeOrderExecuted,
        getBalances: mockGetBalances,
        getOpenOrders: mockGetOpenOrders,
        getIndicators: mockGetIndicators,
        handleOpenOrders: mockHandleOpenOrders,
        determineAction: mockDetermineAction,
        placeManualTrade: mockPlaceManualTrade,
        cancelOrder: mockCancelOrder,
        placeBuyOrder: mockPlaceBuyOrder,
        placeSellOrder: mockPlaceSellOrder,
        placeSellStopLossOrder: mockPlaceSellStopLossOrder,
        removeLastBuyPrice: mockRemoveLastBuyPrice,
        saveDataToCache: mockSaveDataToCache
      }));
    });

    describe('execute trailing trade for BTCUSDT', () => {
      beforeEach(async () => {
        const { execute: trailingTradeExecute } = require('../trailingTrade');
        await trailingTradeExecute(logger, 'BTCUSDT');
      });

      it(`triggers isSymbolLocked - BTCUSDT`, () => {
        expect(mockIsSymbolLocked).toHaveBeenCalledWith(logger, 'BTCUSDT');
      });

      it('returns expected result for BTCUSDT', () => {
        expect(mockLoggerInfo).toHaveBeenCalledWith(
          {
            data: {
              symbol: 'BTCUSDT',
              isLocked: false,
              featureToggle: { feature1Enabled: true },
              lastCandle: { got: 'lowest value' },
              accountInfo: { account: 'info' },
              symbolConfiguration: { symbol: 'configuration data' },
              indicators: { some: 'value' },
              symbolInfo: { symbol: 'info' },
              openOrders: [{ orderId: 'order-id-BTCUSDT', symbol: 'BTCUSDT' }],
              action: 'determined',
              baseAssetBalance: { baseAsset: 'balance' },
              quoteAssetBalance: { quoteAsset: 'balance' },
              buy: { should: 'buy?', actioned: 'yes' },
              sell: { should: 'sell?', actioned: 'yes' },
              overrideAction: { action: 'override-action' },
              ensureManualOrder: { ensured: 'manual-buy-order' },
              ensureGridTradeOrder: { ensured: 'grid-trade' },
              handled: 'open-orders',
              placeManualTrade: { placed: 'manual-trade' },
              cancelOrder: { cancelled: 'existing-order' },
              stopLoss: 'processed',
              removed: 'last-buy-price',
              order: {},
              canDisable: true,
              saveToCache: true,
              saved: 'data-to-cache'
            }
          },
          'TrailingTrade: Finish process...'
        );
      });
    });

    describe('execute trailing trade for ETHUSDT', () => {
      beforeEach(async () => {
        const { execute: trailingTradeExecute } = require('../trailingTrade');
        await trailingTradeExecute(logger, 'ETHUSDT');
      });

      it(`triggers isSymbolLocked - ETHUSDT`, () => {
        expect(mockIsSymbolLocked).toHaveBeenCalledWith(logger, 'ETHUSDT');
      });

      it('returns expected result for ETHUSDT', () => {
        expect(mockLoggerInfo).toHaveBeenCalledWith(
          {
            data: {
              symbol: 'ETHUSDT',
              isLocked: false,
              featureToggle: { feature1Enabled: true },
              lastCandle: { got: 'lowest value' },
              accountInfo: { account: 'info' },
              symbolConfiguration: { symbol: 'configuration data' },
              indicators: { some: 'value' },
              symbolInfo: { symbol: 'info' },
              openOrders: [{ orderId: 'order-id-ETHUSDT', symbol: 'ETHUSDT' }],
              action: 'determined',
              baseAssetBalance: { baseAsset: 'balance' },
              quoteAssetBalance: { quoteAsset: 'balance' },
              buy: { should: 'buy?', actioned: 'yes' },
              sell: { should: 'sell?', actioned: 'yes' },
              overrideAction: { action: 'override-action' },
              ensureManualOrder: { ensured: 'manual-buy-order' },
              ensureGridTradeOrder: { ensured: 'grid-trade' },
              handled: 'open-orders',
              placeManualTrade: { placed: 'manual-trade' },
              cancelOrder: { cancelled: 'existing-order' },
              stopLoss: 'processed',
              removed: 'last-buy-price',
              canDisable: true,
              order: {},
              saveToCache: true,
              saved: 'data-to-cache'
            }
          },
          'TrailingTrade: Finish process...'
        );
      });
    });

    describe('execute trailing trade for LTCUSDT', () => {
      beforeEach(async () => {
        const { execute: trailingTradeExecute } = require('../trailingTrade');
        await trailingTradeExecute(logger, 'LTCUSDT');
      });

      it(`triggers isSymbolLocked - LTCUSDT`, () => {
        expect(mockIsSymbolLocked).toHaveBeenCalledWith(logger, 'LTCUSDT');
      });

      it('returns expected result for LTCUSDT', async () => {
        expect(mockLoggerInfo).toHaveBeenCalledWith(
          {
            data: {
              symbol: 'LTCUSDT',
              isLocked: false,
              featureToggle: { feature1Enabled: true },
              lastCandle: { got: 'lowest value' },
              accountInfo: { account: 'info' },
              symbolConfiguration: { symbol: 'configuration data' },
              indicators: { some: 'value' },
              symbolInfo: { symbol: 'info' },
              openOrders: [{ orderId: 'order-id-LTCUSDT', symbol: 'LTCUSDT' }],
              action: 'determined',
              baseAssetBalance: { baseAsset: 'balance' },
              quoteAssetBalance: { quoteAsset: 'balance' },
              buy: { should: 'buy?', actioned: 'yes' },
              sell: { should: 'sell?', actioned: 'yes' },
              overrideAction: { action: 'override-action' },
              ensureManualOrder: { ensured: 'manual-buy-order' },
              ensureGridTradeOrder: { ensured: 'grid-trade' },
              handled: 'open-orders',
              placeManualTrade: { placed: 'manual-trade' },
              cancelOrder: { cancelled: 'existing-order' },
              stopLoss: 'processed',
              removed: 'last-buy-price',
              canDisable: true,
              order: {},
              saveToCache: true,
              saved: 'data-to-cache'
            }
          },
          'TrailingTrade: Finish process...'
        );
      });
    });
  });
});
