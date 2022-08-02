/* eslint-disable global-require */

describe('get-trading-view.js', () => {
  let rawData;

  let cacheMock;
  let loggerMock;
  let axiosMock;

  let mockHandleError;

  describe('execute', () => {
    beforeEach(() => {
      jest.clearAllMocks().resetModules();

      axiosMock = require('axios');
      jest.mock('axios');

      const { cache, logger } = require('../../../../helpers');

      cacheMock = cache;
      loggerMock = logger;

      cacheMock.hset = jest.fn().mockResolvedValue(true);

      mockHandleError = jest.fn().mockResolvedValue(true);
      jest.mock('../../../../error-handler', () => ({
        handleError: mockHandleError
      }));
    });

    describe('when there are symbols in the global configuration', () => {
      describe('when symbols does not have custom interval for trading view', () => {
        beforeEach(async () => {
          rawData = {
            globalConfiguration: {
              symbols: ['BTCUSDT', 'BNBUSDT']
            }
          };

          cacheMock.hgetall = jest
            .fn()
            .mockResolvedValueOnce({
              BTCUSDT: JSON.stringify({
                candles: { interval: '1h', limit: 100 },
                botOptions: {
                  tradingView: {
                    interval: ''
                  },
                  autoTriggerBuy: {
                    conditions: {
                      tradingView: {
                        overrideInterval: ''
                      }
                    }
                  }
                }
              }),
              BNBUSDT: JSON.stringify({
                candles: { interval: '1h', limit: 100 },
                botOptions: {
                  tradingView: {
                    interval: ''
                  },
                  autoTriggerBuy: {
                    conditions: {
                      tradingView: {
                        overrideInterval: ''
                      }
                    }
                  }
                }
              }),
              global: JSON.stringify({
                candles: { interval: '1h', limit: 100 },
                botOptions: {
                  tradingView: {
                    interval: '15m'
                  },
                  autoTriggerBuy: {
                    conditions: {
                      tradingView: {
                        overrideInterval: ''
                      }
                    }
                  }
                }
              })
            })
            .mockResolvedValueOnce({});

          axiosMock.get = jest.fn().mockResolvedValue({
            data: {
              request: {
                symbols: ['BINANCE:BTCUSDT', 'BINANCE:BNBUSDT'],
                screener: 'CRYPTO',
                interval: '1h'
              },
              result: {
                'BINANCE:BTCUSDT': {
                  summary: {
                    RECOMMENDATION: 'BUY'
                  },
                  time: '2021-10-30T08:53:53.973250'
                },
                'BINANCE:BNBUSDT': {
                  summary: {
                    RECOMMENDATION: 'SELL'
                  },
                  time: '2021-10-30T08:53:53.973250'
                }
              }
            }
          });

          const step = require('../get-trading-view');

          await step.execute(loggerMock, rawData);
        });

        it('triggers cache.hgetall', () => {
          expect(cacheMock.hgetall).toHaveBeenCalledWith(
            'trailing-trade-configurations:',
            'trailing-trade-configurations:*'
          );
        });

        it('triggers axios.get', () => {
          expect(axiosMock.get).toHaveBeenCalledWith(
            'http://tradingview:8080',
            {
              params: {
                symbols: ['BINANCE:BTCUSDT', 'BINANCE:BNBUSDT'],
                screener: 'CRYPTO',
                interval: '1h'
              },
              paramsSerializer: expect.any(Function),
              timeout: 20000
            }
          );
        });

        it('triggers cache.hset twice', () => {
          expect(cacheMock.hset).toHaveBeenCalledTimes(2);
        });

        it('triggers cache.hset for symbols', () => {
          expect(cacheMock.hset).toHaveBeenCalledWith(
            'trailing-trade-tradingview',
            'BTCUSDT',
            JSON.stringify({
              request: {
                symbol: 'BTCUSDT',
                screener: 'CRYPTO',
                exchange: 'BINANCE',
                interval: '1h'
              },
              result: {
                summary: {
                  RECOMMENDATION: 'BUY'
                },
                time: '2021-10-30T08:53:53.973250'
              }
            })
          );

          expect(cacheMock.hset).toHaveBeenCalledWith(
            'trailing-trade-tradingview',
            'BNBUSDT',
            JSON.stringify({
              request: {
                symbol: 'BNBUSDT',
                screener: 'CRYPTO',
                exchange: 'BINANCE',
                interval: '1h'
              },
              result: {
                summary: {
                  RECOMMENDATION: 'SELL'
                },
                time: '2021-10-30T08:53:53.973250'
              }
            })
          );
        });

        it("saves logger.info for symbols because there isn't existing recommendation", () => {
          expect(loggerMock.info).toHaveBeenCalledWith(
            {
              symbol: 'BTCUSDT',
              data: {
                summary: {
                  RECOMMENDATION: 'BUY'
                },
                time: '2021-10-30T08:53:53.973250'
              },
              saveLog: true
            },
            `The TradingView technical analysis recommendation for BTCUSDT is "BUY".`
          );

          expect(loggerMock.info).toHaveBeenCalledWith(
            {
              symbol: 'BNBUSDT',
              data: {
                summary: {
                  RECOMMENDATION: 'SELL'
                },
                time: '2021-10-30T08:53:53.973250'
              },
              saveLog: true
            },
            `The TradingView technical analysis recommendation for BNBUSDT is "SELL".`
          );
        });
      });

      describe('when symbols have custom interval for trading view', () => {
        beforeEach(async () => {
          rawData = {
            globalConfiguration: {
              symbols: ['BTCUSDT', 'BNBUSDT']
            }
          };

          cacheMock.hgetall = jest
            .fn()
            .mockResolvedValueOnce({
              BTCUSDT: JSON.stringify({
                candles: { interval: '1h', limit: 100 },
                botOptions: {
                  tradingView: {
                    interval: '15m'
                  },
                  autoTriggerBuy: {
                    conditions: {
                      tradingView: {
                        overrideInterval: ''
                      }
                    }
                  }
                }
              }),
              BNBUSDT: JSON.stringify({
                candles: { interval: '1h', limit: 100 },
                botOptions: {
                  tradingView: {
                    interval: '3m'
                  },
                  autoTriggerBuy: {
                    conditions: {
                      tradingView: {
                        overrideInterval: ''
                      }
                    }
                  }
                }
              })
            })
            .mockResolvedValueOnce({});

          axiosMock.get = jest
            .fn()
            .mockResolvedValueOnce({
              data: {
                request: {
                  symbols: ['BINANCE:BTCUSDT'],
                  screener: 'CRYPTO',
                  interval: '15m'
                },
                result: {
                  'BINANCE:BTCUSDT': {
                    summary: {
                      RECOMMENDATION: 'NEUTRAL'
                    },
                    time: '2021-10-30T08:53:53.973250'
                  }
                }
              }
            })
            .mockResolvedValueOnce({
              data: {
                request: {
                  symbols: ['BINANCE:BNBUSDT'],
                  screener: 'CRYPTO',
                  interval: '5m'
                },
                result: {
                  'BINANCE:BNBUSDT': {
                    summary: {
                      RECOMMENDATION: 'BUY'
                    },
                    time: '2021-10-30T08:53:53.973250'
                  }
                }
              }
            });

          const step = require('../get-trading-view');

          await step.execute(loggerMock, rawData);
        });

        it('triggers axios.get twice', () => {
          expect(axiosMock.get).toHaveBeenCalledTimes(2);
        });

        it('triggers axios.get', () => {
          expect(axiosMock.get).toHaveBeenCalledWith(
            'http://tradingview:8080',
            {
              params: {
                symbols: ['BINANCE:BTCUSDT'],
                screener: 'CRYPTO',
                interval: '15m'
              },
              paramsSerializer: expect.any(Function),
              timeout: 20000
            }
          );

          expect(axiosMock.get).toHaveBeenCalledWith(
            'http://tradingview:8080',
            {
              params: {
                symbols: ['BINANCE:BNBUSDT'],
                screener: 'CRYPTO',
                interval: '5m'
              },
              paramsSerializer: expect.any(Function),
              timeout: 20000
            }
          );
        });

        it('triggers cache.hset twice', () => {
          expect(cacheMock.hset).toHaveBeenCalledTimes(2);
        });

        it('triggers cache.hset for symbols', () => {
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
                  RECOMMENDATION: 'NEUTRAL'
                },
                time: '2021-10-30T08:53:53.973250'
              }
            })
          );

          expect(cacheMock.hset).toHaveBeenCalledWith(
            'trailing-trade-tradingview',
            'BNBUSDT',
            JSON.stringify({
              request: {
                symbol: 'BNBUSDT',
                screener: 'CRYPTO',
                exchange: 'BINANCE',
                interval: '5m'
              },
              result: {
                summary: {
                  RECOMMENDATION: 'BUY'
                },
                time: '2021-10-30T08:53:53.973250'
              }
            })
          );
        });

        it("saves logger.info for symbols because there isn't existing recommendation", () => {
          expect(loggerMock.info).toHaveBeenCalledWith(
            {
              symbol: 'BTCUSDT',
              data: {
                summary: {
                  RECOMMENDATION: 'NEUTRAL'
                },
                time: '2021-10-30T08:53:53.973250'
              },
              saveLog: true
            },
            `The TradingView technical analysis recommendation for BTCUSDT is "NEUTRAL".`
          );

          expect(loggerMock.info).toHaveBeenCalledWith(
            {
              symbol: 'BNBUSDT',
              data: {
                summary: {
                  RECOMMENDATION: 'BUY'
                },
                time: '2021-10-30T08:53:53.973250'
              },
              saveLog: true
            },
            `The TradingView technical analysis recommendation for BNBUSDT is "BUY".`
          );
        });
      });

      describe('when symbols have override data for trading view', () => {
        describe('when symbol have override interval for trading view', () => {
          beforeEach(async () => {
            rawData = {
              globalConfiguration: {
                symbols: ['BTCUSDT', 'BNBUSDT']
              }
            };

            cacheMock.hgetall = jest
              .fn()
              .mockResolvedValueOnce({
                BTCUSDT: JSON.stringify({
                  candles: { interval: '1h', limit: 100 },
                  botOptions: {
                    tradingView: {
                      interval: '15m'
                    },
                    autoTriggerBuy: {
                      conditions: {
                        tradingView: {
                          overrideInterval: '30m'
                        }
                      }
                    }
                  }
                }),
                BNBUSDT: JSON.stringify({
                  candles: { interval: '1h', limit: 100 },
                  botOptions: {
                    tradingView: {
                      interval: '3m'
                    },
                    autoTriggerBuy: {
                      conditions: {
                        tradingView: {
                          overrideInterval: '1m'
                        }
                      }
                    }
                  }
                })
              })
              .mockResolvedValueOnce({
                BNBUSDT: JSON.stringify({
                  action: 'buy',
                  actionAt: '2022-06-07T11:50:22+00:00',
                  triggeredBy: 'auto-trigger',
                  notify: true,
                  checkTradingView: true
                })
              });

            axiosMock.get = jest
              .fn()
              .mockResolvedValueOnce({
                data: {
                  request: {
                    symbols: ['BINANCE:BTCUSDT'],
                    screener: 'CRYPTO',
                    interval: '15m'
                  },
                  result: {
                    'BINANCE:BTCUSDT': {
                      summary: {
                        RECOMMENDATION: 'NEUTRAL'
                      },
                      time: '2021-10-30T08:53:53.973250'
                    }
                  }
                }
              })
              .mockResolvedValueOnce({
                data: {
                  request: {
                    symbols: ['BINANCE:BNBUSDT'],
                    screener: 'CRYPTO',
                    interval: '1m'
                  },
                  result: {
                    'BINANCE:BNBUSDT': {
                      summary: {
                        RECOMMENDATION: 'BUY'
                      },
                      time: '2021-10-30T08:53:53.973250'
                    }
                  }
                }
              });

            const step = require('../get-trading-view');

            await step.execute(loggerMock, rawData);
          });

          it('triggers axios.get twice', () => {
            expect(axiosMock.get).toHaveBeenCalledTimes(2);
          });

          it('triggers axios.get', () => {
            expect(axiosMock.get).toHaveBeenCalledWith(
              'http://tradingview:8080',
              {
                params: {
                  symbols: ['BINANCE:BTCUSDT'],
                  screener: 'CRYPTO',
                  interval: '15m'
                },
                paramsSerializer: expect.any(Function),
                timeout: 20000
              }
            );

            expect(axiosMock.get).toHaveBeenCalledWith(
              'http://tradingview:8080',
              {
                params: {
                  symbols: ['BINANCE:BNBUSDT'],
                  screener: 'CRYPTO',
                  interval: '1m'
                },
                paramsSerializer: expect.any(Function),
                timeout: 20000
              }
            );
          });

          it('triggers cache.hset twice', () => {
            expect(cacheMock.hset).toHaveBeenCalledTimes(2);
          });

          it('triggers cache.hset for symbols', () => {
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
                    RECOMMENDATION: 'NEUTRAL'
                  },
                  time: '2021-10-30T08:53:53.973250'
                }
              })
            );

            expect(cacheMock.hset).toHaveBeenCalledWith(
              'trailing-trade-tradingview',
              'BNBUSDT',
              JSON.stringify({
                request: {
                  symbol: 'BNBUSDT',
                  screener: 'CRYPTO',
                  exchange: 'BINANCE',
                  interval: '1m'
                },
                result: {
                  summary: {
                    RECOMMENDATION: 'BUY'
                  },
                  time: '2021-10-30T08:53:53.973250'
                }
              })
            );
          });

          it("saves logger.info for symbols because there isn't existing recommendation", () => {
            expect(loggerMock.info).toHaveBeenCalledWith(
              {
                symbol: 'BTCUSDT',
                data: {
                  summary: {
                    RECOMMENDATION: 'NEUTRAL'
                  },
                  time: '2021-10-30T08:53:53.973250'
                },
                saveLog: true
              },
              `The TradingView technical analysis recommendation for BTCUSDT is "NEUTRAL".`
            );

            expect(loggerMock.info).toHaveBeenCalledWith(
              {
                symbol: 'BNBUSDT',
                data: {
                  summary: {
                    RECOMMENDATION: 'BUY'
                  },
                  time: '2021-10-30T08:53:53.973250'
                },
                saveLog: true
              },
              `The TradingView technical analysis recommendation for BNBUSDT is "BUY".`
            );
          });
        });

        describe('when symbol does not have override interval for trading view', () => {
          beforeEach(async () => {
            rawData = {
              globalConfiguration: {
                symbols: ['BTCUSDT', 'BNBUSDT']
              }
            };

            cacheMock.hgetall = jest
              .fn()
              .mockResolvedValueOnce({
                BTCUSDT: JSON.stringify({
                  candles: { interval: '1h', limit: 100 },
                  botOptions: {
                    tradingView: {
                      interval: '15m'
                    },
                    autoTriggerBuy: {
                      conditions: {
                        tradingView: {
                          overrideInterval: '30m'
                        }
                      }
                    }
                  }
                }),
                BNBUSDT: JSON.stringify({
                  candles: { interval: '1h', limit: 100 },
                  botOptions: {
                    tradingView: {
                      interval: '3m'
                    },
                    autoTriggerBuy: {
                      conditions: {
                        tradingView: {
                          overrideInterval: ''
                        }
                      }
                    }
                  }
                })
              })
              .mockResolvedValueOnce({
                BNBUSDT: JSON.stringify({
                  action: 'buy',
                  actionAt: '2022-06-07T11:50:22+00:00',
                  triggeredBy: 'auto-trigger',
                  notify: true,
                  checkTradingView: true
                })
              });

            axiosMock.get = jest
              .fn()
              .mockResolvedValueOnce({
                data: {
                  request: {
                    symbols: ['BINANCE:BTCUSDT'],
                    screener: 'CRYPTO',
                    interval: '15m'
                  },
                  result: {
                    'BINANCE:BTCUSDT': {
                      summary: {
                        RECOMMENDATION: 'NEUTRAL'
                      },
                      time: '2021-10-30T08:53:53.973250'
                    }
                  }
                }
              })
              .mockResolvedValueOnce({
                data: {
                  request: {
                    symbols: ['BINANCE:BNBUSDT'],
                    screener: 'CRYPTO',
                    interval: '1m'
                  },
                  result: {
                    'BINANCE:BNBUSDT': {
                      summary: {
                        RECOMMENDATION: 'BUY'
                      },
                      time: '2021-10-30T08:53:53.973250'
                    }
                  }
                }
              });

            const step = require('../get-trading-view');

            await step.execute(loggerMock, rawData);
          });

          it('triggers axios.get twice', () => {
            expect(axiosMock.get).toHaveBeenCalledTimes(2);
          });

          it('triggers axios.get', () => {
            expect(axiosMock.get).toHaveBeenCalledWith(
              'http://tradingview:8080',
              {
                params: {
                  symbols: ['BINANCE:BTCUSDT'],
                  screener: 'CRYPTO',
                  interval: '15m'
                },
                paramsSerializer: expect.any(Function),
                timeout: 20000
              }
            );

            expect(axiosMock.get).toHaveBeenCalledWith(
              'http://tradingview:8080',
              {
                params: {
                  symbols: ['BINANCE:BNBUSDT'],
                  screener: 'CRYPTO',
                  interval: '5m'
                },
                paramsSerializer: expect.any(Function),
                timeout: 20000
              }
            );
          });

          it('triggers cache.hset twice', () => {
            expect(cacheMock.hset).toHaveBeenCalledTimes(2);
          });

          it('triggers cache.hset for symbols', () => {
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
                    RECOMMENDATION: 'NEUTRAL'
                  },
                  time: '2021-10-30T08:53:53.973250'
                }
              })
            );

            expect(cacheMock.hset).toHaveBeenCalledWith(
              'trailing-trade-tradingview',
              'BNBUSDT',
              JSON.stringify({
                request: {
                  symbol: 'BNBUSDT',
                  screener: 'CRYPTO',
                  exchange: 'BINANCE',
                  interval: '5m'
                },
                result: {
                  summary: {
                    RECOMMENDATION: 'BUY'
                  },
                  time: '2021-10-30T08:53:53.973250'
                }
              })
            );
          });

          it("saves logger.info for symbols because there isn't existing recommendation", () => {
            expect(loggerMock.info).toHaveBeenCalledWith(
              {
                symbol: 'BTCUSDT',
                data: {
                  summary: {
                    RECOMMENDATION: 'NEUTRAL'
                  },
                  time: '2021-10-30T08:53:53.973250'
                },
                saveLog: true
              },
              `The TradingView technical analysis recommendation for BTCUSDT is "NEUTRAL".`
            );

            expect(loggerMock.info).toHaveBeenCalledWith(
              {
                symbol: 'BNBUSDT',
                data: {
                  summary: {
                    RECOMMENDATION: 'BUY'
                  },
                  time: '2021-10-30T08:53:53.973250'
                },
                saveLog: true
              },
              `The TradingView technical analysis recommendation for BNBUSDT is "BUY".`
            );
          });
        });
      });

      describe('when there are existing recommendations', () => {
        describe('recommendation is same', () => {
          beforeEach(async () => {
            rawData = {
              globalConfiguration: {
                symbols: ['BTCUSDT', 'BNBUSDT']
              }
            };

            cacheMock.hgetall = jest
              .fn()
              .mockResolvedValueOnce({
                BTCUSDT: JSON.stringify({
                  candles: { interval: '1h', limit: 100 },
                  botOptions: {
                    tradingView: {
                      interval: '15m'
                    },
                    autoTriggerBuy: {
                      conditions: {
                        tradingView: {
                          overrideInterval: ''
                        }
                      }
                    }
                  }
                }),
                BNBUSDT: JSON.stringify({
                  candles: { interval: '1h', limit: 100 },
                  botOptions: {
                    tradingView: {
                      interval: '3m'
                    },
                    autoTriggerBuy: {
                      conditions: {
                        tradingView: {
                          overrideInterval: ''
                        }
                      }
                    }
                  }
                })
              })
              .mockResolvedValueOnce({})
              .mockResolvedValueOnce({
                BTCUSDT: JSON.stringify({
                  candles: { interval: '1h', limit: 100 },
                  botOptions: {
                    tradingView: {
                      interval: '15m'
                    },
                    autoTriggerBuy: {
                      conditions: {
                        tradingView: {
                          overrideInterval: ''
                        }
                      }
                    }
                  }
                }),
                BNBUSDT: JSON.stringify({
                  candles: { interval: '1h', limit: 100 },
                  botOptions: {
                    tradingView: {
                      interval: '3m'
                    },
                    autoTriggerBuy: {
                      conditions: {
                        tradingView: {
                          overrideInterval: ''
                        }
                      }
                    }
                  }
                })
              })
              .mockResolvedValueOnce({});

            axiosMock.get = jest
              .fn()
              .mockResolvedValueOnce({
                data: {
                  request: {
                    symbols: ['BINANCE:BTCUSDT'],
                    screener: 'CRYPTO',
                    interval: '15m'
                  },
                  result: {
                    'BINANCE:BTCUSDT': {
                      summary: {
                        RECOMMENDATION: 'NEUTRAL'
                      },
                      time: '2021-10-30T08:53:53.973250'
                    }
                  }
                }
              })
              .mockResolvedValueOnce({
                data: {
                  request: {
                    symbols: ['BINANCE:BNBUSDT'],
                    screener: 'CRYPTO',
                    interval: '5m'
                  },
                  result: {
                    'BINANCE:BNBUSDT': {
                      summary: {
                        RECOMMENDATION: 'BUY'
                      },
                      time: '2021-10-30T08:53:53.973250'
                    }
                  }
                }
              })
              .mockResolvedValueOnce({
                data: {
                  request: {
                    symbols: ['BINANCE:BTCUSDT'],
                    screener: 'CRYPTO',
                    interval: '15m'
                  },
                  result: {
                    'BINANCE:BTCUSDT': {
                      summary: {
                        RECOMMENDATION: 'NEUTRAL'
                      },
                      time: '2021-10-30T08:54:53.973250'
                    }
                  }
                }
              })
              .mockResolvedValueOnce({
                data: {
                  request: {
                    symbols: ['BINANCE:BNBUSDT'],
                    screener: 'CRYPTO',
                    interval: '5m'
                  },
                  result: {
                    'BINANCE:BNBUSDT': {
                      summary: {
                        RECOMMENDATION: 'BUY'
                      },
                      time: '2021-10-30T08:54:53.973250'
                    }
                  }
                }
              });

            const step = require('../get-trading-view');

            // Execute twice
            await step.execute(loggerMock, rawData);
            await step.execute(loggerMock, rawData);
          });

          it('triggers axios.get 4 times', () => {
            expect(axiosMock.get).toHaveBeenCalledTimes(4);
          });

          it('triggers axios.get', () => {
            expect(axiosMock.get).toHaveBeenCalledWith(
              'http://tradingview:8080',
              {
                params: {
                  symbols: ['BINANCE:BTCUSDT'],
                  screener: 'CRYPTO',
                  interval: '15m'
                },
                paramsSerializer: expect.any(Function),
                timeout: 20000
              }
            );

            expect(axiosMock.get).toHaveBeenCalledWith(
              'http://tradingview:8080',
              {
                params: {
                  symbols: ['BINANCE:BNBUSDT'],
                  screener: 'CRYPTO',
                  interval: '5m'
                },
                paramsSerializer: expect.any(Function),
                timeout: 20000
              }
            );
          });

          it('triggers cache.hset 4', () => {
            expect(cacheMock.hset).toHaveBeenCalledTimes(4);
          });

          it('triggers cache.hset for symbols', () => {
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
                    RECOMMENDATION: 'NEUTRAL'
                  },
                  time: '2021-10-30T08:53:53.973250'
                }
              })
            );

            expect(cacheMock.hset).toHaveBeenCalledWith(
              'trailing-trade-tradingview',
              'BNBUSDT',
              JSON.stringify({
                request: {
                  symbol: 'BNBUSDT',
                  screener: 'CRYPTO',
                  exchange: 'BINANCE',
                  interval: '5m'
                },
                result: {
                  summary: {
                    RECOMMENDATION: 'BUY'
                  },
                  time: '2021-10-30T08:53:53.973250'
                }
              })
            );

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
                    RECOMMENDATION: 'NEUTRAL'
                  },
                  time: '2021-10-30T08:54:53.973250'
                }
              })
            );

            expect(cacheMock.hset).toHaveBeenCalledWith(
              'trailing-trade-tradingview',
              'BNBUSDT',
              JSON.stringify({
                request: {
                  symbol: 'BNBUSDT',
                  screener: 'CRYPTO',
                  exchange: 'BINANCE',
                  interval: '5m'
                },
                result: {
                  summary: {
                    RECOMMENDATION: 'BUY'
                  },
                  time: '2021-10-30T08:54:53.973250'
                }
              })
            );
          });

          it("saves logger.info for symbols because there isn't existing recommendation for first time", () => {
            expect(loggerMock.info).toHaveBeenCalledWith(
              {
                symbol: 'BTCUSDT',
                data: {
                  summary: {
                    RECOMMENDATION: 'NEUTRAL'
                  },
                  time: '2021-10-30T08:53:53.973250'
                },
                saveLog: true
              },
              `The TradingView technical analysis recommendation for BTCUSDT is "NEUTRAL".`
            );

            expect(loggerMock.info).toHaveBeenCalledWith(
              {
                symbol: 'BNBUSDT',
                data: {
                  summary: {
                    RECOMMENDATION: 'BUY'
                  },
                  time: '2021-10-30T08:53:53.973250'
                },
                saveLog: true
              },
              `The TradingView technical analysis recommendation for BNBUSDT is "BUY".`
            );
          });

          it(
            `does not save logger.info for symbols ` +
              `because there isn't existing recommendation for second time`,
            () => {
              expect(loggerMock.info).toHaveBeenCalledWith(
                {
                  symbol: 'BTCUSDT',
                  data: {
                    summary: {
                      RECOMMENDATION: 'NEUTRAL'
                    },
                    time: '2021-10-30T08:54:53.973250'
                  },
                  saveLog: false
                },
                `The TradingView technical analysis recommendation for BTCUSDT is "NEUTRAL".`
              );

              expect(loggerMock.info).toHaveBeenCalledWith(
                {
                  symbol: 'BNBUSDT',
                  data: {
                    summary: {
                      RECOMMENDATION: 'BUY'
                    },
                    time: '2021-10-30T08:54:53.973250'
                  },
                  saveLog: false
                },
                `The TradingView technical analysis recommendation for BNBUSDT is "BUY".`
              );
            }
          );
        });

        describe('recommendation is different', () => {
          beforeEach(async () => {
            rawData = {
              globalConfiguration: {
                symbols: ['BTCUSDT', 'BNBUSDT']
              }
            };

            cacheMock.hgetall = jest
              .fn()
              .mockResolvedValueOnce({
                BTCUSDT: JSON.stringify({
                  candles: { interval: '1h', limit: 100 },
                  botOptions: {
                    tradingView: {
                      interval: '15m'
                    },
                    autoTriggerBuy: {
                      conditions: {
                        tradingView: {
                          overrideInterval: ''
                        }
                      }
                    }
                  }
                }),
                BNBUSDT: JSON.stringify({
                  candles: { interval: '1h', limit: 100 },
                  botOptions: {
                    tradingView: {
                      interval: '3m'
                    },
                    autoTriggerBuy: {
                      conditions: {
                        tradingView: {
                          overrideInterval: ''
                        }
                      }
                    }
                  }
                })
              })
              .mockResolvedValueOnce({})
              .mockResolvedValueOnce({
                BTCUSDT: JSON.stringify({
                  candles: { interval: '1h', limit: 100 },
                  botOptions: {
                    tradingView: {
                      interval: '15m'
                    },
                    autoTriggerBuy: {
                      conditions: {
                        tradingView: {
                          overrideInterval: ''
                        }
                      }
                    }
                  }
                }),
                BNBUSDT: JSON.stringify({
                  candles: { interval: '1h', limit: 100 },
                  botOptions: {
                    tradingView: {
                      interval: '3m'
                    },
                    autoTriggerBuy: {
                      conditions: {
                        tradingView: {
                          overrideInterval: ''
                        }
                      }
                    }
                  }
                })
              })
              .mockResolvedValueOnce({});

            axiosMock.get = jest
              .fn()
              .mockResolvedValueOnce({
                data: {
                  request: {
                    symbols: ['BINANCE:BTCUSDT'],
                    screener: 'CRYPTO',
                    interval: '15m'
                  },
                  result: {
                    'BINANCE:BTCUSDT': {
                      summary: {
                        RECOMMENDATION: 'NEUTRAL'
                      },
                      time: '2021-10-30T08:53:53.973250'
                    }
                  }
                }
              })
              .mockResolvedValueOnce({
                data: {
                  request: {
                    symbols: ['BINANCE:BNBUSDT'],
                    screener: 'CRYPTO',
                    interval: '5m'
                  },
                  result: {
                    'BINANCE:BNBUSDT': {
                      summary: {
                        RECOMMENDATION: 'BUY'
                      },
                      time: '2021-10-30T08:53:53.973250'
                    }
                  }
                }
              })
              .mockResolvedValueOnce({
                data: {
                  request: {
                    symbols: ['BINANCE:BTCUSDT'],
                    screener: 'CRYPTO',
                    interval: '15m'
                  },
                  result: {
                    'BINANCE:BTCUSDT': {
                      summary: {
                        RECOMMENDATION: 'BUY'
                      },
                      time: '2021-10-30T08:54:53.973250'
                    }
                  }
                }
              })
              .mockResolvedValueOnce({
                data: {
                  request: {
                    symbols: ['BINANCE:BNBUSDT'],
                    screener: 'CRYPTO',
                    interval: '5m'
                  },
                  result: {
                    'BINANCE:BNBUSDT': {
                      summary: {
                        RECOMMENDATION: 'SELL'
                      },
                      time: '2021-10-30T08:54:53.973250'
                    }
                  }
                }
              });

            const step = require('../get-trading-view');

            // Execute twice
            await step.execute(loggerMock, rawData);
            await step.execute(loggerMock, rawData);
          });

          it('triggers axios.get 4 times', () => {
            expect(axiosMock.get).toHaveBeenCalledTimes(4);
          });

          it('triggers axios.get', () => {
            expect(axiosMock.get).toHaveBeenCalledWith(
              'http://tradingview:8080',
              {
                params: {
                  symbols: ['BINANCE:BTCUSDT'],
                  screener: 'CRYPTO',
                  interval: '15m'
                },
                paramsSerializer: expect.any(Function),
                timeout: 20000
              }
            );

            expect(axiosMock.get).toHaveBeenCalledWith(
              'http://tradingview:8080',
              {
                params: {
                  symbols: ['BINANCE:BNBUSDT'],
                  screener: 'CRYPTO',
                  interval: '5m'
                },
                paramsSerializer: expect.any(Function),
                timeout: 20000
              }
            );
          });

          it('triggers cache.hset 4', () => {
            expect(cacheMock.hset).toHaveBeenCalledTimes(4);
          });

          it('triggers cache.hset for symbols', () => {
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
                    RECOMMENDATION: 'NEUTRAL'
                  },
                  time: '2021-10-30T08:53:53.973250'
                }
              })
            );

            expect(cacheMock.hset).toHaveBeenCalledWith(
              'trailing-trade-tradingview',
              'BNBUSDT',
              JSON.stringify({
                request: {
                  symbol: 'BNBUSDT',
                  screener: 'CRYPTO',
                  exchange: 'BINANCE',
                  interval: '5m'
                },
                result: {
                  summary: {
                    RECOMMENDATION: 'BUY'
                  },
                  time: '2021-10-30T08:53:53.973250'
                }
              })
            );

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
                  },
                  time: '2021-10-30T08:54:53.973250'
                }
              })
            );

            expect(cacheMock.hset).toHaveBeenCalledWith(
              'trailing-trade-tradingview',
              'BNBUSDT',
              JSON.stringify({
                request: {
                  symbol: 'BNBUSDT',
                  screener: 'CRYPTO',
                  exchange: 'BINANCE',
                  interval: '5m'
                },
                result: {
                  summary: {
                    RECOMMENDATION: 'SELL'
                  },
                  time: '2021-10-30T08:54:53.973250'
                }
              })
            );
          });

          it("saves logger.info for symbols because there isn't existing recommendation for first time", () => {
            expect(loggerMock.info).toHaveBeenCalledWith(
              {
                symbol: 'BTCUSDT',
                data: {
                  summary: {
                    RECOMMENDATION: 'NEUTRAL'
                  },
                  time: '2021-10-30T08:53:53.973250'
                },
                saveLog: true
              },
              `The TradingView technical analysis recommendation for BTCUSDT is "NEUTRAL".`
            );

            expect(loggerMock.info).toHaveBeenCalledWith(
              {
                symbol: 'BNBUSDT',
                data: {
                  summary: {
                    RECOMMENDATION: 'BUY'
                  },
                  time: '2021-10-30T08:53:53.973250'
                },
                saveLog: true
              },
              `The TradingView technical analysis recommendation for BNBUSDT is "BUY".`
            );
          });

          it(
            `saves logger.info for symbols ` +
              `because recommendation is different`,
            () => {
              expect(loggerMock.info).toHaveBeenCalledWith(
                {
                  symbol: 'BTCUSDT',
                  data: {
                    summary: {
                      RECOMMENDATION: 'BUY'
                    },
                    time: '2021-10-30T08:54:53.973250'
                  },
                  saveLog: true
                },
                `The TradingView technical analysis recommendation for BTCUSDT is "BUY".`
              );

              expect(loggerMock.info).toHaveBeenCalledWith(
                {
                  symbol: 'BNBUSDT',
                  data: {
                    summary: {
                      RECOMMENDATION: 'SELL'
                    },
                    time: '2021-10-30T08:54:53.973250'
                  },
                  saveLog: true
                },
                `The TradingView technical analysis recommendation for BNBUSDT is "SELL".`
              );
            }
          );
        });
      });
    });
    describe('when cache.hset throws an error', () => {
      beforeEach(async () => {
        rawData = {
          globalConfiguration: {
            symbols: ['BTCUSDT', 'BNBUSDT']
          }
        };

        cacheMock.hgetall = jest
          .fn()
          .mockResolvedValueOnce({
            BTCUSDT: JSON.stringify({
              candles: { interval: '1h', limit: 100 },
              botOptions: {
                tradingView: {
                  interval: ''
                },
                autoTriggerBuy: {
                  conditions: {
                    tradingView: {
                      overrideInterval: ''
                    }
                  }
                }
              }
            }),
            BNBUSDT: JSON.stringify({
              candles: { interval: '1h', limit: 100 },
              botOptions: {
                tradingView: {
                  interval: ''
                },
                autoTriggerBuy: {
                  conditions: {
                    tradingView: {
                      overrideInterval: ''
                    }
                  }
                }
              }
            }),
            global: JSON.stringify({
              candles: { interval: '1h', limit: 100 },
              botOptions: {
                tradingView: {
                  interval: '15m'
                },
                autoTriggerBuy: {
                  conditions: {
                    tradingView: {
                      overrideInterval: ''
                    }
                  }
                }
              }
            })
          })
          .mockResolvedValueOnce({});

        axiosMock.get = jest.fn().mockResolvedValue({
          data: {
            request: {
              symbols: ['BINANCE:BTCUSDT', 'BINANCE:BNBUSDT'],
              screener: 'CRYPTO',
              interval: '1h'
            },
            result: {
              'BINANCE:BTCUSDT': {
                summary: {
                  RECOMMENDATION: 'BUY'
                },
                time: '2021-10-30T08:53:53.973250'
              },
              'BINANCE:BNBUSDT': {
                summary: {
                  RECOMMENDATION: 'SELL'
                },
                time: '2021-10-30T08:53:53.973250'
              }
            }
          }
        });

        cacheMock.hset = jest
          .fn()
          .mockRejectedValue(new Error('something went wrong'));

        const step = require('../get-trading-view');

        await step.execute(loggerMock, rawData);
      });

      it('triggers cache.hgetall', () => {
        expect(cacheMock.hgetall).toHaveBeenCalledWith(
          'trailing-trade-configurations:',
          'trailing-trade-configurations:*'
        );
      });

      it('triggers axios.get', () => {
        expect(axiosMock.get).toHaveBeenCalledWith('http://tradingview:8080', {
          params: {
            symbols: ['BINANCE:BTCUSDT', 'BINANCE:BNBUSDT'],
            screener: 'CRYPTO',
            interval: '1h'
          },
          paramsSerializer: expect.any(Function),
          timeout: 20000
        });
      });

      it('triggers cache.hset for symbols', () => {
        expect(cacheMock.hset).toHaveBeenCalledWith(
          'trailing-trade-tradingview',
          'BTCUSDT',
          JSON.stringify({
            request: {
              symbol: 'BTCUSDT',
              screener: 'CRYPTO',
              exchange: 'BINANCE',
              interval: '1h'
            },
            result: {
              summary: {
                RECOMMENDATION: 'BUY'
              },
              time: '2021-10-30T08:53:53.973250'
            }
          })
        );

        expect(cacheMock.hset).toHaveBeenCalledWith(
          'trailing-trade-tradingview',
          'BNBUSDT',
          JSON.stringify({
            request: {
              symbol: 'BNBUSDT',
              screener: 'CRYPTO',
              exchange: 'BINANCE',
              interval: '1h'
            },
            result: {
              summary: {
                RECOMMENDATION: 'SELL'
              },
              time: '2021-10-30T08:53:53.973250'
            }
          })
        );
      });

      it('triggers handleError', () => {
        expect(mockHandleError).toHaveBeenCalled();
      });
    });

    describe('when tradingview returns no result', () => {
      beforeEach(async () => {
        rawData = {
          globalConfiguration: {
            symbols: ['BTCUSDT', 'BNBUSDT']
          }
        };

        cacheMock.hgetall = jest
          .fn()
          .mockResolvedValueOnce({
            BTCUSDT: JSON.stringify({
              candles: { interval: '1h', limit: 100 },
              botOptions: {
                tradingView: {
                  interval: ''
                },
                autoTriggerBuy: {
                  conditions: {
                    tradingView: {
                      overrideInterval: ''
                    }
                  }
                }
              }
            }),
            BNBUSDT: JSON.stringify({
              candles: { interval: '1h', limit: 100 },
              botOptions: {
                tradingView: {
                  interval: ''
                },
                autoTriggerBuy: {
                  conditions: {
                    tradingView: {
                      overrideInterval: ''
                    }
                  }
                }
              }
            }),
            global: JSON.stringify({
              candles: { interval: '1h', limit: 100 },
              botOptions: {
                tradingView: {
                  interval: '15m'
                },
                autoTriggerBuy: {
                  conditions: {
                    tradingView: {
                      overrideInterval: ''
                    }
                  }
                }
              }
            })
          })
          .mockResolvedValueOnce({});

        axiosMock.get = jest.fn().mockResolvedValue({});

        const step = require('../get-trading-view');

        await step.execute(loggerMock, rawData);
      });

      it('triggers cache.hgetall', () => {
        expect(cacheMock.hgetall).toHaveBeenCalledWith(
          'trailing-trade-configurations:',
          'trailing-trade-configurations:*'
        );
      });

      it('triggers axios.get', () => {
        expect(axiosMock.get).toHaveBeenCalledWith('http://tradingview:8080', {
          params: {
            symbols: ['BINANCE:BTCUSDT', 'BINANCE:BNBUSDT'],
            screener: 'CRYPTO',
            interval: '1h'
          },
          paramsSerializer: expect.any(Function),
          timeout: 20000
        });
      });

      it('does not trigger cache.hset for symbols', () => {
        expect(cacheMock.hset).not.toHaveBeenCalled();
      });
    });

    describe('when tradingview returns without recommendation', () => {
      beforeEach(async () => {
        rawData = {
          globalConfiguration: {
            symbols: ['BTCUSDT', 'BNBUSDT']
          }
        };

        cacheMock.hgetall = jest
          .fn()
          .mockResolvedValueOnce({
            BTCUSDT: JSON.stringify({
              candles: { interval: '1h', limit: 100 },
              botOptions: {
                tradingView: {
                  interval: ''
                },
                autoTriggerBuy: {
                  conditions: {
                    tradingView: {
                      overrideInterval: ''
                    }
                  }
                }
              }
            }),
            BNBUSDT: JSON.stringify({
              candles: { interval: '1h', limit: 100 },
              botOptions: {
                tradingView: {
                  interval: ''
                },
                autoTriggerBuy: {
                  conditions: {
                    tradingView: {
                      overrideInterval: ''
                    }
                  }
                }
              }
            }),
            global: JSON.stringify({
              candles: { interval: '1h', limit: 100 },
              botOptions: {
                tradingView: {
                  interval: '15m'
                },
                autoTriggerBuy: {
                  conditions: {
                    tradingView: {
                      overrideInterval: ''
                    }
                  }
                }
              }
            })
          })
          .mockResolvedValueOnce({});

        axiosMock.get = jest.fn().mockResolvedValue({
          data: {
            request: {
              symbols: ['BINANCE:BTCUSDT', 'BINANCE:BNBUSDT'],
              screener: 'CRYPTO',
              interval: '1h'
            },
            result: {
              'BINANCE:BTCUSDT': {
                summary: {},
                time: '2021-10-30T08:53:53.973250'
              },
              'BINANCE:BNBUSDT': {
                summary: {},
                time: '2021-10-30T08:53:53.973250'
              }
            }
          }
        });

        const step = require('../get-trading-view');

        await step.execute(loggerMock, rawData);
      });

      it('triggers cache.hgetall', () => {
        expect(cacheMock.hgetall).toHaveBeenCalledWith(
          'trailing-trade-configurations:',
          'trailing-trade-configurations:*'
        );
      });

      it('triggers axios.get', () => {
        expect(axiosMock.get).toHaveBeenCalledWith('http://tradingview:8080', {
          params: {
            symbols: ['BINANCE:BTCUSDT', 'BINANCE:BNBUSDT'],
            screener: 'CRYPTO',
            interval: '1h'
          },
          paramsSerializer: expect.any(Function),
          timeout: 20000
        });
      });

      it('does not trigger cache.hset for symbols', () => {
        expect(cacheMock.hset).not.toHaveBeenCalled();
      });
    });

    describe('when tradingview throws an error', () => {
      beforeEach(async () => {
        rawData = {
          globalConfiguration: {
            symbols: ['BTCUSDT', 'BNBUSDT']
          }
        };

        cacheMock.hgetall = jest
          .fn()
          .mockResolvedValueOnce({
            BTCUSDT: JSON.stringify({
              candles: { interval: '1h', limit: 100 },
              botOptions: {
                tradingView: {
                  interval: ''
                },
                autoTriggerBuy: {
                  conditions: {
                    tradingView: {
                      overrideInterval: ''
                    }
                  }
                }
              }
            }),
            BNBUSDT: JSON.stringify({
              candles: { interval: '1h', limit: 100 },
              botOptions: {
                tradingView: {
                  interval: ''
                },
                autoTriggerBuy: {
                  conditions: {
                    tradingView: {
                      overrideInterval: ''
                    }
                  }
                }
              }
            }),
            global: JSON.stringify({
              candles: { interval: '1h', limit: 100 },
              botOptions: {
                tradingView: {
                  interval: '15m'
                }
              },
              autoTriggerBuy: {
                conditions: {
                  tradingView: {
                    overrideInterval: ''
                  }
                }
              }
            })
          })
          .mockResolvedValueOnce({});

        axiosMock.get = jest.fn().mockRejectedValue(new Error('timeout'));

        const step = require('../get-trading-view');

        await step.execute(loggerMock, rawData);
      });

      it('triggers cache.hgetall', () => {
        expect(cacheMock.hgetall).toHaveBeenCalledWith(
          'trailing-trade-configurations:',
          'trailing-trade-configurations:*'
        );
      });

      it('triggers axios.get', () => {
        expect(axiosMock.get).toHaveBeenCalledWith('http://tradingview:8080', {
          params: {
            symbols: ['BINANCE:BTCUSDT', 'BINANCE:BNBUSDT'],
            screener: 'CRYPTO',
            interval: '1h'
          },
          paramsSerializer: expect.any(Function),
          timeout: 20000
        });
      });

      it('does not trigger cache.hset for symbols', () => {
        expect(cacheMock.hset).not.toHaveBeenCalled();
      });
    });

    describe('when there is no symbols in the global configuration', () => {
      beforeEach(async () => {
        rawData = {
          globalConfiguration: {
            symbols: []
          }
        };

        cacheMock.hgetall = jest
          .fn()
          .mockResolvedValueOnce({})
          .mockResolvedValueOnce({});

        axiosMock.get = jest.fn().mockRejectedValue(new Error('timeout'));

        const step = require('../get-trading-view');

        await step.execute(loggerMock, rawData);
      });

      it('does not trigger cache.hgetall', () => {
        expect(cacheMock.hgetall).not.toHaveBeenCalled();
      });

      it('does not trigger axios.get', () => {
        expect(axiosMock.get).not.toHaveBeenCalled();
      });

      it('does not trigger cache.hset for symbols', () => {
        expect(cacheMock.hset).not.toHaveBeenCalled();
      });
    });
  });
});
