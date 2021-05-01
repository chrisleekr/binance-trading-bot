/* eslint-disable global-require */
describe('ensure-order-placed.js', () => {
  let result;
  let rawData;

  let cacheMock;
  let binanceMock;
  let loggerMock;
  let slackMock;

  let mockGetAndCacheOpenOrdersForSymbol;
  let mockGetAccountInfoFromAPI;

  beforeEach(() => {
    jest.clearAllMocks().resetModules();
  });

  describe('when there is no order', () => {
    beforeEach(async () => {
      const { slack, cache, binance, logger } = require('../../../../helpers');

      cacheMock = cache;
      binanceMock = binance;
      loggerMock = logger;
      slackMock = slack;

      cacheMock.get = jest.fn().mockResolvedValue(null);
      cacheMock.del = jest.fn().mockResolvedValue(true);
      binanceMock.client.getOrder = jest.fn().mockRejectedValue({});

      mockGetAndCacheOpenOrdersForSymbol = jest.fn().mockResolvedValue([]);
      mockGetAccountInfoFromAPI = jest.fn().mockResolvedValue({
        account: 'info'
      });

      jest.mock('../../../trailingTradeHelper/common', () => ({
        getAndCacheOpenOrdersForSymbol: mockGetAndCacheOpenOrdersForSymbol,
        getAccountInfoFromAPI: mockGetAccountInfoFromAPI
      }));

      rawData = {
        symbol: 'BTCUSDT',
        featureToggle: {
          notifyOrderConfirm: true
        },
        openOrders: [],
        buy: {
          openOrders: []
        }
      };

      const step = require('../ensure-order-placed');
      result = await step.execute(loggerMock, rawData);
    });

    it('triggers cache.get for buy order', () => {
      expect(cacheMock.get).toHaveBeenCalledWith('BTCUSDT-last-buy-order');
    });

    it('triggers cache.get for sell order', () => {
      expect(cacheMock.get).toHaveBeenCalledWith('BTCUSDT-last-sell-order');
    });

    it('does not trigger getAndCacheOpenOrdersForSymbol', () => {
      expect(mockGetAndCacheOpenOrdersForSymbol).not.toHaveBeenCalled();
    });

    it('does not trigger binance.client.getOrder', () => {
      expect(binanceMock.client.getOrder).not.toHaveBeenCalled();
    });

    it('does not trigger getAccountInfoFromAPI', () => {
      expect(mockGetAccountInfoFromAPI).not.toHaveBeenCalled();
    });

    it('does not trigger cache.del', () => {
      expect(cacheMock.del).not.toHaveBeenCalled();
    });

    it('returns expected result', () => {
      expect(result).toStrictEqual({
        symbol: 'BTCUSDT',
        featureToggle: {
          notifyOrderConfirm: true
        },
        openOrders: [],
        buy: {
          openOrders: []
        }
      });
    });
  });

  describe('when there is a buy order', () => {
    describe('when order found in Binance', () => {
      beforeEach(() => {
        const {
          slack,
          cache,
          binance,
          logger
        } = require('../../../../helpers');

        cacheMock = cache;
        binanceMock = binance;
        loggerMock = logger;
        slackMock = slack;

        slackMock.sendMessage = jest.fn();

        cacheMock.get = jest.fn().mockImplementation(key => {
          if (key === 'BTCUSDT-last-buy-order') {
            return JSON.stringify({
              orderId: 123,
              symbol: 'BTCUSDT',
              status: 'NEW'
            });
          }
          return null;
        });
        cacheMock.del = jest.fn().mockResolvedValue(true);

        mockGetAndCacheOpenOrdersForSymbol = jest.fn().mockResolvedValue([
          {
            orderId: 123,
            symbol: 'BTCUSDT',
            side: 'BUY',
            status: 'NEW'
          }
        ]);
        mockGetAccountInfoFromAPI = jest.fn().mockResolvedValue({
          account: 'info'
        });

        jest.mock('../../../trailingTradeHelper/common', () => ({
          getAndCacheOpenOrdersForSymbol: mockGetAndCacheOpenOrdersForSymbol,
          getAccountInfoFromAPI: mockGetAccountInfoFromAPI
        }));
      });

      describe('when notifyOrderConfirm is disabled', () => {
        beforeEach(async () => {
          rawData = {
            symbol: 'BTCUSDT',
            featureToggle: {
              notifyOrderConfirm: false
            },
            openOrders: [],
            buy: {
              openOrders: []
            }
          };

          const step = require('../ensure-order-placed');
          result = await step.execute(loggerMock, rawData);
        });

        it('triggers cache.get for buy order', () => {
          expect(cacheMock.get).toHaveBeenCalledWith('BTCUSDT-last-buy-order');
        });

        it('triggers cache.get for sell order', () => {
          expect(cacheMock.get).toHaveBeenCalledWith('BTCUSDT-last-sell-order');
        });

        it('triggers cache.del', () => {
          expect(cacheMock.del).toHaveBeenCalledWith('BTCUSDT-last-buy-order');
        });

        it('triggers getAndCacheOpenOrdersForSymbol', () => {
          expect(mockGetAndCacheOpenOrdersForSymbol).toHaveBeenCalledWith(
            loggerMock,
            'BTCUSDT'
          );
        });

        it('triggers getAccountInfoFromAPI', () => {
          expect(mockGetAccountInfoFromAPI).toHaveBeenCalled();
        });

        it('does not trigger slack.sendMessage', () => {
          expect(slackMock.sendMessage).not.toHaveBeenCalled();
        });

        it('returns expected result', () => {
          expect(result).toStrictEqual({
            symbol: 'BTCUSDT',
            featureToggle: {
              notifyOrderConfirm: false
            },
            openOrders: [
              {
                orderId: 123,
                symbol: 'BTCUSDT',
                side: 'BUY',
                status: 'NEW'
              }
            ],
            buy: {
              openOrders: [
                {
                  orderId: 123,
                  symbol: 'BTCUSDT',
                  side: 'BUY',
                  status: 'NEW'
                }
              ]
            },
            accountInfo: {
              account: 'info'
            }
          });
        });
      });

      describe('when notifyOrderConfirm is enabled', () => {
        beforeEach(async () => {
          rawData = {
            symbol: 'BTCUSDT',
            featureToggle: {
              notifyOrderConfirm: true
            },
            openOrders: [],
            buy: {
              openOrders: []
            }
          };

          const step = require('../ensure-order-placed');
          result = await step.execute(loggerMock, rawData);
        });

        it('triggers cache.get for buy order', () => {
          expect(cacheMock.get).toHaveBeenCalledWith('BTCUSDT-last-buy-order');
        });

        it('triggers cache.get for sell order', () => {
          expect(cacheMock.get).toHaveBeenCalledWith('BTCUSDT-last-sell-order');
        });

        it('triggers cache.del', () => {
          expect(cacheMock.del).toHaveBeenCalledWith('BTCUSDT-last-buy-order');
        });

        it('triggers getAndCacheOpenOrdersForSymbol', () => {
          expect(mockGetAndCacheOpenOrdersForSymbol).toHaveBeenCalledWith(
            loggerMock,
            'BTCUSDT'
          );
        });

        it('triggers getAccountInfoFromAPI', () => {
          expect(mockGetAccountInfoFromAPI).toHaveBeenCalled();
        });

        it('triggers slack.sendMessage', () => {
          expect(slackMock.sendMessage).toHaveBeenCalled();
        });

        it('returns expected result', () => {
          expect(result).toStrictEqual({
            symbol: 'BTCUSDT',
            featureToggle: {
              notifyOrderConfirm: true
            },
            openOrders: [
              {
                orderId: 123,
                symbol: 'BTCUSDT',
                side: 'BUY',
                status: 'NEW'
              }
            ],
            buy: {
              openOrders: [
                {
                  orderId: 123,
                  symbol: 'BTCUSDT',
                  side: 'BUY',
                  status: 'NEW'
                }
              ]
            },
            accountInfo: {
              account: 'info'
            }
          });
        });
      });
    });

    describe('when order is not found in Binance', () => {
      beforeEach(() => {
        const {
          slack,
          cache,
          binance,
          logger
        } = require('../../../../helpers');

        cacheMock = cache;
        binanceMock = binance;
        loggerMock = logger;
        slackMock = slack;

        slackMock.sendMessage = jest.fn();

        cacheMock.get = jest.fn().mockImplementation(key => {
          if (key === 'BTCUSDT-last-buy-order') {
            return JSON.stringify({
              orderId: 123,
              symbol: 'BTCUSDT',
              status: 'NEW'
            });
          }
          return null;
        });
        cacheMock.del = jest.fn().mockResolvedValue(true);

        mockGetAndCacheOpenOrdersForSymbol = jest.fn().mockResolvedValue([]);
        mockGetAccountInfoFromAPI = jest.fn().mockResolvedValue({
          account: 'info'
        });

        jest.mock('../../../trailingTradeHelper/common', () => ({
          getAndCacheOpenOrdersForSymbol: mockGetAndCacheOpenOrdersForSymbol,
          getAccountInfoFromAPI: mockGetAccountInfoFromAPI
        }));
      });

      describe('when notifyOrderConfir is disabled', () => {
        beforeEach(async () => {
          rawData = {
            symbol: 'BTCUSDT',
            featureToggle: {
              notifyOrderConfirm: false
            },
            openOrders: [],
            buy: {
              openOrders: []
            }
          };

          const step = require('../ensure-order-placed');
          result = await step.execute(loggerMock, rawData);
        });

        it('triggers cache.get for buy order', () => {
          expect(cacheMock.get).toHaveBeenCalledWith('BTCUSDT-last-buy-order');
        });

        it('does not trigger cache.get for sell order', () => {
          expect(cacheMock.get).not.toHaveBeenCalledWith(
            'BTCUSDT-last-sell-order'
          );
        });

        it('triggers getAndCacheOpenOrdersForSymbol', () => {
          expect(mockGetAndCacheOpenOrdersForSymbol).toHaveBeenCalledWith(
            loggerMock,
            'BTCUSDT'
          );
        });

        it('does not trigger cache.del', () => {
          expect(cacheMock.del).not.toHaveBeenCalled();
        });

        it('does not triggers getAccountInfoFromAPI', () => {
          expect(mockGetAccountInfoFromAPI).not.toHaveBeenCalled();
        });

        it('does not trigger slack.sendMessage', () => {
          expect(slackMock.sendMessage).not.toHaveBeenCalled();
        });

        it('returns expected result', () => {
          expect(result).toStrictEqual({
            symbol: 'BTCUSDT',
            featureToggle: {
              notifyOrderConfirm: false
            },
            action: 'buy-order-checking',
            openOrders: [],
            buy: {
              openOrders: [],
              processMessage:
                'The buy order seems placed; however, it does not appear in the open orders. ' +
                'Wait for the buy order to appear in open orders.',
              updatedAt: expect.any(Object)
            }
          });
        });
      });

      describe('when notifyOrderConfir is enabled', () => {
        beforeEach(async () => {
          rawData = {
            symbol: 'BTCUSDT',
            featureToggle: {
              notifyOrderConfirm: true
            },
            openOrders: [],
            buy: {
              openOrders: []
            }
          };

          const step = require('../ensure-order-placed');
          result = await step.execute(loggerMock, rawData);
        });

        it('triggers cache.get for buy order', () => {
          expect(cacheMock.get).toHaveBeenCalledWith('BTCUSDT-last-buy-order');
        });

        it('does not trigger cache.get for sell order', () => {
          expect(cacheMock.get).not.toHaveBeenCalledWith(
            'BTCUSDT-last-sell-order'
          );
        });

        it('triggers getAndCacheOpenOrdersForSymbol', () => {
          expect(mockGetAndCacheOpenOrdersForSymbol).toHaveBeenCalledWith(
            loggerMock,
            'BTCUSDT'
          );
        });

        it('does not trigger cache.del', () => {
          expect(cacheMock.del).not.toHaveBeenCalled();
        });

        it('does not triggers getAccountInfoFromAPI', () => {
          expect(mockGetAccountInfoFromAPI).not.toHaveBeenCalled();
        });

        it('triggers slack.sendMessage', () => {
          expect(slackMock.sendMessage).toHaveBeenCalled();
        });

        it('returns expected result', () => {
          expect(result).toStrictEqual({
            symbol: 'BTCUSDT',
            featureToggle: {
              notifyOrderConfirm: true
            },
            action: 'buy-order-checking',
            openOrders: [],
            buy: {
              openOrders: [],
              processMessage:
                'The buy order seems placed; however, it does not appear in the open orders. ' +
                'Wait for the buy order to appear in open orders.',
              updatedAt: expect.any(Object)
            }
          });
        });
      });
    });
  });

  describe('when there is a sell order', () => {
    describe('when order found in Binance', () => {
      describe('when notifyOrderConfirm is disabled', () => {
        beforeEach(async () => {
          const {
            slack,
            cache,
            binance,
            logger
          } = require('../../../../helpers');

          cacheMock = cache;
          binanceMock = binance;
          loggerMock = logger;
          slackMock = slack;

          slackMock.sendMessage = jest.fn();

          cacheMock.get = jest.fn().mockImplementation(key => {
            if (key === 'BTCUSDT-last-sell-order') {
              return JSON.stringify({
                orderId: 123,
                symbol: 'BTCUSDT',
                status: 'NEW'
              });
            }
            return null;
          });
          cacheMock.del = jest.fn().mockResolvedValue(true);

          mockGetAndCacheOpenOrdersForSymbol = jest.fn().mockResolvedValue([
            {
              orderId: 123,
              symbol: 'BTCUSDT',
              side: 'SELL',
              status: 'NEW'
            }
          ]);
          mockGetAccountInfoFromAPI = jest.fn().mockResolvedValue({
            account: 'info'
          });

          jest.mock('../../../trailingTradeHelper/common', () => ({
            getAndCacheOpenOrdersForSymbol: mockGetAndCacheOpenOrdersForSymbol,
            getAccountInfoFromAPI: mockGetAccountInfoFromAPI
          }));

          rawData = {
            symbol: 'BTCUSDT',
            featureToggle: {
              notifyOrderConfirm: false
            },
            openOrders: [],
            sell: {
              openOrders: []
            }
          };

          const step = require('../ensure-order-placed');
          result = await step.execute(loggerMock, rawData);
        });

        it('triggers cache.get for buy order', () => {
          expect(cacheMock.get).toHaveBeenCalledWith('BTCUSDT-last-buy-order');
        });

        it('triggers cache.get for sell order', () => {
          expect(cacheMock.get).toHaveBeenCalledWith('BTCUSDT-last-sell-order');
        });

        it('does not triggers cache.del for buy order', () => {
          expect(cacheMock.del).not.toHaveBeenCalledWith(
            'BTCUSDT-last-buy-order'
          );
        });

        it('triggers cache.del for sell order', () => {
          expect(cacheMock.del).toHaveBeenCalledWith('BTCUSDT-last-sell-order');
        });

        it('triggers getAndCacheOpenOrdersForSymbol', () => {
          expect(mockGetAndCacheOpenOrdersForSymbol).toHaveBeenCalledWith(
            loggerMock,
            'BTCUSDT'
          );
        });

        it('triggers getAccountInfoFromAPI', () => {
          expect(mockGetAccountInfoFromAPI).toHaveBeenCalled();
        });

        it('does not trigger slack.sendMessage', () => {
          expect(slackMock.sendMessage).not.toHaveBeenCalled();
        });

        it('returns expected result', () => {
          expect(result).toStrictEqual({
            symbol: 'BTCUSDT',
            featureToggle: {
              notifyOrderConfirm: false
            },
            openOrders: [
              {
                orderId: 123,
                symbol: 'BTCUSDT',
                side: 'SELL',
                status: 'NEW'
              }
            ],
            sell: {
              openOrders: [
                {
                  orderId: 123,
                  symbol: 'BTCUSDT',
                  side: 'SELL',
                  status: 'NEW'
                }
              ]
            },
            accountInfo: {
              account: 'info'
            }
          });
        });
      });
      describe('when notifyOrderConfirm is enabled', () => {
        beforeEach(async () => {
          const {
            slack,
            cache,
            binance,
            logger
          } = require('../../../../helpers');

          cacheMock = cache;
          binanceMock = binance;
          loggerMock = logger;
          slackMock = slack;

          slackMock.sendMessage = jest.fn();

          cacheMock.get = jest.fn().mockImplementation(key => {
            if (key === 'BTCUSDT-last-sell-order') {
              return JSON.stringify({
                orderId: 123,
                symbol: 'BTCUSDT',
                status: 'NEW'
              });
            }
            return null;
          });
          cacheMock.del = jest.fn().mockResolvedValue(true);

          mockGetAndCacheOpenOrdersForSymbol = jest.fn().mockResolvedValue([
            {
              orderId: 123,
              symbol: 'BTCUSDT',
              side: 'SELL',
              status: 'NEW'
            }
          ]);
          mockGetAccountInfoFromAPI = jest.fn().mockResolvedValue({
            account: 'info'
          });

          jest.mock('../../../trailingTradeHelper/common', () => ({
            getAndCacheOpenOrdersForSymbol: mockGetAndCacheOpenOrdersForSymbol,
            getAccountInfoFromAPI: mockGetAccountInfoFromAPI
          }));

          rawData = {
            symbol: 'BTCUSDT',
            featureToggle: {
              notifyOrderConfirm: true
            },
            openOrders: [],
            sell: {
              openOrders: []
            }
          };

          const step = require('../ensure-order-placed');
          result = await step.execute(loggerMock, rawData);
        });

        it('triggers cache.get for buy order', () => {
          expect(cacheMock.get).toHaveBeenCalledWith('BTCUSDT-last-buy-order');
        });

        it('triggers cache.get for sell order', () => {
          expect(cacheMock.get).toHaveBeenCalledWith('BTCUSDT-last-sell-order');
        });

        it('does not triggers cache.del for buy order', () => {
          expect(cacheMock.del).not.toHaveBeenCalledWith(
            'BTCUSDT-last-buy-order'
          );
        });

        it('triggers cache.del for sell order', () => {
          expect(cacheMock.del).toHaveBeenCalledWith('BTCUSDT-last-sell-order');
        });

        it('triggers getAndCacheOpenOrdersForSymbol', () => {
          expect(mockGetAndCacheOpenOrdersForSymbol).toHaveBeenCalledWith(
            loggerMock,
            'BTCUSDT'
          );
        });

        it('triggers getAccountInfoFromAPI', () => {
          expect(mockGetAccountInfoFromAPI).toHaveBeenCalled();
        });

        it('triggers slack.sendMessage', () => {
          expect(slackMock.sendMessage).toHaveBeenCalled();
        });

        it('returns expected result', () => {
          expect(result).toStrictEqual({
            symbol: 'BTCUSDT',
            featureToggle: {
              notifyOrderConfirm: true
            },
            openOrders: [
              {
                orderId: 123,
                symbol: 'BTCUSDT',
                side: 'SELL',
                status: 'NEW'
              }
            ],
            sell: {
              openOrders: [
                {
                  orderId: 123,
                  symbol: 'BTCUSDT',
                  side: 'SELL',
                  status: 'NEW'
                }
              ]
            },
            accountInfo: {
              account: 'info'
            }
          });
        });
      });
    });

    describe('when order is not found in Binance', () => {
      describe('when notifyOrderConfirm is disabled', () => {
        beforeEach(async () => {
          const {
            slack,
            cache,
            binance,
            logger
          } = require('../../../../helpers');

          cacheMock = cache;
          binanceMock = binance;
          loggerMock = logger;
          slackMock = slack;

          slackMock.sendMessage = jest.fn();

          cacheMock.get = jest.fn().mockImplementation(key => {
            if (key === 'BTCUSDT-last-sell-order') {
              return JSON.stringify({
                orderId: 123,
                symbol: 'BTCUSDT',
                status: 'NEW'
              });
            }
            return null;
          });
          cacheMock.del = jest.fn().mockResolvedValue(true);

          mockGetAndCacheOpenOrdersForSymbol = jest.fn().mockResolvedValue([]);
          mockGetAccountInfoFromAPI = jest.fn().mockResolvedValue({
            account: 'info'
          });

          jest.mock('../../../trailingTradeHelper/common', () => ({
            getAndCacheOpenOrdersForSymbol: mockGetAndCacheOpenOrdersForSymbol,
            getAccountInfoFromAPI: mockGetAccountInfoFromAPI
          }));

          rawData = {
            symbol: 'BTCUSDT',
            featureToggle: {
              notifyOrderConfirm: false
            },
            openOrders: [],
            sell: {
              openOrders: []
            }
          };

          const step = require('../ensure-order-placed');
          result = await step.execute(loggerMock, rawData);
        });

        it('triggers cache.get for buy order', () => {
          expect(cacheMock.get).toHaveBeenCalledWith('BTCUSDT-last-buy-order');
        });

        it('triggers cache.get for sell order', () => {
          expect(cacheMock.get).toHaveBeenCalledWith('BTCUSDT-last-sell-order');
        });

        it('triggers getAndCacheOpenOrdersForSymbol', () => {
          expect(mockGetAndCacheOpenOrdersForSymbol).toHaveBeenCalledWith(
            loggerMock,
            'BTCUSDT'
          );
        });
        it('does not trigger cache.del', () => {
          expect(cacheMock.del).not.toHaveBeenCalled();
        });

        it('does not triggers getAccountInfoFromAPI', () => {
          expect(mockGetAccountInfoFromAPI).not.toHaveBeenCalled();
        });

        it('does not trigger slack.sendMessage', () => {
          expect(slackMock.sendMessage).not.toHaveBeenCalled();
        });

        it('returns expected result', () => {
          expect(result).toStrictEqual({
            symbol: 'BTCUSDT',
            featureToggle: {
              notifyOrderConfirm: false
            },
            action: 'sell-order-checking',
            openOrders: [],
            sell: {
              openOrders: [],
              processMessage:
                'The sell order seems placed; however, it does not appear in the open orders. ' +
                'Wait for the sell order to appear in open orders.',
              updatedAt: expect.any(Object)
            }
          });
        });
      });
      describe('when notifyOrderConfirm is enabled', () => {
        beforeEach(async () => {
          const {
            slack,
            cache,
            binance,
            logger
          } = require('../../../../helpers');

          cacheMock = cache;
          binanceMock = binance;
          loggerMock = logger;
          slackMock = slack;

          slackMock.sendMessage = jest.fn();

          cacheMock.get = jest.fn().mockImplementation(key => {
            if (key === 'BTCUSDT-last-sell-order') {
              return JSON.stringify({
                orderId: 123,
                symbol: 'BTCUSDT',
                status: 'NEW'
              });
            }
            return null;
          });
          cacheMock.del = jest.fn().mockResolvedValue(true);

          mockGetAndCacheOpenOrdersForSymbol = jest.fn().mockResolvedValue([]);
          mockGetAccountInfoFromAPI = jest.fn().mockResolvedValue({
            account: 'info'
          });

          jest.mock('../../../trailingTradeHelper/common', () => ({
            getAndCacheOpenOrdersForSymbol: mockGetAndCacheOpenOrdersForSymbol,
            getAccountInfoFromAPI: mockGetAccountInfoFromAPI
          }));

          rawData = {
            symbol: 'BTCUSDT',
            featureToggle: {
              notifyOrderConfirm: true
            },
            openOrders: [],
            sell: {
              openOrders: []
            }
          };

          const step = require('../ensure-order-placed');
          result = await step.execute(loggerMock, rawData);
        });

        it('triggers cache.get for buy order', () => {
          expect(cacheMock.get).toHaveBeenCalledWith('BTCUSDT-last-buy-order');
        });

        it('triggers cache.get for sell order', () => {
          expect(cacheMock.get).toHaveBeenCalledWith('BTCUSDT-last-sell-order');
        });

        it('triggers getAndCacheOpenOrdersForSymbol', () => {
          expect(mockGetAndCacheOpenOrdersForSymbol).toHaveBeenCalledWith(
            loggerMock,
            'BTCUSDT'
          );
        });
        it('does not trigger cache.del', () => {
          expect(cacheMock.del).not.toHaveBeenCalled();
        });

        it('does not triggers getAccountInfoFromAPI', () => {
          expect(mockGetAccountInfoFromAPI).not.toHaveBeenCalled();
        });

        it('triggers slack.sendMessage', () => {
          expect(slackMock.sendMessage).toHaveBeenCalled();
        });

        it('returns expected result', () => {
          expect(result).toStrictEqual({
            symbol: 'BTCUSDT',
            featureToggle: {
              notifyOrderConfirm: true
            },
            action: 'sell-order-checking',
            openOrders: [],
            sell: {
              openOrders: [],
              processMessage:
                'The sell order seems placed; however, it does not appear in the open orders. ' +
                'Wait for the sell order to appear in open orders.',
              updatedAt: expect.any(Object)
            }
          });
        });
      });
    });
  });
});
