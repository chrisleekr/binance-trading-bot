/* eslint-disable global-require */
describe('orders.js', () => {
  let binanceMock;
  let loggerMock;
  let mongoMock;
  let cacheMock;
  let spyOnClearInterval;

  let mockUpdateGridTradeLastOrder;
  let mockGetOpenOrdersFromAPI;
  let mockErrorHandlerWrapper;

  beforeEach(async () => {
    jest.clearAllMocks().resetModules();

    const { binance, logger, cache, mongo } = require('../../helpers');
    binanceMock = binance;
    loggerMock = logger;
    cacheMock = cache;
    mongoMock = mongo;

    mockErrorHandlerWrapper = jest
      .fn()
      .mockImplementation((_logger, _job, callback) => {
        callback();
      });

    jest.mock('../../error-handler', () => ({
      errorHandlerWrapper: mockErrorHandlerWrapper
    }));
  });

  describe('syncOpenOrders', () => {
    beforeEach(() => {
      jest.useFakeTimers();
    });

    describe('when open orders are retrieved', () => {
      beforeEach(async () => {
        cacheMock.hset = jest.fn().mockResolvedValue(true);

        mockGetOpenOrdersFromAPI = jest.fn().mockResolvedValue([
          {
            symbol: 'BTCUSDT',
            orderId: 46838,
            price: '1799.58000000',
            type: 'LIMIT',
            side: 'BUY'
          }
        ]);

        jest.mock('../../cronjob/trailingTradeHelper/common', () => ({
          getOpenOrdersFromAPI: mockGetOpenOrdersFromAPI
        }));

        const { syncOpenOrders } = require('../orders');

        await syncOpenOrders(loggerMock, ['BTCUSDT', 'BNBUSDT']);

        jest.advanceTimersByTime(30 * 1340);
      });

      it('triggers getOpenOrdersFromAPI', () => {
        expect(mockGetOpenOrdersFromAPI).toHaveBeenCalled();
      });

      it('triggers cache.hset', () => {
        expect(cacheMock.hset).toHaveBeenCalledWith(
          'trailing-trade-open-orders',
          'BTCUSDT',
          JSON.stringify([
            {
              symbol: 'BTCUSDT',
              orderId: 46838,
              price: '1799.58000000',
              type: 'LIMIT',
              side: 'BUY'
            }
          ])
        );
      });
    });
    describe('when open orders are empty', () => {
      beforeEach(async () => {
        cacheMock.hset = jest.fn().mockResolvedValue(true);

        mockGetOpenOrdersFromAPI = jest.fn().mockResolvedValue([]);

        jest.mock('../../cronjob/trailingTradeHelper/common', () => ({
          getOpenOrdersFromAPI: mockGetOpenOrdersFromAPI
        }));

        const { syncOpenOrders } = require('../orders');

        await syncOpenOrders(loggerMock, ['BTCUSDT', 'BNBUSDT']);

        jest.advanceTimersByTime(30 * 1340);
      });

      it('triggers getOpenOrdersFromAPI', () => {
        expect(mockGetOpenOrdersFromAPI).toHaveBeenCalled();
      });

      it('triggers cache.hset', () => {
        expect(cacheMock.hset).toHaveBeenCalledWith(
          'trailing-trade-open-orders',
          'BTCUSDT',
          JSON.stringify([])
        );
      });
    });

    describe('when openOrdersInterval is not empty', () => {
      beforeEach(async () => {
        cacheMock.hset = jest.fn().mockResolvedValue(true);

        loggerMock.error = jest.fn().mockResolvedValue(true);

        mockGetOpenOrdersFromAPI = jest.fn().mockResolvedValue(true);

        const spyOnSetInterval = jest.spyOn(global, 'setInterval');
        spyOnClearInterval = jest.spyOn(global, 'clearInterval');
        spyOnSetInterval.mockReturnValueOnce(33);

        jest.mock('../../cronjob/trailingTradeHelper/common', () => ({
          getOpenOrdersFromAPI: mockGetOpenOrdersFromAPI
        }));

        const { syncOpenOrders } = require('../orders');

        await syncOpenOrders(loggerMock, ['BTCUSDT', 'BNBUSDT']);
        await syncOpenOrders(loggerMock, ['BTCUSDT', 'BNBUSDT']);
      });

      it('triggers clearInterval', () => {
        expect(spyOnClearInterval).toHaveBeenCalledWith(33);
      });
    });
  });

  describe('syncDatabaseOrders', () => {
    describe('when database orders found', () => {
      beforeEach(async () => {
        mongoMock.findAll = jest.fn().mockResolvedValue([
          {
            order: {
              symbol: 'BTCUSDT',
              cummulativeQuoteQty: '0.00000000',
              executedQty: '0.00000000',
              isWorking: false,
              orderId: 7479643460,
              origQty: '0.00920000',
              price: '3248.37000000',
              side: 'BUY',
              status: 'NEW',
              stopPrice: '3245.19000000',
              type: 'STOP_LOSS_LIMIT',
              updateTime: 1642713283562
            }
          }
        ]);

        binanceMock.client.getOrder = jest.fn().mockResolvedValue({
          symbol: 'BTCUSDT',
          cummulativeQuoteQty: '0.00000000',
          executedQty: '0.00000000',
          isWorking: false,
          orderId: 7479643460,
          origQty: '0.00920000',
          price: '3248.37000000',
          side: 'BUY',
          status: 'CANCELED',
          stopPrice: '3245.19000000',
          type: 'STOP_LOSS_LIMIT',
          updateTime: 1642713283562
        });

        mockUpdateGridTradeLastOrder = jest.fn().mockResolvedValue(true);

        jest.mock('../../cronjob/trailingTradeHelper/order', () => ({
          updateGridTradeLastOrder: mockUpdateGridTradeLastOrder
        }));

        const { syncDatabaseOrders } = require('../orders');

        await syncDatabaseOrders(loggerMock);
      });

      it('triggers mongo.findAll', () => {
        expect(mongoMock.findAll).toHaveBeenCalledWith(
          loggerMock,
          'trailing-trade-grid-trade-orders',
          {}
        );
      });

      it('triggers updateGridTradeLastOrder', () => {
        expect(mockUpdateGridTradeLastOrder).toHaveBeenCalledWith(
          loggerMock,
          'BTCUSDT',
          'buy',
          {
            symbol: 'BTCUSDT',
            cummulativeQuoteQty: '0.00000000',
            executedQty: '0.00000000',
            isWorking: false,
            orderId: 7479643460,
            origQty: '0.00920000',
            price: '3248.37000000',
            side: 'BUY',
            status: 'CANCELED',
            stopPrice: '3245.19000000',
            type: 'STOP_LOSS_LIMIT',
            updateTime: 1642713283562
          }
        );
      });
    });
    describe('when database orders not found', () => {
      beforeEach(async () => {
        mongoMock.findAll = jest.fn().mockResolvedValue([]);

        binanceMock.client.getOrder = jest.fn().mockResolvedValue(true);

        mockUpdateGridTradeLastOrder = jest.fn().mockResolvedValue(true);

        jest.mock('../../cronjob/trailingTradeHelper/order', () => ({
          updateGridTradeLastOrder: mockUpdateGridTradeLastOrder
        }));

        const { syncDatabaseOrders } = require('../orders');

        await syncDatabaseOrders(loggerMock);
      });

      it('triggers mongo.findAll', () => {
        expect(mongoMock.findAll).toHaveBeenCalledWith(
          loggerMock,
          'trailing-trade-grid-trade-orders',
          {}
        );
      });

      it('does not trigger updateGridTradeLastOrder', () => {
        expect(mockUpdateGridTradeLastOrder).not.toHaveBeenCalled();
      });
    });
  });
});
