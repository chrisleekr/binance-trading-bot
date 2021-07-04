/* eslint-disable global-require */

describe('get-indicators.js', () => {
  let result;
  let rawData;
  let step;

  let cacheMock;
  let loggerMock;

  let mockGetLastBuyPrice;

  describe('execute', () => {
    beforeEach(() => {
      jest.clearAllMocks().resetModules();
    });

    describe('with no open orders and no last buy price', () => {
      beforeEach(async () => {
        const { cache, logger } = require('../../../../helpers');
        cacheMock = cache;
        loggerMock = logger;

        mockGetLastBuyPrice = jest.fn().mockResolvedValue(null);
        jest.mock('../../../trailingTradeHelper/common', () => ({
          getLastBuyPrice: mockGetLastBuyPrice
        }));

        cacheMock.hget = jest.fn().mockImplementation((hash, key) => {
          if (
            hash === 'trailing-trade-symbols' &&
            key === 'BTCUSDT-indicator-data'
          ) {
            return JSON.stringify({
              highestPrice: 10000,
              lowestPrice: 8893.03,
              athPrice: 9000
            });
          }

          if (
            hash === 'trailing-trade-symbols' &&
            key === 'BTCUSDT-latest-candle'
          ) {
            return JSON.stringify({
              symbol: 'BTCUSDT',
              close: '15555.09000000'
            });
          }

          return null;
        });

        step = require('../get-indicators');

        rawData = {
          symbol: 'BTCUSDT',
          symbolInfo: {
            filterMinNotional: { minNotional: '10.000' }
          },
          symbolConfiguration: {
            buy: {
              triggerPercentage: 1.01,
              limitPercentage: 1.021,
              athRestriction: {
                enabled: true,
                restrictionPercentage: 0.9
              }
            },
            sell: {
              triggerPercentage: 1.06,
              limitPercentage: 0.979,
              stopLoss: { maxLossPercentage: 0.8 }
            }
          },
          baseAssetBalance: { total: 0.1 },
          openOrders: []
        };

        result = await step.execute(logger, rawData);
      });

      it('triggers getLastBuyPrice', () => {
        expect(mockGetLastBuyPrice).toHaveBeenCalledWith(loggerMock, 'BTCUSDT');
      });

      it('returns expected value', () => {
        expect(result).toStrictEqual({
          symbol: 'BTCUSDT',
          symbolInfo: {
            filterMinNotional: { minNotional: '10.000' }
          },
          symbolConfiguration: {
            buy: {
              triggerPercentage: 1.01,
              limitPercentage: 1.021,
              athRestriction: {
                enabled: true,
                restrictionPercentage: 0.9
              }
            },
            sell: {
              triggerPercentage: 1.06,
              limitPercentage: 0.979,
              stopLoss: {
                maxLossPercentage: 0.8
              }
            }
          },
          baseAssetBalance: {
            total: 0.1,
            estimatedValue: 1555.509,
            isLessThanMinNotionalValue: false
          },
          openOrders: [],
          indicators: {
            highestPrice: 10000,
            lowestPrice: 8893.03,
            athPrice: 9000
          },
          lastCandle: {
            symbol: 'BTCUSDT',
            close: '15555.09000000'
          },
          buy: {
            currentPrice: 15555.09,
            limitPrice: 15881.746889999999,
            highestPrice: 10000,
            lowestPrice: 8893.03,
            athPrice: 9000,
            athRestrictionPrice: 8100,
            triggerPrice: 8981.9603,
            difference: 73.18146017634923,
            openOrders: [],
            processMessage: '',
            updatedAt: expect.any(Object)
          },
          sell: {
            currentPrice: 15555.09,
            limitPrice: 15228.43311,
            lastBuyPrice: null,
            triggerPrice: null,
            difference: null,
            currentProfit: null,
            currentProfitPercentage: null,
            openOrders: [],
            stopLossDifference: null,
            stopLossTriggerPrice: null,
            processMessage: '',
            updatedAt: expect.any(Object)
          }
        });
      });
    });

    describe('with disabled ATH restriction', () => {
      beforeEach(async () => {
        const { cache, logger } = require('../../../../helpers');
        cacheMock = cache;
        loggerMock = logger;

        mockGetLastBuyPrice = jest.fn().mockResolvedValue(null);
        jest.mock('../../../trailingTradeHelper/common', () => ({
          getLastBuyPrice: mockGetLastBuyPrice
        }));

        cacheMock.hget = jest.fn().mockImplementation((hash, key) => {
          if (
            hash === 'trailing-trade-symbols' &&
            key === 'BTCUSDT-indicator-data'
          ) {
            return JSON.stringify({
              highestPrice: 10000,
              lowestPrice: 8893.03,
              athPrice: null
            });
          }

          if (
            hash === 'trailing-trade-symbols' &&
            key === 'BTCUSDT-latest-candle'
          ) {
            return JSON.stringify({
              symbol: 'BTCUSDT',
              close: '15555.09000000'
            });
          }

          return null;
        });

        step = require('../get-indicators');

        rawData = {
          symbol: 'BTCUSDT',
          symbolInfo: {
            filterMinNotional: { minNotional: '10.000' }
          },
          symbolConfiguration: {
            buy: {
              triggerPercentage: 1.01,
              limitPercentage: 1.021,
              athRestriction: {
                enabled: false,
                restrictionPercentage: 0.9
              }
            },
            sell: {
              triggerPercentage: 1.06,
              limitPercentage: 0.979,
              stopLoss: { maxLossPercentage: 0.8 }
            }
          },
          baseAssetBalance: { total: 0.1 },
          openOrders: []
        };

        result = await step.execute(logger, rawData);
      });

      it('triggers getLastBuyPrice', () => {
        expect(mockGetLastBuyPrice).toHaveBeenCalledWith(loggerMock, 'BTCUSDT');
      });

      it('returns expected value', () => {
        expect(result).toStrictEqual({
          symbol: 'BTCUSDT',
          symbolInfo: {
            filterMinNotional: { minNotional: '10.000' }
          },
          symbolConfiguration: {
            buy: {
              triggerPercentage: 1.01,
              limitPercentage: 1.021,
              athRestriction: {
                enabled: false,
                restrictionPercentage: 0.9
              }
            },
            sell: {
              triggerPercentage: 1.06,
              limitPercentage: 0.979,
              stopLoss: {
                maxLossPercentage: 0.8
              }
            }
          },
          baseAssetBalance: {
            total: 0.1,
            estimatedValue: 1555.509,
            isLessThanMinNotionalValue: false
          },
          openOrders: [],
          indicators: {
            highestPrice: 10000,
            lowestPrice: 8893.03,
            athPrice: null
          },
          lastCandle: {
            symbol: 'BTCUSDT',
            close: '15555.09000000'
          },
          buy: {
            currentPrice: 15555.09,
            limitPrice: 15881.746889999999,
            highestPrice: 10000,
            lowestPrice: 8893.03,
            athPrice: null,
            athRestrictionPrice: null,
            triggerPrice: 8981.9603,
            difference: 73.18146017634923,
            openOrders: [],
            processMessage: '',
            updatedAt: expect.any(Object)
          },
          sell: {
            currentPrice: 15555.09,
            limitPrice: 15228.43311,
            lastBuyPrice: null,
            triggerPrice: null,
            difference: null,
            currentProfit: null,
            currentProfitPercentage: null,
            openOrders: [],
            stopLossDifference: null,
            stopLossTriggerPrice: null,
            processMessage: '',
            updatedAt: expect.any(Object)
          }
        });
      });
    });

    describe('with no open orders but has last buy price', () => {
      beforeEach(async () => {
        const { cache, logger } = require('../../../../helpers');
        cacheMock = cache;
        loggerMock = logger;

        mockGetLastBuyPrice = jest
          .fn()
          .mockResolvedValue({ lastBuyPrice: 9000, quantity: 1 });
        jest.mock('../../../trailingTradeHelper/common', () => ({
          getLastBuyPrice: mockGetLastBuyPrice
        }));

        cacheMock.hget = jest.fn().mockImplementation((hash, key) => {
          if (
            hash === 'trailing-trade-symbols' &&
            key === 'BTCUSDT-indicator-data'
          ) {
            return JSON.stringify({
              highestPrice: 10000,
              lowestPrice: 8893.03,
              athPrice: 9000
            });
          }

          if (
            hash === 'trailing-trade-symbols' &&
            key === 'BTCUSDT-latest-candle'
          ) {
            return JSON.stringify({
              symbol: 'BTCUSDT',
              close: '15555.09000000'
            });
          }

          return null;
        });

        step = require('../get-indicators');

        rawData = {
          symbol: 'BTCUSDT',
          symbolInfo: {
            filterMinNotional: { minNotional: '10.000' }
          },
          symbolConfiguration: {
            buy: {
              triggerPercentage: 1.01,
              limitPercentage: 1.021,
              athRestriction: {
                enabled: true,
                restrictionPercentage: 0.9
              }
            },
            sell: {
              triggerPercentage: 1.06,
              limitPercentage: 0.979,
              stopLoss: { maxLossPercentage: 0.8 }
            }
          },
          baseAssetBalance: { total: 0.1 },
          openOrders: [
            {
              orderId: 1,
              symbol: 'BTCUSDT',
              type: 'LIMIT',
              side: 'BUY',
              price: '13000.000',
              origQty: '0.005',
              time: 1615465601162
            },
            {
              orderId: 2,
              symbol: 'BTCUSDT',
              type: 'STOP_LOSS_LIMIT',
              side: 'BUY',
              price: '16000.000',
              origQty: '0.005',
              stopPrice: '16100.000',
              time: 1615465601162
            },
            {
              orderId: 3,
              symbol: 'BTCUSDT',
              type: 'STOP_LOSS_LIMIT',
              side: 'SELL',
              price: '16000.000',
              origQty: '0.005',
              stopPrice: '15900.000',
              time: 1615465601162
            }
          ]
        };

        result = await step.execute(logger, rawData);
      });

      it('triggers getLastBuyPrice', () => {
        expect(mockGetLastBuyPrice).toHaveBeenCalledWith(loggerMock, 'BTCUSDT');
      });

      it('triggers expected value', () => {
        expect(result).toStrictEqual({
          symbol: 'BTCUSDT',
          symbolInfo: {
            filterMinNotional: { minNotional: '10.000' }
          },
          symbolConfiguration: {
            buy: {
              triggerPercentage: 1.01,
              limitPercentage: 1.021,
              athRestriction: {
                enabled: true,
                restrictionPercentage: 0.9
              }
            },
            sell: {
              triggerPercentage: 1.06,
              limitPercentage: 0.979,
              stopLoss: {
                maxLossPercentage: 0.8
              }
            }
          },
          baseAssetBalance: {
            total: 0.1,
            estimatedValue: 1555.509,
            isLessThanMinNotionalValue: false
          },
          openOrders: [
            {
              orderId: 1,
              symbol: 'BTCUSDT',
              type: 'LIMIT',
              side: 'BUY',
              price: '13000.000',
              origQty: '0.005',
              time: 1615465601162,
              currentPrice: 15555.09,
              updatedAt: expect.any(Object)
            },
            {
              orderId: 2,
              symbol: 'BTCUSDT',
              type: 'STOP_LOSS_LIMIT',
              side: 'BUY',
              price: '16000.000',
              origQty: '0.005',
              stopPrice: '16100.000',
              time: 1615465601162,
              currentPrice: 15555.09,
              limitPrice: 15881.746889999999,
              limitPercentage: 1.021,
              differenceToExecute: -3.5030976998525976,
              differenceToCancel: -1.37423868741684,
              updatedAt: expect.any(Object)
            },
            {
              orderId: 3,
              symbol: 'BTCUSDT',
              type: 'STOP_LOSS_LIMIT',
              side: 'SELL',
              price: '16000.000',
              origQty: '0.005',
              stopPrice: '15900.000',
              time: 1615465601162,
              currentPrice: 15555.09,
              limitPrice: 15228.43311,
              limitPercentage: 0.979,
              differenceToExecute: -2.2173449333947826,
              differenceToCancel: -4.40995396669539,
              minimumProfit: 35,
              minimumProfitPercentage: 43.75,
              updatedAt: expect.any(Object)
            }
          ],
          indicators: {
            highestPrice: 10000,
            lowestPrice: 8893.03,
            athPrice: 9000
          },
          lastCandle: {
            symbol: 'BTCUSDT',
            close: '15555.09000000'
          },
          buy: {
            currentPrice: 15555.09,
            limitPrice: 15881.746889999999,
            highestPrice: 10000,
            lowestPrice: 8893.03,
            athPrice: 9000,
            athRestrictionPrice: 8100,
            triggerPrice: 8981.9603,
            difference: 73.18146017634923,
            openOrders: [
              {
                orderId: 1,
                symbol: 'BTCUSDT',
                type: 'LIMIT',
                side: 'BUY',
                price: '13000.000',
                origQty: '0.005',
                time: 1615465601162,
                currentPrice: 15555.09,
                updatedAt: expect.any(Object)
              },
              {
                orderId: 2,
                symbol: 'BTCUSDT',
                type: 'STOP_LOSS_LIMIT',
                side: 'BUY',
                price: '16000.000',
                origQty: '0.005',
                stopPrice: '16100.000',
                time: 1615465601162,
                currentPrice: 15555.09,
                limitPrice: 15881.746889999999,
                limitPercentage: 1.021,
                differenceToExecute: -3.5030976998525976,
                differenceToCancel: -1.37423868741684,
                updatedAt: expect.any(Object)
              }
            ],
            processMessage: '',
            updatedAt: expect.any(Object)
          },
          sell: {
            currentPrice: 15555.09,
            limitPrice: 15228.43311,
            lastBuyPrice: 9000,
            triggerPrice: 9540,
            difference: 38.669593039963125,
            currentProfit: 655.509,
            currentProfitPercentage: 42.14112550939918,
            stopLossDifference: 53.712900407519335,
            stopLossTriggerPrice: 7200,
            openOrders: [
              {
                orderId: 3,
                symbol: 'BTCUSDT',
                type: 'STOP_LOSS_LIMIT',
                side: 'SELL',
                price: '16000.000',
                origQty: '0.005',
                stopPrice: '15900.000',
                time: 1615465601162,
                currentPrice: 15555.09,
                limitPrice: 15228.43311,
                limitPercentage: 0.979,
                differenceToExecute: -2.2173449333947826,
                differenceToCancel: -4.40995396669539,
                minimumProfit: 35,
                minimumProfitPercentage: 43.75,
                updatedAt: expect.any(Object)
              }
            ],
            processMessage: '',
            updatedAt: expect.any(Object)
          }
        });
      });
    });

    describe('with open orders but no last buy price', () => {
      beforeEach(async () => {
        const { cache, logger } = require('../../../../helpers');
        cacheMock = cache;
        loggerMock = logger;

        mockGetLastBuyPrice = jest.fn().mockResolvedValue(null);
        jest.mock('../../../trailingTradeHelper/common', () => ({
          getLastBuyPrice: mockGetLastBuyPrice
        }));

        cacheMock.hget = jest.fn().mockImplementation((hash, key) => {
          if (
            hash === 'trailing-trade-symbols' &&
            key === 'BTCUSDT-indicator-data'
          ) {
            return JSON.stringify({
              highestPrice: 10000,
              lowestPrice: 8893.03,
              athPrice: 9000
            });
          }

          if (
            hash === 'trailing-trade-symbols' &&
            key === 'BTCUSDT-latest-candle'
          ) {
            return JSON.stringify({
              symbol: 'BTCUSDT',
              close: '15555.09000000'
            });
          }

          return null;
        });

        step = require('../get-indicators');
        rawData = {
          symbol: 'BTCUSDT',
          symbolInfo: {
            filterMinNotional: { minNotional: '10.000' }
          },
          symbolConfiguration: {
            buy: {
              triggerPercentage: 1.01,
              limitPercentage: 1.021,
              athRestriction: {
                enabled: true,
                restrictionPercentage: 0.9
              }
            },
            sell: {
              triggerPercentage: 1.06,
              limitPercentage: 0.979,
              stopLoss: { maxLossPercentage: 0.8 }
            }
          },
          baseAssetBalance: {
            total: 0.1
          },
          openOrders: [
            {
              orderId: 1,
              symbol: 'BTCUSDT',
              type: 'LIMIT',
              side: 'BUY',
              price: '13000.000',
              origQty: '0.005',
              time: 1615465601162
            },
            {
              orderId: 2,
              symbol: 'BTCUSDT',
              type: 'STOP_LOSS_LIMIT',
              side: 'BUY',
              price: '16000.000',
              origQty: '0.005',
              stopPrice: '16100.000',
              time: 1615465601162
            },
            {
              orderId: 3,
              symbol: 'BTCUSDT',
              type: 'STOP_LOSS_LIMIT',
              side: 'SELL',
              price: '16000.000',
              origQty: '0.005',
              stopPrice: '15900.000',
              time: 1615465601162
            }
          ]
        };

        result = await step.execute(logger, rawData);
      });

      it('triggers expected value', () => {
        expect(result).toStrictEqual({
          symbol: 'BTCUSDT',
          symbolInfo: {
            filterMinNotional: { minNotional: '10.000' }
          },
          symbolConfiguration: {
            buy: {
              triggerPercentage: 1.01,
              limitPercentage: 1.021,
              athRestriction: {
                enabled: true,
                restrictionPercentage: 0.9
              }
            },
            sell: {
              triggerPercentage: 1.06,
              limitPercentage: 0.979,
              stopLoss: {
                maxLossPercentage: 0.8
              }
            }
          },
          baseAssetBalance: {
            total: 0.1,
            estimatedValue: 1555.509,
            isLessThanMinNotionalValue: false
          },
          openOrders: [
            {
              orderId: 1,
              symbol: 'BTCUSDT',
              type: 'LIMIT',
              side: 'BUY',
              price: '13000.000',
              origQty: '0.005',
              time: 1615465601162,
              currentPrice: 15555.09,
              updatedAt: expect.any(Object)
            },
            {
              orderId: 2,
              symbol: 'BTCUSDT',
              type: 'STOP_LOSS_LIMIT',
              side: 'BUY',
              price: '16000.000',
              origQty: '0.005',
              stopPrice: '16100.000',
              time: 1615465601162,
              currentPrice: 15555.09,
              limitPrice: 15881.746889999999,
              limitPercentage: 1.021,
              differenceToExecute: -3.5030976998525976,
              differenceToCancel: -1.37423868741684,
              updatedAt: expect.any(Object)
            },
            {
              orderId: 3,
              symbol: 'BTCUSDT',
              type: 'STOP_LOSS_LIMIT',
              side: 'SELL',
              price: '16000.000',
              origQty: '0.005',
              stopPrice: '15900.000',
              time: 1615465601162,
              currentPrice: 15555.09,
              limitPrice: 15228.43311,
              limitPercentage: 0.979,
              differenceToExecute: -2.2173449333947826,
              differenceToCancel: -4.40995396669539,
              minimumProfit: null,
              minimumProfitPercentage: null,
              updatedAt: expect.any(Object)
            }
          ],
          indicators: {
            highestPrice: 10000,
            lowestPrice: 8893.03,
            athPrice: 9000
          },
          lastCandle: {
            symbol: 'BTCUSDT',
            close: '15555.09000000'
          },
          buy: {
            currentPrice: 15555.09,
            limitPrice: 15881.746889999999,
            highestPrice: 10000,
            lowestPrice: 8893.03,
            triggerPrice: 8981.9603,
            athPrice: 9000,
            athRestrictionPrice: 8100,
            difference: 73.18146017634923,
            openOrders: [
              {
                orderId: 1,
                symbol: 'BTCUSDT',
                type: 'LIMIT',
                side: 'BUY',
                price: '13000.000',
                origQty: '0.005',
                time: 1615465601162,
                currentPrice: 15555.09,
                updatedAt: expect.any(Object)
              },
              {
                orderId: 2,
                symbol: 'BTCUSDT',
                type: 'STOP_LOSS_LIMIT',
                side: 'BUY',
                price: '16000.000',
                origQty: '0.005',
                stopPrice: '16100.000',
                time: 1615465601162,
                currentPrice: 15555.09,
                limitPrice: 15881.746889999999,
                limitPercentage: 1.021,
                differenceToExecute: -3.5030976998525976,
                differenceToCancel: -1.37423868741684,
                updatedAt: expect.any(Object)
              }
            ],
            processMessage: '',
            updatedAt: expect.any(Object)
          },
          sell: {
            currentPrice: 15555.09,
            limitPrice: 15228.43311,
            lastBuyPrice: null,
            triggerPrice: null,
            difference: null,
            currentProfit: null,
            currentProfitPercentage: null,
            stopLossDifference: null,
            stopLossTriggerPrice: null,
            openOrders: [
              {
                orderId: 3,
                symbol: 'BTCUSDT',
                type: 'STOP_LOSS_LIMIT',
                side: 'SELL',
                price: '16000.000',
                origQty: '0.005',
                stopPrice: '15900.000',
                time: 1615465601162,
                currentPrice: 15555.09,
                limitPrice: 15228.43311,
                limitPercentage: 0.979,
                differenceToExecute: -2.2173449333947826,
                differenceToCancel: -4.40995396669539,
                minimumProfit: null,
                minimumProfitPercentage: null,
                updatedAt: expect.any(Object)
              }
            ],
            processMessage: '',
            updatedAt: expect.any(Object)
          }
        });
      });
    });

    describe('with balance is not found', () => {
      beforeEach(async () => {
        const { cache, logger } = require('../../../../helpers');
        cacheMock = cache;
        loggerMock = logger;

        mockGetLastBuyPrice = jest.fn().mockResolvedValue(null);
        jest.mock('../../../trailingTradeHelper/common', () => ({
          getLastBuyPrice: mockGetLastBuyPrice
        }));

        cacheMock.hget = jest.fn().mockImplementation((hash, key) => {
          if (
            hash === 'trailing-trade-symbols' &&
            key === 'BTCUSDT-indicator-data'
          ) {
            return JSON.stringify({
              highestPrice: 10000,
              lowestPrice: 8893.03,
              athPrice: 9000
            });
          }

          if (
            hash === 'trailing-trade-symbols' &&
            key === 'BTCUSDT-latest-candle'
          ) {
            return JSON.stringify({
              symbol: 'BTCUSDT',
              close: '15555.09000000'
            });
          }

          return null;
        });

        step = require('../get-indicators');

        rawData = {
          symbol: 'BTCUSDT',
          symbolInfo: {
            filterMinNotional: { minNotional: '10.000' }
          },
          symbolConfiguration: {
            buy: {
              triggerPercentage: 1.01,
              limitPercentage: 1.011,
              athRestriction: {
                enabled: true,
                restrictionPercentage: 0.9
              }
            },
            sell: {
              triggerPercentage: 0.99,
              limitPercentage: 0.98,
              stopLoss: { maxLossPercentage: 0.8 }
            }
          },
          baseAssetBalance: {
            total: 0.1
          },
          openOrders: [],
          buy: {
            processMessage: 'Hello'
          },
          sell: {
            processMessage: 'World'
          }
        };

        result = await step.execute(logger, rawData);
      });

      it('triggers expected value', () => {
        expect(result).toStrictEqual({
          symbol: 'BTCUSDT',
          symbolInfo: {
            filterMinNotional: { minNotional: '10.000' }
          },
          symbolConfiguration: {
            buy: {
              triggerPercentage: 1.01,
              limitPercentage: 1.011,
              athRestriction: {
                enabled: true,
                restrictionPercentage: 0.9
              }
            },
            sell: {
              triggerPercentage: 0.99,
              limitPercentage: 0.98,
              stopLoss: {
                maxLossPercentage: 0.8
              }
            }
          },
          baseAssetBalance: {
            total: 0.1,
            estimatedValue: 1555.509,
            isLessThanMinNotionalValue: false
          },
          openOrders: [],
          indicators: {
            highestPrice: 10000,
            lowestPrice: 8893.03,
            athPrice: 9000
          },
          lastCandle: {
            symbol: 'BTCUSDT',
            close: '15555.09000000'
          },
          buy: {
            currentPrice: 15555.09,
            limitPrice: 15726.195989999998,
            highestPrice: 10000,
            lowestPrice: 8893.03,
            athPrice: 9000,
            athRestrictionPrice: 8100,
            triggerPrice: 8981.9603,
            difference: 73.18146017634923,
            openOrders: [],
            processMessage: 'Hello',
            updatedAt: expect.any(Object)
          },
          sell: {
            currentPrice: 15555.09,
            limitPrice: 15243.9882,
            lastBuyPrice: null,
            triggerPrice: null,
            difference: null,
            currentProfit: null,
            currentProfitPercentage: null,
            stopLossDifference: null,
            stopLossTriggerPrice: null,
            openOrders: [],
            processMessage: 'World',
            updatedAt: expect.any(Object)
          }
        });
      });
    });

    describe('when there is no indicator data cache', () => {
      beforeEach(async () => {
        const { cache, logger } = require('../../../../helpers');
        cacheMock = cache;
        loggerMock = logger;

        mockGetLastBuyPrice = jest.fn().mockResolvedValue(null);
        jest.mock('../../../trailingTradeHelper/common', () => ({
          getLastBuyPrice: mockGetLastBuyPrice
        }));

        cacheMock.hget = jest.fn().mockImplementation((hash, key) => {
          if (
            hash === 'trailing-trade-symbols' &&
            key === 'BTCUSDT-latest-candle'
          ) {
            return JSON.stringify({
              symbol: 'BTCUSDT',
              close: '15555.09000000'
            });
          }

          return null;
        });

        step = require('../get-indicators');

        rawData = {
          symbol: 'BTCUSDT',
          symbolInfo: {
            filterMinNotional: { minNotional: '10.000' }
          },
          symbolConfiguration: {
            buy: {
              triggerPercentage: 1.01,
              limitPercentage: 1.021,
              athRestriction: {
                enabled: true,
                restrictionPercentage: 0.9
              }
            },
            sell: {
              triggerPercentage: 1.06,
              limitPercentage: 0.979,
              stopLoss: { maxLossPercentage: 0.8 }
            }
          },
          baseAssetBalance: { total: 0.1 },
          openOrders: []
        };

        result = await step.execute(logger, rawData);
      });

      it('returns expected value', () => {
        expect(result).toStrictEqual({
          symbol: 'BTCUSDT',
          symbolInfo: {
            filterMinNotional: { minNotional: '10.000' }
          },
          symbolConfiguration: {
            buy: {
              triggerPercentage: 1.01,
              limitPercentage: 1.021,
              athRestriction: {
                enabled: true,
                restrictionPercentage: 0.9
              }
            },
            sell: {
              triggerPercentage: 1.06,
              limitPercentage: 0.979,
              stopLoss: { maxLossPercentage: 0.8 }
            }
          },
          baseAssetBalance: { total: 0.1 },
          openOrders: [],
          saveToCache: false
        });
      });
    });

    describe('when there is no latest candle cache', () => {
      beforeEach(async () => {
        const { cache, logger } = require('../../../../helpers');
        cacheMock = cache;
        loggerMock = logger;

        mockGetLastBuyPrice = jest.fn().mockResolvedValue(null);
        jest.mock('../../../trailingTradeHelper/common', () => ({
          getLastBuyPrice: mockGetLastBuyPrice
        }));

        cacheMock.hget = jest.fn().mockImplementation((hash, key) => {
          if (
            hash === 'trailing-trade-symbols' &&
            key === 'BTCUSDT-indicator-data'
          ) {
            return JSON.stringify({
              lowestPrice: 8893.03
            });
          }

          return null;
        });

        step = require('../get-indicators');

        rawData = {
          symbol: 'BTCUSDT',
          symbolInfo: {
            filterMinNotional: { minNotional: '10.000' }
          },
          symbolConfiguration: {
            buy: {
              triggerPercentage: 1.01,
              limitPercentage: 1.021,
              athRestriction: {
                enabled: true,
                restrictionPercentage: 0.9
              }
            },
            sell: {
              triggerPercentage: 1.06,
              limitPercentage: 0.979,
              stopLoss: { maxLossPercentage: 0.8 }
            }
          },
          baseAssetBalance: { total: 0.1 },
          openOrders: []
        };

        result = await step.execute(logger, rawData);
      });

      it('returns expected value', () => {
        expect(result).toStrictEqual({
          symbol: 'BTCUSDT',
          symbolInfo: {
            filterMinNotional: { minNotional: '10.000' }
          },
          symbolConfiguration: {
            buy: {
              triggerPercentage: 1.01,
              limitPercentage: 1.021,
              athRestriction: {
                enabled: true,
                restrictionPercentage: 0.9
              }
            },
            sell: {
              triggerPercentage: 1.06,
              limitPercentage: 0.979,
              stopLoss: { maxLossPercentage: 0.8 }
            }
          },
          baseAssetBalance: { total: 0.1 },
          openOrders: [],
          saveToCache: false
        });
      });
    });
  });
});
