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

    describe('with no cached symbol info, no open orders and no last buy price', () => {
      beforeEach(async () => {
        cache.hget = jest.fn().mockResolvedValue(undefined);
        binance.client.exchangeInfo = jest
          .fn()
          .mockResolvedValue(require('./fixtures/binance-exchange-info.json'));

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
          accountInfo: {
            balances: [
              {
                asset: 'BTC',
                free: '0.1000000',
                locked: '0.00000000'
              },
              {
                asset: 'USDT',
                free: '100.0000000',
                locked: '0.00000000'
              }
            ],
            updateTime: 1615602880892
          },
          openOrders: []
        };

        result = await step.execute(logger, rawData);
      });

      it('triggers cache.hget', () => {
        expect(cache.hget).toHaveBeenCalledWith(
          'trailing-trade-symbols',
          'BTCUSDT-symbol-info'
        );
      });

      it('triggers binance.client.exchangeInfo', () => {
        expect(binance.client.exchangeInfo).toHaveBeenCalled();
      });

      it('triggers cache.hset', () => {
        expect(cache.hset).toHaveBeenCalledWith(
          'trailing-trade-symbols',
          'BTCUSDT-symbol-info',
          JSON.stringify(
            require('./fixtures/binance-cached-exchange-info.json')
          )
        );
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
          accountInfo: {
            balances: [
              {
                asset: 'BTC',
                free: '0.1000000',
                locked: '0.00000000',
                total: 0.1,
                estimatedValue: 1555.509,
                updatedAt: expect.any(Object)
              },
              { asset: 'USDT', free: '100.0000000', locked: '0.00000000' }
            ],
            updateTime: 1615602880892
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
          symbolInfo: {
            symbol: 'BTCUSDT',
            status: 'TRADING',
            baseAsset: 'BTC',
            baseAssetPrecision: 8,
            quoteAsset: 'USDT',
            quotePrecision: 8,
            filterLotSize: {
              filterType: 'LOT_SIZE',
              minQty: '0.00000100',
              maxQty: '900.00000000',
              stepSize: '0.00000100'
            },
            filterPrice: {
              filterType: 'PRICE_FILTER',
              minPrice: '0.01000000',
              maxPrice: '1000000.00000000',
              tickSize: '0.01000000'
            },
            filterMinNotional: {
              filterType: 'MIN_NOTIONAL',
              minNotional: '10.00000000',
              applyToMarket: true,
              avgPriceMins: 1
            }
          },
          baseAssetBalance: {
            asset: 'BTC',
            free: '0.1000000',
            locked: '0.00000000',
            total: 0.1,
            estimatedValue: 1555.509,
            updatedAt: expect.any(Object)
          },
          quoteAssetBalance: {
            asset: 'USDT',
            free: '100.0000000',
            locked: '0.00000000'
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

    describe('with cached symbol info, no open orders and last buy price', () => {
      beforeEach(async () => {
        cache.hget = jest
          .fn()
          .mockResolvedValue(
            JSON.stringify(
              require('./fixtures/binance-cached-exchange-info.json')
            )
          );
        binance.client.exchangeInfo = jest.fn().mockResolvedValue();

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
          accountInfo: {
            balances: [
              {
                asset: 'BTC',
                free: '0.1000000',
                locked: '0.00000000'
              },
              {
                asset: 'USDT',
                free: '100.0000000',
                locked: '0.00000000'
              }
            ],
            updateTime: 1615602880892
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

      it('triggers cache.hget', () => {
        expect(cache.hget).toHaveBeenCalledWith(
          'trailing-trade-symbols',
          'BTCUSDT-symbol-info'
        );
      });

      it('does not trigger binance.client.exchangeInfo', () => {
        expect(binance.client.exchangeInfo).not.toHaveBeenCalled();
      });

      it('does not trigger cache.hset', () => {
        expect(cache.hset).not.toHaveBeenCalled();
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
          accountInfo: {
            balances: [
              {
                asset: 'BTC',
                free: '0.1000000',
                locked: '0.00000000',
                total: 0.1,
                estimatedValue: 1555.509,
                updatedAt: expect.any(Object)
              },
              { asset: 'USDT', free: '100.0000000', locked: '0.00000000' }
            ],
            updateTime: 1615602880892
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
          symbolInfo: {
            symbol: 'BTCUSDT',
            status: 'TRADING',
            baseAsset: 'BTC',
            baseAssetPrecision: 8,
            quoteAsset: 'USDT',
            quotePrecision: 8,
            filterLotSize: {
              filterType: 'LOT_SIZE',
              minQty: '0.00000100',
              maxQty: '900.00000000',
              stepSize: '0.00000100'
            },
            filterPrice: {
              filterType: 'PRICE_FILTER',
              minPrice: '0.01000000',
              maxPrice: '1000000.00000000',
              tickSize: '0.01000000'
            },
            filterMinNotional: {
              filterType: 'MIN_NOTIONAL',
              minNotional: '10.00000000',
              applyToMarket: true,
              avgPriceMins: 1
            }
          },
          baseAssetBalance: {
            asset: 'BTC',
            free: '0.1000000',
            locked: '0.00000000',
            total: 0.1,
            estimatedValue: 1555.509,
            updatedAt: expect.any(Object)
          },
          quoteAssetBalance: {
            asset: 'USDT',
            free: '100.0000000',
            locked: '0.00000000'
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

    describe('with cached symbol info, open orders and no last buy price', () => {
      beforeEach(async () => {
        cache.hget = jest
          .fn()
          .mockResolvedValue(
            JSON.stringify(
              require('./fixtures/binance-cached-exchange-info.json')
            )
          );
        binance.client.exchangeInfo = jest.fn().mockResolvedValue();

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
          accountInfo: {
            balances: [
              {
                asset: 'BTC',
                free: '0.1000000',
                locked: '0.00000000'
              },
              {
                asset: 'USDT',
                free: '100.0000000',
                locked: '0.00000000'
              }
            ],
            updateTime: 1615602880892
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
          accountInfo: {
            balances: [
              {
                asset: 'BTC',
                free: '0.1000000',
                locked: '0.00000000',
                total: 0.1,
                estimatedValue: 1555.509,
                updatedAt: expect.any(Object)
              },
              { asset: 'USDT', free: '100.0000000', locked: '0.00000000' }
            ],
            updateTime: 1615602880892
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
          symbolInfo: {
            symbol: 'BTCUSDT',
            status: 'TRADING',
            baseAsset: 'BTC',
            baseAssetPrecision: 8,
            quoteAsset: 'USDT',
            quotePrecision: 8,
            filterLotSize: {
              filterType: 'LOT_SIZE',
              minQty: '0.00000100',
              maxQty: '900.00000000',
              stepSize: '0.00000100'
            },
            filterPrice: {
              filterType: 'PRICE_FILTER',
              minPrice: '0.01000000',
              maxPrice: '1000000.00000000',
              tickSize: '0.01000000'
            },
            filterMinNotional: {
              filterType: 'MIN_NOTIONAL',
              minNotional: '10.00000000',
              applyToMarket: true,
              avgPriceMins: 1
            }
          },
          baseAssetBalance: {
            asset: 'BTC',
            free: '0.1000000',
            locked: '0.00000000',
            total: 0.1,
            estimatedValue: 1555.509,
            updatedAt: expect.any(Object)
          },
          quoteAssetBalance: {
            asset: 'USDT',
            free: '100.0000000',
            locked: '0.00000000'
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
        cache.hget = jest
          .fn()
          .mockResolvedValue(
            JSON.stringify(
              require('./fixtures/binance-cached-exchange-info.json')
            )
          );
        binance.client.exchangeInfo = jest.fn().mockResolvedValue(undefined);

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
          accountInfo: {
            balances: [
              {
                asset: 'BNB',
                free: '0.1000000',
                locked: '0.00000000'
              },
              {
                asset: 'LTC',
                free: '100.0000000',
                locked: '0.00000000'
              }
            ],
            updateTime: 1615602880892
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
          accountInfo: {
            balances: [
              {
                asset: 'BNB',
                free: '0.1000000',
                locked: '0.00000000'
              },
              { asset: 'LTC', free: '100.0000000', locked: '0.00000000' }
            ],
            updateTime: 1615602880892
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
          symbolInfo: {
            symbol: 'BTCUSDT',
            status: 'TRADING',
            baseAsset: 'BTC',
            baseAssetPrecision: 8,
            quoteAsset: 'USDT',
            quotePrecision: 8,
            filterLotSize: {
              filterType: 'LOT_SIZE',
              minQty: '0.00000100',
              maxQty: '900.00000000',
              stepSize: '0.00000100'
            },
            filterPrice: {
              filterType: 'PRICE_FILTER',
              minPrice: '0.01000000',
              maxPrice: '1000000.00000000',
              tickSize: '0.01000000'
            },
            filterMinNotional: {
              filterType: 'MIN_NOTIONAL',
              minNotional: '10.00000000',
              applyToMarket: true,
              avgPriceMins: 1
            }
          },
          baseAssetBalance: {
            asset: 'BTC',
            free: 0,
            locked: 0,
            total: 0,
            estimatedValue: 0,
            updatedAt: expect.any(Object)
          },
          quoteAssetBalance: {
            asset: 'USDT',
            free: 0,
            locked: 0
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
