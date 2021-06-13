/* eslint-disable global-require */
const { logger } = require('../../helpers');

describe('trailingTradeIndicator', () => {
  let config;

  let mockLoggerInfo;
  let mockSlackSendMessage;

  let mockGetGlobalConfiguration;
  let mockGetNextSymbol;
  let mockGetSymbolConfiguration;
  let mockGetOverrideAction;
  let mockGetAccountInfo;
  let mockGetIndicators;
  let mockGetOpenOrders;
  let mockExecuteDustTransfer;
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
        getOverrideAction: mockGetOverrideAction,
        executeDustTransfer: mockExecuteDustTransfer,
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
            accountInfo: { account: 'information' },
            indicators: { some: 'value' },
            openOrders: [{ orderId: 1 }],
            overrideParams: { param: 'overrided' },
            apiLimit: { start: 10, end: 10 },
            dustTransfer: 'dust-transfer',
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
  });
});
