const { cache, logger } = require('../../../../helpers');

const step = require('../get-next-symbol');

describe('get-next-symbols.js', () => {
  let result;
  let rawData;

  describe('execute', () => {
    beforeEach(() => {
      cache.hset = jest.fn().mockResolvedValue(true);
    });

    describe('when there is cached symbol with valid symbol', () => {
      beforeEach(async () => {
        cache.hget = jest.fn().mockResolvedValue('BNBUSDT');

        rawData = {
          globalConfiguration: {
            symbols: ['BTCUSDT', 'BNBUSDT', 'LTCUSDT']
          }
        };

        result = await step.execute(logger, rawData);
      });

      it('saves last symbol to cache', () => {
        expect(cache.hset).toHaveBeenCalledWith(
          'trailing-trade-common',
          'last-indicator-symbol',
          'LTCUSDT'
        );
      });

      it('returns expected result', () => {
        expect(result).toStrictEqual({
          globalConfiguration: {
            symbols: ['BTCUSDT', 'BNBUSDT', 'LTCUSDT']
          },
          symbol: 'LTCUSDT'
        });
      });
    });

    describe('when there is cached symbol with invalid symbol', () => {
      beforeEach(async () => {
        cache.hget = jest.fn().mockResolvedValue('XRPUSDT');

        rawData = {
          globalConfiguration: {
            symbols: ['BTCUSDT', 'BNBUSDT', 'LTCUSDT']
          }
        };

        result = await step.execute(logger, rawData);
      });

      it('saves last symbol to cache', () => {
        expect(cache.hset).toHaveBeenCalledWith(
          'trailing-trade-common',
          'last-indicator-symbol',
          'BTCUSDT'
        );
      });

      it('returns expected result', () => {
        expect(result).toStrictEqual({
          globalConfiguration: {
            symbols: ['BTCUSDT', 'BNBUSDT', 'LTCUSDT']
          },
          symbol: 'BTCUSDT'
        });
      });
    });

    describe('when there is cached symbol with last symbol', () => {
      beforeEach(async () => {
        cache.hget = jest.fn().mockResolvedValue('LTCUSDT');

        rawData = {
          globalConfiguration: {
            symbols: ['BTCUSDT', 'BNBUSDT', 'LTCUSDT']
          }
        };

        result = await step.execute(logger, rawData);
      });

      it('saves last symbol to cache', () => {
        expect(cache.hset).toHaveBeenCalledWith(
          'trailing-trade-common',
          'last-indicator-symbol',
          'BTCUSDT'
        );
      });

      it('returns expected result', () => {
        expect(result).toStrictEqual({
          globalConfiguration: {
            symbols: ['BTCUSDT', 'BNBUSDT', 'LTCUSDT']
          },
          symbol: 'BTCUSDT'
        });
      });
    });

    describe('when there is no cached symbol', () => {
      beforeEach(async () => {
        cache.hget = jest.fn().mockResolvedValue(undefined);

        rawData = {
          globalConfiguration: {
            symbols: ['BTCUSDT', 'BNBUSDT', 'LTCUSDT']
          }
        };

        result = await step.execute(logger, rawData);
      });

      it('saves last symbol to cache', () => {
        expect(cache.hset).toHaveBeenCalledWith(
          'trailing-trade-common',
          'last-indicator-symbol',
          'BTCUSDT'
        );
      });

      it('returns expected result', () => {
        expect(result).toStrictEqual({
          globalConfiguration: {
            symbols: ['BTCUSDT', 'BNBUSDT', 'LTCUSDT']
          },
          symbol: 'BTCUSDT'
        });
      });
    });
  });
});
