/* eslint-disable global-require */
describe('cancel-order.js', () => {
  let result;
  let rawData;

  let binanceMock;
  let slackMock;
  let loggerMock;
  let PubSubMock;

  let mockGetAPILimit;
  let mockGetAndCacheOpenOrdersForSymbol;
  let mockGetAccountInfoFromAPI;

  let mockDeleteManualOrder;

  describe('execute', () => {
    beforeEach(() => {
      jest.clearAllMocks().resetModules();

      const { binance, slack, PubSub, logger } = require('../../../../helpers');

      binanceMock = binance;
      slackMock = slack;
      PubSubMock = PubSub;
      loggerMock = logger;

      slackMock.sendMessage = jest.fn().mockResolvedValue(true);
      binanceMock.client.cancelOrder = jest.fn().mockResolvedValue(true);
      mockGetAPILimit = jest.fn().mockReturnValue(10);
      mockGetAndCacheOpenOrdersForSymbol = jest.fn().mockResolvedValue([]);
      mockGetAccountInfoFromAPI = jest.fn().mockResolvedValue({
        account: 'info'
      });
      PubSubMock.publish = jest.fn().mockResolvedValue(true);

      mockDeleteManualOrder = jest.fn().mockResolvedValue(true);

      jest.mock('../../../trailingTradeHelper/order', () => ({
        deleteManualOrder: mockDeleteManualOrder
      }));
    });

    describe('when action is not cancel-order', () => {
      beforeEach(async () => {
        jest.mock('../../../trailingTradeHelper/common', () => ({
          getAPILimit: mockGetAPILimit,
          getAndCacheOpenOrdersForSymbol: mockGetAndCacheOpenOrdersForSymbol,
          getAccountInfoFromAPI: mockGetAccountInfoFromAPI
        }));

        const step = require('../cancel-order');
        rawData = {
          symbol: 'BTCUSDT',
          action: 'buy-order-wait',
          order: {}
        };

        result = await step.execute(loggerMock, rawData);
      });

      it('does not trigger binance.client.cancelOrder', () => {
        expect(binanceMock.client.cancelOrder).not.toHaveBeenCalled();
      });

      it('returns expected value', () => {
        expect(result).toStrictEqual(rawData);
      });
    });

    describe('when action is cancel-order', () => {
      describe('when there are open orders', () => {
        beforeEach(async () => {
          mockGetAndCacheOpenOrdersForSymbol = jest.fn().mockResolvedValue([
            {
              orderId: 'new-buy-order',
              side: 'buy'
            },
            {
              orderId: 'new-sell-order',
              side: 'sell'
            }
          ]);

          jest.mock('../../../trailingTradeHelper/common', () => ({
            getAPILimit: mockGetAPILimit,
            getAndCacheOpenOrdersForSymbol: mockGetAndCacheOpenOrdersForSymbol,
            getAccountInfoFromAPI: mockGetAccountInfoFromAPI
          }));

          const step = require('../cancel-order');
          rawData = {
            symbol: 'BTCUSDT',
            action: 'cancel-order',
            accountInfo: {
              existing: 'data'
            },
            openOrders: [
              {
                orderId: 'another-buy-order',
                side: 'buy'
              },
              {
                orderId: 'another-sell-order',
                side: 'sell'
              }
            ],
            buy: {
              openOrders: [
                {
                  orderId: 'another-buy-order',
                  side: 'buy'
                }
              ]
            },
            sell: {
              openOrders: [
                {
                  orderId: 'another-sell-order',
                  side: 'sell'
                }
              ]
            },
            order: {
              orderId: 'order-123',
              side: 'buy'
            }
          };

          result = await step.execute(loggerMock, rawData);
        });

        it('triggers binance.client.cancelOrder', () => {
          expect(binanceMock.client.cancelOrder).toHaveBeenCalledWith({
            symbol: 'BTCUSDT',
            orderId: 'order-123'
          });
        });

        it('deleteManualOrder', () => {
          expect(mockDeleteManualOrder).toHaveBeenCalledWith(
            loggerMock,
            'BTCUSDT',
            'order-123'
          );
        });

        it('returns expected value', () => {
          expect(result).toStrictEqual({
            symbol: 'BTCUSDT',
            action: 'cancel-order',
            accountInfo: {
              account: 'info'
            },
            openOrders: [
              {
                orderId: 'new-buy-order',
                side: 'buy'
              },
              {
                orderId: 'new-sell-order',
                side: 'sell'
              }
            ],
            buy: {
              openOrders: [
                {
                  orderId: 'new-buy-order',
                  side: 'buy'
                }
              ],
              processMessage: 'The buy order has been cancelled.',
              updatedAt: expect.any(Object)
            },
            sell: {
              openOrders: [
                {
                  orderId: 'new-sell-order',
                  side: 'sell'
                }
              ]
            },
            order: {
              orderId: 'order-123',
              side: 'buy'
            }
          });
        });
      });

      describe('when there is no open order', () => {
        beforeEach(async () => {
          mockGetAndCacheOpenOrdersForSymbol = jest.fn().mockResolvedValue([]);

          jest.mock('../../../trailingTradeHelper/common', () => ({
            getAPILimit: mockGetAPILimit,
            getAndCacheOpenOrdersForSymbol: mockGetAndCacheOpenOrdersForSymbol,
            getAccountInfoFromAPI: mockGetAccountInfoFromAPI
          }));

          const step = require('../cancel-order');
          rawData = {
            symbol: 'BTCUSDT',
            action: 'cancel-order',
            accountInfo: {
              existing: 'data'
            },
            openOrders: [
              {
                orderId: 'another-buy-order',
                side: 'buy'
              },
              {
                orderId: 'another-sell-order',
                side: 'sell'
              }
            ],
            buy: {
              openOrders: [
                {
                  orderId: 'another-buy-order',
                  side: 'buy'
                }
              ]
            },
            sell: {
              openOrders: [
                {
                  orderId: 'another-sellorder',
                  side: 'sell'
                }
              ]
            },
            order: {
              orderId: 'order-123',
              side: 'buy'
            }
          };

          result = await step.execute(loggerMock, rawData);
        });

        it('triggers binance.client.cancelOrder', () => {
          expect(binanceMock.client.cancelOrder).toHaveBeenCalledWith({
            symbol: 'BTCUSDT',
            orderId: 'order-123'
          });
        });

        it('deleteManualOrder', () => {
          expect(mockDeleteManualOrder).toHaveBeenCalledWith(
            loggerMock,
            'BTCUSDT',
            'order-123'
          );
        });

        it('returns expected value', () => {
          expect(result).toStrictEqual({
            symbol: 'BTCUSDT',
            action: 'cancel-order',
            accountInfo: {
              account: 'info'
            },
            openOrders: [],
            buy: {
              openOrders: [],
              processMessage: 'The buy order has been cancelled.',
              updatedAt: expect.any(Object)
            },
            sell: {
              openOrders: []
            },
            order: {
              orderId: 'order-123',
              side: 'buy'
            }
          });
        });
      });
    });
  });
});
