/* eslint-disable global-require */

describe('get-open-orders.js', () => {
  let loggerMock;

  let rawData;

  let step;
  let result;

  let mockGetAndCacheOpenOrdersForSymbol;

  beforeEach(() => {
    jest.clearAllMocks().resetModules();
  });

  describe('execute', () => {
    beforeEach(async () => {
      const { logger } = require('../../../../helpers');

      loggerMock = logger;

      mockGetAndCacheOpenOrdersForSymbol = jest
        .fn()
        .mockResolvedValue([{ orderId: 1 }]);

      jest.mock('../../../trailingTradeHelper/common', () => ({
        getAndCacheOpenOrdersForSymbol: mockGetAndCacheOpenOrdersForSymbol
      }));

      step = require('../get-open-orders');

      rawData = {
        symbol: 'BTCUSDT'
      };

      result = await step.execute(loggerMock, rawData);
    });

    it('triggers getAndCacheOpenOrdersForSymbol', () => {
      expect(mockGetAndCacheOpenOrdersForSymbol).toHaveBeenCalledWith(
        loggerMock,
        'BTCUSDT'
      );
    });

    it('retruns expected data', () => {
      expect(result).toStrictEqual({
        symbol: 'BTCUSDT',
        openOrders: [{ orderId: 1 }]
      });
    });
  });
});
