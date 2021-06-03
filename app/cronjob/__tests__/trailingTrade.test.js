/* eslint-disable global-require */
const { logger } = require('../../helpers');

describe('trailingTrade', () => {
  let data;

  let mockLoggerInfo;
  let mockSlackSendMessage;
  let mockConfigGet;

  let mockGetGlobalConfiguration;

  let mockCacheExchangeSymbols;
  let mockGetAccountInfo;
  let mockLockSymbol;
  let mockIsSymbolLocked;
  let mockUnlockSymbol;
  let mockGetAPILimit;

  let mockGetSymbolConfiguration;
  let mockGetSymbolInfo;
  let mockGetOverrideAction;
  let mockEnsureManualBuyOrder;
  let mockEnsureOrderPlaced;
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

  beforeEach(() => {
    jest.clearAllMocks().resetModules();

    mockLoggerInfo = jest.fn();
    mockSlackSendMessage = jest.fn().mockResolvedValue(true);

    mockGetAPILimit = jest.fn().mockReturnValue(10);

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

      mockLockSymbol = jest.fn().mockResolvedValue(true);
      mockIsSymbolLocked = jest.fn().mockResolvedValue(false);
      mockUnlockSymbol = jest.fn().mockResolvedValue(true);

      mockGetGlobalConfiguration = jest.fn().mockResolvedValue({
        symbols: ['BTCUSDT', 'ETHUSDT', 'LTCUSDT']
      });

      mockCacheExchangeSymbols = jest.fn().mockResolvedValue(true);

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

      mockEnsureManualBuyOrder = jest
        .fn()
        .mockImplementation((_logger, rawData) => ({
          ...rawData,
          ...{
            ensureManualBuyOrder: {
              ensured: 'manual-buy-order'
            }
          }
        }));

      mockEnsureOrderPlaced = jest
        .fn()
        .mockImplementation((_logger, rawData) => ({
          ...rawData,
          ensure: 'order-placed'
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

      jest.mock('../trailingTradeHelper/configuration', () => ({
        getGlobalConfiguration: mockGetGlobalConfiguration
      }));

      jest.mock('../trailingTradeHelper/common', () => ({
        cacheExchangeSymbols: mockCacheExchangeSymbols,
        getAccountInfo: mockGetAccountInfo,
        lockSymbol: mockLockSymbol,
        isSymbolLocked: mockIsSymbolLocked,
        unlockSymbol: mockUnlockSymbol,
        getAPILimit: mockGetAPILimit
      }));

      jest.mock('../trailingTrade/steps', () => ({
        getSymbolConfiguration: mockGetSymbolConfiguration,
        getSymbolInfo: mockGetSymbolInfo,
        getOverrideAction: mockGetOverrideAction,
        ensureManualBuyOrder: mockEnsureManualBuyOrder,
        ensureOrderPlaced: mockEnsureOrderPlaced,
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

      const { execute: trailingTradeExecute } = require('../trailingTrade');

      await trailingTradeExecute(logger);
    });

    ['BTCUSDT', 'ETHUSDT', 'LTCUSDT'].forEach(symbol => {
      it(`triggers isSymbolLocked - ${symbol}`, () => {
        expect(mockIsSymbolLocked).toHaveBeenCalledWith(logger, symbol);
      });

      it(`triggers lockSymbol - ${symbol}`, () => {
        expect(mockLockSymbol).toHaveBeenCalledWith(logger, symbol);
      });

      it(`triggers unlockSymbol - ${symbol}`, () => {
        expect(mockUnlockSymbol).toHaveBeenCalledWith(logger, symbol);
      });
    });

    it('returns expected result for BTCUSDT', () => {
      expect(mockLoggerInfo).toHaveBeenCalledWith(
        {
          symbol: 'BTCUSDT',
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
            order: {},
            saveToCache: true,
            overrideAction: { action: 'override-action' },
            ensureManualBuyOrder: { ensured: 'manual-buy-order' },
            ensure: 'order-placed',
            handled: 'open-orders',
            placeManualTrade: { placed: 'manual-trade' },
            cancelOrder: { cancelled: 'existing-order' },
            stopLoss: 'processed',
            removed: 'last-buy-price',
            saved: 'data-to-cache'
          }
        },
        'TrailingTrade: Finish process...'
      );
    });

    it('returns expected result for ETHUSDT', () => {
      expect(mockLoggerInfo).toHaveBeenCalledWith(
        {
          symbol: 'ETHUSDT',
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
            order: {},
            saveToCache: true,
            overrideAction: { action: 'override-action' },
            ensureManualBuyOrder: { ensured: 'manual-buy-order' },
            ensure: 'order-placed',
            handled: 'open-orders',
            placeManualTrade: { placed: 'manual-trade' },
            cancelOrder: { cancelled: 'existing-order' },
            stopLoss: 'processed',
            removed: 'last-buy-price',
            saved: 'data-to-cache'
          }
        },
        'TrailingTrade: Finish process...'
      );
    });

    it('returns expected result for LTCUSDT', () => {
      expect(mockLoggerInfo).toHaveBeenCalledWith(
        {
          symbol: 'LTCUSDT',
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
            order: {},
            saveToCache: true,
            overrideAction: { action: 'override-action' },
            ensureManualBuyOrder: { ensured: 'manual-buy-order' },
            ensure: 'order-placed',
            handled: 'open-orders',
            placeManualTrade: { placed: 'manual-trade' },
            cancelOrder: { cancelled: 'existing-order' },
            stopLoss: 'processed',
            removed: 'last-buy-price',
            saved: 'data-to-cache'
          }
        },
        'TrailingTrade: Finish process...'
      );
    });
  });

  describe('when symbol is locked', () => {
    beforeEach(async () => {
      jest.clearAllMocks().resetModules();

      mockConfigGet = jest.fn(key => {
        if (key === 'featureToggle') {
          return {
            feature1Enabled: false
          };
        }
        return null;
      });

      jest.mock('config', () => ({
        get: mockConfigGet
      }));

      mockLockSymbol = jest.fn().mockResolvedValue(true);
      mockIsSymbolLocked = jest.fn().mockResolvedValue(true);
      mockUnlockSymbol = jest.fn().mockResolvedValue(true);

      mockGetGlobalConfiguration = jest.fn().mockResolvedValue({
        symbols: ['BTCUSDT', 'ETHUSDT', 'LTCUSDT']
      });

      mockCacheExchangeSymbols = jest.fn().mockResolvedValue(true);

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

      mockEnsureManualBuyOrder = jest
        .fn()
        .mockImplementation((_logger, rawData) => ({
          ...rawData,
          ...{
            ensureManualBuyOrder: {
              ensured: 'manual-buy-order'
            }
          }
        }));

      mockEnsureOrderPlaced = jest
        .fn()
        .mockImplementation((_logger, rawData) => ({
          ...rawData,
          ensure: 'order-placed'
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

      jest.mock('../trailingTradeHelper/configuration', () => ({
        getGlobalConfiguration: mockGetGlobalConfiguration
      }));

      jest.mock('../trailingTradeHelper/common', () => ({
        cacheExchangeSymbols: mockCacheExchangeSymbols,
        getAccountInfo: mockGetAccountInfo,
        lockSymbol: mockLockSymbol,
        isSymbolLocked: mockIsSymbolLocked,
        unlockSymbol: mockUnlockSymbol,
        getAPILimit: mockGetAPILimit
      }));

      jest.mock('../trailingTrade/steps', () => ({
        getSymbolConfiguration: mockGetSymbolConfiguration,
        getSymbolInfo: mockGetSymbolInfo,
        getOverrideAction: mockGetOverrideAction,
        ensureManualBuyOrder: mockEnsureManualBuyOrder,
        ensureOrderPlaced: mockEnsureOrderPlaced,
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

      const { execute: trailingTradeExecute } = require('../trailingTrade');

      await trailingTradeExecute(logger);
    });

    ['BTCUSDT', 'ETHUSDT', 'LTCUSDT'].forEach(symbol => {
      it(`triggers isSymbolLocked - ${symbol}`, () => {
        expect(mockIsSymbolLocked).toHaveBeenCalledWith(logger, symbol);
      });

      it(`does not trigger lockSymbol - ${symbol}`, () => {
        expect(mockLockSymbol).not.toHaveBeenCalled();
      });

      it(`does not trigger unlockSymbol - ${symbol}`, () => {
        expect(mockUnlockSymbol).not.toHaveBeenCalled();
      });
    });

    it('returns expected result for BTCUSDT', () => {
      expect(mockLoggerInfo).toHaveBeenCalledWith(
        {
          symbol: 'BTCUSDT',
          data: {
            symbol: 'BTCUSDT',
            isLocked: true,
            featureToggle: {
              feature1Enabled: false
            },
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
            order: {},
            saveToCache: true,
            overrideAction: { action: 'override-action' },
            ensureManualBuyOrder: { ensured: 'manual-buy-order' },
            ensure: 'order-placed',
            handled: 'open-orders',
            placeManualTrade: { placed: 'manual-trade' },
            cancelOrder: { cancelled: 'existing-order' },
            stopLoss: 'processed',
            removed: 'last-buy-price',
            saved: 'data-to-cache'
          }
        },
        'TrailingTrade: Finish process...'
      );
    });

    it('returns expected result for ETHUSDT', () => {
      expect(mockLoggerInfo).toHaveBeenCalledWith(
        {
          symbol: 'ETHUSDT',
          data: {
            symbol: 'ETHUSDT',
            isLocked: true,
            featureToggle: {
              feature1Enabled: false
            },
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
            order: {},
            saveToCache: true,
            overrideAction: { action: 'override-action' },
            ensureManualBuyOrder: { ensured: 'manual-buy-order' },
            ensure: 'order-placed',
            handled: 'open-orders',
            placeManualTrade: { placed: 'manual-trade' },
            cancelOrder: { cancelled: 'existing-order' },
            stopLoss: 'processed',
            removed: 'last-buy-price',
            saved: 'data-to-cache'
          }
        },
        'TrailingTrade: Finish process...'
      );
    });

    it('returns expected result for LTCUSDT', () => {
      expect(mockLoggerInfo).toHaveBeenCalledWith(
        {
          symbol: 'LTCUSDT',
          data: {
            symbol: 'LTCUSDT',
            isLocked: true,
            featureToggle: {
              feature1Enabled: false
            },
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
            order: {},
            saveToCache: true,
            overrideAction: { action: 'override-action' },
            ensureManualBuyOrder: { ensured: 'manual-buy-order' },
            ensure: 'order-placed',
            handled: 'open-orders',
            placeManualTrade: { placed: 'manual-trade' },
            cancelOrder: { cancelled: 'existing-order' },
            stopLoss: 'processed',
            removed: 'last-buy-price',
            saved: 'data-to-cache'
          }
        },
        'TrailingTrade: Finish process...'
      );
    });
  });

  describe('with errors', () => {
    beforeEach(() => {
      mockLockSymbol = jest.fn().mockResolvedValue(true);
      mockIsSymbolLocked = jest.fn().mockResolvedValue(false);
      mockUnlockSymbol = jest.fn().mockResolvedValue(true);

      data = {
        ...data,
        symbol: 'BTCUSDT'
      };

      mockGetSymbolConfiguration = jest.fn().mockResolvedValue(true);
      mockGetSymbolInfo = jest.fn().mockResolvedValue(true);
      mockGetOverrideAction = jest.fn().mockResolvedValue(true);
      mockEnsureManualBuyOrder = jest.fn().mockResolvedValue(true);
      mockEnsureOrderPlaced = jest.fn().mockResolvedValue(true);
      mockGetBalances = jest.fn().mockResolvedValue(true);
      mockGetOpenOrders = jest.fn().mockResolvedValue(true);
      mockGetIndicators = jest.fn().mockResolvedValue(true);
      mockHandleOpenOrders = jest.fn().mockResolvedValue(true);
      mockDetermineAction = jest.fn().mockResolvedValue(true);
      mockPlaceManualTrade = jest.fn().mockResolvedValue(true);
      mockCancelOrder = jest.fn().mockResolvedValue(true);
      mockPlaceBuyOrder = jest.fn().mockResolvedValue(true);
      mockPlaceSellOrder = jest.fn().mockResolvedValue(true);
      mockPlaceSellStopLossOrder = jest.fn().mockResolvedValue(true);
      mockRemoveLastBuyPrice = jest.fn().mockResolvedValue(true);
      mockSaveDataToCache = jest.fn().mockResolvedValue(true);

      jest.mock('../trailingTradeHelper/configuration', () => ({
        getGlobalConfiguration: mockGetGlobalConfiguration
      }));

      jest.mock('../trailingTradeHelper/common', () => ({
        cacheExchangeSymbols: mockCacheExchangeSymbols,
        getAccountInfo: mockGetAccountInfo,
        lockSymbol: mockLockSymbol,
        isSymbolLocked: mockIsSymbolLocked,
        unlockSymbol: mockUnlockSymbol,
        getAPILimit: mockGetAPILimit
      }));

      jest.mock('../trailingTrade/steps', () => ({
        getSymbolConfiguration: mockGetSymbolConfiguration,
        getSymbolInfo: mockGetSymbolInfo,
        getOverrideAction: mockGetOverrideAction,
        ensureManualBuyOrder: mockEnsureManualBuyOrder,
        ensureOrderPlaced: mockEnsureOrderPlaced,
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
