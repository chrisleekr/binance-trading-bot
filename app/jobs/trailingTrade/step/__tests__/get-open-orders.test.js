const { binance, logger } = require('../../../../helpers');

const step = require('../get-open-orders');

describe('get-open-orders.js', () => {
  let result;
  let rawData;

  describe('execute', () => {
    beforeEach(async () => {
      binance.client.openOrders = jest.fn().mockResolvedValue([
        {
          orderId: 'id-1'
        }
      ]);

      rawData = {
        symbol: 'BTCUSDT'
      };

      result = await step.execute(logger, rawData);
    });

    it('return expected result', () => {
      expect(result).toStrictEqual({
        symbol: 'BTCUSDT',
        openOrders: [
          {
            orderId: 'id-1'
          }
        ]
      });
    });
  });
});
