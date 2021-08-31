/* eslint-disable max-classes-per-file */
/* eslint-disable global-require */
const { logger } = require('../../helpers');

describe('trailingTradeIndicator', () => {
  let config;

  let mockLoggerInfo;
  let mockSlackSendMessage;
  let mockConfigGet;

  let mockGetGlobalConfiguration;
  let mockGetNextSymbol;
  let mockGetSymbolConfiguration;
  let mockGetSymbolInfo;
  let mockGetOverrideAction;
  let mockGetAccountInfo;
  let mockGetIndicators;
  let mockGetOpenOrders;
  let mockExecuteDustTransfer;
  let mockGetClosedTrades;
  let mockSaveDataToCache;

  let mockLockSymbol;
  let mockIsSymbolLocked;
  let mockUnlockSymbol;
  let mockGetAPILimit;

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
  });

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

      mockGetAccountInfo = jest.fn().mockImplementation((_logger, rawData) => ({
        ...rawData,
        ...{
          accountInfo: {
            account: 'information'
          }
        }
      }));

      mockGetIndicators = jest.fn().mockImplementation((_logger, rawData) => ({
        ...rawData,
        ...{
          indicators: {
            some: 'value'
          }
        }
      }));

      mockGetOpenOrders = jest.fn().mockImplementation((_logger, rawData) => ({
        ...rawData,
        ...{
          openOrders: [{ orderId: 1 }]
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

      mockGetClosedTrades = jest
        .fn()
        .mockImplementation((_logger, rawData) => ({
          ...rawData,
          ...{
            getClosedTrades: 'executed'
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

      jest.mock('../trailingTradeIndicator/steps', () => ({
        getGlobalConfiguration: mockGetGlobalConfiguration,
        getNextSymbol: mockGetNextSymbol,
        getSymbolConfiguration: mockGetSymbolConfiguration,
        getSymbolInfo: mockGetSymbolInfo,
        getOverrideAction: mockGetOverrideAction,
        getAccountInfo: mockGetAccountInfo,
        getIndicators: mockGetIndicators,
        getOpenOrders: mockGetOpenOrders,
        executeDustTransfer: mockExecuteDustTransfer,
        getClosedTrades: mockGetClosedTrades,
        saveDataToCache: mockSaveDataToCache
      }));

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
            accountInfo: { account: 'information' },
            indicators: { some: 'value' },
            openOrders: [{ orderId: 1 }],
            overrideParams: { param: 'overrided' },
            quoteAssetStats: {},
            apiLimit: { start: 10, end: 10 },
            dustTransfer: 'dust-transfer',
            getClosedTrades: 'executed',
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

      mockGetAccountInfo = jest.fn().mockImplementation((_logger, rawData) => ({
        ...rawData,
        ...{
          accountInfo: {
            account: 'information'
          }
        }
      }));

      mockGetIndicators = jest.fn().mockImplementation((_logger, rawData) => ({
        ...rawData,
        ...{
          indicators: {
            some: 'value'
          }
        }
      }));

      mockGetOpenOrders = jest.fn().mockImplementation((_logger, rawData) => ({
        ...rawData,
        ...{
          openOrders: [{ orderId: 1 }]
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

      jest.mock('../trailingTradeIndicator/steps', () => ({
        getGlobalConfiguration: mockGetGlobalConfiguration,
        getNextSymbol: mockGetNextSymbol,
        getSymbolConfiguration: mockGetSymbolConfiguration,
        getAccountInfo: mockGetAccountInfo,
        getIndicators: mockGetIndicators,
        getOpenOrders: mockGetOpenOrders,
        saveDataToCache: mockSaveDataToCache
      }));

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

  describe('with errors', () => {
    beforeEach(() => {
      mockGetGlobalConfiguration = jest.fn().mockResolvedValue(true);
      mockGetNextSymbol = jest.fn().mockResolvedValue(true);
      mockGetSymbolConfiguration = jest.fn().mockResolvedValue(true);
      mockGetAccountInfo = jest.fn().mockResolvedValue(true);
      mockGetIndicators = jest.fn().mockResolvedValue(true);
      mockGetOpenOrders = jest.fn().mockResolvedValue(true);
      mockSaveDataToCache = jest.fn().mockResolvedValue(true);

      jest.mock('../trailingTradeIndicator/steps', () => ({
        getGlobalConfiguration: mockGetGlobalConfiguration,
        getNextSymbol: mockGetNextSymbol,
        getSymbolConfiguration: mockGetSymbolConfiguration,
        getAccountInfo: mockGetAccountInfo,
        getIndicators: mockGetIndicators,
        getOpenOrders: mockGetOpenOrders,
        saveDataToCache: mockSaveDataToCache
      }));
    });

    [
      {
        label: 'Error -1001',
        code: -1001,
        sendSlack: false,
        featureToggleNotifyDebug: false
      },
      {
        label: 'Error -1021',
        code: -1021,
        sendSlack: false,
        featureToggleNotifyDebug: false
      },
      {
        label: 'Error ECONNRESET',
        code: 'ECONNRESET',
        sendSlack: false,
        featureToggleNotifyDebug: false
      },
      {
        label: 'Error ECONNREFUSED',
        code: 'ECONNREFUSED',
        sendSlack: false,
        featureToggleNotifyDebug: false
      },
      {
        label: 'Error something else - with notify debug',
        code: 'something',
        sendSlack: true,
        featureToggleNotifyDebug: true
      },
      {
        label: 'Error something else - without notify debug',
        code: 'something',
        sendSlack: true,
        featureToggleNotifyDebug: false
      }
    ].forEach(errorInfo => {
      describe(`${errorInfo.label}`, () => {
        beforeEach(async () => {
          mockConfigGet = jest.fn(key => {
            if (key === 'featureToggle.notifyDebug') {
              return errorInfo.featureToggleNotifyDebug;
            }
            return null;
          });

          jest.mock('config', () => ({
            get: mockConfigGet
          }));

          mockGetGlobalConfiguration = jest.fn().mockRejectedValueOnce(
            new (class CustomError extends Error {
              constructor() {
                super();
                this.code = errorInfo.code;
                this.message = `${errorInfo.code}`;
              }
            })()
          );

          const {
            execute: trailingTradeIndicatorExecute
          } = require('../trailingTradeIndicator');

          await trailingTradeIndicatorExecute(logger);
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

    describe(`redlock error`, () => {
      beforeEach(async () => {
        mockConfigGet = jest.fn(_key => null);

        jest.mock('config', () => ({
          get: mockConfigGet
        }));

        mockGetGlobalConfiguration = jest.fn().mockRejectedValueOnce(
          new (class CustomError extends Error {
            constructor() {
              super();
              this.code = 500;
              this.message = `redlock:lock-XRPBUSD`;
            }
          })()
        );

        const {
          execute: trailingTradeIndicatorExecute
        } = require('../trailingTradeIndicator');

        await trailingTradeIndicatorExecute(logger);
      });

      it('does not trigger slack.sendMessagage', () => {
        expect(mockSlackSendMessage).not.toHaveBeenCalled();
      });
    });
  });
});
