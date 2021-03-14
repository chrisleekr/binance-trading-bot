const { binance, slack, logger, mongo } = require('../../../../helpers');

const step = require('../place-buy-order');

describe('place-buy-order.js', () => {
  let result;
  let rawData;

  describe('execute', () => {
    beforeEach(async () => {
      slack.sendMessage = jest.fn().mockResolvedValue(true);
      binance.client.order = jest.fn().mockResolvedValue(true);
      mongo.upsertOne = jest.fn().mockResolvedValue(true);
    });

    describe('when action is not buy', () => {
      beforeEach(async () => {
        rawData = {
          symbol: 'BTCUPUSDT',
          symbolInfo: {
            baseAsset: 'BTCUP',
            quoteAsset: 'USDT',
            filterLotSize: { stepSize: '0.01000000', minQty: '0.01000000' },
            filterPrice: { tickSize: '0.00100000' },
            filterMinNotional: { minNotional: '10.00000000' }
          },
          symbolConfiguration: {
            buy: {
              enabed: true,
              maxPurchaseAmount: 50,
              stopPercentage: 1.01,
              limitPercentage: 1.011
            }
          },
          action: 'not-determined',
          quoteAssetBalance: { free: 0 },
          buy: { currentPrice: 200, openOrders: [] }
        };

        result = await step.execute(logger, rawData);
      });

      it('does not trigger binance.client.order', () => {
        expect(binance.client.order).not.toHaveBeenCalled();
      });

      it('retruns expected value', () => {
        expect(result).toStrictEqual(rawData);
      });
    });

    describe('when open orders exist', () => {
      beforeEach(async () => {
        rawData = {
          symbol: 'BTCUPUSDT',
          symbolInfo: {
            baseAsset: 'BTCUP',
            quoteAsset: 'USDT',
            filterLotSize: { stepSize: '0.01000000', minQty: '0.01000000' },
            filterPrice: { tickSize: '0.00100000' },
            filterMinNotional: { minNotional: '10.00000000' }
          },
          symbolConfiguration: {
            buy: {
              enabed: true,
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

        result = await step.execute(logger, rawData);
      });

      it('does not trigger binance.client.order', () => {
        expect(binance.client.order).not.toHaveBeenCalled();
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
        rawData = {
          symbol: 'BTCUPUSDT',
          symbolInfo: {
            baseAsset: 'BTCUP',
            quoteAsset: 'USDT',
            filterLotSize: { stepSize: '0.01000000', minQty: '0.01000000' },
            filterPrice: { tickSize: '0.00100000' },
            filterMinNotional: { minNotional: '10.00000000' }
          },
          symbolConfiguration: {
            buy: {
              enabed: true,
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

        result = await step.execute(logger, rawData);
      });

      it('does not trigger binance.client.order', () => {
        expect(binance.client.order).not.toHaveBeenCalled();
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
        rawData = {
          symbol: 'BTCUPUSDT',
          symbolInfo: {
            baseAsset: 'BTCUP',
            quoteAsset: 'USDT',
            filterLotSize: { stepSize: '0.01000000', minQty: '0.01000000' },
            filterPrice: { tickSize: '0.00100000' },
            filterMinNotional: { minNotional: '10.00000000' }
          },
          symbolConfiguration: {
            buy: {
              enabed: true,
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

        result = await step.execute(logger, rawData);
      });

      it('does not trigger binance.client.order', () => {
        expect(binance.client.order).not.toHaveBeenCalled();
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
        rawData = {
          symbol: 'BTCUPUSDT',
          symbolInfo: {
            baseAsset: 'BTCUP',
            quoteAsset: 'USDT',
            filterLotSize: { stepSize: '0.01000000', minQty: '0.01000000' },
            filterPrice: { tickSize: '0.00100000' },
            filterMinNotional: { minNotional: '10.00000000' }
          },
          symbolConfiguration: {
            buy: {
              enabed: false,
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

        result = await step.execute(logger, rawData);
      });

      it('does not trigger binance.client.order', () => {
        expect(binance.client.order).not.toHaveBeenCalled();
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
        rawData = {
          symbol: 'BTCUPUSDT',
          symbolInfo: {
            baseAsset: 'BTCUP',
            quoteAsset: 'USDT',
            filterLotSize: { stepSize: '0.01000000', minQty: '0.01000000' },
            filterPrice: { tickSize: '0.00100000' },
            filterMinNotional: { minNotional: '10.00000000' }
          },
          symbolConfiguration: {
            buy: {
              enabed: true,
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

        result = await step.execute(logger, rawData);
      });

      it('triggers binance.client.order', () => {
        expect(binance.client.order).toHaveBeenCalledWith({
          price: 202.2,
          quantity: 0.24,
          side: 'buy',
          stopPrice: 202,
          symbol: 'BTCUPUSDT',
          timeInForce: 'GTC',
          type: 'STOP_LOSS_LIMIT'
        });
      });

      it('retruns expected value', () => {
        expect(result).toStrictEqual({
          ...rawData,
          ...{
            buy: {
              currentPrice: 200,
              openOrders: [],
              processMessage: 'Placed new stop loss limit order for buying.',
              updatedAt: expect.any(Object)
            }
          }
        });
      });
    });
  });
});
