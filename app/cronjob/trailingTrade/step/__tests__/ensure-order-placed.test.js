/* eslint-disable global-require */
describe('ensure-order-placed.js', () => {
  let result;
  let rawData;

  let cacheMock;
  let binanceMock;
  let loggerMock;

  let mockGetAndCacheOpenOrdersForSymbol;
  let mockGetAccountInfoFromAPI;

  beforeEach(() => {
    jest.clearAllMocks().resetModules();
  });

  describe('when there is no order', () => {
    beforeEach(async () => {
      const { cache, binance, logger } = require('../../../../helpers');

      cacheMock = cache;
      binanceMock = binance;
      loggerMock = logger;

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
        openOrders: [],
        buy: {
          openOrders: []
        }
      });
    });
  });

  describe('when there is a buy order', () => {
    describe('when order found in Binance', () => {
      beforeEach(async () => {
        const { cache, binance, logger } = require('../../../../helpers');

        cacheMock = cache;
        binanceMock = binance;
        loggerMock = logger;

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
        binanceMock.client.getOrder = jest.fn().mockResolvedValue({
          orderId: 123,
          symbol: 'BTCUSDT',
          side: 'BUY',
          status: 'NEW'
        });

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

        rawData = {
          symbol: 'BTCUSDT',
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

      it('triggers binance.client.getOrder', () => {
        expect(binanceMock.client.getOrder).toHaveBeenCalledWith({
          symbol: 'BTCUSDT',
          orderId: 123,
          recvWindow: 10000
        });
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

      it('returns expected result', () => {
        expect(result).toStrictEqual({
          symbol: 'BTCUSDT',
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

    describe('when order is not found in Binance', () => {
      beforeEach(async () => {
        const { cache, binance, logger } = require('../../../../helpers');

        cacheMock = cache;
        binanceMock = binance;
        loggerMock = logger;

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
        binanceMock.client.getOrder = jest
          .fn()
          .mockRejectedValue(new Error('Order does not exist'));

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

      it('triggers binance.client.getOrder', () => {
        expect(binanceMock.client.getOrder).toHaveBeenCalledWith({
          symbol: 'BTCUSDT',
          orderId: 123,
          recvWindow: 10000
        });
      });

      it('does not trigger cache.del', () => {
        expect(cacheMock.del).not.toHaveBeenCalled();
      });

      it('does not trigger getAndCacheOpenOrdersForSymbol', () => {
        expect(mockGetAndCacheOpenOrdersForSymbol).not.toHaveBeenCalled();
      });

      it('does not triggers getAccountInfoFromAPI', () => {
        expect(mockGetAccountInfoFromAPI).not.toHaveBeenCalled();
      });

      it('returns expected result', () => {
        expect(result).toStrictEqual({
          symbol: 'BTCUSDT',
          action: 'buy-order-checking',
          openOrders: [],
          buy: {
            openOrders: [],
            processMessage:
              'The buy order seems placed; however, cannot find from Binance.' +
              ' Wait for the buy order to appear in the Binance.',
            updatedAt: expect.any(Object)
          }
        });
      });
    });
  });

  describe('when there is a sell order', () => {
    describe('when order found in Binance', () => {
      beforeEach(async () => {
        const { cache, binance, logger } = require('../../../../helpers');

        cacheMock = cache;
        binanceMock = binance;
        loggerMock = logger;

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
        binanceMock.client.getOrder = jest.fn().mockResolvedValue({
          orderId: 123,
          symbol: 'BTCUSDT',
          side: 'SELL',
          status: 'NEW'
        });

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

      it('triggers binance.client.getOrder', () => {
        expect(binanceMock.client.getOrder).toHaveBeenCalledWith({
          symbol: 'BTCUSDT',
          orderId: 123,
          recvWindow: 10000
        });
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

      it('returns expected result', () => {
        expect(result).toStrictEqual({
          symbol: 'BTCUSDT',
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

    describe('when order is not found in Binance', () => {
      beforeEach(async () => {
        const { cache, binance, logger } = require('../../../../helpers');

        cacheMock = cache;
        binanceMock = binance;
        loggerMock = logger;

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
        binanceMock.client.getOrder = jest.fn().mockResolvedValue({
          err: 'not-found'
        });

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

      it('triggers binance.client.getOrder', () => {
        expect(binanceMock.client.getOrder).toHaveBeenCalledWith({
          symbol: 'BTCUSDT',
          orderId: 123,
          recvWindow: 10000
        });
      });

      it('does not trigger cache.del', () => {
        expect(cacheMock.del).not.toHaveBeenCalled();
      });

      it('does not trigger getAndCacheOpenOrdersForSymbol', () => {
        expect(mockGetAndCacheOpenOrdersForSymbol).not.toHaveBeenCalled();
      });

      it('does not triggers getAccountInfoFromAPI', () => {
        expect(mockGetAccountInfoFromAPI).not.toHaveBeenCalled();
      });

      it('returns expected result', () => {
        expect(result).toStrictEqual({
          symbol: 'BTCUSDT',
          action: 'sell-order-checking',
          openOrders: [],
          sell: {
            openOrders: [],
            processMessage:
              'The sell order seems placed; however, cannot find from Binance.' +
              ' Wait for the sell order to appear in the Binance.',
            updatedAt: expect.any(Object)
          }
        });
      });
    });
  });
});
