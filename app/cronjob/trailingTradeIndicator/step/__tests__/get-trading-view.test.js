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
        interval: '1h',
        expectedInterval: '1h'
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
                'BINANCE:BTCUSDT': {
                  summary: {
                    RECOMMENDATION: 'BUY'
                  }
                }
              }
            }
          });

          rawData = {
            globalConfiguration: { symbols: ['BTCUSDT'] },
            symbolConfiguration: {
              candles: { interval: t.interval },
              botOptions: {
                tradingView: { interval: '' }
              }
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
                symbols: ['BINANCE:BTCUSDT'],
                screener: 'CRYPTO',
                interval: t.expectedInterval
              },
              paramsSerializer: expect.any(Function),
              timeout: 5000
            }
          );
        });

        it('triggers cache.hset', () => {
          expect(cacheMock.hset).toHaveBeenCalledWith(
            'trailing-trade-tradingview',
            'BTCUSDT',
            JSON.stringify({
              request: {
                symbol: 'BTCUSDT',
                screener: 'CRYPTO',
                exchange: 'BINANCE',
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
            globalConfiguration: { symbols: ['BTCUSDT'] },
            symbolConfiguration: {
              candles: { interval: t.interval },
              botOptions: {
                tradingView: { interval: '' }
              }
            },
            tradingView: {
              request: {
                interval: t.expectedInterval
              },
              result: {
                'BINANCE:BTCUSDT': {
                  summary: {
                    RECOMMENDATION: 'BUY'
                  }
                }
              }
            }
          });
        });
      });
    });

    describe('symbol configuration has tradingView interval configured', () => {
      beforeEach(async () => {
        axiosMock.get = jest.fn().mockResolvedValue({
          data: {
            request: {
              interval: '15m'
            },
            result: {
              'BINANCE:BTCUSDT': {
                summary: {
                  RECOMMENDATION: 'BUY'
                }
              }
            }
          }
        });

        rawData = {
          globalConfiguration: { symbols: ['BTCUSDT'] },
          symbolConfiguration: {
            candles: { interval: '1h' },
            botOptions: {
              tradingView: {
                interval: '15m'
              }
            }
          },
          tradingView: {}
        };

        const step = require('../get-trading-view');
        result = await step.execute(loggerMock, rawData);
      });

      it('triggers axios.get', () => {
        expect(axiosMock.get).toHaveBeenCalledWith('http://tradingview:8080', {
          params: {
            symbols: ['BINANCE:BTCUSDT'],
            screener: 'CRYPTO',
            interval: '15m'
          },
          paramsSerializer: expect.any(Function),
          timeout: 5000
        });
      });

      it('triggers cache.hset', () => {
        expect(cacheMock.hset).toHaveBeenCalledWith(
          'trailing-trade-tradingview',
          'BTCUSDT',
          JSON.stringify({
            request: {
              symbol: 'BTCUSDT',
              screener: 'CRYPTO',
              exchange: 'BINANCE',
              interval: '15m'
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
          globalConfiguration: { symbols: ['BTCUSDT'] },
          symbolConfiguration: {
            candles: { interval: '1h' },
            botOptions: {
              tradingView: {
                interval: '15m'
              }
            }
          },
          tradingView: {
            request: {
              interval: '15m'
            },
            result: {
              'BINANCE:BTCUSDT': {
                summary: {
                  RECOMMENDATION: 'BUY'
                }
              }
            }
          }
        });
      });
    });

    describe('when the recommendation is not same as previous recommendation', () => {
      beforeEach(async () => {
        axiosMock.get = jest
          .fn()
          .mockResolvedValueOnce({
            data: {
              request: {
                interval: '15m'
              },
              result: {
                'BINANCE:BTCUSDT': {
                  summary: {
                    RECOMMENDATION: 'BUY'
                  }
                },
                'BINANCE:ETHUSDT': {
                  summary: {
                    RECOMMENDATION: 'BUY'
                  }
                }
              }
            }
          })
          .mockResolvedValueOnce({
            data: {
              request: {
                interval: '15m'
              },
              result: {
                'BINANCE:BTCUSDT': {
                  summary: {
                    RECOMMENDATION: 'SELL'
                  }
                },
                'BINANCE:ETHUSDT': {
                  summary: {
                    RECOMMENDATION: 'SELL'
                  }
                }
              }
            }
          });

        rawData = {
          globalConfiguration: {
            symbols: ['BTCUSDT', 'ETHUSDT']
          },
          symbolConfiguration: {
            candles: { interval: '1h' },
            botOptions: {
              tradingView: {
                interval: '15m'
              }
            }
          },
          tradingView: {}
        };

        loggerMock.info = jest.fn();

        const step = require('../get-trading-view');
        result = await step.execute(loggerMock, rawData);
        result = await step.execute(loggerMock, rawData);
      });

      it('triggers logger.info twice', () => {
        expect(loggerMock.info).toHaveBeenCalledTimes(4);
      });

      it('triggers logger.info with saveLog as true for BTCUSDT', () => {
        expect(loggerMock.info).toHaveBeenCalledWith(
          {
            data: {
              summary: {
                RECOMMENDATION: 'BUY'
              }
            },
            saveLog: true
          },
          `The TradingView technical analysis recommendation for BTCUSDT is "BUY".`
        );

        expect(loggerMock.info).toHaveBeenCalledWith(
          {
            data: {
              summary: {
                RECOMMENDATION: 'SELL'
              }
            },
            saveLog: true
          },
          `The TradingView technical analysis recommendation for BTCUSDT is "SELL".`
        );
      });

      it('triggers logger.info with saveLog as true for ETHUSDT', () => {
        expect(loggerMock.info).toHaveBeenCalledWith(
          {
            data: {
              summary: {
                RECOMMENDATION: 'BUY'
              }
            },
            saveLog: true
          },
          `The TradingView technical analysis recommendation for ETHUSDT is "BUY".`
        );

        expect(loggerMock.info).toHaveBeenCalledWith(
          {
            data: {
              summary: {
                RECOMMENDATION: 'SELL'
              }
            },
            saveLog: true
          },
          `The TradingView technical analysis recommendation for ETHUSDT is "SELL".`
        );
      });
    });

    describe('when the recommendation is same as previous recommendation', () => {
      beforeEach(async () => {
        axiosMock.get = jest
          .fn()
          .mockResolvedValueOnce({
            data: {
              request: {
                interval: '15m'
              },
              result: {
                'BINANCE:BTCUSDT': {
                  summary: {
                    RECOMMENDATION: 'BUY'
                  }
                },
                'BINANCE:ETHUSDT': {
                  summary: {
                    RECOMMENDATION: 'BUY'
                  }
                }
              }
            }
          })
          .mockResolvedValueOnce({
            data: {
              request: {
                interval: '15m'
              },
              result: {
                'BINANCE:BTCUSDT': {
                  summary: {
                    RECOMMENDATION: 'BUY'
                  }
                },
                'BINANCE:ETHUSDT': {
                  summary: {
                    RECOMMENDATION: 'BUY'
                  }
                }
              }
            }
          });

        rawData = {
          globalConfiguration: {
            symbols: ['BTCUSDT', 'ETHUSDT']
          },
          symbolConfiguration: {
            candles: { interval: '1h' },
            botOptions: {
              tradingView: {
                interval: '15m'
              }
            }
          },
          tradingView: {}
        };

        loggerMock.info = jest.fn();

        const step = require('../get-trading-view');
        result = await step.execute(loggerMock, rawData);
        result = await step.execute(loggerMock, rawData);
      });

      it('triggers logger.info twice', () => {
        expect(loggerMock.info).toHaveBeenCalledTimes(4);
      });

      it('triggers logger.info with saveLog as true for first', () => {
        expect(loggerMock.info).toHaveBeenCalledWith(
          {
            data: {
              summary: {
                RECOMMENDATION: 'BUY'
              }
            },
            saveLog: true
          },
          `The TradingView technical analysis recommendation for BTCUSDT is "BUY".`
        );

        expect(loggerMock.info).toHaveBeenCalledWith(
          {
            data: {
              summary: {
                RECOMMENDATION: 'BUY'
              }
            },
            saveLog: true
          },
          `The TradingView technical analysis recommendation for ETHUSDT is "BUY".`
        );
      });

      it('triggers logger.info with saveLog as false for second for ETHUSDT', () => {
        expect(loggerMock.info).toHaveBeenCalledWith(
          {
            data: {
              summary: {
                RECOMMENDATION: 'BUY'
              }
            },
            saveLog: false
          },
          `The TradingView technical analysis recommendation for BTCUSDT is "BUY".`
        );

        expect(loggerMock.info).toHaveBeenCalledWith(
          {
            data: {
              summary: {
                RECOMMENDATION: 'BUY'
              }
            },
            saveLog: false
          },
          `The TradingView technical analysis recommendation for ETHUSDT is "BUY".`
        );
      });
    });

    describe('when tradingview result is empty', () => {
      beforeEach(async () => {
        axiosMock.get = jest.fn().mockResolvedValue({
          data: {}
        });

        rawData = {
          globalConfiguration: { symbols: ['BTCUSDT'] },
          symbolConfiguration: {
            candles: { interval: '1h' },
            botOptions: {
              tradingView: {
                interval: '15m'
              }
            }
          },
          tradingView: {}
        };

        const step = require('../get-trading-view');
        result = await step.execute(loggerMock, rawData);
      });

      it('triggers axios.get', () => {
        expect(axiosMock.get).toHaveBeenCalledWith('http://tradingview:8080', {
          params: {
            symbols: ['BINANCE:BTCUSDT'],
            screener: 'CRYPTO',
            interval: '15m'
          },
          paramsSerializer: expect.any(Function),
          timeout: 5000
        });
      });

      it('does not trigger cache.hset', () => {
        expect(cacheMock.hset).not.toHaveBeenCalled();
      });

      it('retruns expected result', () => {
        expect(result).toStrictEqual({
          globalConfiguration: {
            symbols: ['BTCUSDT']
          },
          symbolConfiguration: {
            candles: { interval: '1h' },
            botOptions: {
              tradingView: { interval: '15m' }
            }
          },
          tradingView: {}
        });
      });
    });

    describe('when tradingview result for symbol is empty', () => {
      beforeEach(async () => {
        axiosMock.get = jest.fn().mockResolvedValue({
          data: {
            request: {
              interval: '15m'
            },
            result: {
              'BINANCE:BTCUSDT': {
                summary: {
                  RECOMMENDATION: 'BUY'
                }
              },
              'BINANCE:ETHUSDT': 'None'
            }
          }
        });

        rawData = {
          globalConfiguration: { symbols: ['BTCUSDT', 'ETHUSDT'] },
          symbolConfiguration: {
            candles: { interval: '1h' },
            botOptions: {
              tradingView: {
                interval: '15m'
              }
            }
          },
          tradingView: {}
        };

        const step = require('../get-trading-view');
        result = await step.execute(loggerMock, rawData);
      });

      it('triggers axios.get', () => {
        expect(axiosMock.get).toHaveBeenCalledWith('http://tradingview:8080', {
          params: {
            symbols: ['BINANCE:BTCUSDT', 'BINANCE:ETHUSDT'],
            screener: 'CRYPTO',
            interval: '15m'
          },
          paramsSerializer: expect.any(Function),
          timeout: 5000
        });
      });

      it('triggers cache.hset once', () => {
        expect(cacheMock.hset).toHaveBeenCalledTimes(1);
      });

      it('triggers cache.hset', () => {
        expect(cacheMock.hset).toHaveBeenCalledWith(
          'trailing-trade-tradingview',
          'BTCUSDT',
          JSON.stringify({
            request: {
              symbol: 'BTCUSDT',
              screener: 'CRYPTO',
              exchange: 'BINANCE',
              interval: '15m'
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
          globalConfiguration: {
            symbols: ['BTCUSDT', 'ETHUSDT']
          },
          symbolConfiguration: {
            candles: { interval: '1h' },
            botOptions: {
              tradingView: { interval: '15m' }
            }
          },
          tradingView: {
            request: {
              interval: '15m'
            },
            result: {
              'BINANCE:BTCUSDT': {
                summary: {
                  RECOMMENDATION: 'BUY'
                }
              },
              'BINANCE:ETHUSDT': 'None'
            }
          }
        });
      });
    });

    describe(`when axios throws an error`, () => {
      beforeEach(async () => {
        axiosMock.get = jest
          .fn()
          .mockRejectedValue(new Error('something happened'));

        rawData = {
          globalConfiguration: {
            symbols: ['BTCUSDT', 'ETHUSDT']
          },
          symbolConfiguration: {
            candles: { interval: '15m' },
            botOptions: {
              tradingView: { interval: '' }
            }
          },
          tradingView: {}
        };

        const step = require('../get-trading-view');
        result = await step.execute(loggerMock, rawData);
      });

      it('triggers axios.get', () => {
        expect(axiosMock.get).toHaveBeenCalledWith('http://tradingview:8080', {
          params: {
            symbols: ['BINANCE:BTCUSDT', 'BINANCE:ETHUSDT'],
            screener: 'CRYPTO',
            interval: '15m'
          },
          paramsSerializer: expect.any(Function),
          timeout: 5000
        });
      });

      it('does not trigger cache.hset', () => {
        expect(cacheMock.hset).not.toHaveBeenCalled();
      });

      it('retruns expected result', () => {
        expect(result).toStrictEqual({
          globalConfiguration: {
            symbols: ['BTCUSDT', 'ETHUSDT']
          },
          symbolConfiguration: {
            candles: { interval: '15m' },
            botOptions: {
              tradingView: { interval: '' }
            }
          },
          tradingView: {}
        });
      });
    });
  });
});
