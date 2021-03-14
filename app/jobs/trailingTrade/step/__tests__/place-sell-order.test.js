const { binance, slack, logger } = require('../../../../helpers');

const step = require('../place-sell-order');

describe('place-sell-order.js', () => {
  let result;
  let rawData;

  describe('execute', () => {
    beforeEach(async () => {
      slack.sendMessage = jest.fn().mockResolvedValue(true);
      binance.client.order = jest.fn().mockResolvedValue(true);
    });

    describe('when action is not sell', () => {
      beforeEach(async () => {
        rawData = {
          symbol: 'BTCUPUSDT',
          symbolInfo: {
            filterLotSize: { stepSize: '0.01000000', minQty: '0.01000000' },
            filterPrice: { tickSize: '0.00100000' },
            filterMinNotional: { minNotional: '10.00000000' }
          },
          symbolConfiguration: {
            sell: { enabed: true, stopPercentage: 0.99, limitPercentage: 0.989 }
          },
          action: 'not-determined',
          baseAssetBalance: { free: 0.5 },
          sell: { currentPrice: 200, openOrders: [] }
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
            filterLotSize: { stepSize: '0.01000000', minQty: '0.01000000' },
            filterPrice: { tickSize: '0.00100000' },
            filterMinNotional: { minNotional: '10.00000000' }
          },
          symbolConfiguration: {
            sell: { enabed: true, stopPercentage: 0.99, limitPercentage: 0.989 }
          },
          action: 'sell',
          baseAssetBalance: { free: 0.5 },
          sell: {
            currentPrice: 200,
            openOrders: [
              {
                orderId: 46838,
                type: 'STOP_LOSS_LIMIT',
                side: 'SELL',
                price: '199.000000',
                origQty: '0.5',
                stopPrice: '198.000000'
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
            sell: {
              currentPrice: 200,
              openOrders: [
                {
                  orderId: 46838,
                  type: 'STOP_LOSS_LIMIT',
                  side: 'SELL',
                  price: '199.000000',
                  origQty: '0.5',
                  stopPrice: '198.000000'
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

    describe('when quantity is not enough', () => {
      beforeEach(async () => {
        rawData = {
          symbol: 'BTCUPUSDT',
          symbolInfo: {
            filterLotSize: { stepSize: '0.01000000', minQty: '0.01000000' },
            filterPrice: { tickSize: '0.00100000' },
            filterMinNotional: { minNotional: '10.00000000' }
          },
          symbolConfiguration: {
            sell: { enabed: true, stopPercentage: 0.99, limitPercentage: 0.989 }
          },
          action: 'sell',
          baseAssetBalance: { free: 0.01 },
          sell: {
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
            sell: {
              currentPrice: 200,
              openOrders: [],
              processMessage:
                'Order quantity is less or equal than the minimum quantity - 0.01000000. Do not place an order.',
              updatedAt: expect.any(Object)
            }
          }
        });
      });
    });

    describe('when order amount is less than minimum notional', () => {
      beforeEach(async () => {
        rawData = {
          symbol: 'BTCUPUSDT',
          symbolInfo: {
            filterLotSize: { stepSize: '0.01000000', minQty: '0.01000000' },
            filterPrice: { tickSize: '0.00100000' },
            filterMinNotional: { minNotional: '10.00000000' }
          },
          symbolConfiguration: {
            sell: { enabed: true, stopPercentage: 0.99, limitPercentage: 0.989 }
          },
          action: 'sell',
          baseAssetBalance: { free: 0.05 },
          sell: {
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
            sell: {
              currentPrice: 200,
              openOrders: [],
              processMessage:
                'Notional value is less than the minimum notional value. Do not place an order.',
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
            filterLotSize: { stepSize: '0.01000000', minQty: '0.01000000' },
            filterPrice: { tickSize: '0.00100000' },
            filterMinNotional: { minNotional: '10.00000000' }
          },
          symbolConfiguration: {
            sell: {
              enabed: false,
              stopPercentage: 0.99,
              limitPercentage: 0.989
            }
          },
          action: 'sell',
          baseAssetBalance: { free: 0.1 },
          sell: {
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
            sell: {
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

    describe('when has enough amount to sell', () => {
      beforeEach(async () => {
        rawData = {
          symbol: 'BTCUPUSDT',
          symbolInfo: {
            filterLotSize: { stepSize: '0.01000000', minQty: '0.01000000' },
            filterPrice: { tickSize: '0.00100000' },
            filterMinNotional: { minNotional: '10.00000000' }
          },
          symbolConfiguration: {
            sell: {
              enabed: true,
              stopPercentage: 0.99,
              limitPercentage: 0.989
            }
          },
          action: 'sell',
          baseAssetBalance: { free: 0.1 },
          sell: {
            currentPrice: 200,
            openOrders: []
          }
        };

        result = await step.execute(logger, rawData);
      });

      it('triggers binance.client.order', () => {
        expect(binance.client.order).toHaveBeenCalledWith({
          price: 197.8,
          quantity: 0.09,
          side: 'sell',
          stopPrice: 198,
          symbol: 'BTCUPUSDT',
          timeInForce: 'GTC',
          type: 'STOP_LOSS_LIMIT'
        });
      });

      it('retruns expected value', () => {
        expect(result).toStrictEqual({
          ...rawData,
          ...{
            sell: {
              currentPrice: 200,
              openOrders: [],
              processMessage: 'Placed new stop loss limit order for selling.',
              updatedAt: expect.any(Object)
            }
          }
        });
      });
    });
  });
});
