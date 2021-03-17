/* eslint-disable global-require */
const { binance, mongo, cache, logger } = require('../../../../helpers');

const step = require('../get-indicators');

describe('get-indicators.js', () => {
  let result;
  let rawData;

  describe('execute', () => {
    beforeEach(() => {
      cache.hget = jest.fn().mockResolvedValue(undefined);
      cache.hset = jest.fn().mockResolvedValue(true);
      mongo.findOne = jest.fn().mockResolvedValue(undefined);
      binance.client.candles = jest.fn().mockResolvedValue();
      binance.client.exchangeInfo = jest.fn().mockResolvedValue();
    });

    describe('wit no open orders and no last buy price', () => {
      beforeEach(async () => {
        mongo.findOne = jest.fn().mockResolvedValue(undefined);

        binance.client.candles = jest
          .fn()
          .mockResolvedValue(require('./fixtures/binance-candles.json'));

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
          baseAssetBalance: { total: 0.1 },
          openOrders: []
        };

        result = await step.execute(logger, rawData);
      });

      it('triggers mongo.findOne', () => {
        expect(mongo.findOne).toHaveBeenCalledWith(
          logger,
          'trailing-trade-symbols',
          { key: 'BTCUSDT-last-buy-price' }
        );
      });

      it('triggers expected value', () => {
        expect(result).toStrictEqual({
          symbol: 'BTCUSDT',
          symbolConfiguration: {
            candles: { interval: '1h', limit: 50 },
            buy: { triggerPercentage: 1.01, limitPercentage: 1.011 },
            sell: { triggerPercentage: 0.99, limitPercentage: 0.98 }
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
          baseAssetBalance: {
            total: 0.1,
            estimatedValue: 1555.509
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

    describe('with no open orders and last buy price', () => {
      beforeEach(async () => {
        mongo.findOne = jest.fn().mockResolvedValue({
          lastBuyPrice: 9000
        });

        binance.client.candles = jest
          .fn()
          .mockResolvedValue(require('./fixtures/binance-candles.json'));

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

      it('triggers mongo.findOne', () => {
        expect(mongo.findOne).toHaveBeenCalledWith(
          logger,
          'trailing-trade-symbols',
          { key: 'BTCUSDT-last-buy-price' }
        );
      });

      it('triggers expected value', () => {
        expect(result).toStrictEqual({
          symbol: 'BTCUSDT',
          symbolConfiguration: {
            candles: { interval: '1h', limit: 50 },
            buy: { triggerPercentage: 1.01, limitPercentage: 1.011 },
            sell: { triggerPercentage: 0.99, limitPercentage: 0.98 }
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
              limitPrice: 15726.195989999998,
              limitPercentage: 1.011,
              difference: 2.3769512362538103,
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
              limitPrice: 15243.9882,
              limitPercentage: 0.98,
              difference: -4.303413197341621,
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
            limitPrice: 15726.195989999998,
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
                limitPrice: 15726.195989999998,
                limitPercentage: 1.011,
                difference: 2.3769512362538103,
                updatedAt: expect.any(Object)
              }
            ],
            processMesage: '',
            updatedAt: expect.any(Object)
          },
          sell: {
            currentPrice: 15555.09,
            limitPrice: 15243.9882,
            lastBuyPrice: 9000,
            triggerPrice: 8910,
            difference: 42.71971425430519,
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
                limitPrice: 15243.9882,
                limitPercentage: 0.98,
                difference: -4.303413197341621,
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
        mongo.findOne = jest.fn().mockResolvedValue(undefined);

        binance.client.candles = jest
          .fn()
          .mockResolvedValue(require('./fixtures/binance-candles.json'));

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
            buy: { triggerPercentage: 1.01, limitPercentage: 1.011 },
            sell: { triggerPercentage: 0.99, limitPercentage: 0.98 }
          },
          baseAssetBalance: {
            total: 0.1,
            estimatedValue: 1555.509
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
              limitPrice: 15726.195989999998,
              limitPercentage: 1.011,
              difference: 2.3769512362538103,
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
              limitPrice: 15243.9882,
              limitPercentage: 0.98,
              difference: -4.303413197341621,
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
            limitPrice: 15726.195989999998,
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
                limitPrice: 15726.195989999998,
                limitPercentage: 1.011,
                difference: 2.3769512362538103,
                updatedAt: expect.any(Object)
              }
            ],
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
                limitPrice: 15243.9882,
                limitPercentage: 0.98,
                difference: -4.303413197341621,
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
        mongo.findOne = jest.fn().mockResolvedValue(undefined);

        binance.client.candles = jest
          .fn()
          .mockResolvedValue(require('./fixtures/binance-candles.json'));

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
