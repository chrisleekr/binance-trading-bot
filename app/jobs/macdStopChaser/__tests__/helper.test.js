/* eslint-disable global-require */
const { logger, cache } = require('../../../helpers');
const macdStopChaserHelper = require('../helper');

describe('helper', () => {
  let result;

  describe('getIndicators', () => {
    beforeEach(async () => {
      result = await macdStopChaserHelper.getIndicators(logger);
    });

    it('returns expected result', () => {
      logger.info({ result }, 'getIndicator result');
      expect(result).toEqual({
        macdHistory: expect.any(Object),
        minHistory: expect.any(Object),
        lastCandle: {
          baseAssetVolume: expect.any(String),
          close: expect.any(String),
          closeTime: expect.any(Number),
          high: expect.any(String),
          low: expect.any(String),
          open: expect.any(String),
          openTime: expect.any(Number),
          quoteAssetVolume: expect.any(String),
          quoteVolume: expect.any(String),
          trades: expect.any(Number),
          volume: expect.any(String)
        }
      });
    });
  });

  describe('determineAction', () => {
    describe('when MACD trend is falling', () => {
      const indicators = require('./macdResultFalling.json');
      describe('when there is no last MACD trend', () => {
        beforeEach(() => {
          cache.get = jest.fn().mockReturnValue(undefined);

          result = macdStopChaserHelper.determineAction(logger, indicators);
        });

        it('returns expected result', () => {
          expect(result).toEqual({ action: 'hold', currentTrend: 'falling' });
        });
      });

      describe('when last MACD trend is falling', () => {
        beforeEach(() => {
          cache.get = jest.fn().mockReturnValue('falling');

          result = macdStopChaserHelper.determineAction(logger, indicators);
        });

        it('returns expected result', () => {
          expect(result).toEqual({ action: 'hold', currentTrend: 'falling' });
        });
      });

      describe('when last MACD trend is rising', () => {
        beforeEach(() => {
          cache.get = jest.fn().mockReturnValue('rising');

          result = macdStopChaserHelper.determineAction(logger, indicators);
        });

        it('returns expected result', () => {
          expect(result).toEqual({ action: 'sell', currentTrend: 'falling' });
        });
      });
    });

    describe('when MACD trend is rising', () => {
      const indicators = require('./macdResultRising.json');
      describe('when there is no last MACD trend', () => {
        beforeEach(() => {
          cache.get = jest.fn().mockReturnValue(undefined);

          result = macdStopChaserHelper.determineAction(logger, indicators);
        });

        it('returns expected result', () => {
          expect(result).toEqual({ action: 'hold', currentTrend: 'rising' });
        });
      });

      describe('when last MACD trend is falling', () => {
        beforeEach(() => {
          cache.get = jest.fn().mockReturnValue('falling');

          result = macdStopChaserHelper.determineAction(logger, indicators);
        });

        it('returns expected result', () => {
          expect(result).toEqual({ action: 'buy', currentTrend: 'rising' });
        });
      });

      describe('when last MACD trend is rising', () => {
        beforeEach(() => {
          cache.get = jest.fn().mockReturnValue('rising');

          result = macdStopChaserHelper.determineAction(logger, indicators);
        });

        it('returns expected result', () => {
          expect(result).toEqual({ action: 'hold', currentTrend: 'rising' });
        });
      });
    });
  });
});
