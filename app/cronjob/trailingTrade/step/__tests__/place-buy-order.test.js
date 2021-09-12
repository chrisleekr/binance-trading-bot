/* eslint-disable global-require */
describe('place-buy-order.js', () => {
  let result;
  let rawData;

  let binanceMock;
  let slackMock;
  let loggerMock;

  let mockGetAndCacheOpenOrdersForSymbol;
  let mockGetAccountInfoFromAPI;
  let mockIsExceedAPILimit;
  let mockGetAPILimit;
  let mockSaveOrderStats;

  let mockSaveGridTradeOrder;

  describe('execute', () => {
    beforeEach(() => {
      jest.clearAllMocks().resetModules();
    });

    beforeEach(async () => {
      const { binance, slack, logger } = require('../../../../helpers');

      binanceMock = binance;
      slackMock = slack;
      loggerMock = logger;

      slackMock.sendMessage = jest.fn().mockResolvedValue(true);
      binanceMock.client.order = jest.fn().mockResolvedValue(true);

      mockIsExceedAPILimit = jest.fn().mockReturnValue(false);
      mockGetAPILimit = jest.fn().mockResolvedValue(10);

      mockSaveGridTradeOrder = jest.fn().mockResolvedValue(true);
      mockSaveOrderStats = jest.fn().mockResolvedValue(true);
    });

    describe('when symbol is locked', () => {
      beforeEach(async () => {
        mockGetAndCacheOpenOrdersForSymbol = jest.fn().mockResolvedValue([]);
        mockGetAccountInfoFromAPI = jest.fn().mockResolvedValue({
          account: 'info'
        });

        jest.mock('../../../trailingTradeHelper/common', () => ({
          getAndCacheOpenOrdersForSymbol: mockGetAndCacheOpenOrdersForSymbol,
          getAccountInfoFromAPI: mockGetAccountInfoFromAPI,
          isExceedAPILimit: mockIsExceedAPILimit,
          getAPILimit: mockGetAPILimit,
          saveOrderStats: mockSaveOrderStats
        }));

        jest.mock('../../../trailingTradeHelper/order', () => ({
          saveGridTradeOrder: mockSaveGridTradeOrder
        }));

        const step = require('../place-buy-order');

        rawData = {
          symbol: 'BTCUPUSDT',
          isLocked: true,
          featureToggle: {
            notifyDebug: true
          },
          symbolInfo: {
            baseAsset: 'BTCUP',
            quoteAsset: 'USDT',
            filterLotSize: { stepSize: '0.01000000' },
            filterPrice: { tickSize: '0.00100000' },
            filterMinNotional: { minNotional: '10.00000000' }
          },
          symbolConfiguration: {
            symbols: ['BTCUPUSDT', 'ETHBTC', 'ALPHABTC', 'BTCBRL', 'BNBUSDT'],
            buy: {
              enabled: true,
              currentGridTradeIndex: 0,
              currentGridTrade: {
                triggerPercentage: 1,
                minPurchaseAmount: 10,
                maxPurchaseAmount: 50,
                stopPercentage: 1.01,
                limitPercentage: 1.011,
                executed: false,
                executedOrder: null
              }
            },
            system: {
              checkOrderExecutePeriod: 10
            }
          },
          action: 'not-determined',
          quoteAssetBalance: { free: 0 },
          buy: { currentPrice: 200, openOrders: [] }
        };

        result = await step.execute(loggerMock, rawData);
      });

      it('does not trigger binance.client.order', () => {
        expect(binanceMock.client.order).not.toHaveBeenCalled();
      });

      it('does not trigger getAndCacheOpenOrdersForSymbol', () => {
        expect(mockGetAndCacheOpenOrdersForSymbol).not.toHaveBeenCalled();
      });

      it('does not trigger getAccountInfoFromAPI', () => {
        expect(mockGetAccountInfoFromAPI).not.toHaveBeenCalled();
      });

      it('does not trigger saveGridTradeOrder', () => {
        expect(mockSaveGridTradeOrder).not.toHaveBeenCalled();
      });

      it('does not trigger saveOrderStats', () => {
        expect(mockSaveOrderStats).not.toHaveBeenCalled();
      });

      it('retruns expected value', () => {
        expect(result).toStrictEqual(rawData);
      });
    });

    describe('when action is not buy', () => {
      beforeEach(async () => {
        mockGetAndCacheOpenOrdersForSymbol = jest.fn().mockResolvedValue([]);
        mockGetAccountInfoFromAPI = jest.fn().mockResolvedValue({
          account: 'info'
        });

        jest.mock('../../../trailingTradeHelper/common', () => ({
          getAndCacheOpenOrdersForSymbol: mockGetAndCacheOpenOrdersForSymbol,
          getAccountInfoFromAPI: mockGetAccountInfoFromAPI,
          isExceedAPILimit: mockIsExceedAPILimit,
          getAPILimit: mockGetAPILimit,
          saveOrderStats: mockSaveOrderStats
        }));

        jest.mock('../../../trailingTradeHelper/order', () => ({
          saveGridTradeOrder: mockSaveGridTradeOrder
        }));

        const step = require('../place-buy-order');

        rawData = {
          symbol: 'BTCUPUSDT',
          isLocked: false,
          featureToggle: {
            notifyDebug: true
          },
          symbolInfo: {
            baseAsset: 'BTCUP',
            quoteAsset: 'USDT',
            filterLotSize: { stepSize: '0.01000000' },
            filterPrice: { tickSize: '0.00100000' },
            filterMinNotional: { minNotional: '10.00000000' }
          },
          symbolConfiguration: {
            symbols: ['BTCUPUSDT', 'ETHBTC', 'ALPHABTC', 'BTCBRL', 'BNBUSDT'],
            buy: {
              enabled: true,
              currentGridTradeIndex: 0,
              currentGridTrade: {
                triggerPercentage: 1,
                minPurchaseAmount: 10,
                maxPurchaseAmount: 50,
                stopPercentage: 1.01,
                limitPercentage: 1.011,
                executed: false,
                executedOrder: null
              }
            },
            system: {
              checkOrderExecutePeriod: 10
            }
          },
          action: 'not-determined',
          quoteAssetBalance: { free: 0 },
          buy: { currentPrice: 200, openOrders: [] }
        };

        result = await step.execute(loggerMock, rawData);
      });

      it('does not trigger binance.client.order', () => {
        expect(binanceMock.client.order).not.toHaveBeenCalled();
      });

      it('does not trigger getAndCacheOpenOrdersForSymbol', () => {
        expect(mockGetAndCacheOpenOrdersForSymbol).not.toHaveBeenCalled();
      });

      it('does not trigger getAccountInfoFromAPI', () => {
        expect(mockGetAccountInfoFromAPI).not.toHaveBeenCalled();
      });

      it('does not trigger saveGridTradeOrder', () => {
        expect(mockSaveGridTradeOrder).not.toHaveBeenCalled();
      });

      it('does not trigger saveOrderStats', () => {
        expect(mockSaveOrderStats).not.toHaveBeenCalled();
      });

      it('retruns expected value', () => {
        expect(result).toStrictEqual(rawData);
      });
    });

    describe('when open orders exist', () => {
      beforeEach(async () => {
        mockGetAndCacheOpenOrdersForSymbol = jest.fn().mockResolvedValue([]);
        mockGetAccountInfoFromAPI = jest.fn().mockResolvedValue({
          account: 'info'
        });

        jest.mock('../../../trailingTradeHelper/common', () => ({
          getAndCacheOpenOrdersForSymbol: mockGetAndCacheOpenOrdersForSymbol,
          getAccountInfoFromAPI: mockGetAccountInfoFromAPI,
          isExceedAPILimit: mockIsExceedAPILimit,
          getAPILimit: mockGetAPILimit,
          saveOrderStats: mockSaveOrderStats
        }));

        jest.mock('../../../trailingTradeHelper/order', () => ({
          saveGridTradeOrder: mockSaveGridTradeOrder
        }));

        const step = require('../place-buy-order');

        rawData = {
          symbol: 'BTCUPUSDT',
          isLocked: false,
          featureToggle: {
            notifyDebug: true
          },
          symbolInfo: {
            baseAsset: 'BTCUP',
            quoteAsset: 'USDT',
            filterLotSize: { stepSize: '0.01000000' },
            filterPrice: { tickSize: '0.00100000' },
            filterMinNotional: { minNotional: '10.00000000' }
          },
          symbolConfiguration: {
            symbols: ['BTCUPUSDT', 'ETHBTC', 'ALPHABTC', 'BTCBRL', 'BNBUSDT'],
            buy: {
              enabled: true,
              currentGridTradeIndex: 0,
              currentGridTrade: {
                triggerPercentage: 1,
                minPurchaseAmount: 10,
                maxPurchaseAmount: 50,
                stopPercentage: 1.01,
                limitPercentage: 1.011,
                executed: false,
                executedOrder: null
              }
            },
            system: {
              checkOrderExecutePeriod: 10
            }
          },
          action: 'buy',
          quoteAssetBalance: { free: 0 },
          buy: {
            currentPrice: 200,
            openOrders: [
              {
                orderId: 46838,
                type: 'STOP_LOSS_LIMIT',
                side: 'BUY',
                price: '201.000000',
                origQty: '0.5',
                stopPrice: '200.000000'
              }
            ]
          }
        };

        result = await step.execute(loggerMock, rawData);
      });

      it('does not trigger binance.client.order', () => {
        expect(binanceMock.client.order).not.toHaveBeenCalled();
      });

      it('does not trigger getAndCacheOpenOrdersForSymbol', () => {
        expect(mockGetAndCacheOpenOrdersForSymbol).not.toHaveBeenCalled();
      });

      it('does not trigger getAccountInfoFromAPI', () => {
        expect(mockGetAccountInfoFromAPI).not.toHaveBeenCalled();
      });

      it('does not trigger saveGridTradeOrder', () => {
        expect(mockSaveGridTradeOrder).not.toHaveBeenCalled();
      });

      it('does not trigger saveOrderStats', () => {
        expect(mockSaveOrderStats).not.toHaveBeenCalled();
      });

      it('retruns expected value', () => {
        expect(result).toStrictEqual({
          ...rawData,
          ...{
            buy: {
              currentPrice: 200,
              openOrders: [
                {
                  orderId: 46838,
                  type: 'STOP_LOSS_LIMIT',
                  side: 'BUY',
                  price: '201.000000',
                  origQty: '0.5',
                  stopPrice: '200.000000'
                }
              ],
              processMessage:
                'There are open orders for BTCUPUSDT. Do not place an order for the grid trade #1.',
              updatedAt: expect.any(Object)
            }
          }
        });
      });
    });

    describe('when current grid trade is not defined', () => {
      beforeEach(async () => {
        mockGetAndCacheOpenOrdersForSymbol = jest.fn().mockResolvedValue([]);
        mockGetAccountInfoFromAPI = jest.fn().mockResolvedValue({
          account: 'info'
        });

        jest.mock('../../../trailingTradeHelper/common', () => ({
          getAndCacheOpenOrdersForSymbol: mockGetAndCacheOpenOrdersForSymbol,
          getAccountInfoFromAPI: mockGetAccountInfoFromAPI,
          isExceedAPILimit: mockIsExceedAPILimit,
          getAPILimit: mockGetAPILimit,
          saveOrderStats: mockSaveOrderStats
        }));

        jest.mock('../../../trailingTradeHelper/order', () => ({
          saveGridTradeOrder: mockSaveGridTradeOrder
        }));

        const step = require('../place-buy-order');

        rawData = {
          symbol: 'BTCUPUSDT',
          isLocked: false,
          featureToggle: {
            notifyDebug: true
          },
          symbolInfo: {
            baseAsset: 'BTCUP',
            quoteAsset: 'USDT',
            filterLotSize: { stepSize: '0.01000000' },
            filterPrice: { tickSize: '0.00100000' },
            filterMinNotional: { minNotional: '10.00000000' }
          },
          symbolConfiguration: {
            symbols: ['BTCUPUSDT', 'ETHBTC', 'ALPHABTC', 'BTCBRL', 'BNBUSDT'],
            buy: {
              enabled: true,
              currentGridTradeIndex: -1,
              currentGridTrade: null
            },
            system: {
              checkOrderExecutePeriod: 10
            }
          },
          action: 'buy',
          quoteAssetBalance: { free: 0 },
          buy: {
            currentPrice: 200,
            openOrders: []
          }
        };

        result = await step.execute(loggerMock, rawData);
      });

      it('does not trigger binance.client.order', () => {
        expect(binanceMock.client.order).not.toHaveBeenCalled();
      });

      it('does not trigger getAndCacheOpenOrdersForSymbol', () => {
        expect(mockGetAndCacheOpenOrdersForSymbol).not.toHaveBeenCalled();
      });

      it('does not trigger getAccountInfoFromAPI', () => {
        expect(mockGetAccountInfoFromAPI).not.toHaveBeenCalled();
      });

      it('does not trigger saveGridTradeOrder', () => {
        expect(mockSaveGridTradeOrder).not.toHaveBeenCalled();
      });

      it('does not trigger saveOrderStats', () => {
        expect(mockSaveOrderStats).not.toHaveBeenCalled();
      });

      it('retruns expected value', () => {
        expect(result).toStrictEqual({
          ...rawData,
          ...{
            buy: {
              currentPrice: 200,
              openOrders: [],
              processMessage:
                'Current grid trade is not defined. Cannot place an order.',
              updatedAt: expect.any(Object)
            }
          }
        });
      });
    });

    describe('when min purchase amount is not configured for some reason', () => {
      beforeEach(async () => {
        mockGetAndCacheOpenOrdersForSymbol = jest.fn().mockResolvedValue([]);
        mockGetAccountInfoFromAPI = jest.fn().mockResolvedValue({
          account: 'info'
        });

        jest.mock('../../../trailingTradeHelper/common', () => ({
          getAndCacheOpenOrdersForSymbol: mockGetAndCacheOpenOrdersForSymbol,
          getAccountInfoFromAPI: mockGetAccountInfoFromAPI,
          isExceedAPILimit: mockIsExceedAPILimit,
          getAPILimit: mockGetAPILimit,
          saveOrderStats: mockSaveOrderStats
        }));

        jest.mock('../../../trailingTradeHelper/order', () => ({
          saveGridTradeOrder: mockSaveGridTradeOrder
        }));

        const step = require('../place-buy-order');

        rawData = {
          symbol: 'BTCUPUSDT',
          isLocked: false,
          featureToggle: {
            notifyDebug: true
          },
          symbolInfo: {
            baseAsset: 'BTCUP',
            quoteAsset: 'USDT',
            filterLotSize: { stepSize: '0.01000000' },
            filterPrice: { tickSize: '0.00100000' },
            filterMinNotional: { minNotional: '10.00000000' }
          },
          symbolConfiguration: {
            symbols: ['BTCUPUSDT', 'ETHBTC', 'ALPHABTC', 'BTCBRL', 'BNBUSDT'],
            buy: {
              enabled: true,
              currentGridTradeIndex: 0,
              currentGridTrade: {
                triggerPercentage: 1,
                minPurchaseAmount: -1,
                maxPurchaseAmount: -1,
                stopPercentage: 1.01,
                limitPercentage: 1.011,
                executed: false,
                executedOrder: null
              }
            },
            system: {
              checkOrderExecutePeriod: 10
            }
          },
          action: 'buy',
          quoteAssetBalance: { free: 0 },
          buy: {
            currentPrice: 200,
            openOrders: []
          }
        };

        result = await step.execute(loggerMock, rawData);
      });

      it('does not trigger binance.client.order', () => {
        expect(binanceMock.client.order).not.toHaveBeenCalled();
      });

      it('does not trigger getAndCacheOpenOrdersForSymbol', () => {
        expect(mockGetAndCacheOpenOrdersForSymbol).not.toHaveBeenCalled();
      });

      it('does not trigger getAccountInfoFromAPI', () => {
        expect(mockGetAccountInfoFromAPI).not.toHaveBeenCalled();
      });

      it('does not trigger saveGridTradeOrder', () => {
        expect(mockSaveGridTradeOrder).not.toHaveBeenCalled();
      });

      it('does not trigger saveOrderStats', () => {
        expect(mockSaveOrderStats).not.toHaveBeenCalled();
      });

      it('retruns expected value', () => {
        expect(result).toStrictEqual({
          ...rawData,
          ...{
            buy: {
              currentPrice: 200,
              openOrders: [],
              processMessage:
                'Min purchase amount must be configured. Please configure symbol settings.',
              updatedAt: expect.any(Object)
            }
          }
        });
      });
    });

    describe('when max purchase amount is not configured for some reason', () => {
      beforeEach(async () => {
        mockGetAndCacheOpenOrdersForSymbol = jest.fn().mockResolvedValue([]);
        mockGetAccountInfoFromAPI = jest.fn().mockResolvedValue({
          account: 'info'
        });

        jest.mock('../../../trailingTradeHelper/common', () => ({
          getAndCacheOpenOrdersForSymbol: mockGetAndCacheOpenOrdersForSymbol,
          getAccountInfoFromAPI: mockGetAccountInfoFromAPI,
          isExceedAPILimit: mockIsExceedAPILimit,
          getAPILimit: mockGetAPILimit,
          saveOrderStats: mockSaveOrderStats
        }));

        jest.mock('../../../trailingTradeHelper/order', () => ({
          saveGridTradeOrder: mockSaveGridTradeOrder
        }));

        const step = require('../place-buy-order');

        rawData = {
          symbol: 'BTCUPUSDT',
          isLocked: false,
          featureToggle: {
            notifyDebug: true
          },
          symbolInfo: {
            baseAsset: 'BTCUP',
            quoteAsset: 'USDT',
            filterLotSize: { stepSize: '0.01000000' },
            filterPrice: { tickSize: '0.00100000' },
            filterMinNotional: { minNotional: '10.00000000' }
          },
          symbolConfiguration: {
            symbols: ['BTCUPUSDT', 'ETHBTC', 'ALPHABTC', 'BTCBRL', 'BNBUSDT'],
            buy: {
              enabled: true,
              currentGridTradeIndex: 0,
              currentGridTrade: {
                triggerPercentage: 1,
                minPurchaseAmount: 10,
                maxPurchaseAmount: -1,
                stopPercentage: 1.01,
                limitPercentage: 1.011,
                executed: false,
                executedOrder: null
              }
            },
            system: {
              checkOrderExecutePeriod: 10
            }
          },
          action: 'buy',
          quoteAssetBalance: { free: 0 },
          buy: {
            currentPrice: 200,
            openOrders: []
          }
        };

        result = await step.execute(loggerMock, rawData);
      });

      it('does not trigger binance.client.order', () => {
        expect(binanceMock.client.order).not.toHaveBeenCalled();
      });

      it('does not trigger getAndCacheOpenOrdersForSymbol', () => {
        expect(mockGetAndCacheOpenOrdersForSymbol).not.toHaveBeenCalled();
      });

      it('does not trigger getAccountInfoFromAPI', () => {
        expect(mockGetAccountInfoFromAPI).not.toHaveBeenCalled();
      });

      it('does not trigger saveGridTradeOrder', () => {
        expect(mockSaveGridTradeOrder).not.toHaveBeenCalled();
      });

      it('does not trigger saveOrderStats', () => {
        expect(mockSaveOrderStats).not.toHaveBeenCalled();
      });

      it('retruns expected value', () => {
        expect(result).toStrictEqual({
          ...rawData,
          ...{
            buy: {
              currentPrice: 200,
              openOrders: [],
              processMessage:
                'Max purchase amount must be configured. Please configure symbol settings.',
              updatedAt: expect.any(Object)
            }
          }
        });
      });
    });

    describe('when balance is less than minimum notional value', () => {
      describe('BTCUPUSDT', () => {
        beforeEach(async () => {
          mockGetAndCacheOpenOrdersForSymbol = jest.fn().mockResolvedValue([]);
          mockGetAccountInfoFromAPI = jest.fn().mockResolvedValue({
            account: 'info'
          });

          jest.mock('../../../trailingTradeHelper/common', () => ({
            getAndCacheOpenOrdersForSymbol: mockGetAndCacheOpenOrdersForSymbol,
            getAccountInfoFromAPI: mockGetAccountInfoFromAPI,
            isExceedAPILimit: mockIsExceedAPILimit,
            getAPILimit: mockGetAPILimit,
            saveOrderStats: mockSaveOrderStats
          }));

          jest.mock('../../../trailingTradeHelper/order', () => ({
            saveGridTradeOrder: mockSaveGridTradeOrder
          }));

          const step = require('../place-buy-order');

          rawData = {
            symbol: 'BTCUPUSDT',
            isLocked: false,
            featureToggle: {
              notifyDebug: true
            },
            symbolInfo: {
              baseAsset: 'BTCUP',
              quoteAsset: 'USDT',
              filterLotSize: { stepSize: '0.01000000', minQty: '0.01000000' },
              filterPrice: { tickSize: '0.00100000' },
              filterMinNotional: { minNotional: '10.00000000' }
            },
            symbolConfiguration: {
              buy: {
                enabled: true,
                currentGridTradeIndex: 0,
                currentGridTrade: {
                  triggerPercentage: 1,
                  minPurchaseAmount: 10,
                  maxPurchaseAmount: 50,
                  stopPercentage: 1.01,
                  limitPercentage: 1.011,
                  executed: false,
                  executedOrder: null
                }
              },
              system: {
                checkOrderExecutePeriod: 10
              }
            },
            action: 'buy',
            quoteAssetBalance: { free: 9 },
            buy: {
              currentPrice: 200,
              openOrders: []
            }
          };

          result = await step.execute(loggerMock, rawData);
        });

        it('does not trigger binance.client.order', () => {
          expect(binanceMock.client.order).not.toHaveBeenCalled();
        });

        it('does not trigger getAndCacheOpenOrdersForSymbol', () => {
          expect(mockGetAndCacheOpenOrdersForSymbol).not.toHaveBeenCalled();
        });

        it('does not trigger getAccountInfoFromAPI', () => {
          expect(mockGetAccountInfoFromAPI).not.toHaveBeenCalled();
        });

        it('does not trigger saveGridTradeOrder', () => {
          expect(mockSaveGridTradeOrder).not.toHaveBeenCalled();
        });

        it('does not trigger saveOrderStats', () => {
          expect(mockSaveOrderStats).not.toHaveBeenCalled();
        });

        it('retruns expected value', () => {
          expect(result).toStrictEqual({
            ...rawData,
            ...{
              buy: {
                currentPrice: 200,
                openOrders: [],
                processMessage:
                  'Do not place a buy order for the grid trade #1 as not enough USDT to buy BTCUP.',
                updatedAt: expect.any(Object)
              }
            }
          });
        });
      });

      describe('ETHBTC', () => {
        beforeEach(async () => {
          mockGetAndCacheOpenOrdersForSymbol = jest.fn().mockResolvedValue([]);
          mockGetAccountInfoFromAPI = jest.fn().mockResolvedValue({
            account: 'info'
          });

          jest.mock('../../../trailingTradeHelper/common', () => ({
            getAndCacheOpenOrdersForSymbol: mockGetAndCacheOpenOrdersForSymbol,
            getAccountInfoFromAPI: mockGetAccountInfoFromAPI,
            isExceedAPILimit: mockIsExceedAPILimit,
            getAPILimit: mockGetAPILimit,
            saveOrderStats: mockSaveOrderStats
          }));

          jest.mock('../../../trailingTradeHelper/order', () => ({
            saveGridTradeOrder: mockSaveGridTradeOrder
          }));

          const step = require('../place-buy-order');

          rawData = {
            symbol: 'ETHBTC',
            isLocked: false,
            featureToggle: {
              notifyDebug: true
            },
            symbolInfo: {
              baseAsset: 'ETH',
              quoteAsset: 'BTC',
              filterLotSize: { stepSize: '0.00100000', minQty: '0.00100000' },
              filterPrice: { tickSize: '0.00000100' },
              filterMinNotional: { minNotional: '0.00010000' }
            },
            symbolConfiguration: {
              buy: {
                enabled: true,
                currentGridTradeIndex: 0,
                currentGridTrade: {
                  triggerPercentage: 1,
                  minPurchaseAmount: 10,
                  maxPurchaseAmount: 0.001,
                  stopPercentage: 1.01,
                  limitPercentage: 1.011,
                  executed: false,
                  executedOrder: null
                }
              },
              system: {
                checkOrderExecutePeriod: 10
              }
            },
            action: 'buy',
            quoteAssetBalance: { free: 0.00009 },
            buy: {
              currentPrice: 0.044866,
              openOrders: []
            }
          };

          result = await step.execute(loggerMock, rawData);
        });

        it('does not trigger binance.client.order', () => {
          expect(binanceMock.client.order).not.toHaveBeenCalled();
        });

        it('does not trigger getAndCacheOpenOrdersForSymbol', () => {
          expect(mockGetAndCacheOpenOrdersForSymbol).not.toHaveBeenCalled();
        });

        it('does not trigger getAccountInfoFromAPI', () => {
          expect(mockGetAccountInfoFromAPI).not.toHaveBeenCalled();
        });

        it('does not trigger saveGridTradeOrder', () => {
          expect(mockSaveGridTradeOrder).not.toHaveBeenCalled();
        });

        it('does not trigger saveOrderStats', () => {
          expect(mockSaveOrderStats).not.toHaveBeenCalled();
        });

        it('retruns expected value', () => {
          expect(result).toStrictEqual({
            ...rawData,
            ...{
              buy: {
                currentPrice: 0.044866,
                openOrders: [],
                processMessage:
                  'Do not place a buy order for the grid trade #1 as not enough BTC to buy ETH.',
                updatedAt: expect.any(Object)
              }
            }
          });
        });
      });

      describe('ALPHABTC', () => {
        beforeEach(async () => {
          mockGetAndCacheOpenOrdersForSymbol = jest.fn().mockResolvedValue([]);
          mockGetAccountInfoFromAPI = jest.fn().mockResolvedValue({
            account: 'info'
          });

          jest.mock('../../../trailingTradeHelper/common', () => ({
            getAndCacheOpenOrdersForSymbol: mockGetAndCacheOpenOrdersForSymbol,
            getAccountInfoFromAPI: mockGetAccountInfoFromAPI,
            isExceedAPILimit: mockIsExceedAPILimit,
            getAPILimit: mockGetAPILimit,
            saveOrderStats: mockSaveOrderStats
          }));

          jest.mock('../../../trailingTradeHelper/order', () => ({
            saveGridTradeOrder: mockSaveGridTradeOrder
          }));

          const step = require('../place-buy-order');

          rawData = {
            symbol: 'ALPHABTC',
            isLocked: false,
            featureToggle: {
              notifyDebug: true
            },
            symbolInfo: {
              baseAsset: 'ALPHA',
              quoteAsset: 'BTC',
              filterLotSize: { stepSize: '1.00000000', minQty: '1.00000000' },
              filterPrice: { tickSize: '0.00000001' },
              filterMinNotional: { minNotional: '0.00010000' }
            },
            symbolConfiguration: {
              buy: {
                enabled: true,
                currentGridTradeIndex: 0,
                currentGridTrade: {
                  triggerPercentage: 1,
                  minPurchaseAmount: 10,
                  maxPurchaseAmount: 0.001,
                  stopPercentage: 1.01,
                  limitPercentage: 1.011,
                  executed: false,
                  executedOrder: null
                }
              },
              system: {
                checkOrderExecutePeriod: 10
              }
            },
            action: 'buy',
            quoteAssetBalance: { free: 0.00009 },
            buy: {
              currentPrice: 0.00003771,
              openOrders: []
            }
          };

          result = await step.execute(loggerMock, rawData);
        });

        it('does not trigger binance.client.order', () => {
          expect(binanceMock.client.order).not.toHaveBeenCalled();
        });

        it('does not trigger getAndCacheOpenOrdersForSymbol', () => {
          expect(mockGetAndCacheOpenOrdersForSymbol).not.toHaveBeenCalled();
        });

        it('does not trigger getAccountInfoFromAPI', () => {
          expect(mockGetAccountInfoFromAPI).not.toHaveBeenCalled();
        });

        it('does not trigger saveGridTradeOrder', () => {
          expect(mockSaveGridTradeOrder).not.toHaveBeenCalled();
        });

        it('does not trigger saveOrderStats', () => {
          expect(mockSaveOrderStats).not.toHaveBeenCalled();
        });

        it('retruns expected value', () => {
          expect(result).toStrictEqual({
            ...rawData,
            ...{
              buy: {
                currentPrice: 0.00003771,
                openOrders: [],
                processMessage:
                  'Do not place a buy order for the grid trade #1 as not enough BTC to buy ALPHA.',
                updatedAt: expect.any(Object)
              }
            }
          });
        });
      });

      describe('BTCBRL', () => {
        beforeEach(async () => {
          mockGetAndCacheOpenOrdersForSymbol = jest.fn().mockResolvedValue([]);
          mockGetAccountInfoFromAPI = jest.fn().mockResolvedValue({
            account: 'info'
          });

          jest.mock('../../../trailingTradeHelper/common', () => ({
            getAndCacheOpenOrdersForSymbol: mockGetAndCacheOpenOrdersForSymbol,
            getAccountInfoFromAPI: mockGetAccountInfoFromAPI,
            isExceedAPILimit: mockIsExceedAPILimit,
            getAPILimit: mockGetAPILimit,
            saveOrderStats: mockSaveOrderStats
          }));

          jest.mock('../../../trailingTradeHelper/order', () => ({
            saveGridTradeOrder: mockSaveGridTradeOrder
          }));

          const step = require('../place-buy-order');

          rawData = {
            symbol: 'BTCBRL',
            isLocked: false,
            featureToggle: {
              notifyDebug: true
            },
            symbolInfo: {
              baseAsset: 'BTC',
              quoteAsset: 'BRL',
              filterLotSize: { stepSize: '0.00000100', minQty: '0.00000100' },
              filterPrice: { tickSize: '1.00000000' },
              filterMinNotional: { minNotional: '10.00000000' }
            },
            symbolConfiguration: {
              buy: {
                enabled: true,
                currentGridTradeIndex: 0,
                currentGridTrade: {
                  triggerPercentage: 1,
                  minPurchaseAmount: 10,
                  maxPurchaseAmount: 50,
                  stopPercentage: 1.01,
                  limitPercentage: 1.011,
                  executed: false,
                  executedOrder: null
                }
              },
              system: {
                checkOrderExecutePeriod: 10
              }
            },
            action: 'buy',
            quoteAssetBalance: { free: 9 },
            buy: {
              currentPrice: 268748,
              openOrders: []
            }
          };

          result = await step.execute(loggerMock, rawData);
        });

        it('does not trigger binance.client.order', () => {
          expect(binanceMock.client.order).not.toHaveBeenCalled();
        });

        it('does not trigger getAndCacheOpenOrdersForSymbol', () => {
          expect(mockGetAndCacheOpenOrdersForSymbol).not.toHaveBeenCalled();
        });

        it('does not trigger getAccountInfoFromAPI', () => {
          expect(mockGetAccountInfoFromAPI).not.toHaveBeenCalled();
        });

        it('does not trigger saveGridTradeOrder', () => {
          expect(mockSaveGridTradeOrder).not.toHaveBeenCalled();
        });

        it('does not trigger saveOrderStats', () => {
          expect(mockSaveOrderStats).not.toHaveBeenCalled();
        });

        it('retruns expected value', () => {
          expect(result).toStrictEqual({
            ...rawData,
            ...{
              buy: {
                currentPrice: 268748,
                openOrders: [],
                processMessage:
                  'Do not place a buy order for the grid trade #1 as not enough BRL to buy BTC.',
                updatedAt: expect.any(Object)
              }
            }
          });
        });
      });
    });

    describe('when balance is not enough after calculation', () => {
      describe('BTCUPUSDT', () => {
        beforeEach(async () => {
          mockGetAndCacheOpenOrdersForSymbol = jest.fn().mockResolvedValue([]);
          mockGetAccountInfoFromAPI = jest.fn().mockResolvedValue({
            account: 'info'
          });

          jest.mock('../../../trailingTradeHelper/common', () => ({
            getAndCacheOpenOrdersForSymbol: mockGetAndCacheOpenOrdersForSymbol,
            getAccountInfoFromAPI: mockGetAccountInfoFromAPI,
            isExceedAPILimit: mockIsExceedAPILimit,
            getAPILimit: mockGetAPILimit,
            saveOrderStats: mockSaveOrderStats
          }));

          jest.mock('../../../trailingTradeHelper/order', () => ({
            saveGridTradeOrder: mockSaveGridTradeOrder
          }));

          const step = require('../place-buy-order');

          rawData = {
            symbol: 'BTCUPUSDT',
            isLocked: false,
            featureToggle: {
              notifyDebug: true
            },
            symbolInfo: {
              baseAsset: 'BTCUP',
              quoteAsset: 'USDT',
              filterLotSize: { stepSize: '0.01000000', minQty: '0.01000000' },
              filterPrice: { tickSize: '0.00100000' },
              filterMinNotional: { minNotional: '10.00000000' }
            },
            symbolConfiguration: {
              buy: {
                enabled: true,
                currentGridTradeIndex: 0,
                currentGridTrade: {
                  triggerPercentage: 1,
                  minPurchaseAmount: 10,
                  maxPurchaseAmount: 50,
                  stopPercentage: 1.01,
                  limitPercentage: 1.011,
                  executed: false,
                  executedOrder: null
                }
              },
              system: {
                checkOrderExecutePeriod: 10
              }
            },
            action: 'buy',
            quoteAssetBalance: { free: 10.01 },
            buy: {
              currentPrice: 200,
              openOrders: []
            }
          };

          result = await step.execute(loggerMock, rawData);
        });

        it('does not trigger binance.client.order', () => {
          expect(binanceMock.client.order).not.toHaveBeenCalled();
        });

        it('does not trigger getAndCacheOpenOrdersForSymbol', () => {
          expect(mockGetAndCacheOpenOrdersForSymbol).not.toHaveBeenCalled();
        });

        it('does not trigger getAccountInfoFromAPI', () => {
          expect(mockGetAccountInfoFromAPI).not.toHaveBeenCalled();
        });

        it('does not trigger saveGridTradeOrder', () => {
          expect(mockSaveGridTradeOrder).not.toHaveBeenCalled();
        });

        it('does not trigger saveOrderStats', () => {
          expect(mockSaveOrderStats).not.toHaveBeenCalled();
        });

        it('retruns expected value', () => {
          expect(result).toStrictEqual({
            ...rawData,
            ...{
              buy: {
                currentPrice: 200,
                openOrders: [],
                processMessage:
                  `Do not place a buy order for the grid trade #1 as not enough ` +
                  `USDT to buy BTCUP after calculating commission - ` +
                  `Order amount: 8.088 USDT, Minimum notional: 10.00000000.`,
                updatedAt: expect.any(Object)
              }
            }
          });
        });
      });

      describe('ETHBTC', () => {
        beforeEach(async () => {
          mockGetAndCacheOpenOrdersForSymbol = jest.fn().mockResolvedValue([]);
          mockGetAccountInfoFromAPI = jest.fn().mockResolvedValue({
            account: 'info'
          });

          jest.mock('../../../trailingTradeHelper/common', () => ({
            getAndCacheOpenOrdersForSymbol: mockGetAndCacheOpenOrdersForSymbol,
            getAccountInfoFromAPI: mockGetAccountInfoFromAPI,
            isExceedAPILimit: mockIsExceedAPILimit,
            getAPILimit: mockGetAPILimit,
            saveOrderStats: mockSaveOrderStats
          }));

          jest.mock('../../../trailingTradeHelper/order', () => ({
            saveGridTradeOrder: mockSaveGridTradeOrder
          }));

          const step = require('../place-buy-order');

          rawData = {
            symbol: 'ETHBTC',
            isLocked: false,
            featureToggle: {
              notifyDebug: true
            },
            symbolInfo: {
              baseAsset: 'ETH',
              quoteAsset: 'BTC',
              filterLotSize: { stepSize: '0.00100000', minQty: '0.00100000' },
              filterPrice: { tickSize: '0.00000100' },
              filterMinNotional: { minNotional: '0.00010000' }
            },
            symbolConfiguration: {
              buy: {
                enabled: true,
                currentGridTradeIndex: 0,
                currentGridTrade: {
                  triggerPercentage: 1,
                  minPurchaseAmount: 0.0001,
                  maxPurchaseAmount: 0.001,
                  stopPercentage: 1.01,
                  limitPercentage: 1.011,
                  executed: false,
                  executedOrder: null
                }
              },
              system: {
                checkOrderExecutePeriod: 10
              }
            },
            action: 'buy',
            quoteAssetBalance: { free: 0.0001 },
            buy: {
              currentPrice: 0.044866,
              openOrders: []
            }
          };

          result = await step.execute(loggerMock, rawData);
        });

        it('does not trigger binance.client.order', () => {
          expect(binanceMock.client.order).not.toHaveBeenCalled();
        });

        it('does not trigger getAndCacheOpenOrdersForSymbol', () => {
          expect(mockGetAndCacheOpenOrdersForSymbol).not.toHaveBeenCalled();
        });

        it('does not trigger getAccountInfoFromAPI', () => {
          expect(mockGetAccountInfoFromAPI).not.toHaveBeenCalled();
        });

        it('does not trigger saveGridTradeOrder', () => {
          expect(mockSaveGridTradeOrder).not.toHaveBeenCalled();
        });

        it('does not trigger saveOrderStats', () => {
          expect(mockSaveOrderStats).not.toHaveBeenCalled();
        });

        it('retruns expected value', () => {
          expect(result).toStrictEqual({
            ...rawData,
            ...{
              buy: {
                currentPrice: 0.044866,
                openOrders: [],
                processMessage:
                  `Do not place a buy order for the grid trade #1 ` +
                  `as not enough BTC to buy ETH after calculating commission - ` +
                  `Order amount: 0.00009 BTC, Minimum notional: 0.00010000.`,
                updatedAt: expect.any(Object)
              }
            }
          });
        });
      });

      describe('ALPHABTC', () => {
        beforeEach(async () => {
          mockGetAndCacheOpenOrdersForSymbol = jest.fn().mockResolvedValue([]);
          mockGetAccountInfoFromAPI = jest.fn().mockResolvedValue({
            account: 'info'
          });

          jest.mock('../../../trailingTradeHelper/common', () => ({
            getAndCacheOpenOrdersForSymbol: mockGetAndCacheOpenOrdersForSymbol,
            getAccountInfoFromAPI: mockGetAccountInfoFromAPI,
            isExceedAPILimit: mockIsExceedAPILimit,
            getAPILimit: mockGetAPILimit,
            saveOrderStats: mockSaveOrderStats
          }));

          jest.mock('../../../trailingTradeHelper/order', () => ({
            saveGridTradeOrder: mockSaveGridTradeOrder
          }));

          const step = require('../place-buy-order');

          rawData = {
            symbol: 'ALPHABTC',
            isLocked: false,
            featureToggle: {
              notifyDebug: true
            },
            symbolInfo: {
              baseAsset: 'ALPHA',
              quoteAsset: 'BTC',
              filterLotSize: { stepSize: '1.00000000', minQty: '1.00000000' },
              filterPrice: { tickSize: '0.00000001' },
              filterMinNotional: { minNotional: '0.00010000' }
            },
            symbolConfiguration: {
              buy: {
                enabled: true,
                currentGridTradeIndex: 0,
                currentGridTrade: {
                  triggerPercentage: 1,
                  minPurchaseAmount: 0.0001,
                  maxPurchaseAmount: 0.001,
                  stopPercentage: 1.01,
                  limitPercentage: 1.011,
                  executed: false,
                  executedOrder: null
                }
              },
              system: {
                checkOrderExecutePeriod: 10
              }
            },
            action: 'buy',
            quoteAssetBalance: { free: 0.0001 },
            buy: {
              currentPrice: 0.00003771,
              openOrders: []
            }
          };

          result = await step.execute(loggerMock, rawData);
        });

        it('does not trigger binance.client.order', () => {
          expect(binanceMock.client.order).not.toHaveBeenCalled();
        });

        it('does not trigger getAndCacheOpenOrdersForSymbol', () => {
          expect(mockGetAndCacheOpenOrdersForSymbol).not.toHaveBeenCalled();
        });

        it('does not trigger getAccountInfoFromAPI', () => {
          expect(mockGetAccountInfoFromAPI).not.toHaveBeenCalled();
        });

        it('does not trigger saveGridTradeOrder', () => {
          expect(mockSaveGridTradeOrder).not.toHaveBeenCalled();
        });

        it('does not trigger saveOrderStats', () => {
          expect(mockSaveOrderStats).not.toHaveBeenCalled();
        });

        it('retruns expected value', () => {
          expect(result).toStrictEqual({
            ...rawData,
            ...{
              buy: {
                currentPrice: 0.00003771,
                openOrders: [],
                processMessage:
                  `Do not place a buy order for the grid trade #1 ` +
                  `as not enough BTC to buy ALPHA after calculating commission - ` +
                  `Order amount: 0.00007624 BTC, Minimum notional: 0.00010000.`,
                updatedAt: expect.any(Object)
              }
            }
          });
        });
      });

      describe('BTCBRL', () => {
        beforeEach(async () => {
          mockGetAndCacheOpenOrdersForSymbol = jest.fn().mockResolvedValue([]);
          mockGetAccountInfoFromAPI = jest.fn().mockResolvedValue({
            account: 'info'
          });

          jest.mock('../../../trailingTradeHelper/common', () => ({
            getAndCacheOpenOrdersForSymbol: mockGetAndCacheOpenOrdersForSymbol,
            getAccountInfoFromAPI: mockGetAccountInfoFromAPI,
            isExceedAPILimit: mockIsExceedAPILimit,
            getAPILimit: mockGetAPILimit,
            saveOrderStats: mockSaveOrderStats
          }));

          jest.mock('../../../trailingTradeHelper/order', () => ({
            saveGridTradeOrder: mockSaveGridTradeOrder
          }));

          const step = require('../place-buy-order');

          rawData = {
            symbol: 'BTCBRL',
            isLocked: false,
            featureToggle: {
              notifyDebug: true
            },
            symbolInfo: {
              baseAsset: 'BTC',
              quoteAsset: 'BRL',
              filterLotSize: { stepSize: '0.00000100', minQty: '0.00000100' },
              filterPrice: { tickSize: '1.00000000' },
              filterMinNotional: { minNotional: '10.00000000' }
            },
            symbolConfiguration: {
              buy: {
                enabled: true,
                currentGridTradeIndex: 0,
                currentGridTrade: {
                  triggerPercentage: 1,
                  minPurchaseAmount: 10,
                  maxPurchaseAmount: 50,
                  stopPercentage: 1.01,
                  limitPercentage: 1.011,
                  executed: false,
                  executedOrder: null
                }
              },
              system: {
                checkOrderExecutePeriod: 10
              }
            },
            action: 'buy',
            quoteAssetBalance: { free: 10.01 },
            buy: {
              currentPrice: 268748,
              openOrders: []
            }
          };

          result = await step.execute(loggerMock, rawData);
        });

        it('does not trigger binance.client.order', () => {
          expect(binanceMock.client.order).not.toHaveBeenCalled();
        });

        it('does not trigger getAndCacheOpenOrdersForSymbol', () => {
          expect(mockGetAndCacheOpenOrdersForSymbol).not.toHaveBeenCalled();
        });

        it('does not trigger getAccountInfoFromAPI', () => {
          expect(mockGetAccountInfoFromAPI).not.toHaveBeenCalled();
        });

        it('does not trigger saveGridTradeOrder', () => {
          expect(mockSaveGridTradeOrder).not.toHaveBeenCalled();
        });

        it('does not trigger saveOrderStats', () => {
          expect(mockSaveOrderStats).not.toHaveBeenCalled();
        });

        it('retruns expected value', () => {
          expect(result).toStrictEqual({
            ...rawData,
            ...{
              buy: {
                currentPrice: 268748,
                openOrders: [],
                processMessage:
                  `Do not place a buy order for the grid trade #1 as not enough ` +
                  `BRL to buy BTC after calculating commission - Order amount: ` +
                  `9 BRL, Minimum notional: 10.00000000.`,
                updatedAt: expect.any(Object)
              }
            }
          });
        });
      });
    });

    describe('when trading is disabled', () => {
      beforeEach(async () => {
        mockGetAndCacheOpenOrdersForSymbol = jest.fn().mockResolvedValue([]);
        mockGetAccountInfoFromAPI = jest.fn().mockResolvedValue({
          account: 'info'
        });

        jest.mock('../../../trailingTradeHelper/common', () => ({
          getAndCacheOpenOrdersForSymbol: mockGetAndCacheOpenOrdersForSymbol,
          getAccountInfoFromAPI: mockGetAccountInfoFromAPI,
          isExceedAPILimit: mockIsExceedAPILimit,
          getAPILimit: mockGetAPILimit,
          saveOrderStats: mockSaveOrderStats
        }));

        jest.mock('../../../trailingTradeHelper/order', () => ({
          saveGridTradeOrder: mockSaveGridTradeOrder
        }));

        const step = require('../place-buy-order');
        rawData = {
          symbol: 'BTCUPUSDT',
          isLocked: false,
          featureToggle: {
            notifyDebug: true
          },
          symbolInfo: {
            baseAsset: 'BTCUP',
            quoteAsset: 'USDT',
            filterLotSize: { stepSize: '0.01000000', minQty: '0.01000000' },
            filterPrice: { tickSize: '0.00100000' },
            filterMinNotional: { minNotional: '10.00000000' }
          },
          symbolConfiguration: {
            symbols: ['BTCUPUSDT', 'ETHBTC', 'ALPHABTC', 'BTCBRL', 'BNBUSDT'],
            buy: {
              enabled: false,
              currentGridTradeIndex: 0,
              currentGridTrade: {
                triggerPercentage: 1,
                minPurchaseAmount: 10,
                maxPurchaseAmount: 50,
                stopPercentage: 1.01,
                limitPercentage: 1.011,
                executed: false,
                executedOrder: null
              }
            },
            system: {
              checkOrderExecutePeriod: 10
            }
          },
          action: 'buy',
          quoteAssetBalance: { free: 15 },
          buy: {
            currentPrice: 200,
            openOrders: []
          }
        };

        result = await step.execute(loggerMock, rawData);
      });

      it('does not trigger binance.client.order', () => {
        expect(binanceMock.client.order).not.toHaveBeenCalled();
      });

      it('does not trigger getAndCacheOpenOrdersForSymbol', () => {
        expect(mockGetAndCacheOpenOrdersForSymbol).not.toHaveBeenCalled();
      });

      it('does not trigger getAccountInfoFromAPI', () => {
        expect(mockGetAccountInfoFromAPI).not.toHaveBeenCalled();
      });

      it('does not trigger saveGridTradeOrder', () => {
        expect(mockSaveGridTradeOrder).not.toHaveBeenCalled();
      });

      it('does not trigger saveOrderStats', () => {
        expect(mockSaveOrderStats).not.toHaveBeenCalled();
      });

      it('retruns expected value', () => {
        expect(result).toStrictEqual({
          ...rawData,
          ...{
            buy: {
              currentPrice: 200,
              openOrders: [],
              processMessage:
                'Trading for BTCUPUSDT is disabled. Do not place an order for the grid trade #1.',
              updatedAt: expect.any(Object)
            }
          }
        });
      });
    });

    describe('when API limit is exceeded', () => {
      beforeEach(async () => {
        mockIsExceedAPILimit = jest.fn().mockReturnValue(true);

        mockGetAndCacheOpenOrdersForSymbol = jest.fn().mockResolvedValue([]);
        mockGetAccountInfoFromAPI = jest.fn().mockResolvedValue({
          account: 'info'
        });

        jest.mock('../../../trailingTradeHelper/common', () => ({
          getAndCacheOpenOrdersForSymbol: mockGetAndCacheOpenOrdersForSymbol,
          getAccountInfoFromAPI: mockGetAccountInfoFromAPI,
          isExceedAPILimit: mockIsExceedAPILimit,
          getAPILimit: mockGetAPILimit,
          saveOrderStats: mockSaveOrderStats
        }));

        jest.mock('../../../trailingTradeHelper/order', () => ({
          saveGridTradeOrder: mockSaveGridTradeOrder
        }));

        const step = require('../place-buy-order');
        rawData = {
          symbol: 'BTCUPUSDT',
          isLocked: false,
          featureToggle: {
            notifyDebug: true
          },
          symbolInfo: {
            baseAsset: 'BTCUP',
            quoteAsset: 'USDT',
            filterLotSize: { stepSize: '0.01000000', minQty: '0.01000000' },
            filterPrice: { tickSize: '0.00100000' },
            filterMinNotional: { minNotional: '10.00000000' }
          },
          symbolConfiguration: {
            symbols: ['BTCUPUSDT', 'ETHBTC', 'ALPHABTC', 'BTCBRL', 'BNBUSDT'],
            buy: {
              enabled: true,
              currentGridTradeIndex: 0,
              currentGridTrade: {
                triggerPercentage: 1,
                minPurchaseAmount: 10,
                maxPurchaseAmount: 50,
                stopPercentage: 1.01,
                limitPercentage: 1.011,
                executed: false,
                executedOrder: null
              }
            },
            system: {
              checkOrderExecutePeriod: 10
            }
          },
          action: 'buy',
          quoteAssetBalance: { free: 101 },
          buy: {
            currentPrice: 200,
            openOrders: []
          }
        };

        result = await step.execute(loggerMock, rawData);
      });

      it('does not trigger binance.client.order', () => {
        expect(binanceMock.client.order).not.toHaveBeenCalled();
      });

      it('does not trigger getAndCacheOpenOrdersForSymbol', () => {
        expect(mockGetAndCacheOpenOrdersForSymbol).not.toHaveBeenCalled();
      });

      it('does not trigger getAccountInfoFromAPI', () => {
        expect(mockGetAccountInfoFromAPI).not.toHaveBeenCalled();
      });

      it('does not trigger saveGridTradeOrder', () => {
        expect(mockSaveGridTradeOrder).not.toHaveBeenCalled();
      });

      it('does not trigger saveOrderStats', () => {
        expect(mockSaveOrderStats).not.toHaveBeenCalled();
      });

      it('retruns expected value', () => {
        expect(result).toStrictEqual({
          ...rawData,
          ...{
            buy: {
              currentPrice: 200,
              openOrders: [],
              processMessage:
                'Binance API limit has been exceeded. Do not place an order.',
              updatedAt: expect.any(Object)
            }
          }
        });
      });
    });

    describe('when has enough balance', () => {
      describe('when free balance is less than minimum purchase amount', () => {
        describe('BTCUPUSDT', () => {
          beforeEach(async () => {
            mockGetAndCacheOpenOrdersForSymbol = jest.fn().mockResolvedValue([
              {
                orderId: 123,
                price: 202.2,
                quantity: 0.05,
                side: 'buy',
                stopPrice: 202,
                symbol: 'BTCUPUSDT',
                timeInForce: 'GTC',
                type: 'STOP_LOSS_LIMIT'
              }
            ]);
            binanceMock.client.order = jest.fn().mockResolvedValue({
              symbol: 'BTCUPUSDT',
              orderId: 2701762317,
              orderListId: -1,
              clientOrderId: '6eGYHaJbmJrIS40eoq8ziM',
              transactTime: 1626946722520
            });

            mockGetAccountInfoFromAPI = jest.fn().mockResolvedValue({
              account: 'info'
            });

            jest.mock('../../../trailingTradeHelper/common', () => ({
              getAndCacheOpenOrdersForSymbol:
                mockGetAndCacheOpenOrdersForSymbol,
              getAccountInfoFromAPI: mockGetAccountInfoFromAPI,
              isExceedAPILimit: mockIsExceedAPILimit,
              getAPILimit: mockGetAPILimit,
              saveOrderStats: mockSaveOrderStats
            }));

            jest.mock('../../../trailingTradeHelper/order', () => ({
              saveGridTradeOrder: mockSaveGridTradeOrder
            }));

            const step = require('../place-buy-order');

            rawData = {
              symbol: 'BTCUPUSDT',
              isLocked: false,
              featureToggle: {
                notifyDebug: true
              },
              symbolInfo: {
                baseAsset: 'BTCUP',
                quoteAsset: 'USDT',
                filterLotSize: { stepSize: '0.01000000', minQty: '0.01000000' },
                filterPrice: { tickSize: '0.00100000' },
                filterMinNotional: { minNotional: '10.00000000' }
              },
              symbolConfiguration: {
                symbols: [
                  'BTCUPUSDT',
                  'ETHBTC',
                  'ALPHABTC',
                  'BTCBRL',
                  'BNBUSDT'
                ],
                buy: {
                  enabled: true,
                  currentGridTradeIndex: 0,
                  currentGridTrade: {
                    triggerPercentage: 1,
                    minPurchaseAmount: 15,
                    maxPurchaseAmount: 20,
                    stopPercentage: 1.01,
                    limitPercentage: 1.011,
                    executed: false,
                    executedOrder: null
                  }
                },
                system: {
                  checkOrderExecutePeriod: 10
                }
              },
              action: 'buy',
              quoteAssetBalance: { free: 12 },
              buy: {
                currentPrice: 200,
                openOrders: []
              }
            };

            result = await step.execute(loggerMock, rawData);
          });

          it('does not trigger binance.client.order', () => {
            expect(binanceMock.client.order).not.toHaveBeenCalled();
          });

          it('does not trigger saveGridTradeOrder for grid trade last buy order', () => {
            expect(mockSaveGridTradeOrder).not.toHaveBeenCalled();
          });

          it('does not trigger getAndCacheOpenOrdersForSymbol', () => {
            expect(mockGetAndCacheOpenOrdersForSymbol).not.toHaveBeenCalled();
          });

          it('does not trigger getAccountInfoFromAPI', () => {
            expect(mockGetAccountInfoFromAPI).not.toHaveBeenCalled();
          });

          it('does not trigger saveOrderStats', () => {
            expect(mockSaveOrderStats).not.toHaveBeenCalled();
          });

          it('retruns expected value', () => {
            expect(result).toStrictEqual({
              ...rawData,
              ...{
                buy: {
                  currentPrice: 200,
                  openOrders: [],
                  processMessage:
                    `Do not place a buy order for the grid trade #1 because ` +
                    `free balance is less than minimum purchase amount.`,
                  updatedAt: expect.any(Object)
                }
              }
            });
          });
        });
      });

      describe('when max purchase amount is exactly same as minimum notional value', () => {
        describe('BTCUPUSDT', () => {
          beforeEach(async () => {
            mockGetAndCacheOpenOrdersForSymbol = jest.fn().mockResolvedValue([
              {
                orderId: 123,
                price: 202.2,
                quantity: 0.05,
                side: 'buy',
                stopPrice: 202,
                symbol: 'BTCUPUSDT',
                timeInForce: 'GTC',
                type: 'STOP_LOSS_LIMIT'
              }
            ]);
            binanceMock.client.order = jest.fn().mockResolvedValue({
              symbol: 'BTCUPUSDT',
              orderId: 2701762317,
              orderListId: -1,
              clientOrderId: '6eGYHaJbmJrIS40eoq8ziM',
              transactTime: 1626946722520
            });

            mockGetAccountInfoFromAPI = jest.fn().mockResolvedValue({
              account: 'info'
            });

            jest.mock('../../../trailingTradeHelper/common', () => ({
              getAndCacheOpenOrdersForSymbol:
                mockGetAndCacheOpenOrdersForSymbol,
              getAccountInfoFromAPI: mockGetAccountInfoFromAPI,
              isExceedAPILimit: mockIsExceedAPILimit,
              getAPILimit: mockGetAPILimit,
              saveOrderStats: mockSaveOrderStats
            }));

            jest.mock('../../../trailingTradeHelper/order', () => ({
              saveGridTradeOrder: mockSaveGridTradeOrder
            }));

            const step = require('../place-buy-order');

            rawData = {
              symbol: 'BTCUPUSDT',
              isLocked: false,
              featureToggle: {
                notifyDebug: true
              },
              symbolInfo: {
                baseAsset: 'BTCUP',
                quoteAsset: 'USDT',
                filterLotSize: { stepSize: '0.01000000', minQty: '0.01000000' },
                filterPrice: { tickSize: '0.00100000' },
                filterMinNotional: { minNotional: '10.00000000' }
              },
              symbolConfiguration: {
                symbols: [
                  'BTCUPUSDT',
                  'ETHBTC',
                  'ALPHABTC',
                  'BTCBRL',
                  'BNBUSDT'
                ],
                buy: {
                  enabled: true,
                  currentGridTradeIndex: 0,
                  currentGridTrade: {
                    triggerPercentage: 1,
                    minPurchaseAmount: 10,
                    maxPurchaseAmount: 10,
                    stopPercentage: 1.01,
                    limitPercentage: 1.011,
                    executed: false,
                    executedOrder: null
                  }
                },
                system: {
                  checkOrderExecutePeriod: 10
                }
              },
              action: 'buy',
              quoteAssetBalance: { free: 50 },
              buy: {
                currentPrice: 200,
                openOrders: []
              }
            };

            result = await step.execute(loggerMock, rawData);
          });

          it('triggers binance.client.order', () => {
            expect(binanceMock.client.order).toHaveBeenCalledWith({
              price: 202.2,
              quantity: 0.05,
              side: 'buy',
              stopPrice: 202,
              symbol: 'BTCUPUSDT',
              timeInForce: 'GTC',
              type: 'STOP_LOSS_LIMIT'
            });
          });

          it('triggers saveGridTradeOrder for grid trade last buy order', () => {
            expect(mockSaveGridTradeOrder).toHaveBeenCalledWith(
              loggerMock,
              'BTCUPUSDT-grid-trade-last-buy-order',
              {
                symbol: 'BTCUPUSDT',
                orderId: 2701762317,
                orderListId: -1,
                clientOrderId: '6eGYHaJbmJrIS40eoq8ziM',
                transactTime: 1626946722520,
                currentGridTradeIndex: 0,
                nextCheck: expect.any(String)
              }
            );
          });

          it('triggers getAndCacheOpenOrdersForSymbol', () => {
            expect(mockGetAndCacheOpenOrdersForSymbol).toHaveBeenCalled();
          });

          it('triggers getAccountInfoFromAPI', () => {
            expect(mockGetAccountInfoFromAPI).toHaveBeenCalled();
          });

          it('triggers saveOrderStats', () => {
            expect(mockSaveOrderStats).toHaveBeenCalledWith(loggerMock, [
              'BTCUPUSDT',
              'ETHBTC',
              'ALPHABTC',
              'BTCBRL',
              'BNBUSDT'
            ]);
          });

          it('retruns expected value', () => {
            expect(result).toStrictEqual({
              ...rawData,
              ...{
                openOrders: [
                  {
                    orderId: 123,
                    price: 202.2,
                    quantity: 0.05,
                    side: 'buy',
                    stopPrice: 202,
                    symbol: 'BTCUPUSDT',
                    timeInForce: 'GTC',
                    type: 'STOP_LOSS_LIMIT'
                  }
                ],
                buy: {
                  currentPrice: 200,
                  openOrders: [
                    {
                      orderId: 123,
                      price: 202.2,
                      quantity: 0.05,
                      side: 'buy',
                      stopPrice: 202,
                      symbol: 'BTCUPUSDT',
                      timeInForce: 'GTC',
                      type: 'STOP_LOSS_LIMIT'
                    }
                  ],
                  processMessage:
                    'Placed new stop loss limit order for buying of grid trade #1.',
                  updatedAt: expect.any(Object)
                }
              }
            });
          });
        });

        describe('ETHBTC', () => {
          beforeEach(async () => {
            mockGetAndCacheOpenOrdersForSymbol = jest.fn().mockResolvedValue([
              {
                orderId: 456,
                price: 0.045359,
                quantity: 0.003,
                side: 'buy',
                stopPrice: 0.045314,
                symbol: 'ETHBTC',
                timeInForce: 'GTC',
                type: 'STOP_LOSS_LIMIT'
              }
            ]);
            binanceMock.client.order = jest.fn().mockResolvedValue({
              symbol: 'ETHBTC',
              orderId: 2701762317,
              orderListId: -1,
              clientOrderId: '6eGYHaJbmJrIS40eoq8ziM',
              transactTime: 1626946722520
            });

            mockGetAccountInfoFromAPI = jest.fn().mockResolvedValue({
              account: 'info'
            });

            jest.mock('../../../trailingTradeHelper/common', () => ({
              getAndCacheOpenOrdersForSymbol:
                mockGetAndCacheOpenOrdersForSymbol,
              getAccountInfoFromAPI: mockGetAccountInfoFromAPI,
              isExceedAPILimit: mockIsExceedAPILimit,
              getAPILimit: mockGetAPILimit,
              saveOrderStats: mockSaveOrderStats
            }));

            jest.mock('../../../trailingTradeHelper/order', () => ({
              saveGridTradeOrder: mockSaveGridTradeOrder
            }));

            const step = require('../place-buy-order');

            rawData = {
              symbol: 'ETHBTC',
              isLocked: false,
              featureToggle: {
                notifyDebug: true
              },
              symbolInfo: {
                baseAsset: 'ETH',
                quoteAsset: 'BTC',
                filterLotSize: { stepSize: '0.00100000', minQty: '0.00100000' },
                filterPrice: { tickSize: '0.00000100' },
                filterMinNotional: { minNotional: '0.00010000' }
              },
              symbolConfiguration: {
                symbols: [
                  'BTCUPUSDT',
                  'ETHBTC',
                  'ALPHABTC',
                  'BTCBRL',
                  'BNBUSDT'
                ],
                buy: {
                  enabled: true,
                  currentGridTradeIndex: 0,
                  currentGridTrade: {
                    triggerPercentage: 1,
                    minPurchaseAmount: 0.0001,
                    maxPurchaseAmount: 0.0001,
                    stopPercentage: 1.01,
                    limitPercentage: 1.011,
                    executed: false,
                    executedOrder: null
                  }
                },
                system: {
                  checkOrderExecutePeriod: 10
                }
              },
              action: 'buy',
              quoteAssetBalance: { free: 0.002 },
              buy: {
                currentPrice: 0.044866,
                openOrders: []
              }
            };

            result = await step.execute(loggerMock, rawData);
          });

          it('triggers binance.client.order', () => {
            expect(binanceMock.client.order).toHaveBeenCalledWith({
              price: 0.045359,
              quantity: 0.003,
              side: 'buy',
              stopPrice: 0.045314,
              symbol: 'ETHBTC',
              timeInForce: 'GTC',
              type: 'STOP_LOSS_LIMIT'
            });
          });

          it('triggers saveGridTradeOrder for grid trade last buy order', () => {
            expect(mockSaveGridTradeOrder).toHaveBeenCalledWith(
              loggerMock,
              'ETHBTC-grid-trade-last-buy-order',
              {
                symbol: 'ETHBTC',
                orderId: 2701762317,
                orderListId: -1,
                clientOrderId: '6eGYHaJbmJrIS40eoq8ziM',
                transactTime: 1626946722520,
                currentGridTradeIndex: 0,
                nextCheck: expect.any(String)
              }
            );
          });

          it('triggers getAndCacheOpenOrdersForSymbol', () => {
            expect(mockGetAndCacheOpenOrdersForSymbol).toHaveBeenCalled();
          });

          it('triggers getAccountInfoFromAPI', () => {
            expect(mockGetAccountInfoFromAPI).toHaveBeenCalled();
          });

          it('triggers saveOrderStats', () => {
            expect(mockSaveOrderStats).toHaveBeenCalledWith(loggerMock, [
              'BTCUPUSDT',
              'ETHBTC',
              'ALPHABTC',
              'BTCBRL',
              'BNBUSDT'
            ]);
          });

          it('retruns expected value', () => {
            expect(result).toStrictEqual({
              ...rawData,
              ...{
                openOrders: [
                  {
                    orderId: 456,
                    price: 0.045359,
                    quantity: 0.003,
                    side: 'buy',
                    stopPrice: 0.045314,
                    symbol: 'ETHBTC',
                    timeInForce: 'GTC',
                    type: 'STOP_LOSS_LIMIT'
                  }
                ],
                buy: {
                  currentPrice: 0.044866,
                  openOrders: [
                    {
                      orderId: 456,
                      price: 0.045359,
                      quantity: 0.003,
                      side: 'buy',
                      stopPrice: 0.045314,
                      symbol: 'ETHBTC',
                      timeInForce: 'GTC',
                      type: 'STOP_LOSS_LIMIT'
                    }
                  ],
                  processMessage:
                    'Placed new stop loss limit order for buying of grid trade #1.',
                  updatedAt: expect.any(Object)
                }
              }
            });
          });
        });

        describe('ALPHABTC', () => {
          beforeEach(async () => {
            mockGetAndCacheOpenOrdersForSymbol = jest.fn().mockResolvedValue([
              {
                orderId: 456,
                price: 0.00003812,
                quantity: 3,
                side: 'buy',
                stopPrice: 0.00003808,
                symbol: 'ALPHABTC',
                timeInForce: 'GTC',
                type: 'STOP_LOSS_LIMIT'
              }
            ]);
            binanceMock.client.order = jest.fn().mockResolvedValue({
              symbol: 'ALPHABTC',
              orderId: 2701762317,
              orderListId: -1,
              clientOrderId: '6eGYHaJbmJrIS40eoq8ziM',
              transactTime: 1626946722520
            });

            mockGetAccountInfoFromAPI = jest.fn().mockResolvedValue({
              account: 'info'
            });

            jest.mock('../../../trailingTradeHelper/common', () => ({
              getAndCacheOpenOrdersForSymbol:
                mockGetAndCacheOpenOrdersForSymbol,
              getAccountInfoFromAPI: mockGetAccountInfoFromAPI,
              isExceedAPILimit: mockIsExceedAPILimit,
              getAPILimit: mockGetAPILimit,
              saveOrderStats: mockSaveOrderStats
            }));

            jest.mock('../../../trailingTradeHelper/order', () => ({
              saveGridTradeOrder: mockSaveGridTradeOrder
            }));

            const step = require('../place-buy-order');

            rawData = {
              symbol: 'ALPHABTC',
              isLocked: false,
              featureToggle: {
                notifyDebug: true
              },
              symbolInfo: {
                baseAsset: 'ALPHA',
                quoteAsset: 'BTC',
                filterLotSize: { stepSize: '1.00000000', minQty: '1.00000000' },
                filterPrice: { tickSize: '0.00000001' },
                filterMinNotional: { minNotional: '0.00010000' }
              },
              symbolConfiguration: {
                symbols: [
                  'BTCUPUSDT',
                  'ETHBTC',
                  'ALPHABTC',
                  'BTCBRL',
                  'BNBUSDT'
                ],
                buy: {
                  enabled: true,
                  currentGridTradeIndex: 0,
                  currentGridTrade: {
                    triggerPercentage: 1,
                    minPurchaseAmount: 0.0001,
                    maxPurchaseAmount: 0.0001,
                    stopPercentage: 1.01,
                    limitPercentage: 1.011,
                    executed: false,
                    executedOrder: null
                  }
                },
                system: {
                  checkOrderExecutePeriod: 10
                }
              },
              action: 'buy',
              quoteAssetBalance: { free: 0.002 },
              buy: {
                currentPrice: 0.00003771,
                openOrders: []
              }
            };

            result = await step.execute(loggerMock, rawData);
          });

          it('triggers binance.client.order', () => {
            expect(binanceMock.client.order).toHaveBeenCalledWith({
              price: 0.00003812,
              quantity: 3,
              side: 'buy',
              stopPrice: 0.00003808,
              symbol: 'ALPHABTC',
              timeInForce: 'GTC',
              type: 'STOP_LOSS_LIMIT'
            });
          });

          it('triggers saveGridTradeOrder for grid trade last buy order', () => {
            expect(mockSaveGridTradeOrder).toHaveBeenCalledWith(
              loggerMock,
              'ALPHABTC-grid-trade-last-buy-order',
              {
                symbol: 'ALPHABTC',
                orderId: 2701762317,
                orderListId: -1,
                clientOrderId: '6eGYHaJbmJrIS40eoq8ziM',
                transactTime: 1626946722520,
                currentGridTradeIndex: 0,
                nextCheck: expect.any(String)
              }
            );
          });

          it('triggers getAndCacheOpenOrdersForSymbol', () => {
            expect(mockGetAndCacheOpenOrdersForSymbol).toHaveBeenCalled();
          });

          it('triggers getAccountInfoFromAPI', () => {
            expect(mockGetAccountInfoFromAPI).toHaveBeenCalled();
          });

          it('triggers saveOrderStats', () => {
            expect(mockSaveOrderStats).toHaveBeenCalledWith(loggerMock, [
              'BTCUPUSDT',
              'ETHBTC',
              'ALPHABTC',
              'BTCBRL',
              'BNBUSDT'
            ]);
          });

          it('retruns expected value', () => {
            expect(result).toStrictEqual({
              ...rawData,
              ...{
                openOrders: [
                  {
                    orderId: 456,
                    price: 0.00003812,
                    quantity: 3,
                    side: 'buy',
                    stopPrice: 0.00003808,
                    symbol: 'ALPHABTC',
                    timeInForce: 'GTC',
                    type: 'STOP_LOSS_LIMIT'
                  }
                ],
                buy: {
                  currentPrice: 0.00003771,
                  openOrders: [
                    {
                      orderId: 456,
                      price: 0.00003812,
                      quantity: 3,
                      side: 'buy',
                      stopPrice: 0.00003808,
                      symbol: 'ALPHABTC',
                      timeInForce: 'GTC',
                      type: 'STOP_LOSS_LIMIT'
                    }
                  ],
                  processMessage:
                    'Placed new stop loss limit order for buying of grid trade #1.',
                  updatedAt: expect.any(Object)
                }
              }
            });
          });
        });

        describe('BTCBRL', () => {
          beforeEach(async () => {
            mockGetAndCacheOpenOrdersForSymbol = jest.fn().mockResolvedValue([
              {
                orderId: 456,
                price: 271704,
                quantity: 0.000037,
                side: 'buy',
                stopPrice: 271435,
                symbol: 'BTCBRL',
                timeInForce: 'GTC',
                type: 'STOP_LOSS_LIMIT'
              }
            ]);
            binanceMock.client.order = jest.fn().mockResolvedValue({
              symbol: 'BTCBRL',
              orderId: 2701762317,
              orderListId: -1,
              clientOrderId: '6eGYHaJbmJrIS40eoq8ziM',
              transactTime: 1626946722520
            });
            mockGetAccountInfoFromAPI = jest.fn().mockResolvedValue({
              account: 'info'
            });

            jest.mock('../../../trailingTradeHelper/common', () => ({
              getAndCacheOpenOrdersForSymbol:
                mockGetAndCacheOpenOrdersForSymbol,
              getAccountInfoFromAPI: mockGetAccountInfoFromAPI,
              isExceedAPILimit: mockIsExceedAPILimit,
              getAPILimit: mockGetAPILimit,
              saveOrderStats: mockSaveOrderStats
            }));

            jest.mock('../../../trailingTradeHelper/order', () => ({
              saveGridTradeOrder: mockSaveGridTradeOrder
            }));

            const step = require('../place-buy-order');

            rawData = {
              symbol: 'BTCBRL',
              isLocked: false,
              featureToggle: {
                notifyDebug: true
              },
              symbolInfo: {
                baseAsset: 'BTC',
                quoteAsset: 'BRL',
                filterLotSize: { stepSize: '0.00000100', minQty: '0.00000100' },
                filterPrice: { tickSize: '1.00000000' },
                filterMinNotional: { minNotional: '10.00000000' }
              },
              symbolConfiguration: {
                symbols: [
                  'BTCUPUSDT',
                  'ETHBTC',
                  'ALPHABTC',
                  'BTCBRL',
                  'BNBUSDT'
                ],
                buy: {
                  enabled: true,
                  currentGridTradeIndex: 0,
                  currentGridTrade: {
                    triggerPercentage: 1,
                    minPurchaseAmount: 10,
                    maxPurchaseAmount: 10,
                    stopPercentage: 1.01,
                    limitPercentage: 1.011,
                    executed: false,
                    executedOrder: null
                  }
                },
                system: {
                  checkOrderExecutePeriod: 10
                }
              },
              action: 'buy',
              quoteAssetBalance: { free: 15 },
              buy: {
                currentPrice: 268748,
                openOrders: []
              }
            };

            result = await step.execute(loggerMock, rawData);
          });

          it('triggers binance.client.order', () => {
            expect(binanceMock.client.order).toHaveBeenCalledWith({
              price: 271704,
              quantity: 0.000037,
              side: 'buy',
              stopPrice: 271435,
              symbol: 'BTCBRL',
              timeInForce: 'GTC',
              type: 'STOP_LOSS_LIMIT'
            });
          });

          it('triggers saveGridTradeOrder for grid trade last buy order', () => {
            expect(mockSaveGridTradeOrder).toHaveBeenCalledWith(
              loggerMock,
              'BTCBRL-grid-trade-last-buy-order',
              {
                symbol: 'BTCBRL',
                orderId: 2701762317,
                orderListId: -1,
                clientOrderId: '6eGYHaJbmJrIS40eoq8ziM',
                transactTime: 1626946722520,
                currentGridTradeIndex: 0,
                nextCheck: expect.any(String)
              }
            );
          });

          it('triggers getAndCacheOpenOrdersForSymbol', () => {
            expect(mockGetAndCacheOpenOrdersForSymbol).toHaveBeenCalled();
          });

          it('triggers getAccountInfoFromAPI', () => {
            expect(mockGetAccountInfoFromAPI).toHaveBeenCalled();
          });

          it('triggers saveOrderStats', () => {
            expect(mockSaveOrderStats).toHaveBeenCalledWith(loggerMock, [
              'BTCUPUSDT',
              'ETHBTC',
              'ALPHABTC',
              'BTCBRL',
              'BNBUSDT'
            ]);
          });

          it('retruns expected value', () => {
            expect(result).toStrictEqual({
              ...rawData,
              ...{
                openOrders: [
                  {
                    orderId: 456,
                    price: 271704,
                    quantity: 0.000037,
                    side: 'buy',
                    stopPrice: 271435,
                    symbol: 'BTCBRL',
                    timeInForce: 'GTC',
                    type: 'STOP_LOSS_LIMIT'
                  }
                ],
                buy: {
                  currentPrice: 268748,
                  openOrders: [
                    {
                      orderId: 456,
                      price: 271704,
                      quantity: 0.000037,
                      side: 'buy',
                      stopPrice: 271435,
                      symbol: 'BTCBRL',
                      timeInForce: 'GTC',
                      type: 'STOP_LOSS_LIMIT'
                    }
                  ],
                  processMessage:
                    'Placed new stop loss limit order for buying of grid trade #1.',
                  updatedAt: expect.any(Object)
                }
              }
            });
          });
        });

        describe('BNBUSDT', () => {
          beforeEach(async () => {
            mockGetAndCacheOpenOrdersForSymbol = jest.fn().mockResolvedValue([
              {
                orderId: 456,
                price: 271704,
                quantity: 0.000037,
                side: 'buy',
                stopPrice: 271435,
                symbol: 'BNBUSDT',
                timeInForce: 'GTC',
                type: 'STOP_LOSS_LIMIT'
              }
            ]);
            binanceMock.client.order = jest.fn().mockResolvedValue({
              symbol: 'BNBUSDT',
              orderId: 2701762317,
              orderListId: -1,
              clientOrderId: '6eGYHaJbmJrIS40eoq8ziM',
              transactTime: 1626946722520
            });
            mockGetAccountInfoFromAPI = jest.fn().mockResolvedValue({
              account: 'info'
            });

            jest.mock('../../../trailingTradeHelper/common', () => ({
              getAndCacheOpenOrdersForSymbol:
                mockGetAndCacheOpenOrdersForSymbol,
              getAccountInfoFromAPI: mockGetAccountInfoFromAPI,
              isExceedAPILimit: mockIsExceedAPILimit,
              getAPILimit: mockGetAPILimit,
              saveOrderStats: mockSaveOrderStats
            }));

            jest.mock('../../../trailingTradeHelper/order', () => ({
              saveGridTradeOrder: mockSaveGridTradeOrder
            }));

            const step = require('../place-buy-order');

            rawData = {
              symbol: 'BNBUSDT',
              isLocked: false,
              featureToggle: {
                notifyDebug: true
              },
              symbolInfo: {
                baseAsset: 'BNB',
                quoteAsset: 'USDT',
                filterLotSize: { stepSize: '0.00010000', minQty: '0.00010000' },
                filterPrice: { tickSize: '0.01000000' },
                filterMinNotional: { minNotional: '10.00000000' }
              },
              symbolConfiguration: {
                symbols: [
                  'BTCUPUSDT',
                  'ETHBTC',
                  'ALPHABTC',
                  'BTCBRL',
                  'BNBUSDT'
                ],
                buy: {
                  enabled: true,
                  currentGridTradeIndex: 1,
                  currentGridTrade: {
                    triggerPercentage: 0.9,
                    stopPercentage: 1.025,
                    limitPercentage: 1.026,
                    minPurchaseAmount: 10,
                    maxPurchaseAmount: 10,
                    executed: false,
                    executedOrder: null
                  }
                },
                system: {
                  checkOrderExecutePeriod: 10
                }
              },
              action: 'buy',
              quoteAssetBalance: { free: 100 },
              buy: {
                currentPrice: 289.48,
                openOrders: []
              }
            };

            result = await step.execute(loggerMock, rawData);
          });

          it('triggers binance.client.order', () => {
            expect(binanceMock.client.order).toHaveBeenCalledWith({
              price: 297,
              quantity: 0.0338,
              side: 'buy',
              stopPrice: 296.71,
              symbol: 'BNBUSDT',
              timeInForce: 'GTC',
              type: 'STOP_LOSS_LIMIT'
            });
          });

          it('triggers saveGridTradeOrder for grid trade last buy order', () => {
            expect(mockSaveGridTradeOrder).toHaveBeenCalledWith(
              loggerMock,
              'BNBUSDT-grid-trade-last-buy-order',
              {
                symbol: 'BNBUSDT',
                orderId: 2701762317,
                orderListId: -1,
                clientOrderId: '6eGYHaJbmJrIS40eoq8ziM',
                transactTime: 1626946722520,
                currentGridTradeIndex: 1,
                nextCheck: expect.any(String)
              }
            );
          });

          it('triggers getAndCacheOpenOrdersForSymbol', () => {
            expect(mockGetAndCacheOpenOrdersForSymbol).toHaveBeenCalled();
          });

          it('triggers getAccountInfoFromAPI', () => {
            expect(mockGetAccountInfoFromAPI).toHaveBeenCalled();
          });

          it('triggers saveOrderStats', () => {
            expect(mockSaveOrderStats).toHaveBeenCalledWith(loggerMock, [
              'BTCUPUSDT',
              'ETHBTC',
              'ALPHABTC',
              'BTCBRL',
              'BNBUSDT'
            ]);
          });

          it('retruns expected value', () => {
            expect(result).toStrictEqual({
              ...rawData,
              ...{
                openOrders: [
                  {
                    orderId: 456,
                    price: 271704,
                    quantity: 0.000037,
                    side: 'buy',
                    stopPrice: 271435,
                    symbol: 'BNBUSDT',
                    timeInForce: 'GTC',
                    type: 'STOP_LOSS_LIMIT'
                  }
                ],
                buy: {
                  currentPrice: 289.48,
                  openOrders: [
                    {
                      orderId: 456,
                      price: 271704,
                      quantity: 0.000037,
                      side: 'buy',
                      stopPrice: 271435,
                      symbol: 'BNBUSDT',
                      timeInForce: 'GTC',
                      type: 'STOP_LOSS_LIMIT'
                    }
                  ],
                  processMessage:
                    'Placed new stop loss limit order for buying of grid trade #2.',
                  updatedAt: expect.any(Object)
                }
              }
            });
          });
        });
      });

      describe('when max purchase amount is not same as minimum notional value', () => {
        describe('BTCUPUSDT', () => {
          beforeEach(async () => {
            mockGetAndCacheOpenOrdersForSymbol = jest.fn().mockResolvedValue([
              {
                orderId: 123,
                price: 202.2,
                quantity: 0.24,
                side: 'buy',
                stopPrice: 202,
                symbol: 'BTCUPUSDT',
                timeInForce: 'GTC',
                type: 'STOP_LOSS_LIMIT'
              }
            ]);
            binanceMock.client.order = jest.fn().mockResolvedValue({
              symbol: 'BTCUPUSDT',
              orderId: 2701762317,
              orderListId: -1,
              clientOrderId: '6eGYHaJbmJrIS40eoq8ziM',
              transactTime: 1626946722520
            });

            mockGetAccountInfoFromAPI = jest.fn().mockResolvedValue({
              account: 'info'
            });

            jest.mock('../../../trailingTradeHelper/common', () => ({
              getAndCacheOpenOrdersForSymbol:
                mockGetAndCacheOpenOrdersForSymbol,
              getAccountInfoFromAPI: mockGetAccountInfoFromAPI,
              isExceedAPILimit: mockIsExceedAPILimit,
              getAPILimit: mockGetAPILimit,
              saveOrderStats: mockSaveOrderStats
            }));

            jest.mock('../../../trailingTradeHelper/order', () => ({
              saveGridTradeOrder: mockSaveGridTradeOrder
            }));

            const step = require('../place-buy-order');

            rawData = {
              symbol: 'BTCUPUSDT',
              isLocked: false,
              featureToggle: {
                notifyDebug: true
              },
              symbolInfo: {
                baseAsset: 'BTCUP',
                quoteAsset: 'USDT',
                filterLotSize: { stepSize: '0.01000000', minQty: '0.01000000' },
                filterPrice: { tickSize: '0.00100000' },
                filterMinNotional: { minNotional: '10.00000000' }
              },
              symbolConfiguration: {
                symbols: [
                  'BTCUPUSDT',
                  'ETHBTC',
                  'ALPHABTC',
                  'BTCBRL',
                  'BNBUSDT'
                ],
                buy: {
                  enabled: true,
                  currentGridTradeIndex: 0,
                  currentGridTrade: {
                    triggerPercentage: 1,
                    minPurchaseAmount: 10,
                    maxPurchaseAmount: 50,
                    stopPercentage: 1.01,
                    limitPercentage: 1.011,
                    executed: false,
                    executedOrder: null
                  }
                },
                system: {
                  checkOrderExecutePeriod: 10
                }
              },
              action: 'buy',
              quoteAssetBalance: { free: 101 },
              buy: {
                currentPrice: 200,
                openOrders: []
              }
            };

            result = await step.execute(loggerMock, rawData);
          });

          it('triggers binance.client.order', () => {
            expect(binanceMock.client.order).toHaveBeenCalledWith({
              price: 202.2,
              quantity: 0.24,
              side: 'buy',
              stopPrice: 202,
              symbol: 'BTCUPUSDT',
              timeInForce: 'GTC',
              type: 'STOP_LOSS_LIMIT'
            });
          });

          it('triggers saveGridTradeOrder for grid trade last buy order', () => {
            expect(mockSaveGridTradeOrder).toHaveBeenCalledWith(
              loggerMock,
              'BTCUPUSDT-grid-trade-last-buy-order',
              {
                symbol: 'BTCUPUSDT',
                orderId: 2701762317,
                orderListId: -1,
                clientOrderId: '6eGYHaJbmJrIS40eoq8ziM',
                transactTime: 1626946722520,
                currentGridTradeIndex: 0,
                nextCheck: expect.any(String)
              }
            );
          });

          it('triggers getAndCacheOpenOrdersForSymbol', () => {
            expect(mockGetAndCacheOpenOrdersForSymbol).toHaveBeenCalled();
          });

          it('triggers getAccountInfoFromAPI', () => {
            expect(mockGetAccountInfoFromAPI).toHaveBeenCalled();
          });

          it('triggers saveOrderStats', () => {
            expect(mockSaveOrderStats).toHaveBeenCalledWith(loggerMock, [
              'BTCUPUSDT',
              'ETHBTC',
              'ALPHABTC',
              'BTCBRL',
              'BNBUSDT'
            ]);
          });

          it('retruns expected value', () => {
            expect(result).toStrictEqual({
              ...rawData,
              ...{
                openOrders: [
                  {
                    orderId: 123,
                    price: 202.2,
                    quantity: 0.24,
                    side: 'buy',
                    stopPrice: 202,
                    symbol: 'BTCUPUSDT',
                    timeInForce: 'GTC',
                    type: 'STOP_LOSS_LIMIT'
                  }
                ],
                buy: {
                  currentPrice: 200,
                  openOrders: [
                    {
                      orderId: 123,
                      price: 202.2,
                      quantity: 0.24,
                      side: 'buy',
                      stopPrice: 202,
                      symbol: 'BTCUPUSDT',
                      timeInForce: 'GTC',
                      type: 'STOP_LOSS_LIMIT'
                    }
                  ],
                  processMessage:
                    'Placed new stop loss limit order for buying of grid trade #1.',
                  updatedAt: expect.any(Object)
                }
              }
            });
          });
        });

        describe('ETHBTC', () => {
          beforeEach(async () => {
            mockGetAndCacheOpenOrdersForSymbol = jest.fn().mockResolvedValue([
              {
                orderId: 456,
                price: 0.045359,
                quantity: 0.022,
                side: 'buy',
                stopPrice: 0.045314,
                symbol: 'ETHBTC',
                timeInForce: 'GTC',
                type: 'STOP_LOSS_LIMIT'
              }
            ]);
            binanceMock.client.order = jest.fn().mockResolvedValue({
              symbol: 'ETHBTC',
              orderId: 2701762317,
              orderListId: -1,
              clientOrderId: '6eGYHaJbmJrIS40eoq8ziM',
              transactTime: 1626946722520
            });

            mockGetAccountInfoFromAPI = jest.fn().mockResolvedValue({
              account: 'info'
            });

            jest.mock('../../../trailingTradeHelper/common', () => ({
              getAndCacheOpenOrdersForSymbol:
                mockGetAndCacheOpenOrdersForSymbol,
              getAccountInfoFromAPI: mockGetAccountInfoFromAPI,
              isExceedAPILimit: mockIsExceedAPILimit,
              getAPILimit: mockGetAPILimit,
              saveOrderStats: mockSaveOrderStats
            }));

            jest.mock('../../../trailingTradeHelper/order', () => ({
              saveGridTradeOrder: mockSaveGridTradeOrder
            }));

            const step = require('../place-buy-order');

            rawData = {
              symbol: 'ETHBTC',
              isLocked: false,
              featureToggle: {
                notifyDebug: true
              },
              symbolInfo: {
                baseAsset: 'ETH',
                quoteAsset: 'BTC',
                filterLotSize: { stepSize: '0.00100000', minQty: '0.00100000' },
                filterPrice: { tickSize: '0.00000100' },
                filterMinNotional: { minNotional: '0.00010000' }
              },
              symbolConfiguration: {
                symbols: [
                  'BTCUPUSDT',
                  'ETHBTC',
                  'ALPHABTC',
                  'BTCBRL',
                  'BNBUSDT'
                ],
                buy: {
                  enabled: true,
                  currentGridTradeIndex: 0,
                  currentGridTrade: {
                    triggerPercentage: 1,
                    minPurchaseAmount: 0.0001,
                    maxPurchaseAmount: 0.001,
                    stopPercentage: 1.01,
                    limitPercentage: 1.011,
                    executed: false,
                    executedOrder: null
                  }
                },
                system: {
                  checkOrderExecutePeriod: 10
                }
              },
              action: 'buy',
              quoteAssetBalance: { free: 0.002 },
              buy: {
                currentPrice: 0.044866,
                openOrders: []
              }
            };

            result = await step.execute(loggerMock, rawData);
          });

          it('triggers binance.client.order', () => {
            expect(binanceMock.client.order).toHaveBeenCalledWith({
              price: 0.045359,
              quantity: 0.022,
              side: 'buy',
              stopPrice: 0.045314,
              symbol: 'ETHBTC',
              timeInForce: 'GTC',
              type: 'STOP_LOSS_LIMIT'
            });
          });

          it('triggers saveGridTradeOrder for grid trade last buy order', () => {
            expect(mockSaveGridTradeOrder).toHaveBeenCalledWith(
              loggerMock,
              'ETHBTC-grid-trade-last-buy-order',
              {
                symbol: 'ETHBTC',
                orderId: 2701762317,
                orderListId: -1,
                clientOrderId: '6eGYHaJbmJrIS40eoq8ziM',
                transactTime: 1626946722520,
                currentGridTradeIndex: 0,
                nextCheck: expect.any(String)
              }
            );
          });

          it('triggers getAndCacheOpenOrdersForSymbol', () => {
            expect(mockGetAndCacheOpenOrdersForSymbol).toHaveBeenCalled();
          });

          it('triggers getAccountInfoFromAPI', () => {
            expect(mockGetAccountInfoFromAPI).toHaveBeenCalled();
          });

          it('triggers saveOrderStats', () => {
            expect(mockSaveOrderStats).toHaveBeenCalledWith(loggerMock, [
              'BTCUPUSDT',
              'ETHBTC',
              'ALPHABTC',
              'BTCBRL',
              'BNBUSDT'
            ]);
          });

          it('retruns expected value', () => {
            expect(result).toStrictEqual({
              ...rawData,
              ...{
                openOrders: [
                  {
                    orderId: 456,
                    price: 0.045359,
                    quantity: 0.022,
                    side: 'buy',
                    stopPrice: 0.045314,
                    symbol: 'ETHBTC',
                    timeInForce: 'GTC',
                    type: 'STOP_LOSS_LIMIT'
                  }
                ],
                buy: {
                  currentPrice: 0.044866,
                  openOrders: [
                    {
                      orderId: 456,
                      price: 0.045359,
                      quantity: 0.022,
                      side: 'buy',
                      stopPrice: 0.045314,
                      symbol: 'ETHBTC',
                      timeInForce: 'GTC',
                      type: 'STOP_LOSS_LIMIT'
                    }
                  ],
                  processMessage:
                    'Placed new stop loss limit order for buying of grid trade #1.',
                  updatedAt: expect.any(Object)
                }
              }
            });
          });
        });

        describe('ALPHABTC', () => {
          beforeEach(async () => {
            mockGetAndCacheOpenOrdersForSymbol = jest.fn().mockResolvedValue([
              {
                orderId: 456,
                price: 0.00003812,
                quantity: 26,
                side: 'buy',
                stopPrice: 0.00003808,
                symbol: 'ALPHABTC',
                timeInForce: 'GTC',
                type: 'STOP_LOSS_LIMIT'
              }
            ]);
            binanceMock.client.order = jest.fn().mockResolvedValue({
              symbol: 'ALPHABTC',
              orderId: 2701762317,
              orderListId: -1,
              clientOrderId: '6eGYHaJbmJrIS40eoq8ziM',
              transactTime: 1626946722520
            });

            mockGetAccountInfoFromAPI = jest.fn().mockResolvedValue({
              account: 'info'
            });

            jest.mock('../../../trailingTradeHelper/common', () => ({
              getAndCacheOpenOrdersForSymbol:
                mockGetAndCacheOpenOrdersForSymbol,
              getAccountInfoFromAPI: mockGetAccountInfoFromAPI,
              isExceedAPILimit: mockIsExceedAPILimit,
              getAPILimit: mockGetAPILimit,
              saveOrderStats: mockSaveOrderStats
            }));

            jest.mock('../../../trailingTradeHelper/order', () => ({
              saveGridTradeOrder: mockSaveGridTradeOrder
            }));

            const step = require('../place-buy-order');

            rawData = {
              symbol: 'ALPHABTC',
              isLocked: false,
              featureToggle: {
                notifyDebug: false
              },
              symbolInfo: {
                baseAsset: 'ALPHA',
                quoteAsset: 'BTC',
                filterLotSize: { stepSize: '1.00000000', minQty: '1.00000000' },
                filterPrice: { tickSize: '0.00000001' },
                filterMinNotional: { minNotional: '0.00010000' }
              },
              symbolConfiguration: {
                symbols: [
                  'BTCUPUSDT',
                  'ETHBTC',
                  'ALPHABTC',
                  'BTCBRL',
                  'BNBUSDT'
                ],
                buy: {
                  enabled: true,
                  currentGridTradeIndex: 0,
                  currentGridTrade: {
                    triggerPercentage: 1,
                    minPurchaseAmount: 0.0001,
                    maxPurchaseAmount: 0.001,
                    stopPercentage: 1.01,
                    limitPercentage: 1.011,
                    executed: false,
                    executedOrder: null
                  }
                },
                system: {
                  checkOrderExecutePeriod: 10
                }
              },
              action: 'buy',
              quoteAssetBalance: { free: 0.002 },
              buy: {
                currentPrice: 0.00003771,
                openOrders: []
              }
            };

            result = await step.execute(loggerMock, rawData);
          });

          it('triggers binance.client.order', () => {
            expect(binanceMock.client.order).toHaveBeenCalledWith({
              price: 0.00003812,
              quantity: 26,
              side: 'buy',
              stopPrice: 0.00003808,
              symbol: 'ALPHABTC',
              timeInForce: 'GTC',
              type: 'STOP_LOSS_LIMIT'
            });
          });

          it('triggers saveGridTradeOrder for grid trade last buy order', () => {
            expect(mockSaveGridTradeOrder).toHaveBeenCalledWith(
              loggerMock,
              'ALPHABTC-grid-trade-last-buy-order',
              {
                symbol: 'ALPHABTC',
                orderId: 2701762317,
                orderListId: -1,
                clientOrderId: '6eGYHaJbmJrIS40eoq8ziM',
                transactTime: 1626946722520,
                currentGridTradeIndex: 0,
                nextCheck: expect.any(String)
              }
            );
          });

          it('triggers getAndCacheOpenOrdersForSymbol', () => {
            expect(mockGetAndCacheOpenOrdersForSymbol).toHaveBeenCalled();
          });

          it('triggers getAccountInfoFromAPI', () => {
            expect(mockGetAccountInfoFromAPI).toHaveBeenCalled();
          });

          it('triggers saveOrderStats', () => {
            expect(mockSaveOrderStats).toHaveBeenCalledWith(loggerMock, [
              'BTCUPUSDT',
              'ETHBTC',
              'ALPHABTC',
              'BTCBRL',
              'BNBUSDT'
            ]);
          });

          it('retruns expected value', () => {
            expect(result).toStrictEqual({
              ...rawData,
              ...{
                openOrders: [
                  {
                    orderId: 456,
                    price: 0.00003812,
                    quantity: 26,
                    side: 'buy',
                    stopPrice: 0.00003808,
                    symbol: 'ALPHABTC',
                    timeInForce: 'GTC',
                    type: 'STOP_LOSS_LIMIT'
                  }
                ],
                buy: {
                  currentPrice: 0.00003771,
                  openOrders: [
                    {
                      orderId: 456,
                      price: 0.00003812,
                      quantity: 26,
                      side: 'buy',
                      stopPrice: 0.00003808,
                      symbol: 'ALPHABTC',
                      timeInForce: 'GTC',
                      type: 'STOP_LOSS_LIMIT'
                    }
                  ],
                  processMessage:
                    'Placed new stop loss limit order for buying of grid trade #1.',
                  updatedAt: expect.any(Object)
                }
              }
            });
          });
        });

        describe('BTCBRL', () => {
          beforeEach(async () => {
            mockGetAndCacheOpenOrdersForSymbol = jest.fn().mockResolvedValue([
              {
                orderId: 456,
                price: 271704,
                quantity: 0.00004,
                side: 'buy',
                stopPrice: 271435,
                symbol: 'BTCBRL',
                timeInForce: 'GTC',
                type: 'STOP_LOSS_LIMIT'
              }
            ]);
            binanceMock.client.order = jest.fn().mockResolvedValue({
              symbol: 'BTCBRL',
              orderId: 2701762317,
              orderListId: -1,
              clientOrderId: '6eGYHaJbmJrIS40eoq8ziM',
              transactTime: 1626946722520
            });
            mockGetAccountInfoFromAPI = jest.fn().mockResolvedValue({
              account: 'info'
            });

            jest.mock('../../../trailingTradeHelper/common', () => ({
              getAndCacheOpenOrdersForSymbol:
                mockGetAndCacheOpenOrdersForSymbol,
              getAccountInfoFromAPI: mockGetAccountInfoFromAPI,
              isExceedAPILimit: mockIsExceedAPILimit,
              getAPILimit: mockGetAPILimit,
              saveOrderStats: mockSaveOrderStats
            }));

            jest.mock('../../../trailingTradeHelper/order', () => ({
              saveGridTradeOrder: mockSaveGridTradeOrder
            }));

            const step = require('../place-buy-order');

            rawData = {
              symbol: 'BTCBRL',
              isLocked: false,
              featureToggle: {
                notifyDebug: false
              },
              symbolInfo: {
                baseAsset: 'BTC',
                quoteAsset: 'BRL',
                filterLotSize: { stepSize: '0.00000100', minQty: '0.00000100' },
                filterPrice: { tickSize: '1.00000000' },
                filterMinNotional: { minNotional: '10.00000000' }
              },
              symbolConfiguration: {
                symbols: [
                  'BTCUPUSDT',
                  'ETHBTC',
                  'ALPHABTC',
                  'BTCBRL',
                  'BNBUSDT'
                ],
                buy: {
                  enabled: true,
                  currentGridTradeIndex: 0,
                  currentGridTrade: {
                    triggerPercentage: 1,
                    minPurchaseAmount: 10,
                    maxPurchaseAmount: 100,
                    stopPercentage: 1.01,
                    limitPercentage: 1.011,
                    executed: false,
                    executedOrder: null
                  }
                },
                system: {
                  checkOrderExecutePeriod: 10
                }
              },
              action: 'buy',
              quoteAssetBalance: { free: 11 },
              buy: {
                currentPrice: 268748,
                openOrders: []
              }
            };

            result = await step.execute(loggerMock, rawData);
          });

          it('triggers binance.client.order', () => {
            expect(binanceMock.client.order).toHaveBeenCalledWith({
              price: 271704,
              quantity: 0.00004,
              side: 'buy',
              stopPrice: 271435,
              symbol: 'BTCBRL',
              timeInForce: 'GTC',
              type: 'STOP_LOSS_LIMIT'
            });
          });

          it('triggers saveGridTradeOrder for grid trade last buy order', () => {
            expect(mockSaveGridTradeOrder).toHaveBeenCalledWith(
              loggerMock,
              'BTCBRL-grid-trade-last-buy-order',
              {
                symbol: 'BTCBRL',
                orderId: 2701762317,
                orderListId: -1,
                clientOrderId: '6eGYHaJbmJrIS40eoq8ziM',
                transactTime: 1626946722520,
                currentGridTradeIndex: 0,
                nextCheck: expect.any(String)
              }
            );
          });

          it('triggers getAndCacheOpenOrdersForSymbol', () => {
            expect(mockGetAndCacheOpenOrdersForSymbol).toHaveBeenCalled();
          });

          it('triggers getAccountInfoFromAPI', () => {
            expect(mockGetAccountInfoFromAPI).toHaveBeenCalled();
          });

          it('triggers saveOrderStats', () => {
            expect(mockSaveOrderStats).toHaveBeenCalledWith(loggerMock, [
              'BTCUPUSDT',
              'ETHBTC',
              'ALPHABTC',
              'BTCBRL',
              'BNBUSDT'
            ]);
          });

          it('retruns expected value', () => {
            expect(result).toStrictEqual({
              ...rawData,
              ...{
                openOrders: [
                  {
                    orderId: 456,
                    price: 271704,
                    quantity: 0.00004,
                    side: 'buy',
                    stopPrice: 271435,
                    symbol: 'BTCBRL',
                    timeInForce: 'GTC',
                    type: 'STOP_LOSS_LIMIT'
                  }
                ],
                buy: {
                  currentPrice: 268748,
                  openOrders: [
                    {
                      orderId: 456,
                      price: 271704,
                      quantity: 0.00004,
                      side: 'buy',
                      stopPrice: 271435,
                      symbol: 'BTCBRL',
                      timeInForce: 'GTC',
                      type: 'STOP_LOSS_LIMIT'
                    }
                  ],
                  processMessage:
                    'Placed new stop loss limit order for buying of grid trade #1.',
                  updatedAt: expect.any(Object)
                }
              }
            });
          });
        });
      });
    });
  });
});
