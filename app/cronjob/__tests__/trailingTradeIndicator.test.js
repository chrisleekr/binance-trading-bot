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

  let mockExecute;
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

    mockExecute = jest.fn((funcLogger, symbol, jobPayload) => {
      if (!funcLogger || !symbol || !jobPayload) return false;
      return jobPayload.processFn();
    });
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

    jest.mock('../trailingTradeHelper/common', () => ({
      getAPILimit: mockGetAPILimit
    }));

    jest.mock('../trailingTradeHelper/queue', () => ({
      execute: mockExecute,
      getAPILimit: mockGetAPILimit
    }));
    mockSteps();

    const {
      execute: trailingTradeIndicatorExecute
    } = require('../trailingTradeIndicator');

    await trailingTradeIndicatorExecute(logger);
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
