/* eslint-disable global-require */
describe('place-buy-order.js', () => {
  let result;
  let rawData;

  let binanceMock;
  let slackMock;
  let loggerMock;
  let mongoMock;

  let mockRefreshOpenOrdersWithSymbol;
  let mockGetAccountInfoFromAPI;

  describe('execute', () => {
    beforeEach(() => {
      jest.clearAllMocks().resetModules();
    });

    beforeEach(async () => {
      const { binance, slack, logger, mongo } = require('../../../../helpers');
      binanceMock = binance;
      slackMock = slack;
      loggerMock = logger;
      mongoMock = mongo;

      slackMock.sendMessage = jest.fn().mockResolvedValue(true);
      binanceMock.client.order = jest.fn().mockResolvedValue(true);
      mongoMock.upsertOne = jest.fn().mockResolvedValue(true);
    });

    describe('when symbol is locked', () => {
      beforeEach(async () => {
        mockRefreshOpenOrdersWithSymbol = jest.fn().mockResolvedValue([]);
        mockGetAccountInfoFromAPI = jest.fn().mockResolvedValue({
          account: 'info'
        });

        jest.mock('../../../trailingTradeHelper/common', () => ({
          refreshOpenOrdersWithSymbol: mockRefreshOpenOrdersWithSymbol,
          getAccountInfoFromAPI: mockGetAccountInfoFromAPI
        }));

        const step = require('../place-buy-order');

        rawData = {
          symbol: 'BTCUPUSDT',
          isLocked: true,
          symbolInfo: {
            baseAsset: 'BTCUP',
            quoteAsset: 'USDT',
            filterLotSize: { stepSize: '0.01000000' },
            filterPrice: { tickSize: '0.00100000' },
            filterMinNotional: { minNotional: '10.00000000' }
          },
          symbolConfiguration: {
            buy: {
              enabled: true,
              maxPurchaseAmount: 50,
              stopPercentage: 1.01,
              limitPercentage: 1.011
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

      it('does not trigger refreshOpenOrdersWithSymbol', () => {
        expect(mockRefreshOpenOrdersWithSymbol).not.toHaveBeenCalled();
      });

      it('does not trigger getAccountInfoFromAPI', () => {
        expect(mockGetAccountInfoFromAPI).not.toHaveBeenCalled();
      });

      it('retruns expected value', () => {
        expect(result).toStrictEqual(rawData);
      });
    });

    describe('when action is not buy', () => {
      beforeEach(async () => {
        mockRefreshOpenOrdersWithSymbol = jest.fn().mockResolvedValue([]);
        mockGetAccountInfoFromAPI = jest.fn().mockResolvedValue({
          account: 'info'
        });

        jest.mock('../../../trailingTradeHelper/common', () => ({
          refreshOpenOrdersWithSymbol: mockRefreshOpenOrdersWithSymbol,
          getAccountInfoFromAPI: mockGetAccountInfoFromAPI
        }));

        const step = require('../place-buy-order');

        rawData = {
          symbol: 'BTCUPUSDT',
          isLocked: false,
          symbolInfo: {
            baseAsset: 'BTCUP',
            quoteAsset: 'USDT',
            filterLotSize: { stepSize: '0.01000000' },
            filterPrice: { tickSize: '0.00100000' },
            filterMinNotional: { minNotional: '10.00000000' }
          },
          symbolConfiguration: {
            buy: {
              enabled: true,
              maxPurchaseAmount: 50,
              stopPercentage: 1.01,
              limitPercentage: 1.011
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

      it('does not trigger refreshOpenOrdersWithSymbol', () => {
        expect(mockRefreshOpenOrdersWithSymbol).not.toHaveBeenCalled();
      });

      it('does not trigger getAccountInfoFromAPI', () => {
        expect(mockGetAccountInfoFromAPI).not.toHaveBeenCalled();
      });

      it('retruns expected value', () => {
        expect(result).toStrictEqual(rawData);
      });
    });

    describe('when open orders exist', () => {
      beforeEach(async () => {
        mockRefreshOpenOrdersWithSymbol = jest.fn().mockResolvedValue([]);
        mockGetAccountInfoFromAPI = jest.fn().mockResolvedValue({
          account: 'info'
        });

        jest.mock('../../../trailingTradeHelper/common', () => ({
          refreshOpenOrdersWithSymbol: mockRefreshOpenOrdersWithSymbol,
          getAccountInfoFromAPI: mockGetAccountInfoFromAPI
        }));

        const step = require('../place-buy-order');

        rawData = {
          symbol: 'BTCUPUSDT',
          isLocked: false,
          symbolInfo: {
            baseAsset: 'BTCUP',
            quoteAsset: 'USDT',
            filterLotSize: { stepSize: '0.01000000' },
            filterPrice: { tickSize: '0.00100000' },
            filterMinNotional: { minNotional: '10.00000000' }
          },
          symbolConfiguration: {
            buy: {
              enabled: true,
              maxPurchaseAmount: 50,
              stopPercentage: 1.01,
              limitPercentage: 1.011
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

      it('does not trigger refreshOpenOrdersWithSymbol', () => {
        expect(mockRefreshOpenOrdersWithSymbol).not.toHaveBeenCalled();
      });

      it('does not trigger getAccountInfoFromAPI', () => {
        expect(mockGetAccountInfoFromAPI).not.toHaveBeenCalled();
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
                'There are open orders for BTCUPUSDT. Do not place an order.',
              updatedAt: expect.any(Object)
            }
          }
        });
      });
    });

    describe('when balance is less than minimum notional value', () => {
      beforeEach(async () => {
        mockRefreshOpenOrdersWithSymbol = jest.fn().mockResolvedValue([]);
        mockGetAccountInfoFromAPI = jest.fn().mockResolvedValue({
          account: 'info'
        });

        jest.mock('../../../trailingTradeHelper/common', () => ({
          refreshOpenOrdersWithSymbol: mockRefreshOpenOrdersWithSymbol,
          getAccountInfoFromAPI: mockGetAccountInfoFromAPI
        }));

        const step = require('../place-buy-order');

        rawData = {
          symbol: 'BTCUPUSDT',
          isLocked: false,
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
              maxPurchaseAmount: 50,
              stopPercentage: 1.01,
              limitPercentage: 1.011
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

      it('does not trigger refreshOpenOrdersWithSymbol', () => {
        expect(mockRefreshOpenOrdersWithSymbol).not.toHaveBeenCalled();
      });

      it('does not trigger getAccountInfoFromAPI', () => {
        expect(mockGetAccountInfoFromAPI).not.toHaveBeenCalled();
      });

      it('retruns expected value', () => {
        expect(result).toStrictEqual({
          ...rawData,
          ...{
            buy: {
              currentPrice: 200,
              openOrders: [],
              processMessage:
                'Do not place a buy order as not enough USDT to buy BTCUP.',
              updatedAt: expect.any(Object)
            }
          }
        });
      });
    });

    describe('when balance is not enough after calculation', () => {
      beforeEach(async () => {
        mockRefreshOpenOrdersWithSymbol = jest.fn().mockResolvedValue([]);
        mockGetAccountInfoFromAPI = jest.fn().mockResolvedValue({
          account: 'info'
        });

        jest.mock('../../../trailingTradeHelper/common', () => ({
          refreshOpenOrdersWithSymbol: mockRefreshOpenOrdersWithSymbol,
          getAccountInfoFromAPI: mockGetAccountInfoFromAPI
        }));

        const step = require('../place-buy-order');

        rawData = {
          symbol: 'BTCUPUSDT',
          isLocked: false,
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
              maxPurchaseAmount: 50,
              stopPercentage: 1.01,
              limitPercentage: 1.011
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

      it('does not trigger refreshOpenOrdersWithSymbol', () => {
        expect(mockRefreshOpenOrdersWithSymbol).not.toHaveBeenCalled();
      });

      it('does not trigger getAccountInfoFromAPI', () => {
        expect(mockGetAccountInfoFromAPI).not.toHaveBeenCalled();
      });

      it('retruns expected value', () => {
        expect(result).toStrictEqual({
          ...rawData,
          ...{
            buy: {
              currentPrice: 200,
              openOrders: [],
              processMessage:
                'Do not place a buy order as not enough USDT to buy BTCUP after calculation.',
              updatedAt: expect.any(Object)
            }
          }
        });
      });
    });

    describe('when trading is disabled', () => {
      beforeEach(async () => {
        mockRefreshOpenOrdersWithSymbol = jest.fn().mockResolvedValue([]);
        mockGetAccountInfoFromAPI = jest.fn().mockResolvedValue({
          account: 'info'
        });

        jest.mock('../../../trailingTradeHelper/common', () => ({
          refreshOpenOrdersWithSymbol: mockRefreshOpenOrdersWithSymbol,
          getAccountInfoFromAPI: mockGetAccountInfoFromAPI
        }));

        const step = require('../place-buy-order');
        rawData = {
          symbol: 'BTCUPUSDT',
          isLocked: false,
          symbolInfo: {
            baseAsset: 'BTCUP',
            quoteAsset: 'USDT',
            filterLotSize: { stepSize: '0.01000000', minQty: '0.01000000' },
            filterPrice: { tickSize: '0.00100000' },
            filterMinNotional: { minNotional: '10.00000000' }
          },
          symbolConfiguration: {
            buy: {
              enabled: false,
              maxPurchaseAmount: 50,
              stopPercentage: 1.01,
              limitPercentage: 1.011
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

      it('does not trigger refreshOpenOrdersWithSymbol', () => {
        expect(mockRefreshOpenOrdersWithSymbol).not.toHaveBeenCalled();
      });

      it('does not trigger getAccountInfoFromAPI', () => {
        expect(mockGetAccountInfoFromAPI).not.toHaveBeenCalled();
      });

      it('retruns expected value', () => {
        expect(result).toStrictEqual({
          ...rawData,
          ...{
            buy: {
              currentPrice: 200,
              openOrders: [],
              processMessage:
                'Trading for BTCUPUSDT is disabled. Do not place an order.',
              updatedAt: expect.any(Object)
            }
          }
        });
      });
    });

    describe('when has enough balance', () => {
      beforeEach(async () => {
        mockRefreshOpenOrdersWithSymbol = jest.fn().mockResolvedValue([
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
        mockGetAccountInfoFromAPI = jest.fn().mockResolvedValue({
          account: 'info'
        });

        jest.mock('../../../trailingTradeHelper/common', () => ({
          refreshOpenOrdersWithSymbol: mockRefreshOpenOrdersWithSymbol,
          getAccountInfoFromAPI: mockGetAccountInfoFromAPI
        }));

        const step = require('../place-buy-order');

        rawData = {
          symbol: 'BTCUPUSDT',
          isLocked: false,
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
              maxPurchaseAmount: 50,
              stopPercentage: 1.01,
              limitPercentage: 1.011
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

      it('triggers refreshOpenOrdersWithSymbol', () => {
        expect(mockRefreshOpenOrdersWithSymbol).toHaveBeenCalled();
      });

      it('triggers getAccountInfoFromAPI', () => {
        expect(mockGetAccountInfoFromAPI).toHaveBeenCalled();
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
              processMessage: 'Placed new stop loss limit order for buying.',
              updatedAt: expect.any(Object)
            }
          }
        });
      });
    });
  });
});
