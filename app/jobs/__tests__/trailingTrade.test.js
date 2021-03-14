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
      mockGetGlobalConfiguration = jest.fn().mockResolvedValueOnce(data);

      data = {
        ...data,
        symbol: 'BTCUSDT'
      };
      mockGetNextSymbol = jest.fn().mockResolvedValueOnce(data);

      data = {
        ...data
      };
      mockGetExchangeSymbols = jest.fn().mockResolvedValueOnce(data);

      data = {
        ...data,
        symbolConfiguration: {
          symbol: 'value'
        }
      };
      mockGetSymbolConfiguration = jest.fn().mockResolvedValueOnce(data);

      data = {
        ...data,
        accountInfo: {
          account: 'value'
        }
      };
      mockGetAccountInfo = jest.fn().mockResolvedValueOnce(data);

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
        },
        symbolInfo: {
          symbol: 'value'
        }
      };
      mockGetIndicators = jest.fn().mockResolvedValueOnce(data);

      data = {
        ...data,
        openOrders: {
          order: 'value'
        }
      };
      mockGetOpenOrders = jest.fn().mockResolvedValueOnce(data);

      mockHandleOpenOrders = jest.fn().mockResolvedValueOnce(data);

      data = {
        ...data,
        action: 'value'
      };
      mockDetermineAction = jest.fn().mockResolvedValueOnce(data);

      data = {
        ...data,
        buy: {
          buy: 'value'
        }
      };
      mockPlaceBuyOrder = jest.fn().mockResolvedValueOnce(data);

      data = {
        ...data,
        sell: {
          sell: 'value'
        }
      };
      mockPlaceSellOrder = jest.fn().mockResolvedValueOnce(data);
      mockRemoveLastBuyPrice = jest.fn().mockResolvedValueOnce(data);
      mockSaveDataToCache = jest.fn().mockResolvedValueOnce(data);

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
      mockGetGlobalConfiguration = jest.fn().mockResolvedValueOnce(data);
      mockGetNextSymbol = jest.fn().mockResolvedValueOnce(data);
      mockGetExchangeSymbols = jest.fn().mockResolvedValueOnce(data);
      mockGetSymbolConfiguration = jest.fn().mockResolvedValueOnce(data);
      mockGetAccountInfo = jest.fn().mockResolvedValueOnce(data);
      mockGetIndicators = jest.fn().mockResolvedValueOnce(data);
      mockGetOpenOrders = jest.fn().mockResolvedValueOnce(data);
      mockHandleOpenOrders = jest.fn().mockResolvedValueOnce(data);
      mockDetermineAction = jest.fn().mockResolvedValueOnce(data);
      mockPlaceBuyOrder = jest.fn().mockResolvedValueOnce(data);
      mockPlaceSellOrder = jest.fn().mockResolvedValueOnce(data);
      mockRemoveLastBuyPrice = jest.fn().mockResolvedValueOnce(data);
      mockSaveDataToCache = jest.fn().mockResolvedValueOnce(data);

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
