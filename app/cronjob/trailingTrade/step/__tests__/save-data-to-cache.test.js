const { logger, mongo } = require('../../../../helpers');

const step = require('../save-data-to-cache');

describe('save-data-to-cache.js', () => {
  let result;
  let rawData;

  describe('execute', () => {
    describe('when save to cache is disabled', () => {
      beforeEach(async () => {
        mongo.upsertOne = jest.fn().mockResolvedValue(true);

        rawData = {
          symbol: 'BTCUSDT',
          saveToCache: false
        };

        result = await step.execute(logger, rawData);
      });

      it('does not trigger mongo.upsertOne', () => {
        expect(mongo.upsertOne).not.toHaveBeenCalled();
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
        mongo.upsertOne = jest.fn().mockResolvedValue(true);

        rawData = {
          symbol: 'BTCUSDT',
          saveToCache: true,
          closedTrades: 'something',
          accountInfo: { some: 'thing' },
          symbolConfiguration: {
            candles: {
              interval: '1m'
            },
            symbols: ['BTCUSDT', 'ETHUSDT']
          },
          other: 'data',
          tradingView: {
            some: 'thing'
          }
        };

        result = await step.execute(logger, rawData);
      });

      it('triggers mongo.upsertOne', () => {
        expect(mongo.upsertOne).toHaveBeenCalledWith(
          logger,
          'trailing-trade-cache',
          {
            symbol: 'BTCUSDT'
          },
          {
            other: 'data',
            saveToCache: true,
            symbol: 'BTCUSDT',
            symbolConfiguration: {
              candles: {
                interval: '1m'
              }
            }
          }
        );
      });

      it('returns expected value', () => {
        expect(result).toStrictEqual(rawData);
      });
    });
  });
});
