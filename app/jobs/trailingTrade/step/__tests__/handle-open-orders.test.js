const { binance, logger } = require('../../../../helpers');

const step = require('../handle-open-orders');

describe('handle-open-orders.js', () => {
  let result;
  let rawData;

  describe('execute', () => {
    beforeEach(async () => {
      binance.client.cancelOrder = jest.fn().mockResolvedValue(true);
    });

    describe('when order is not STOP_LOSS_LIMIT', () => {
      beforeEach(async () => {
        rawData = {
          symbol: 'BTCUSDT',
          action: 'not-determined',
          openOrders: [
            {
              symbol: 'BTCUSDT',
              orderId: 46838,
              price: '1799.58000000',
              type: 'LIMIT',
              side: 'BUY'
            }
          ],
          buy: {
            limitPrice: 1800,
            openOrders: [
              {
                symbol: 'BTCUSDT',
                orderId: 46838,
                price: '1799.58000000',
                type: 'LIMIT',
                side: 'BUY'
              }
            ]
          },
          sell: {
            limitPrice: 1800,
            openOrders: []
          }
        };

        result = await step.execute(logger, rawData);
      });

      it('returns expected value', () => {
        expect(result).toStrictEqual({
          symbol: 'BTCUSDT',
          action: 'not-determined',
          openOrders: [
            {
              symbol: 'BTCUSDT',
              orderId: 46838,
              price: '1799.58000000',
              type: 'LIMIT',
              side: 'BUY'
            }
          ],
          buy: {
            limitPrice: 1800,
            openOrders: [
              {
                symbol: 'BTCUSDT',
                orderId: 46838,
                price: '1799.58000000',
                type: 'LIMIT',
                side: 'BUY'
              }
            ]
          },
          sell: { limitPrice: 1800, openOrders: [] }
        });
      });
    });

    describe('when order is buy', () => {
      describe('when stop price is higher or equal than current limit price', () => {
        beforeEach(async () => {
          rawData = {
            symbol: 'BTCUSDT',
            action: 'not-determined',
            openOrders: [
              {
                symbol: 'BTCUSDT',
                orderId: 46838,
                price: '1799.58000000',
                stopPrice: '1800.1000',
                type: 'STOP_LOSS_LIMIT',
                side: 'BUY'
              }
            ],
            buy: {
              limitPrice: 1800,
              openOrders: [
                {
                  symbol: 'BTCUSDT',
                  orderId: 46838,
                  price: '1799.58000000',
                  stopPrice: '1800.1000',
                  type: 'STOP_LOSS_LIMIT',
                  side: 'BUY'
                }
              ]
            },
            sell: {
              limitPrice: 1800,
              openOrders: []
            }
          };

          result = await step.execute(logger, rawData);
        });

        it('triggers cancelOrder', () => {
          expect(binance.client.cancelOrder).toHaveBeenCalledWith({
            symbol: 'BTCUSDT',
            orderId: 46838
          });
        });

        it('returns expected value', () => {
          expect(result).toStrictEqual({
            symbol: 'BTCUSDT',
            action: 'buy',
            refreshAccountInfo: true,
            openOrders: [
              {
                symbol: 'BTCUSDT',
                orderId: 46838,
                price: '1799.58000000',
                stopPrice: '1800.1000',
                type: 'STOP_LOSS_LIMIT',
                side: 'BUY'
              }
            ],
            buy: { limitPrice: 1800, openOrders: [] },
            sell: { limitPrice: 1800, openOrders: [] }
          });
        });
      });

      describe('when stop price is less than current limit price', () => {
        beforeEach(async () => {
          rawData = {
            symbol: 'BTCUSDT',
            action: 'not-determined',
            openOrders: [
              {
                symbol: 'BTCUSDT',
                orderId: 46838,
                price: '1799.58000000',
                stopPrice: '1800.1000',
                type: 'STOP_LOSS_LIMIT',
                side: 'BUY'
              }
            ],
            buy: {
              limitPrice: 1810,
              openOrders: [
                {
                  symbol: 'BTCUSDT',
                  orderId: 46838,
                  price: '1799.58000000',
                  stopPrice: '1800.1000',
                  type: 'STOP_LOSS_LIMIT',
                  side: 'BUY'
                }
              ]
            },
            sell: {
              limitPrice: 1800,
              openOrders: []
            }
          };

          result = await step.execute(logger, rawData);
        });

        it('does not trigger cancelOrder', () => {
          expect(binance.client.cancelOrder).not.toHaveBeenCalled();
        });

        it('returns expected value', () => {
          expect(result).toStrictEqual({
            symbol: 'BTCUSDT',
            action: 'buy-order-wait',
            openOrders: [
              {
                symbol: 'BTCUSDT',
                orderId: 46838,
                price: '1799.58000000',
                stopPrice: '1800.1000',
                type: 'STOP_LOSS_LIMIT',
                side: 'BUY'
              }
            ],
            buy: {
              limitPrice: 1810,
              openOrders: [
                {
                  symbol: 'BTCUSDT',
                  orderId: 46838,
                  price: '1799.58000000',
                  stopPrice: '1800.1000',
                  type: 'STOP_LOSS_LIMIT',
                  side: 'BUY'
                }
              ]
            },
            sell: { limitPrice: 1800, openOrders: [] }
          });
        });
      });
    });

    describe('when order is sell', () => {
      describe('when stop price is less or equal than current limit price', () => {
        beforeEach(async () => {
          rawData = {
            symbol: 'BTCUSDT',
            action: 'not-determined',
            openOrders: [
              {
                symbol: 'BTCUSDT',
                orderId: 46838,
                price: '1799.58000000',
                stopPrice: '1800.1000',
                type: 'STOP_LOSS_LIMIT',
                side: 'SELL'
              }
            ],
            buy: {
              limitPrice: 1800,
              openOrders: []
            },
            sell: {
              limitPrice: 1801,
              openOrders: [
                {
                  symbol: 'BTCUSDT',
                  orderId: 46838,
                  price: '1799.58000000',
                  stopPrice: '1800.1000',
                  type: 'STOP_LOSS_LIMIT',
                  side: 'SELL'
                }
              ]
            }
          };

          result = await step.execute(logger, rawData);
        });

        it('triggers cancelOrder', () => {
          expect(binance.client.cancelOrder).toHaveBeenCalledWith({
            symbol: 'BTCUSDT',
            orderId: 46838
          });
        });

        it('returns expected value', () => {
          expect(result).toStrictEqual({
            symbol: 'BTCUSDT',
            action: 'sell',
            refreshAccountInfo: true,
            openOrders: [
              {
                symbol: 'BTCUSDT',
                orderId: 46838,
                price: '1799.58000000',
                stopPrice: '1800.1000',
                type: 'STOP_LOSS_LIMIT',
                side: 'SELL'
              }
            ],
            buy: { limitPrice: 1800, openOrders: [] },
            sell: { limitPrice: 1801, openOrders: [] }
          });
        });
      });

      describe('when stop price is more than current limit price', () => {
        beforeEach(async () => {
          rawData = {
            symbol: 'BTCUSDT',
            action: 'not-determined',
            openOrders: [
              {
                symbol: 'BTCUSDT',
                orderId: 46838,
                price: '1799.58000000',
                stopPrice: '1800.1000',
                type: 'STOP_LOSS_LIMIT',
                side: 'SELL'
              }
            ],
            buy: {
              limitPrice: 1800,
              openOrders: []
            },
            sell: {
              limitPrice: 1799,
              openOrders: [
                {
                  symbol: 'BTCUSDT',
                  orderId: 46838,
                  price: '1799.58000000',
                  stopPrice: '1800.1000',
                  type: 'STOP_LOSS_LIMIT',
                  side: 'SELL'
                }
              ]
            }
          };

          result = await step.execute(logger, rawData);
        });

        it('does not trigger cancelOrder', () => {
          expect(binance.client.cancelOrder).not.toHaveBeenCalled();
        });

        it('returns expected value', () => {
          expect(result).toStrictEqual({
            symbol: 'BTCUSDT',
            action: 'sell-order-wait',
            openOrders: [
              {
                symbol: 'BTCUSDT',
                orderId: 46838,
                price: '1799.58000000',
                stopPrice: '1800.1000',
                type: 'STOP_LOSS_LIMIT',
                side: 'SELL'
              }
            ],
            buy: { limitPrice: 1800, openOrders: [] },
            sell: {
              limitPrice: 1799,
              openOrders: [
                {
                  symbol: 'BTCUSDT',
                  orderId: 46838,
                  price: '1799.58000000',
                  stopPrice: '1800.1000',
                  type: 'STOP_LOSS_LIMIT',
                  side: 'SELL'
                }
              ]
            }
          });
        });
      });
    });
  });
});
