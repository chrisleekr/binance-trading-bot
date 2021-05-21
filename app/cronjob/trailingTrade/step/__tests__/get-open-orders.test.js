/* eslint-disable global-require */
const { cache, logger } = require('../../../../helpers');

const step = require('../get-open-orders');

describe('get-open-orders.js', () => {
  let result;
  let rawData;

  describe('execute', () => {
    describe('when trailing trade orders for symbol exists', () => {
      beforeEach(async () => {
        rawData = {
          symbol: 'BTCUSDT'
        };

        cache.hget = jest
          .fn()
          .mockResolvedValue(
            JSON.stringify([{ orderId: 1, symbol: 'BTCUSDT' }])
          );

        result = await step.execute(logger, rawData);
      });

      it('retruns expected data', () => {
        expect(result).toStrictEqual({
          symbol: 'BTCUSDT',
          openOrders: [
            {
              orderId: 1,
              symbol: 'BTCUSDT'
            }
          ]
        });
      });
    });

    describe('when trailing trade orders for symbol does not exist', () => {
      beforeEach(async () => {
        rawData = {
          symbol: 'BTCUSDT'
        };

        cache.hget = jest.fn().mockResolvedValue(null);

        result = await step.execute(logger, rawData);
      });

      it('retruns expected data', () => {
        expect(result).toStrictEqual({
          symbol: 'BTCUSDT',
          openOrders: []
        });
      });
    });
  });
});
