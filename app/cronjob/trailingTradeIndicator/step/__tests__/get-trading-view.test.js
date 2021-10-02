/* eslint-disable global-require */
describe('get-trading-view.js', () => {
  let result;
  let rawData;

  let cacheMock;
  let loggerMock;
  let axiosMock;

  describe('execute', () => {
    beforeEach(() => {
      jest.clearAllMocks().resetModules();

      axiosMock = require('axios');
      jest.mock('axios');

      const { cache, logger } = require('../../../../helpers');

      cacheMock = cache;
      loggerMock = logger;

      cacheMock.hset = jest.fn().mockResolvedValue(true);
    });

    [
      {
        interval: '1m',
        expectedInterval: '1m'
      },
      {
        interval: '3m',
        expectedInterval: '5m'
      },
      {
        interval: '5m',
        expectedInterval: '5m'
      },
      {
        interval: '15m',
        expectedInterval: '15m'
      },
      {
        interval: '30m',
        expectedInterval: '1h'
      },
      {
        interval: '1h',
        expectedInterval: '1h'
      },
      {
        interval: '2h',
        expectedInterval: '4h'
      },
      {
        interval: '4h',
        expectedInterval: '4h'
      },
      {
        interval: '1d',
        expectedInterval: '1d'
      }
    ].forEach(t => {
      describe(`${t.interval}`, () => {
        beforeEach(async () => {
          axiosMock.get = jest.fn().mockResolvedValue({
            data: {
              request: {
                interval: t.expectedInterval
              },
              result: {
                summary: {
                  RECOMMENDATION: 'BUY'
                }
              }
            }
          });

          rawData = {
            symbol: 'BTCUSDT',
            symbolConfiguration: {
              candles: { interval: t.interval }
            },
            tradingView: {}
          };

          const step = require('../get-trading-view');
          result = await step.execute(loggerMock, rawData);
        });

        it('triggers axios.get', () => {
          expect(axiosMock.get).toHaveBeenCalledWith(
            'http://tradingview:8080',
            {
              params: {
                symbol: 'BTCUSDT',
                screener: 'CRYPTO',
                exchange: 'BINANCE',
                interval: t.expectedInterval
              }
            }
          );
        });

        it('triggers cache.hset', () => {
          expect(cacheMock.hset).toHaveBeenCalledWith(
            'trailing-trade-tradingview',
            'BTCUSDT',
            JSON.stringify({
              request: {
                interval: t.expectedInterval
              },
              result: {
                summary: {
                  RECOMMENDATION: 'BUY'
                }
              }
            })
          );
        });

        it('retruns expected result', () => {
          expect(result).toStrictEqual({
            symbol: 'BTCUSDT',
            symbolConfiguration: {
              candles: { interval: t.interval }
            },
            tradingView: {
              request: {
                interval: t.expectedInterval
              },
              result: {
                summary: {
                  RECOMMENDATION: 'BUY'
                }
              }
            }
          });
        });
      });
    });

    describe(`when axios throws an error`, () => {
      beforeEach(async () => {
        axiosMock.get = jest
          .fn()
          .mockRejectedValue(new Error('something happened'));

        rawData = {
          symbol: 'BTCUSDT',
          symbolConfiguration: {
            candles: { interval: '15m' }
          },
          tradingView: {}
        };

        const step = require('../get-trading-view');
        result = await step.execute(loggerMock, rawData);
      });

      it('triggers axios.get', () => {
        expect(axiosMock.get).toHaveBeenCalledWith('http://tradingview:8080', {
          params: {
            symbol: 'BTCUSDT',
            screener: 'CRYPTO',
            exchange: 'BINANCE',
            interval: '15m'
          }
        });
      });

      it('does not trigger cache.hset', () => {
        expect(cacheMock.hset).not.toHaveBeenCalled();
      });

      it('retruns expected result', () => {
        expect(result).toStrictEqual({
          symbol: 'BTCUSDT',
          symbolConfiguration: {
            candles: { interval: '15m' }
          },
          tradingView: {}
        });
      });
    });
  });
});
