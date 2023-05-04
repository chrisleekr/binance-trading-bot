/* eslint-disable global-require */

describe('get-tradingview.js', () => {
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
      cacheMock.hdel = jest.fn().mockResolvedValue(true);

      mockHandleError = jest.fn().mockResolvedValue(true);
      jest.mock('../../../../error-handler', () => ({
        handleError: mockHandleError
      }));
    });

    describe('when there are symbols in the global configuration', () => {
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
                  tradingViews: [
                    {
                      interval: '5m',
                      buy: {
                        whenStrongBuy: true,
                        whenBuy: true
                      },
                      sell: {
                        forceSellOverZeroBelowTriggerPrice: {
                          whenNeutral: false,
                          whenSell: true,
                          whenStrongSell: true
                        }
                      }
                    },
                    {
                      interval: '15m',
                      buy: {
                        whenStrongBuy: true,
                        whenBuy: true
                      },
                      sell: {
                        forceSellOverZeroBelowTriggerPrice: {
                          whenNeutral: false,
                          whenSell: true,
                          whenStrongSell: true
                        }
                      }
                    }
                  ]
                }
              }),
              BNBUSDT: JSON.stringify({
                candles: { interval: '1h', limit: 100 },
                botOptions: {
                  tradingViews: [
                    {
                      interval: '5m',
                      buy: {
                        whenStrongBuy: true,
                        whenBuy: true
                      },
                      sell: {
                        forceSellOverZeroBelowTriggerPrice: {
                          whenNeutral: false,
                          whenSell: true,
                          whenStrongSell: true
                        }
                      }
                    },
                    {
                      interval: '30m',
                      buy: {
                        whenStrongBuy: true,
                        whenBuy: true
                      },
                      sell: {
                        forceSellOverZeroBelowTriggerPrice: {
                          whenNeutral: false,
                          whenSell: true,
                          whenStrongSell: true
                        }
                      }
                    }
                  ]
                }
              })
            })
            .mockResolvedValueOnce({
              'BTCUSDT:5m': JSON.stringify({
                request: {
                  symbol: 'BTCUSDT',
                  interval: '5m'
                },
                result: {
                  summary: {
                    RECOMMENDATION: 'NEUTRAL'
                  },
                  time: '2021-10-30T08:53:53.973250'
                }
              }),
              'BTCUSDT:1d': JSON.stringify({
                request: {
                  symbol: 'BTCUSDT',
                  interval: '1d'
                },
                result: {
                  summary: {
                    RECOMMENDATION: 'NEUTRAL'
                  },
                  time: '2021-10-30T08:53:53.973250'
                }
              })
            });

          axiosMock.get = jest
            .fn()
            .mockResolvedValueOnce({
              data: {
                request: {
                  symbols: ['BINANCE:BTCUSDT', 'BINANCE:BNBUSDT'],
                  screener: 'CRYPTO',
                  interval: '5m'
                },
                result: {
                  'BINANCE:BTCUSDT': {
                    summary: {
                      RECOMMENDATION: 'NEUTRAL'
                    },
                    time: '2021-10-30T08:53:53.973250'
                  },
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
                  interval: '30m'
                },
                result: {
                  'BINANCE:BNBUSDT': {
                    summary: {
                      RECOMMENDATION: 'STRONG_BUY'
                    },
                    time: '2021-10-30T08:53:53.973250'
                  }
                }
              }
            });

          const step = require('../get-tradingview');

          await step.execute(loggerMock, rawData);
        });

        it('triggers axios.get three times', () => {
          expect(axiosMock.get).toHaveBeenCalledTimes(3);
        });

        it('triggers axios.get', () => {
          expect(axiosMock.get).toHaveBeenCalledWith(
            'http://tradingview:8080',
            {
              params: {
                symbols: ['BINANCE:BTCUSDT', 'BINANCE:BNBUSDT'],
                screener: 'CRYPTO',
                interval: '5m'
              },
              paramsSerializer: expect.any(Function),
              timeout: 20000
            }
          );

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
                interval: '30m'
              },
              paramsSerializer: expect.any(Function),
              timeout: 20000
            }
          );
        });

        it('triggers cache.hset four times', () => {
          expect(cacheMock.hset).toHaveBeenCalledTimes(4);
        });

        it('triggers cache.hset for symbols', () => {
          expect(cacheMock.hset).toHaveBeenCalledWith(
            'trailing-trade-tradingview',
            'BTCUSDT:5m',
            JSON.stringify({
              request: {
                symbol: 'BTCUSDT',
                screener: 'CRYPTO',
                exchange: 'BINANCE',
                interval: '5m'
              },
              result: {
                summary: { RECOMMENDATION: 'NEUTRAL' },
                time: '2021-10-30T08:53:53.973250'
              }
            })
          );

          expect(cacheMock.hset).toHaveBeenCalledWith(
            'trailing-trade-tradingview',
            'BNBUSDT:5m',
            JSON.stringify({
              request: {
                symbol: 'BNBUSDT',
                screener: 'CRYPTO',
                exchange: 'BINANCE',
                interval: '5m'
              },
              result: {
                summary: { RECOMMENDATION: 'BUY' },
                time: '2021-10-30T08:53:53.973250'
              }
            })
          );

          expect(cacheMock.hset).toHaveBeenCalledWith(
            'trailing-trade-tradingview',
            'BTCUSDT:15m',
            JSON.stringify({
              request: {
                symbol: 'BTCUSDT',
                screener: 'CRYPTO',
                exchange: 'BINANCE',
                interval: '15m'
              },
              result: {
                summary: { RECOMMENDATION: 'BUY' },
                time: '2021-10-30T08:53:53.973250'
              }
            })
          );

          expect(cacheMock.hset).toHaveBeenCalledWith(
            'trailing-trade-tradingview',
            'BNBUSDT:30m',
            JSON.stringify({
              request: {
                symbol: 'BNBUSDT',
                screener: 'CRYPTO',
                exchange: 'BINANCE',
                interval: '30m'
              },
              result: {
                summary: { RECOMMENDATION: 'STRONG_BUY' },
                time: '2021-10-30T08:53:53.973250'
              }
            })
          );
        });

        it('triggers cache.hdel to remove unmonitored interval', () => {
          expect(cacheMock.hdel).toHaveBeenCalledWith(
            'trailing-trade-tradingview',
            'BTCUSDT:1d'
          );
        });

        it("saves logger.info for symbols because there isn't existing recommendation", () => {
          expect(loggerMock.info).toHaveBeenCalledWith(
            {
              symbol: 'BTCUSDT',
              interval: '5m',
              data: {
                summary: { RECOMMENDATION: 'NEUTRAL' },
                time: '2021-10-30T08:53:53.973250'
              },
              saveLog: true
            },
            `The TradingView technical analysis recommendation for BTCUSDT:5m is "NEUTRAL".`
          );

          expect(loggerMock.info).toHaveBeenCalledWith(
            {
              symbol: 'BNBUSDT',
              interval: '5m',
              data: {
                summary: { RECOMMENDATION: 'BUY' },
                time: '2021-10-30T08:53:53.973250'
              },
              saveLog: true
            },
            `The TradingView technical analysis recommendation for BNBUSDT:5m is "BUY".`
          );

          expect(loggerMock.info).toHaveBeenCalledWith(
            {
              symbol: 'BTCUSDT',
              interval: '15m',
              data: {
                summary: { RECOMMENDATION: 'BUY' },
                time: '2021-10-30T08:53:53.973250'
              },
              saveLog: true
            },
            `The TradingView technical analysis recommendation for BTCUSDT:15m is "BUY".`
          );

          expect(loggerMock.info).toHaveBeenCalledWith(
            {
              symbol: 'BNBUSDT',
              interval: '30m',
              data: {
                summary: { RECOMMENDATION: 'STRONG_BUY' },
                time: '2021-10-30T08:53:53.973250'
              },
              saveLog: true
            },
            `The TradingView technical analysis recommendation for BNBUSDT:30m is "STRONG_BUY".`
          );
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
                    tradingViews: [
                      {
                        interval: '5m',
                        buy: {
                          whenStrongBuy: true,
                          whenBuy: true
                        },
                        sell: {
                          forceSellOverZeroBelowTriggerPrice: {
                            whenNeutral: false,
                            whenSell: true,
                            whenStrongSell: true
                          }
                        }
                      },
                      {
                        interval: '15m',
                        buy: {
                          whenStrongBuy: true,
                          whenBuy: true
                        },
                        sell: {
                          forceSellOverZeroBelowTriggerPrice: {
                            whenNeutral: false,
                            whenSell: true,
                            whenStrongSell: true
                          }
                        }
                      }
                    ]
                  }
                }),
                BNBUSDT: JSON.stringify({
                  candles: { interval: '1h', limit: 100 },
                  botOptions: {
                    tradingViews: [
                      {
                        interval: '5m',
                        buy: {
                          whenStrongBuy: true,
                          whenBuy: true
                        },
                        sell: {
                          forceSellOverZeroBelowTriggerPrice: {
                            whenNeutral: false,
                            whenSell: true,
                            whenStrongSell: true
                          }
                        }
                      },
                      {
                        interval: '30m',
                        buy: {
                          whenStrongBuy: true,
                          whenBuy: true
                        },
                        sell: {
                          forceSellOverZeroBelowTriggerPrice: {
                            whenNeutral: false,
                            whenSell: true,
                            whenStrongSell: true
                          }
                        }
                      }
                    ]
                  }
                })
              })
              .mockResolvedValueOnce({
                'BTCUSDT:5m': JSON.stringify({
                  request: {
                    symbol: 'BTCUSDT',
                    interval: '5m'
                  },
                  result: {
                    summary: {
                      RECOMMENDATION: 'NEUTRAL'
                    },
                    time: '2021-10-30T08:53:53.973250'
                  }
                }),
                'BTCUSDT:1d': JSON.stringify({
                  request: {
                    symbol: 'BTCUSDT',
                    interval: '1d'
                  },
                  result: {
                    summary: {
                      RECOMMENDATION: 'NEUTRAL'
                    },
                    time: '2021-10-30T08:53:53.973250'
                  }
                })
              })
              .mockResolvedValueOnce({
                BTCUSDT: JSON.stringify({
                  candles: { interval: '1h', limit: 100 },
                  botOptions: {
                    tradingViews: [
                      {
                        interval: '5m',
                        buy: {
                          whenStrongBuy: true,
                          whenBuy: true
                        },
                        sell: {
                          forceSellOverZeroBelowTriggerPrice: {
                            whenNeutral: false,
                            whenSell: true,
                            whenStrongSell: true
                          }
                        }
                      },
                      {
                        interval: '15m',
                        buy: {
                          whenStrongBuy: true,
                          whenBuy: true
                        },
                        sell: {
                          forceSellOverZeroBelowTriggerPrice: {
                            whenNeutral: false,
                            whenSell: true,
                            whenStrongSell: true
                          }
                        }
                      }
                    ]
                  }
                }),
                BNBUSDT: JSON.stringify({
                  candles: { interval: '1h', limit: 100 },
                  botOptions: {
                    tradingViews: [
                      {
                        interval: '5m',
                        buy: {
                          whenStrongBuy: true,
                          whenBuy: true
                        },
                        sell: {
                          forceSellOverZeroBelowTriggerPrice: {
                            whenNeutral: false,
                            whenSell: true,
                            whenStrongSell: true
                          }
                        }
                      },
                      {
                        interval: '30m',
                        buy: {
                          whenStrongBuy: true,
                          whenBuy: true
                        },
                        sell: {
                          forceSellOverZeroBelowTriggerPrice: {
                            whenNeutral: false,
                            whenSell: true,
                            whenStrongSell: true
                          }
                        }
                      }
                    ]
                  }
                })
              })
              .mockResolvedValueOnce({});

            axiosMock.get = jest
              .fn()
              .mockResolvedValueOnce({
                data: {
                  request: {
                    symbols: ['BINANCE:BTCUSDT', 'BINANCE:BNBUSDT'],
                    screener: 'CRYPTO',
                    interval: '5m'
                  },
                  result: {
                    'BINANCE:BTCUSDT': {
                      summary: {
                        RECOMMENDATION: 'NEUTRAL'
                      },
                      time: '2021-10-30T08:53:53.973250'
                    },
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
                    interval: '30m'
                  },
                  result: {
                    'BINANCE:BNBUSDT': {
                      summary: {
                        RECOMMENDATION: 'STRONG_BUY'
                      },
                      time: '2021-10-30T08:53:53.973250'
                    }
                  }
                }
              })
              .mockResolvedValueOnce({
                data: {
                  request: {
                    symbols: ['BINANCE:BTCUSDT', 'BINANCE:BNBUSDT'],
                    screener: 'CRYPTO',
                    interval: '5m'
                  },
                  result: {
                    'BINANCE:BTCUSDT': {
                      summary: {
                        RECOMMENDATION: 'NEUTRAL'
                      },
                      time: '2021-10-30T08:54:53.973250'
                    },
                    'BINANCE:BNBUSDT': {
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
                    interval: '30m'
                  },
                  result: {
                    'BINANCE:BNBUSDT': {
                      summary: {
                        RECOMMENDATION: 'STRONG_BUY'
                      },
                      time: '2021-10-30T08:54:53.973250'
                    }
                  }
                }
              });

            const step = require('../get-tradingview');

            await step.execute(loggerMock, rawData);
            await step.execute(loggerMock, rawData);
          });

          it('triggers axios.get six times', () => {
            expect(axiosMock.get).toHaveBeenCalledTimes(6);
          });

          it('triggers cache.hset eight times', () => {
            expect(cacheMock.hset).toHaveBeenCalledTimes(8);
          });

          it("saves logger.info for symbols because there isn't existing recommendation for first time", () => {
            expect(loggerMock.info).toHaveBeenCalledWith(
              {
                symbol: 'BTCUSDT',
                interval: '5m',
                data: {
                  summary: { RECOMMENDATION: 'NEUTRAL' },
                  time: '2021-10-30T08:53:53.973250'
                },
                saveLog: true
              },
              `The TradingView technical analysis recommendation for BTCUSDT:5m is "NEUTRAL".`
            );

            expect(loggerMock.info).toHaveBeenCalledWith(
              {
                symbol: 'BNBUSDT',
                interval: '5m',
                data: {
                  summary: { RECOMMENDATION: 'BUY' },
                  time: '2021-10-30T08:53:53.973250'
                },
                saveLog: true
              },
              `The TradingView technical analysis recommendation for BNBUSDT:5m is "BUY".`
            );

            expect(loggerMock.info).toHaveBeenCalledWith(
              {
                symbol: 'BTCUSDT',
                interval: '15m',
                data: {
                  summary: { RECOMMENDATION: 'BUY' },
                  time: '2021-10-30T08:53:53.973250'
                },
                saveLog: true
              },
              `The TradingView technical analysis recommendation for BTCUSDT:15m is "BUY".`
            );

            expect(loggerMock.info).toHaveBeenCalledWith(
              {
                symbol: 'BNBUSDT',
                interval: '30m',
                data: {
                  summary: { RECOMMENDATION: 'STRONG_BUY' },
                  time: '2021-10-30T08:53:53.973250'
                },
                saveLog: true
              },
              `The TradingView technical analysis recommendation for BNBUSDT:30m is "STRONG_BUY".`
            );
          });

          it(
            `does not save logger.info for symbols ` +
              `because there isn't existing recommendation for second time`,
            () => {
              expect(loggerMock.info).not.toHaveBeenCalledWith(
                {
                  symbol: 'BTCUSDT',
                  interval: '5m',
                  data: {
                    summary: { RECOMMENDATION: 'NEUTRAL' },
                    time: '2021-10-30T08:54:53.973250'
                  },
                  saveLog: true
                },
                `The TradingView technical analysis recommendation for BTCUSDT:5m is "NEUTRAL".`
              );

              expect(loggerMock.info).not.toHaveBeenCalledWith(
                {
                  symbol: 'BNBUSDT',
                  interval: '5m',
                  data: {
                    summary: { RECOMMENDATION: 'BUY' },
                    time: '2021-10-30T08:54:53.973250'
                  },
                  saveLog: true
                },
                `The TradingView technical analysis recommendation for BNBUSDT:5m is "BUY".`
              );

              expect(loggerMock.info).not.toHaveBeenCalledWith(
                {
                  symbol: 'BTCUSDT',
                  interval: '15m',
                  data: {
                    summary: { RECOMMENDATION: 'BUY' },
                    time: '2021-10-30T08:54:53.973250'
                  },
                  saveLog: true
                },
                `The TradingView technical analysis recommendation for BTCUSDT:15m is "BUY".`
              );

              expect(loggerMock.info).not.toHaveBeenCalledWith(
                {
                  symbol: 'BNBUSDT',
                  interval: '30m',
                  data: {
                    summary: { RECOMMENDATION: 'STRONG_BUY' },
                    time: '2021-10-30T08:54:53.973250'
                  },
                  saveLog: true
                },
                `The TradingView technical analysis recommendation for BNBUSDT:30m is "STRONG_BUY".`
              );
            }
          );

          it('triggers cache.hdel to remove unmonitored interval', () => {
            expect(cacheMock.hdel).toHaveBeenCalledWith(
              'trailing-trade-tradingview',
              'BTCUSDT:1d'
            );
          });
        });

        describe('reecomendation is different', () => {
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
                    tradingViews: [
                      {
                        interval: '5m',
                        buy: {
                          whenStrongBuy: true,
                          whenBuy: true
                        },
                        sell: {
                          forceSellOverZeroBelowTriggerPrice: {
                            whenNeutral: false,
                            whenSell: true,
                            whenStrongSell: true
                          }
                        }
                      },
                      {
                        interval: '15m',
                        buy: {
                          whenStrongBuy: true,
                          whenBuy: true
                        },
                        sell: {
                          forceSellOverZeroBelowTriggerPrice: {
                            whenNeutral: false,
                            whenSell: true,
                            whenStrongSell: true
                          }
                        }
                      }
                    ]
                  }
                }),
                BNBUSDT: JSON.stringify({
                  candles: { interval: '1h', limit: 100 },
                  botOptions: {
                    tradingViews: [
                      {
                        interval: '5m',
                        buy: {
                          whenStrongBuy: true,
                          whenBuy: true
                        },
                        sell: {
                          forceSellOverZeroBelowTriggerPrice: {
                            whenNeutral: false,
                            whenSell: true,
                            whenStrongSell: true
                          }
                        }
                      },
                      {
                        interval: '30m',
                        buy: {
                          whenStrongBuy: true,
                          whenBuy: true
                        },
                        sell: {
                          forceSellOverZeroBelowTriggerPrice: {
                            whenNeutral: false,
                            whenSell: true,
                            whenStrongSell: true
                          }
                        }
                      }
                    ]
                  }
                })
              })
              .mockResolvedValueOnce({
                'BTCUSDT:5m': JSON.stringify({
                  request: {
                    symbol: 'BTCUSDT',
                    interval: '5m'
                  },
                  result: {
                    summary: {
                      RECOMMENDATION: 'NEUTRAL'
                    },
                    time: '2021-10-30T08:53:53.973250'
                  }
                }),
                'BTCUSDT:1d': JSON.stringify({
                  request: {
                    symbol: 'BTCUSDT',
                    interval: '1d'
                  },
                  result: {
                    summary: {
                      RECOMMENDATION: 'NEUTRAL'
                    },
                    time: '2021-10-30T08:53:53.973250'
                  }
                })
              })
              .mockResolvedValueOnce({
                BTCUSDT: JSON.stringify({
                  candles: { interval: '1h', limit: 100 },
                  botOptions: {
                    tradingViews: [
                      {
                        interval: '5m',
                        buy: {
                          whenStrongBuy: true,
                          whenBuy: true
                        },
                        sell: {
                          forceSellOverZeroBelowTriggerPrice: {
                            whenNeutral: false,
                            whenSell: true,
                            whenStrongSell: true
                          }
                        }
                      },
                      {
                        interval: '15m',
                        buy: {
                          whenStrongBuy: true,
                          whenBuy: true
                        },
                        sell: {
                          forceSellOverZeroBelowTriggerPrice: {
                            whenNeutral: false,
                            whenSell: true,
                            whenStrongSell: true
                          }
                        }
                      }
                    ]
                  }
                }),
                BNBUSDT: JSON.stringify({
                  candles: { interval: '1h', limit: 100 },
                  botOptions: {
                    tradingViews: [
                      {
                        interval: '5m',
                        buy: {
                          whenStrongBuy: true,
                          whenBuy: true
                        },
                        sell: {
                          forceSellOverZeroBelowTriggerPrice: {
                            whenNeutral: false,
                            whenSell: true,
                            whenStrongSell: true
                          }
                        }
                      },
                      {
                        interval: '30m',
                        buy: {
                          whenStrongBuy: true,
                          whenBuy: true
                        },
                        sell: {
                          forceSellOverZeroBelowTriggerPrice: {
                            whenNeutral: false,
                            whenSell: true,
                            whenStrongSell: true
                          }
                        }
                      }
                    ]
                  }
                })
              })
              .mockResolvedValueOnce({});

            axiosMock.get = jest
              .fn()
              .mockResolvedValueOnce({
                data: {
                  request: {
                    symbols: ['BINANCE:BTCUSDT', 'BINANCE:BNBUSDT'],
                    screener: 'CRYPTO',
                    interval: '5m'
                  },
                  result: {
                    'BINANCE:BTCUSDT': {
                      summary: {
                        RECOMMENDATION: 'NEUTRAL'
                      },
                      time: '2021-10-30T08:53:53.973250'
                    },
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
                    interval: '30m'
                  },
                  result: {
                    'BINANCE:BNBUSDT': {
                      summary: {
                        RECOMMENDATION: 'STRONG_BUY'
                      },
                      time: '2021-10-30T08:53:53.973250'
                    }
                  }
                }
              })
              .mockResolvedValueOnce({
                data: {
                  request: {
                    symbols: ['BINANCE:BTCUSDT', 'BINANCE:BNBUSDT'],
                    screener: 'CRYPTO',
                    interval: '5m'
                  },
                  result: {
                    'BINANCE:BTCUSDT': {
                      summary: {
                        RECOMMENDATION: 'BUY'
                      },
                      time: '2021-10-30T08:54:53.973250'
                    },
                    'BINANCE:BNBUSDT': {
                      summary: {
                        RECOMMENDATION: 'STRONG_BUY'
                      },
                      time: '2021-10-30T08:54:53.973250'
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
                        RECOMMENDATION: 'SELL'
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
                    interval: '30m'
                  },
                  result: {
                    'BINANCE:BNBUSDT': {
                      summary: {
                        RECOMMENDATION: 'STRONG_BUY'
                      },
                      time: '2021-10-30T08:54:53.973250'
                    }
                  }
                }
              });

            const step = require('../get-tradingview');

            await step.execute(loggerMock, rawData);
            await step.execute(loggerMock, rawData);
          });

          it('triggers axios.get six times', () => {
            expect(axiosMock.get).toHaveBeenCalledTimes(6);
          });

          it('triggers cache.hset eight times', () => {
            expect(cacheMock.hset).toHaveBeenCalledTimes(8);
          });

          it("saves logger.info for symbols because there isn't existing recommendation for first time", () => {
            expect(loggerMock.info).toHaveBeenCalledWith(
              {
                symbol: 'BTCUSDT',
                interval: '5m',
                data: {
                  summary: { RECOMMENDATION: 'NEUTRAL' },
                  time: '2021-10-30T08:53:53.973250'
                },
                saveLog: true
              },
              `The TradingView technical analysis recommendation for BTCUSDT:5m is "NEUTRAL".`
            );

            expect(loggerMock.info).toHaveBeenCalledWith(
              {
                symbol: 'BNBUSDT',
                interval: '5m',
                data: {
                  summary: { RECOMMENDATION: 'BUY' },
                  time: '2021-10-30T08:53:53.973250'
                },
                saveLog: true
              },
              `The TradingView technical analysis recommendation for BNBUSDT:5m is "BUY".`
            );

            expect(loggerMock.info).toHaveBeenCalledWith(
              {
                symbol: 'BTCUSDT',
                interval: '15m',
                data: {
                  summary: { RECOMMENDATION: 'BUY' },
                  time: '2021-10-30T08:53:53.973250'
                },
                saveLog: true
              },
              `The TradingView technical analysis recommendation for BTCUSDT:15m is "BUY".`
            );

            expect(loggerMock.info).toHaveBeenCalledWith(
              {
                symbol: 'BNBUSDT',
                interval: '30m',
                data: {
                  summary: { RECOMMENDATION: 'STRONG_BUY' },
                  time: '2021-10-30T08:53:53.973250'
                },
                saveLog: true
              },
              `The TradingView technical analysis recommendation for BNBUSDT:30m is "STRONG_BUY".`
            );
          });

          it("saves logger.info for symbols because there isn't existing recommendation for second time", () => {
            expect(loggerMock.info).toHaveBeenCalledWith(
              {
                symbol: 'BTCUSDT',
                interval: '5m',
                data: {
                  summary: { RECOMMENDATION: 'BUY' },
                  time: '2021-10-30T08:54:53.973250'
                },
                saveLog: true
              },
              `The TradingView technical analysis recommendation for BTCUSDT:5m is "BUY".`
            );

            expect(loggerMock.info).toHaveBeenCalledWith(
              {
                symbol: 'BNBUSDT',
                interval: '5m',
                data: {
                  summary: { RECOMMENDATION: 'STRONG_BUY' },
                  time: '2021-10-30T08:54:53.973250'
                },
                saveLog: true
              },
              `The TradingView technical analysis recommendation for BNBUSDT:5m is "STRONG_BUY".`
            );

            expect(loggerMock.info).toHaveBeenCalledWith(
              {
                symbol: 'BTCUSDT',
                interval: '15m',
                data: {
                  summary: { RECOMMENDATION: 'SELL' },
                  time: '2021-10-30T08:54:53.973250'
                },
                saveLog: true
              },
              `The TradingView technical analysis recommendation for BTCUSDT:15m is "SELL".`
            );
          });

          it('triggers cache.hdel to remove unmonitored interval', () => {
            expect(cacheMock.hdel).toHaveBeenCalledWith(
              'trailing-trade-tradingview',
              'BTCUSDT:1d'
            );
          });

          it(
            `does not save logger.info for symbols` +
              ` because there isn't existing recommendation for second time`,
            () => {
              expect(loggerMock.info).not.toHaveBeenCalledWith(
                {
                  symbol: 'BNBUSDT',
                  interval: '30m',
                  data: {
                    summary: { RECOMMENDATION: 'STRONG_BUY' },
                    time: '2021-10-30T08:54:53.973250'
                  },
                  saveLog: true
                },
                `The TradingView technical analysis recommendation for BNBUSDT:30m is "STRONG_BUY".`
              );
            }
          );
        });
      });

      describe('when symbol tradingViews configuration is undefined for some reason', () => {
        beforeEach(async () => {
          rawData = {
            globalConfiguration: {
              symbols: ['BTCUSDT']
            }
          };

          cacheMock.hgetall = jest
            .fn()
            .mockResolvedValueOnce({
              BTCUSDT: JSON.stringify({
                candles: { interval: '1h', limit: 100 }
              })
            })
            .mockResolvedValueOnce({
              'BTCUSDT:5m': JSON.stringify({
                request: {
                  symbol: 'BTCUSDT',
                  interval: '5m'
                },
                result: {
                  summary: {
                    RECOMMENDATION: 'NEUTRAL'
                  },
                  time: '2021-10-30T08:53:53.973250'
                }
              }),
              'BTCUSDT:1d': JSON.stringify({
                request: {
                  symbol: 'BTCUSDT',
                  interval: '1d'
                },
                result: {
                  summary: {
                    RECOMMENDATION: 'NEUTRAL'
                  },
                  time: '2021-10-30T08:53:53.973250'
                }
              })
            });

          axiosMock.get = jest.fn();

          const step = require('../get-tradingview');

          await step.execute(loggerMock, rawData);
        });

        it('does not triggers axios.get', () => {
          expect(axiosMock.get).not.toBeCalled();
        });

        it('triggers cache.hdel to remove unmonitored interval', () => {
          expect(cacheMock.hdel).toHaveBeenCalledWith(
            'trailing-trade-tradingview',
            'BTCUSDT:1d'
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
                tradingViews: [
                  {
                    interval: '5m',
                    buy: {
                      whenStrongBuy: true,
                      whenBuy: true
                    },
                    sell: {
                      forceSellOverZeroBelowTriggerPrice: {
                        whenNeutral: false,
                        whenSell: true,
                        whenStrongSell: true
                      }
                    }
                  }
                ]
              }
            }),
            BNBUSDT: JSON.stringify({
              candles: { interval: '1h', limit: 100 },
              botOptions: {
                tradingViews: [
                  {
                    interval: '5m',
                    buy: {
                      whenStrongBuy: true,
                      whenBuy: true
                    },
                    sell: {
                      forceSellOverZeroBelowTriggerPrice: {
                        whenNeutral: false,
                        whenSell: true,
                        whenStrongSell: true
                      }
                    }
                  }
                ]
              }
            })
          })
          .mockResolvedValueOnce({});

        axiosMock.get = jest.fn().mockResolvedValue({
          data: {
            request: {
              symbols: ['BINANCE:BTCUSDT', 'BINANCE:BNBUSDT'],
              screener: 'CRYPTO',
              interval: '5m'
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

        const step = require('../get-tradingview');

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
            interval: '5m'
          },
          paramsSerializer: expect.any(Function),
          timeout: 20000
        });
      });

      it('triggers cache.hset for symbols', () => {
        expect(cacheMock.hset).toHaveBeenCalledWith(
          'trailing-trade-tradingview',
          'BTCUSDT:5m',
          JSON.stringify({
            request: {
              symbol: 'BTCUSDT',
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
          'BNBUSDT:5m',
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
                tradingViews: [
                  {
                    interval: '5m',
                    buy: {
                      whenStrongBuy: true,
                      whenBuy: true
                    },
                    sell: {
                      forceSellOverZeroBelowTriggerPrice: {
                        whenNeutral: false,
                        whenSell: true,
                        whenStrongSell: true
                      }
                    }
                  },
                  {
                    interval: '15m',
                    buy: {
                      whenStrongBuy: true,
                      whenBuy: true
                    },
                    sell: {
                      forceSellOverZeroBelowTriggerPrice: {
                        whenNeutral: false,
                        whenSell: true,
                        whenStrongSell: true
                      }
                    }
                  }
                ]
              }
            }),
            BNBUSDT: JSON.stringify({
              candles: { interval: '1h', limit: 100 },
              botOptions: {
                tradingViews: [
                  {
                    interval: '30m',
                    buy: {
                      whenStrongBuy: true,
                      whenBuy: true
                    },
                    sell: {
                      forceSellOverZeroBelowTriggerPrice: {
                        whenNeutral: false,
                        whenSell: true,
                        whenStrongSell: true
                      }
                    }
                  }
                ]
              }
            }),
            global: JSON.stringify({
              candles: { interval: '1h', limit: 100 },
              botOptions: {
                tradingViews: [
                  {
                    interval: '5m',
                    buy: {
                      whenStrongBuy: true,
                      whenBuy: true
                    },
                    sell: {
                      forceSellOverZeroBelowTriggerPrice: {
                        whenNeutral: false,
                        whenSell: true,
                        whenStrongSell: true
                      }
                    }
                  }
                ]
              }
            })
          })
          .mockResolvedValueOnce({});

        axiosMock.get = jest.fn().mockResolvedValue({});

        const step = require('../get-tradingview');

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
            symbols: ['BINANCE:BTCUSDT'],
            screener: 'CRYPTO',
            interval: '5m'
          },
          paramsSerializer: expect.any(Function),
          timeout: 20000
        });

        expect(axiosMock.get).toHaveBeenCalledWith('http://tradingview:8080', {
          params: {
            symbols: ['BINANCE:BTCUSDT'],
            screener: 'CRYPTO',
            interval: '15m'
          },
          paramsSerializer: expect.any(Function),
          timeout: 20000
        });

        expect(axiosMock.get).toHaveBeenCalledWith('http://tradingview:8080', {
          params: {
            symbols: ['BINANCE:BNBUSDT'],
            screener: 'CRYPTO',
            interval: '30m'
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
                tradingViews: [
                  {
                    interval: '5m',
                    buy: {
                      whenStrongBuy: true,
                      whenBuy: true
                    },
                    sell: {
                      forceSellOverZeroBelowTriggerPrice: {
                        whenNeutral: false,
                        whenSell: true,
                        whenStrongSell: true
                      }
                    }
                  }
                ]
              }
            }),
            BNBUSDT: JSON.stringify({
              candles: { interval: '1h', limit: 100 },
              botOptions: {
                tradingViews: [
                  {
                    interval: '5m',
                    buy: {
                      whenStrongBuy: true,
                      whenBuy: true
                    },
                    sell: {
                      forceSellOverZeroBelowTriggerPrice: {
                        whenNeutral: false,
                        whenSell: true,
                        whenStrongSell: true
                      }
                    }
                  }
                ]
              }
            }),
            global: JSON.stringify({
              candles: { interval: '1h', limit: 100 },
              botOptions: {
                tradingViews: [
                  {
                    interval: '15m',
                    buy: {
                      whenStrongBuy: true,
                      whenBuy: true
                    },
                    sell: {
                      forceSellOverZeroBelowTriggerPrice: {
                        whenNeutral: false,
                        whenSell: true,
                        whenStrongSell: true
                      }
                    }
                  }
                ]
              }
            })
          })
          .mockResolvedValueOnce({});

        axiosMock.get = jest.fn().mockResolvedValue({
          data: {
            request: {
              symbols: ['BINANCE:BTCUSDT', 'BINANCE:BNBUSDT'],
              screener: 'CRYPTO',
              interval: '5m'
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

        const step = require('../get-tradingview');

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
            interval: '5m'
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

        cacheMock.hgetall = jest.fn().mockResolvedValueOnce({
          BTCUSDT: JSON.stringify({
            candles: { interval: '1h', limit: 100 },
            botOptions: {
              tradingViews: [
                {
                  interval: '5m',
                  buy: {
                    whenStrongBuy: true,
                    whenBuy: true
                  },
                  sell: {
                    forceSellOverZeroBelowTriggerPrice: {
                      whenNeutral: false,
                      whenSell: true,
                      whenStrongSell: true
                    }
                  }
                }
              ]
            }
          }),
          BNBUSDT: JSON.stringify({
            candles: { interval: '1h', limit: 100 },
            botOptions: {
              tradingViews: [
                {
                  interval: '5m',
                  buy: {
                    whenStrongBuy: true,
                    whenBuy: true
                  },
                  sell: {
                    forceSellOverZeroBelowTriggerPrice: {
                      whenNeutral: false,
                      whenSell: true,
                      whenStrongSell: true
                    }
                  }
                }
              ]
            }
          }),
          global: JSON.stringify({
            candles: { interval: '1h', limit: 100 },
            botOptions: {
              tradingViews: [
                {
                  interval: '15m',
                  buy: {
                    whenStrongBuy: true,
                    whenBuy: true
                  },
                  sell: {
                    forceSellOverZeroBelowTriggerPrice: {
                      whenNeutral: false,
                      whenSell: true,
                      whenStrongSell: true
                    }
                  }
                }
              ]
            }
          })
        });

        axiosMock.get = jest.fn().mockRejectedValue(new Error('timeout'));

        const step = require('../get-tradingview');

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
            interval: '5m'
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

        cacheMock.hgetall = jest.fn().mockResolvedValueOnce({});

        axiosMock.get = jest.fn().mockRejectedValue(new Error('timeout'));

        const step = require('../get-tradingview');

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
