const { cache, logger } = require('../../../../helpers');

const step = require('../save-data-to-cache');

describe('save-data-to-cache.js', () => {
  let result;
  let rawData;

  describe('execute', () => {
    beforeEach(async () => {
      cache.hset = jest.fn().mockResolvedValue(true);

      rawData = {
        symbol: 'BTCUSDT'
      };

      result = await step.execute(logger, rawData);
    });

    it('triggers cache.hset', () => {
      expect(cache.hset).toHaveBeenCalledWith(
        'trailing-trade-symbols',
        'BTCUSDT-data',
        JSON.stringify(rawData)
      );
    });

    it('returns expected value', () => {
      expect(result).toStrictEqual({
        symbol: 'BTCUSDT'
      });
    });
  });
});
