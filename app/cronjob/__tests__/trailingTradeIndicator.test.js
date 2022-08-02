/* eslint-disable max-classes-per-file */
/* eslint-disable global-require */
const { logger } = require('../../helpers');

describe('trailingTradeIndicator', () => {
  let config;

  let mockLoggerInfo;
  let mockSlackSendMessage;
  let mockGetGlobalConfiguration;
  let mockGetNextSymbol;
  let mockGetSymbolConfiguration;
  let mockGetSymbolInfo;
  let mockGetOverrideAction;
  let mockExecuteDustTransfer;
  let mockGetClosedTrades;
  let mockGetOrderStats;
  let mockGetTradingView;
  let mockSaveDataToCache;

  let mockLockSymbol;
  let mockIsSymbolLocked;
  let mockUnlockSymbol;
  let mockGetAPILimit;
  let mockErrorHandlerWrapper;

  beforeEach(() => {
    jest.clearAllMocks().resetModules();
    jest.mock('config');

    config = require('config');

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

    mockErrorHandlerWrapper = jest
      .fn()
      .mockImplementation((_logger, _job, callback) =>
        Promise.resolve(callback())
      );

    jest.mock('../../error-handler', () => ({
      errorHandlerWrapper: mockErrorHandlerWrapper
    }));
  });

  const mockSteps = () => {
    mockGetGlobalConfiguration = jest
      .fn()
      .mockImplementation((_logger, rawData) => ({
        ...rawData,
        ...{
          globalConfiguration: {
            global: 'configuration data'
          }
        }
      }));

    mockGetNextSymbol = jest.fn().mockImplementation((_logger, rawData) => ({
      ...rawData,
      ...{
        symbol: 'BTCUSDT'
      }
    }));

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
          some: 'info'
        }
      }
    }));

    mockGetOverrideAction = jest
      .fn()
      .mockImplementation((_logger, rawData) => ({
        ...rawData,
        ...{
          action: 'override-action',
          overrideParams: { param: 'overrided' }
        }
      }));

    mockExecuteDustTransfer = jest
      .fn()
      .mockImplementation((_logger, rawData) => ({
        ...rawData,
        ...{
          dustTransfer: 'dust-transfer'
        }
      }));

    mockGetClosedTrades = jest.fn().mockImplementation((_logger, rawData) => ({
      ...rawData,
      ...{
        getClosedTrades: 'executed'
      }
    }));

    mockGetOrderStats = jest.fn().mockImplementation((_logger, rawData) => ({
      ...rawData,
      ...{
        getOrderStats: 'retrieved'
      }
    }));

    mockGetTradingView = jest.fn().mockImplementation((_logger, rawData) => ({
      ...rawData,
      ...{
        tradingView: 'retrieved'
      }
    }));

    mockSaveDataToCache = jest.fn().mockImplementation((_logger, rawData) => ({
      ...rawData,
      ...{
        saved: 'data-to-cache'
      }
    }));

    jest.mock('../trailingTradeIndicator/steps', () => ({
      getGlobalConfiguration: mockGetGlobalConfiguration,
      getNextSymbol: mockGetNextSymbol,
      getSymbolConfiguration: mockGetSymbolConfiguration,
      getSymbolInfo: mockGetSymbolInfo,
      getOverrideAction: mockGetOverrideAction,
      executeDustTransfer: mockExecuteDustTransfer,
      getClosedTrades: mockGetClosedTrades,
      getOrderStats: mockGetOrderStats,
      getTradingView: mockGetTradingView,
      saveDataToCache: mockSaveDataToCache
    }));
  };

  describe('without any error', () => {
    beforeEach(async () => {
      config.get = jest.fn(key => {
        switch (key) {
          case 'featureToggle':
            return {
              notifyOrderConfirm: true,
              notifyDebug: false
            };
          default:
            return `value-${key}`;
        }
      });

      mockLockSymbol = jest.fn().mockResolvedValue(true);
      mockIsSymbolLocked = jest.fn().mockResolvedValue(false);
      mockUnlockSymbol = jest.fn().mockResolvedValue(true);

      jest.mock('../trailingTradeHelper/common', () => ({
        lockSymbol: mockLockSymbol,
        isSymbolLocked: mockIsSymbolLocked,
        unlockSymbol: mockUnlockSymbol,
        getAPILimit: mockGetAPILimit
      }));

      mockSteps();

      const {
        execute: trailingTradeIndicatorExecute
      } = require('../trailingTradeIndicator');

      await trailingTradeIndicatorExecute(logger);
    });

    it('triggers isSymbolLocked', () => {
      expect(mockIsSymbolLocked).toHaveBeenCalledWith(logger, 'BTCUSDT');
    });

    it('triggers lockSymbol', () => {
      expect(mockLockSymbol).toHaveBeenCalledWith(logger, 'BTCUSDT');
    });

    it('triggers unlockSymbol', () => {
      expect(mockUnlockSymbol).toHaveBeenCalledWith(logger, 'BTCUSDT');
    });

    it('returns expected result', () => {
      expect(mockLoggerInfo).toHaveBeenCalledWith(
        {
          symbol: 'BTCUSDT',
          data: {
            action: 'override-action',
            featureToggle: { notifyOrderConfirm: true, notifyDebug: false },
            globalConfiguration: { global: 'configuration data' },
            symbol: 'BTCUSDT',
            symbolConfiguration: { symbol: 'configuration data' },
            symbolInfo: { some: 'info' },
            overrideParams: { param: 'overrided' },
            quoteAssetStats: {},
            apiLimit: { start: 10, end: 10 },
            dustTransfer: 'dust-transfer',
            getClosedTrades: 'executed',
            getOrderStats: 'retrieved',
            tradingView: 'retrieved',
            saved: 'data-to-cache'
          }
        },
        'TrailingTradeIndicator: Finish process...'
      );
    });
  });

  describe('when symbol is locked', () => {
    beforeEach(async () => {
      mockLockSymbol = jest.fn().mockResolvedValue(true);
      mockIsSymbolLocked = jest.fn().mockResolvedValue(true);
      mockUnlockSymbol = jest.fn().mockResolvedValue(true);

      jest.mock('../trailingTradeHelper/common', () => ({
        lockSymbol: mockLockSymbol,
        isSymbolLocked: mockIsSymbolLocked,
        unlockSymbol: mockUnlockSymbol,
        getAPILimit: mockGetAPILimit
      }));

      mockSteps();

      const {
        execute: trailingTradeIndicatorExecute
      } = require('../trailingTradeIndicator');

      await trailingTradeIndicatorExecute(logger);
    });

    it('triggers isSymbolLocked', () => {
      expect(mockIsSymbolLocked).toHaveBeenCalledWith(logger, 'BTCUSDT');
    });

    it('does not trigger lockSymbol', () => {
      expect(mockLockSymbol).not.toHaveBeenCalled();
    });

    it('does not trigger unlockSymbol', () => {
      expect(mockUnlockSymbol).not.toHaveBeenCalled();
    });

    it('returns expected result', () => {
      expect(mockLoggerInfo).toHaveBeenCalledWith(
        {
          debug: true,
          symbol: 'BTCUSDT'
        },
        '⏯ TrailingTradeIndicator: Skip process as the symbol is currently locked.'
      );
    });
  });
});
