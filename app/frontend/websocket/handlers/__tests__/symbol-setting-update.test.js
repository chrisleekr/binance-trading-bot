/* eslint-disable global-require */

describe('symbol-setting-update.test.js', () => {
  let mockWebSocketServer;
  let mockWebSocketServerWebSocketSend;

  let mockLogger;

  let mockExecute;

  let mockGetSymbolConfiguration;
  let mockSaveSymbolConfiguration;

  beforeEach(() => {
    jest.clearAllMocks().resetModules();

    mockWebSocketServerWebSocketSend = jest.fn().mockResolvedValue(true);

    mockWebSocketServer = {
      send: mockWebSocketServerWebSocketSend
    };

    mockExecute = jest.fn((funcLogger, symbol, jobPayload) => {
      if (!funcLogger || !symbol || !jobPayload) return false;
      return jobPayload.preprocessFn();
    });

    jest.mock('../../../../cronjob/trailingTradeHelper/queue', () => ({
      execute: mockExecute
    }));
  });

  describe('when configuration is valid', () => {
    beforeEach(async () => {
      const { logger } = require('../../../../helpers');
      mockLogger = logger;
      mockLogger.fields = { correlationId: 'correlationId' };

      mockGetSymbolConfiguration = jest.fn().mockResolvedValue({
        candles: {
          interval: '1d',
          limit: '10'
        },
        buy: {
          enabled: true,
          maxPurchaseAmount: 100
        },
        sell: {
          enabled: true,
          lastbuyPercentage: 1.06,
          stopPercentage: 0.99,
          limitPercentage: 0.98
        },
        botOptions: {
          autoTriggerBuy: {
            enabled: false,
            triggerAfter: 20
          }
        }
      });

      mockSaveSymbolConfiguration = jest.fn().mockResolvedValue(true);

      jest.mock(
        '../../../../cronjob/trailingTradeHelper/configuration',
        () => ({
          getSymbolConfiguration: mockGetSymbolConfiguration,
          saveSymbolConfiguration: mockSaveSymbolConfiguration
        })
      );

      const { handleSymbolSettingUpdate } = require('../symbol-setting-update');
      await handleSymbolSettingUpdate(logger, mockWebSocketServer, {
        data: {
          symbol: 'BTCUSDT',
          configuration: {
            candles: {
              interval: '15m',
              limit: '200'
            },
            buy: {
              enabled: false,
              currentGridTradeIndex: 0,
              currentGridTrade: {
                triggerPercentage: 1,
                stopPercentage: 1.001,
                limitPercentage: 1.0021,
                maxPurchaseAmount: -1,
                maxPurchaseAmounts: {
                  USDT: 15,
                  BTC: 0.00011,
                  BUSD: 15,
                  BNB: 0.11
                },
                executed: false,
                executedOrder: null
              },
              gridTrade: [
                {
                  triggerPercentage: 1,
                  stopPercentage: 1.001,
                  limitPercentage: 1.0021,
                  maxPurchaseAmount: -1,
                  maxPurchaseAmounts: {
                    USDT: 15,
                    BTC: 0.00011,
                    BUSD: 15,
                    BNB: 0.11
                  },
                  executed: false,
                  executedOrder: null
                },
                {
                  triggerPercentage: 0.9999,
                  stopPercentage: 1.001,
                  limitPercentage: 1.0021,
                  maxPurchaseAmount: -1,
                  maxPurchaseAmounts: {
                    USDT: 15,
                    BTC: 0.00011,
                    BUSD: 15,
                    BNB: 0.11
                  },
                  executed: false,
                  executedOrder: null
                }
              ]
            },
            sell: {
              enabled: false,
              currentGridTradeIndex: 0,
              currentGridTrade: {
                triggerPercentage: 1.001,
                stopPercentage: 0.999,
                limitPercentage: 0.998,
                quantityPercentage: -1,
                quantityPercentages: {
                  USDT: 0.9999,
                  BTC: 1,
                  BUSD: 0.9999,
                  BNB: 1
                },
                executed: false,
                executedOrder: null
              },
              gridTrade: [
                {
                  triggerPercentage: 1.001,
                  stopPercentage: 0.999,
                  limitPercentage: 0.998,
                  quantityPercentage: -1,
                  quantityPercentages: {
                    USDT: 0.9999,
                    BTC: 1,
                    BUSD: 0.9999,
                    BNB: 1
                  },
                  executed: false,
                  executedOrder: null
                },
                {
                  triggerPercentage: 1.0011,
                  stopPercentage: 0.999,
                  limitPercentage: 0.998,
                  quantityPercentage: -1,
                  quantityPercentages: {
                    USDT: 1,
                    BTC: 1,
                    BUSD: 1,
                    BNB: 1
                  },
                  executed: false,
                  executedOrder: null
                }
              ]
            },
            some: 'other value',
            botOptions: {
              autoTriggerBuy: {
                enabled: true,
                triggerAfter: 10
              }
            }
          }
        }
      });
    });

    it('triggers getSymbolConfiguration', () => {
      expect(mockGetSymbolConfiguration).toHaveBeenCalledWith(
        mockLogger,
        'BTCUSDT'
      );
    });

    it('triggers saveSymbolConfiguration', () => {
      expect(mockSaveSymbolConfiguration).toHaveBeenCalledWith(
        mockLogger,
        'BTCUSDT',
        {
          botOptions: {
            autoTriggerBuy: {
              enabled: true,
              triggerAfter: 10
            }
          },
          buy: {
            enabled: false,
            gridTrade: [
              {
                limitPercentage: 1.0021,
                maxPurchaseAmount: -1,
                maxPurchaseAmounts: {
                  BNB: 0.11,
                  BTC: 0.00011,
                  BUSD: 15,
                  USDT: 15
                },
                stopPercentage: 1.001,
                triggerPercentage: 1
              },
              {
                limitPercentage: 1.0021,
                maxPurchaseAmount: -1,
                maxPurchaseAmounts: {
                  BNB: 0.11,
                  BTC: 0.00011,
                  BUSD: 15,
                  USDT: 15
                },
                stopPercentage: 1.001,
                triggerPercentage: 0.9999
              }
            ]
          },
          candles: {
            interval: '15m',
            limit: '200'
          },
          sell: {
            enabled: false,
            gridTrade: [
              {
                limitPercentage: 0.998,
                quantityPercentage: -1,
                quantityPercentages: {
                  BNB: 1,
                  BTC: 1,
                  BUSD: 0.9999,
                  USDT: 0.9999
                },
                stopPercentage: 0.999,
                triggerPercentage: 1.001
              },
              {
                limitPercentage: 0.998,
                quantityPercentage: -1,
                quantityPercentages: {
                  BNB: 1,
                  BTC: 1,
                  BUSD: 1,
                  USDT: 1
                },
                stopPercentage: 0.999,
                triggerPercentage: 1.0011
              }
            ]
          }
        }
      );
    });

    it('triggers queue.execute', () => {
      expect(mockExecute).toHaveBeenCalledWith(mockLogger, 'BTCUSDT', {
        correlationId: 'correlationId',
        preprocessFn: expect.any(Function),
        processFn: expect.any(Function)
      });
    });

    it('triggers ws.send', () => {
      const args = JSON.parse(
        mockWebSocketServerWebSocketSend.mock.calls[0][0]
      );
      expect(args).toStrictEqual({
        result: true,
        symbolConfiguration: {
          botOptions: {
            autoTriggerBuy: {
              enabled: true,
              triggerAfter: 10
            }
          },
          buy: {
            enabled: false,
            gridTrade: [
              {
                limitPercentage: 1.0021,
                maxPurchaseAmount: -1,
                maxPurchaseAmounts: {
                  BNB: 0.11,
                  BTC: 0.00011,
                  BUSD: 15,
                  USDT: 15
                },
                stopPercentage: 1.001,
                triggerPercentage: 1
              },
              {
                limitPercentage: 1.0021,
                maxPurchaseAmount: -1,
                maxPurchaseAmounts: {
                  BNB: 0.11,
                  BTC: 0.00011,
                  BUSD: 15,
                  USDT: 15
                },
                stopPercentage: 1.001,
                triggerPercentage: 0.9999
              }
            ]
          },
          candles: {
            interval: '15m',
            limit: '200'
          },
          sell: {
            enabled: false,
            gridTrade: [
              {
                limitPercentage: 0.998,
                quantityPercentage: -1,
                quantityPercentages: {
                  BNB: 1,
                  BTC: 1,
                  BUSD: 0.9999,
                  USDT: 0.9999
                },
                stopPercentage: 0.999,
                triggerPercentage: 1.001
              },
              {
                limitPercentage: 0.998,
                quantityPercentage: -1,
                quantityPercentages: {
                  BNB: 1,
                  BTC: 1,
                  BUSD: 1,
                  USDT: 1
                },
                stopPercentage: 0.999,
                triggerPercentage: 1.0011
              }
            ]
          }
        },
        type: 'symbol-setting-update-result'
      });
    });
  });
});
