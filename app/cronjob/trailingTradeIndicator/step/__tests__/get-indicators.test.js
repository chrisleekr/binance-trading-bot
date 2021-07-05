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
    describe('when buy ATH restriction is disabled', () => {
      beforeEach(async () => {
        const { binance, logger } = require('../../../../helpers');
        binanceMock = binance;

        binanceMock.client = {};
        binanceMock.client.candles = jest
          .fn()
          .mockResolvedValueOnce(require('./fixtures/binance-candles.json'))
          .mockResolvedValueOnce(
            require('./fixtures/bianance-candles-1d-7limit.json')
          );

        step = require('../get-indicators');

        rawData = {
          symbol: 'BTCUSDT',
          symbolConfiguration: {
            candles: { interval: '1h', limit: 50 },
            buy: {
              athRestriction: {
                enabled: false,
                candles: {
                  interval: '1d',
                  limit: 7
                }
              }
            }
          }
        };

        result = await step.execute(logger, rawData);
      });

      it('triggers binance.client.candles once', () => {
        expect(binanceMock.client.candles).toBeCalledTimes(1);
      });

      it('triggers binance.client.candles for high/low prices', () => {
        expect(binanceMock.client.candles).toHaveBeenCalledWith({
          symbol: 'BTCUSDT',
          interval: '1h',
          limit: 50
        });
      });

      it('does not trigger binance.client.candles for ATH price', () => {
        expect(binanceMock.client.candles).not.toHaveBeenCalledWith({
          symbol: 'BTCUSDT',
          interval: '1d',
          limit: 7
        });
      });

      it('retruns expected data', () => {
        expect(result).toStrictEqual({
          symbol: 'BTCUSDT',
          symbolConfiguration: {
            candles: {
              interval: '1h',
              limit: 50
            },
            buy: {
              athRestriction: {
                enabled: false,
                candles: {
                  interval: '1d',
                  limit: 7
                }
              }
            }
          },
          indicators: {
            highestPrice: 15960,
            lowestPrice: 8893.03,
            athPrice: null
          }
        });
      });
    });

    describe('when buy ATH restriction is enabled', () => {
      beforeEach(async () => {
        const { binance, logger } = require('../../../../helpers');
        binanceMock = binance;

        binanceMock.client = {};
        binanceMock.client.candles = jest
          .fn()
          .mockResolvedValueOnce(require('./fixtures/binance-candles.json'))
          .mockResolvedValueOnce(
            require('./fixtures/bianance-candles-1d-7limit.json')
          );

        step = require('../get-indicators');

        rawData = {
          symbol: 'BTCUSDT',
          symbolConfiguration: {
            candles: { interval: '1h', limit: 50 },
            buy: {
              athRestriction: {
                enabled: true,
                candles: {
                  interval: '1d',
                  limit: 7
                }
              }
            }
          }
        };

        result = await step.execute(logger, rawData);
      });

      it('triggers binance.client.candles twice', () => {
        expect(binanceMock.client.candles).toBeCalledTimes(2);
      });

      it('triggers binance.client.candles for high/low prices', () => {
        expect(binanceMock.client.candles).toHaveBeenCalledWith({
          symbol: 'BTCUSDT',
          interval: '1h',
          limit: 50
        });
      });

      it('triggers binance.client.candles for ATH price', () => {
        expect(binanceMock.client.candles).toHaveBeenCalledWith({
          symbol: 'BTCUSDT',
          interval: '1d',
          limit: 7
        });
      });

      it('retruns expected data', () => {
        expect(result).toStrictEqual({
          symbol: 'BTCUSDT',
          symbolConfiguration: {
            candles: {
              interval: '1h',
              limit: 50
            },
            buy: {
              athRestriction: {
                enabled: true,
                candles: {
                  interval: '1d',
                  limit: 7
                }
              }
            }
          },
          indicators: {
            highestPrice: 15960,
            lowestPrice: 8893.03,
            athPrice: 112925.66
          }
        });
      });
    });
  });
});
