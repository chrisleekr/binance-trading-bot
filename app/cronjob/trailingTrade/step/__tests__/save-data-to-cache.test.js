const { cache, logger } = require('../../../../helpers');

const step = require('../save-data-to-cache');

describe('save-data-to-cache.js', () => {
  let result;
  let rawData;

  describe('execute', () => {
    describe('when save to cache is disabled', () => {
      beforeEach(async () => {
        cache.hset = jest.fn().mockResolvedValue(true);

        rawData = {
          symbol: 'BTCUSDT',
          saveToCache: false
        };

        result = await step.execute(logger, rawData);
      });

      it('does not trigger cache.hset', () => {
        expect(cache.hset).not.toHaveBeenCalled();
      });

      it('returns expected value', () => {
        expect(result).toStrictEqual({
          symbol: 'BTCUSDT',
          saveToCache: false
        });
      });
    });

    describe('when save to cache is enabled', () => {
      beforeEach(async () => {
        cache.hset = jest.fn().mockResolvedValue(true);

        rawData = {
          symbol: 'BTCUSDT',
          saveToCache: true
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
          symbol: 'BTCUSDT',
          saveToCache: true
        });
      });
    });
  });
});
