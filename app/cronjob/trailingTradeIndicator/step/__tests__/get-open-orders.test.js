/* eslint-disable global-require */

describe('get-open-orders.js', () => {
  let loggerMock;
  let rawData;

  let step;
  let result;

  beforeEach(() => {
    jest.clearAllMocks().resetModules();
  });

  describe('execute', () => {
    let mockRefreshOpenOrdersWithSymbol;
    beforeEach(async () => {
      const { logger } = require('../../../../helpers');

      loggerMock = logger;
      mockRefreshOpenOrdersWithSymbol = jest
        .fn()
        .mockResolvedValue([{ orderId: 1 }]);

      jest.mock('../../../trailingTradeHelper/common', () => ({
        refreshOpenOrdersWithSymbol: mockRefreshOpenOrdersWithSymbol
      }));

      step = require('../get-open-orders');

      rawData = {
        symbol: 'BTCUSDT'
      };

      result = await step.execute(loggerMock, rawData);
    });

    it('triggers refreshOpenOrdersWithSymbol', () => {
      expect(mockRefreshOpenOrdersWithSymbol).toHaveBeenCalledWith(
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
