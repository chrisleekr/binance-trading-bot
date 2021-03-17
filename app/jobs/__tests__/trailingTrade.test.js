/* eslint-disable global-require */
const { logger } = require('../../helpers');

jest.mock('config');

describe('trailingTrade', () => {
  let data;

  let mockLoggerInfo;
  let mockSlackSendMessage;

  let mockGetGlobalConfiguration;
  let mockGetNextSymbol;
  let mockGetExchangeSymbols;
  let mockGetSymbolConfiguration;
  let mockGetSymbolInfo;
  let mockGetAccountInfo;
  let mockGetIndicators;
  let mockGetOpenOrders;
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

      data = {
        ...data,
        globalConfiguration: {
          global: 'value'
        }
      };
      mockGetGlobalConfiguration = jest.fn().mockResolvedValue(data);

      data = {
        ...data,
        symbol: 'BTCUSDT'
      };
      mockGetNextSymbol = jest.fn().mockResolvedValue(data);

      data = {
        ...data
      };
      mockGetExchangeSymbols = jest.fn().mockResolvedValue(data);

      data = {
        ...data,
        symbolConfiguration: {
          symbol: 'value'
        }
      };
      mockGetSymbolConfiguration = jest.fn().mockResolvedValue(data);

      data = {
        ...data,
        symbolInfo: {
          symbol: 'value'
        }
      };
      mockGetSymbolInfo = jest.fn().mockResolvedValue(data);

      data = {
        ...data,
        accountInfo: {
          account: 'value'
        }
      };
      mockGetAccountInfo = jest.fn().mockResolvedValue(data);

      data = {
        ...data,
        indicators: {
          indicator: 'value'
        },
        baseAssetBalance: {
          baseAsset: 'value'
        },
        quoteAssetBalance: {
          quoteAsset: 'value'
        }
      };
      mockGetIndicators = jest.fn().mockResolvedValue(data);

      data = {
        ...data,
        openOrders: {
          order: 'value'
        }
      };
      mockGetOpenOrders = jest.fn().mockResolvedValue(data);

      mockHandleOpenOrders = jest.fn().mockResolvedValue(data);

      data = {
        ...data,
        action: 'value'
      };
      mockDetermineAction = jest.fn().mockResolvedValue(data);

      data = {
        ...data,
        buy: {
          buy: 'value'
        }
      };
      mockPlaceBuyOrder = jest.fn().mockResolvedValue(data);

      data = {
        ...data,
        sell: {
          sell: 'value'
        }
      };
      mockPlaceSellOrder = jest.fn().mockResolvedValue(data);
      mockRemoveLastBuyPrice = jest.fn().mockResolvedValue(data);
      mockSaveDataToCache = jest.fn().mockResolvedValue(data);

      jest.mock('../trailingTrade/steps', () => ({
        getGlobalConfiguration: mockGetGlobalConfiguration,
        getNextSymbol: mockGetNextSymbol,
        getExchangeSymbols: mockGetExchangeSymbols,
        getSymbolConfiguration: mockGetSymbolConfiguration,
        getSymbolInfo: mockGetSymbolInfo,
        getAccountInfo: mockGetAccountInfo,
        getIndicators: mockGetIndicators,
        getOpenOrders: mockGetOpenOrders,
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

    it('returns expected result', () => {
      expect(mockLoggerInfo).toHaveBeenCalledWith(
        {
          symbol: 'BTCUSDT',
          data: {
            globalConfiguration: {
              global: 'value'
            },
            symbol: 'BTCUSDT',
            symbolConfiguration: {
              symbol: 'value'
            },
            accountInfo: {
              account: 'value'
            },
            action: 'value',
            indicators: {
              indicator: 'value'
            },
            symbolInfo: {
              symbol: 'value'
            },
            openOrders: {
              order: 'value'
            },
            baseAssetBalance: {
              baseAsset: 'value'
            },
            quoteAssetBalance: {
              quoteAsset: 'value'
            },
            buy: {
              buy: 'value'
            },
            sell: {
              sell: 'value'
            }
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
      mockGetGlobalConfiguration = jest.fn().mockResolvedValue(data);
      mockGetNextSymbol = jest.fn().mockResolvedValue(data);
      mockGetExchangeSymbols = jest.fn().mockResolvedValue(data);
      mockGetSymbolConfiguration = jest.fn().mockResolvedValue(data);
      mockGetAccountInfo = jest.fn().mockResolvedValue(data);
      mockGetIndicators = jest.fn().mockResolvedValue(data);
      mockGetOpenOrders = jest.fn().mockResolvedValue(data);
      mockHandleOpenOrders = jest.fn().mockResolvedValue(data);
      mockDetermineAction = jest.fn().mockResolvedValue(data);
      mockPlaceBuyOrder = jest.fn().mockResolvedValue(data);
      mockPlaceSellOrder = jest.fn().mockResolvedValue(data);
      mockRemoveLastBuyPrice = jest.fn().mockResolvedValue(data);
      mockSaveDataToCache = jest.fn().mockResolvedValue(data);

      jest.mock('../trailingTrade/steps', () => ({
        getGlobalConfiguration: mockGetGlobalConfiguration,
        getNextSymbol: mockGetNextSymbol,
        getExchangeSymbols: mockGetExchangeSymbols,
        getSymbolConfiguration: mockGetSymbolConfiguration,
        getAccountInfo: mockGetAccountInfo,
        getIndicators: mockGetIndicators,
        getOpenOrders: mockGetOpenOrders,
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
