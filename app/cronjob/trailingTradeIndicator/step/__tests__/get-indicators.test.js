/* eslint-disable global-require */

describe('get-indicators.js', () => {
  let binanceMock;
  let rawData;

  let step;
  let result;

  beforeEach(() => {
    jest.clearAllMocks().resetModules();
  });

  describe('execute', () => {
    beforeEach(async () => {
      const { binance, logger } = require('../../../../helpers');
      binanceMock = binance;

      binanceMock.client = {};
      binanceMock.client.candles = jest
        .fn()
        .mockResolvedValue(require('./fixtures/binance-candles.json'));

      step = require('../get-indicators');

      rawData = {
        symbol: 'BTCUSDT',
        symbolConfiguration: {
          candles: { interval: '1h', limit: 50 }
        }
      };

      result = await step.execute(logger, rawData);
    });

    it('retruns expected data', () => {
      expect(result).toStrictEqual({
        symbol: 'BTCUSDT',
        symbolConfiguration: {
          candles: {
            interval: '1h',
            limit: 50
          }
        },
        indicators: {
          highestPrice: 15960,
          lowestPrice: 8893.03
        }
      });
    });
  });
});
