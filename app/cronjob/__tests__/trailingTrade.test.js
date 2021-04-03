/* eslint-disable global-require */
const { logger } = require('../../helpers');

jest.mock('config');

describe('trailingTrade', () => {
  let data;

  let mockLoggerInfo;
  let mockSlackSendMessage;

  let mockGetGlobalConfiguration;

  let mockCacheExchangeSymbols;
  let mockGetAccountInfo;
  let mockGetOpenOrdersFromCache;

  let mockGetSymbolConfiguration;
  let mockGetSymbolInfo;
  let mockGetBalances;
  let mockGetIndicators;
  let mockHandleOpenOrders;
  let mockDetermineAction;
  let mockPlaceBuyOrder;
  let mockPlaceSellOrder;
  let mockRemoveLastBuyPrice;
  let mockSaveDataToCache;

  beforeEach(() => {
    jest.clearAllMocks().resetModules();

    mockLoggerInfo = jest.fn();
    mockSlackSendMessage = jest.fn().mockResolvedValue(true);

    logger.info = mockLoggerInfo;
    jest.mock('../../helpers', () => ({
      logger: {
        info: mockLoggerInfo,
        error: jest.fn(),
        warn: jest.fn(),
        debug: jest.fn(),
        child: jest.fn()
      },
      slack: { sendMessage: mockSlackSendMessage }
    }));
  });

  describe('without any error', () => {
    beforeEach(async () => {
      jest.clearAllMocks().resetModules();

      mockGetGlobalConfiguration = jest.fn().mockResolvedValue({
        symbols: ['BTCUSDT', 'ETHUSDT', 'LTCUSDT']
      });

      mockCacheExchangeSymbols = jest.fn().mockResolvedValue(true);

      mockGetAccountInfo = jest.fn().mockResolvedValue({
        account: 'info'
      });

      mockGetOpenOrdersFromCache = jest.fn().mockResolvedValue([
        {
          orderId: 1,
          symbol: 'BTCUSDT'
        },
        {
          orderId: 2,
          symbol: 'LTCUSDT'
        }
      ]);

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

      mockGetBalances = jest.fn().mockImplementation((_logger, rawData) => ({
        ...rawData,
        ...{
          baseAssetBalance: { baseAsset: 'balance' },
          quoteAssetBalance: { quoteAsset: 'balance' }
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

      jest.mock('../trailingTradeHelper/configuration', () => ({
        getGlobalConfiguration: mockGetGlobalConfiguration
      }));

      jest.mock('../trailingTradeHelper/common', () => ({
        cacheExchangeSymbols: mockCacheExchangeSymbols,
        getAccountInfo: mockGetAccountInfo,
        getOpenOrdersFromCache: mockGetOpenOrdersFromCache
      }));

      jest.mock('../trailingTrade/steps', () => ({
        getSymbolConfiguration: mockGetSymbolConfiguration,
        getSymbolInfo: mockGetSymbolInfo,
        getBalances: mockGetBalances,
        getIndicators: mockGetIndicators,
        handleOpenOrders: mockHandleOpenOrders,
        determineAction: mockDetermineAction,
        placeBuyOrder: mockPlaceBuyOrder,
        placeSellOrder: mockPlaceSellOrder,
        removeLastBuyPrice: mockRemoveLastBuyPrice,
        saveDataToCache: mockSaveDataToCache
      }));

      const { execute: trailingTradeExecute } = require('../trailingTrade');

      await trailingTradeExecute(logger);
    });

    it('returns expected result for BTCUSDT', () => {
      expect(mockLoggerInfo).toHaveBeenCalledWith(
        {
          symbol: 'BTCUSDT',
          data: {
            symbol: 'BTCUSDT',
            lastCandle: { got: 'lowest value' },
            accountInfo: { account: 'info' },
            symbolConfiguration: { symbol: 'configuration data' },
            indicators: { some: 'value' },
            symbolInfo: { symbol: 'info' },
            openOrders: [{ orderId: 1, symbol: 'BTCUSDT' }],
            action: 'determined',
            baseAssetBalance: { baseAsset: 'balance' },
            quoteAssetBalance: { quoteAsset: 'balance' },
            buy: { should: 'buy?', actioned: 'yes' },
            sell: { should: 'sell?', actioned: 'yes' },
            saveToCache: true,
            handled: 'open-orders',
            removed: 'last-buy-price',
            saved: 'data-to-cache'
          }
        },
        'Trade: Finish trailing trade process...'
      );
    });

    it('returns expected result for ETHUSDT', () => {
      expect(mockLoggerInfo).toHaveBeenCalledWith(
        {
          symbol: 'ETHUSDT',
          data: {
            symbol: 'ETHUSDT',
            lastCandle: { got: 'lowest value' },
            accountInfo: { account: 'info' },
            symbolConfiguration: { symbol: 'configuration data' },
            indicators: { some: 'value' },
            symbolInfo: { symbol: 'info' },
            openOrders: [],
            action: 'determined',
            baseAssetBalance: { baseAsset: 'balance' },
            quoteAssetBalance: { quoteAsset: 'balance' },
            buy: { should: 'buy?', actioned: 'yes' },
            sell: { should: 'sell?', actioned: 'yes' },
            saveToCache: true,
            handled: 'open-orders',
            removed: 'last-buy-price',
            saved: 'data-to-cache'
          }
        },
        'Trade: Finish trailing trade process...'
      );
    });

    it('returns expected result for LTCUSDT', () => {
      expect(mockLoggerInfo).toHaveBeenCalledWith(
        {
          symbol: 'LTCUSDT',
          data: {
            symbol: 'LTCUSDT',
            lastCandle: { got: 'lowest value' },
            accountInfo: { account: 'info' },
            symbolConfiguration: { symbol: 'configuration data' },
            indicators: { some: 'value' },
            symbolInfo: { symbol: 'info' },
            openOrders: [{ orderId: 2, symbol: 'LTCUSDT' }],
            action: 'determined',
            baseAssetBalance: { baseAsset: 'balance' },
            quoteAssetBalance: { quoteAsset: 'balance' },
            buy: { should: 'buy?', actioned: 'yes' },
            sell: { should: 'sell?', actioned: 'yes' },
            saveToCache: true,
            handled: 'open-orders',
            removed: 'last-buy-price',
            saved: 'data-to-cache'
          }
        },
        'Trade: Finish trailing trade process...'
      );
    });
  });

  describe('with errors', () => {
    beforeEach(() => {
      data = {
        ...data,
        symbol: 'BTCUSDT'
      };
      mockGetGlobalConfiguration = jest.fn().mockResolvedValue(true);
      mockCacheExchangeSymbols = jest.fn().mockResolvedValue(true);
      mockGetAccountInfo = jest.fn().mockResolvedValue(true);
      mockGetOpenOrdersFromCache = jest.fn().mockResolvedValue(true);
      mockGetSymbolConfiguration = jest.fn().mockResolvedValue(true);
      mockGetSymbolInfo = jest.fn().mockResolvedValue(true);
      mockGetBalances = jest.fn().mockResolvedValue(true);
      mockGetIndicators = jest.fn().mockResolvedValue(true);
      mockHandleOpenOrders = jest.fn().mockResolvedValue(true);
      mockDetermineAction = jest.fn().mockResolvedValue(true);
      mockPlaceBuyOrder = jest.fn().mockResolvedValue(true);
      mockPlaceSellOrder = jest.fn().mockResolvedValue(true);
      mockRemoveLastBuyPrice = jest.fn().mockResolvedValue(true);
      mockSaveDataToCache = jest.fn().mockResolvedValue(true);

      jest.mock('../trailingTradeHelper/configuration', () => ({
        getGlobalConfiguration: mockGetGlobalConfiguration
      }));

      jest.mock('../trailingTradeHelper/common', () => ({
        cacheExchangeSymbols: mockCacheExchangeSymbols,
        getAccountInfo: mockGetAccountInfo,
        getOpenOrdersFromCache: mockGetOpenOrdersFromCache
      }));

      jest.mock('../trailingTrade/steps', () => ({
        getSymbolConfiguration: mockGetSymbolConfiguration,
        getSymbolInfo: mockGetSymbolInfo,
        getBalances: mockGetBalances,
        getIndicators: mockGetIndicators,
        handleOpenOrders: mockHandleOpenOrders,
        determineAction: mockDetermineAction,
        placeBuyOrder: mockPlaceBuyOrder,
        placeSellOrder: mockPlaceSellOrder,
        removeLastBuyPrice: mockRemoveLastBuyPrice,
        saveDataToCache: mockSaveDataToCache
      }));
    });

    [
      {
        label: 'Error -1001',
        code: -1001,
        sendSlack: false
      },
      {
        label: 'Error -1021',
        code: -1021,
        sendSlack: false
      },
      {
        label: 'Error ECONNRESET',
        code: 'ECONNRESET',
        sendSlack: false
      },
      {
        label: 'Error ECONNREFUSED',
        code: 'ECONNREFUSED',
        sendSlack: false
      },
      {
        label: 'Error something else',
        code: 'something',
        sendSlack: true
      }
    ].forEach(errorInfo => {
      describe(`${errorInfo.label}`, () => {
        beforeEach(async () => {
          mockGetGlobalConfiguration = jest.fn().mockRejectedValueOnce(
            new (class CustomError extends Error {
              constructor() {
                super();
                this.code = errorInfo.code;
                this.message = `${errorInfo.code}`;
              }
            })()
          );

          const { execute: trailingTradeExecute } = require('../trailingTrade');

          await trailingTradeExecute(logger);
        });

        if (errorInfo.sendSlack) {
          it('triggers slack.sendMessage', () => {
            expect(mockSlackSendMessage).toHaveBeenCalled();
          });
        } else {
          it('does not trigger slack.sendMessagage', () => {
            expect(mockSlackSendMessage).not.toHaveBeenCalled();
          });
        }
      });
    });
  });
});
