/* eslint-disable global-require */

describe('get-indicators.js', () => {
  let result;
  let rawData;
  let step;

  let binanceMock;
  let loggerMock;

  let mockGetLastBuyPrice;

  describe('execute', () => {
    beforeEach(() => {
      jest.clearAllMocks().resetModules();
    });

    describe('with no open orders and no last buy price', () => {
      beforeEach(async () => {
        const { binance, logger } = require('../../../../helpers');
        binanceMock = binance;
        loggerMock = logger;

        mockGetLastBuyPrice = jest.fn().mockResolvedValue(null);
        jest.mock('../../symbol', () => ({
          getLastBuyPrice: mockGetLastBuyPrice
        }));
        binanceMock.client = {};
        binanceMock.client.candles = jest
          .fn()
          .mockResolvedValue(require('./fixtures/binance-candles.json'));

        step = require('../get-indicators');

        rawData = {
          symbol: 'BTCUSDT',
          symbolConfiguration: {
            candles: { interval: '1h', limit: 50 },
            buy: {
              triggerPercentage: 1.01,
              limitPercentage: 1.021
            },
            sell: {
              triggerPercentage: 1.06,
              limitPercentage: 0.979
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

      it('triggers expected value', () => {
        expect(result).toStrictEqual({
          symbol: 'BTCUSDT',
          symbolConfiguration: {
            candles: { interval: '1h', limit: 50 },
            buy: { triggerPercentage: 1.01, limitPercentage: 1.021 },
            sell: { triggerPercentage: 1.06, limitPercentage: 0.979 }
          },
          baseAssetBalance: { total: 0.1, estimatedValue: 1555.509 },
          openOrders: [],
          indicators: {
            lowestPrice: 8893.03,
            lastCandle: {
              openTime: 1604664000000,
              open: '15572.35000000',
              high: '15580.00000000',
              low: '15359.78000000',
              close: '15555.09000000',
              volume: '8016.61952700',
              closeTime: 1604685599999,
              quoteVolume: '124080975.39234051',
              trades: 113923,
              baseAssetVolume: '3869.62434400',
              quoteAssetVolume: '59899003.79417636'
            }
          },
          buy: {
            currentPrice: 15555.09,
            limitPrice: 15881.746889999999,
            lowestPrice: 8893.03,
            triggerPrice: 8981.9603,
            difference: 73.18146017634923,
            openOrders: [],
            processMesage: '',
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
            processMessage: '',
            updatedAt: expect.any(Object)
          }
        });
      });
    });

    describe('with no open orders and last buy price', () => {
      beforeEach(async () => {
        const { binance, logger } = require('../../../../helpers');
        binanceMock = binance;
        loggerMock = logger;

        mockGetLastBuyPrice = jest.fn().mockResolvedValue(9000);
        jest.mock('../../symbol', () => ({
          getLastBuyPrice: mockGetLastBuyPrice
        }));
        binanceMock.client = {};
        binanceMock.client.candles = jest
          .fn()
          .mockResolvedValue(require('./fixtures/binance-candles.json'));

        step = require('../get-indicators');

        rawData = {
          symbol: 'BTCUSDT',
          symbolConfiguration: {
            candles: { interval: '1h', limit: 50 },
            buy: {
              triggerPercentage: 1.01,
              limitPercentage: 1.021
            },
            sell: {
              triggerPercentage: 1.06,
              limitPercentage: 0.979
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
          symbolConfiguration: {
            candles: { interval: '1h', limit: 50 },
            buy: { triggerPercentage: 1.01, limitPercentage: 1.021 },
            sell: { triggerPercentage: 1.06, limitPercentage: 0.979 }
          },
          baseAssetBalance: { total: 0.1, estimatedValue: 1555.509 },
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
            lowestPrice: 8893.03,
            lastCandle: {
              openTime: 1604664000000,
              open: '15572.35000000',
              high: '15580.00000000',
              low: '15359.78000000',
              close: '15555.09000000',
              volume: '8016.61952700',
              closeTime: 1604685599999,
              quoteVolume: '124080975.39234051',
              trades: 113923,
              baseAssetVolume: '3869.62434400',
              quoteAssetVolume: '59899003.79417636'
            }
          },
          buy: {
            currentPrice: 15555.09,
            limitPrice: 15881.746889999999,
            lowestPrice: 8893.03,
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
            processMesage: '',
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

    describe('with open orders and no last buy price', () => {
      beforeEach(async () => {
        const { binance, logger } = require('../../../../helpers');
        binanceMock = binance;
        loggerMock = logger;

        mockGetLastBuyPrice = jest.fn().mockResolvedValue(null);
        jest.mock('../../symbol', () => ({
          getLastBuyPrice: mockGetLastBuyPrice
        }));
        binanceMock.client = {};
        binanceMock.client.candles = jest
          .fn()
          .mockResolvedValue(require('./fixtures/binance-candles.json'));

        step = require('../get-indicators');
        rawData = {
          symbol: 'BTCUSDT',
          symbolConfiguration: {
            candles: { interval: '1h', limit: 50 },
            buy: {
              triggerPercentage: 1.01,
              limitPercentage: 1.021
            },
            sell: {
              triggerPercentage: 1.06,
              limitPercentage: 0.979
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
          symbolConfiguration: {
            candles: { interval: '1h', limit: 50 },
            buy: { triggerPercentage: 1.01, limitPercentage: 1.021 },
            sell: { triggerPercentage: 1.06, limitPercentage: 0.979 }
          },
          baseAssetBalance: { total: 0.1, estimatedValue: 1555.509 },
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
            lowestPrice: 8893.03,
            lastCandle: {
              openTime: 1604664000000,
              open: '15572.35000000',
              high: '15580.00000000',
              low: '15359.78000000',
              close: '15555.09000000',
              volume: '8016.61952700',
              closeTime: 1604685599999,
              quoteVolume: '124080975.39234051',
              trades: 113923,
              baseAssetVolume: '3869.62434400',
              quoteAssetVolume: '59899003.79417636'
            }
          },
          buy: {
            currentPrice: 15555.09,
            limitPrice: 15881.746889999999,
            lowestPrice: 8893.03,
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
            processMesage: '',
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
        const { binance, logger } = require('../../../../helpers');
        binanceMock = binance;
        loggerMock = logger;

        mockGetLastBuyPrice = jest.fn().mockResolvedValue(null);
        jest.mock('../../symbol', () => ({
          getLastBuyPrice: mockGetLastBuyPrice
        }));
        binanceMock.client = {};
        binanceMock.client.candles = jest
          .fn()
          .mockResolvedValue(require('./fixtures/binance-candles.json'));

        step = require('../get-indicators');

        rawData = {
          symbol: 'BTCUSDT',
          symbolConfiguration: {
            candles: { interval: '1h', limit: 50 },
            buy: {
              triggerPercentage: 1.01,
              limitPercentage: 1.011
            },
            sell: {
              triggerPercentage: 0.99,
              limitPercentage: 0.98
            }
          },
          baseAssetBalance: {
            total: 0.1
          },
          openOrders: []
        };

        result = await step.execute(logger, rawData);
      });

      it('triggers expected value', () => {
        expect(result).toStrictEqual({
          symbol: 'BTCUSDT',
          symbolConfiguration: {
            candles: { interval: '1h', limit: 50 },
            buy: { triggerPercentage: 1.01, limitPercentage: 1.011 },
            sell: { triggerPercentage: 0.99, limitPercentage: 0.98 }
          },
          baseAssetBalance: {
            total: 0.1,
            estimatedValue: 1555.509
          },
          openOrders: [],
          indicators: {
            lowestPrice: 8893.03,
            lastCandle: {
              openTime: 1604664000000,
              open: '15572.35000000',
              high: '15580.00000000',
              low: '15359.78000000',
              close: '15555.09000000',
              volume: '8016.61952700',
              closeTime: 1604685599999,
              quoteVolume: '124080975.39234051',
              trades: 113923,
              baseAssetVolume: '3869.62434400',
              quoteAssetVolume: '59899003.79417636'
            }
          },
          buy: {
            currentPrice: 15555.09,
            limitPrice: 15726.195989999998,
            lowestPrice: 8893.03,
            triggerPrice: 8981.9603,
            difference: 73.18146017634923,
            openOrders: [],
            processMesage: '',
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
            openOrders: [],
            processMessage: '',
            updatedAt: expect.any(Object)
          }
        });
      });
    });
  });
});
