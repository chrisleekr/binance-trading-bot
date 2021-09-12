/* eslint-disable global-require */

describe('get-order-stats.js', () => {
  let loggerMock;

  let rawData;

  let step;
  let result;

  let mockSaveOrderStats;

  beforeEach(() => {
    jest.clearAllMocks().resetModules();
  });

  describe('execute', () => {
    beforeEach(async () => {
      const { logger } = require('../../../../helpers');

      loggerMock = logger;

      mockSaveOrderStats = jest.fn().mockResolvedValue([{ orderId: 1 }]);

      jest.mock('../../../trailingTradeHelper/common', () => ({
        saveOrderStats: mockSaveOrderStats
      }));

      step = require('../get-order-stats');

      rawData = {
        globalConfiguration: {
          symbols: ['BTCUSDT', 'ETHUSDT']
        }
      };

      result = await step.execute(loggerMock, rawData);
    });

    it('triggers saveOrderStats', () => {
      expect(mockSaveOrderStats).toHaveBeenCalledWith(loggerMock, [
        'BTCUSDT',
        'ETHUSDT'
      ]);
    });

    it('retruns expected data', () => {
      expect(result).toStrictEqual({
        globalConfiguration: {
          symbols: ['BTCUSDT', 'ETHUSDT']
        }
      });
    });
  });
});
