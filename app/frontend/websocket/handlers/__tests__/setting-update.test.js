/* eslint-disable global-require */
const moment = require('moment');

describe('setting-update.test.js', () => {
  let mockWebSocketServer;
  let mockWebSocketServerWebSocketSend;

  let mockGetGlobalConfiguration;
  let mockSaveGlobalConfiguration;
  let mockDeleteAllSymbolConfiguration;

  let cacheMock;
  let mockLogger;
  let PubSubMock;

  let config;

  const validTime = moment().utc().format('YYYY-MM-DDTHH:mm:ss.SSSSSS');

  beforeEach(() => {
    jest.clearAllMocks().resetModules();

    mockDeleteAllSymbolConfiguration = jest.fn().mockResolvedValue(true);

    jest.mock('../../../../cronjob/trailingTradeHelper/configuration', () => ({
      getGlobalConfiguration: mockGetGlobalConfiguration,
      saveGlobalConfiguration: mockSaveGlobalConfiguration,
      deleteAllSymbolConfiguration: mockDeleteAllSymbolConfiguration
    }));

    mockWebSocketServerWebSocketSend = jest.fn().mockResolvedValue(true);

    mockWebSocketServer = {
      send: mockWebSocketServerWebSocketSend
    };

    jest.mock('config');
    config = require('config');

    config.get = jest.fn(key => {
      if (key === 'demoMode') {
        return false;
      }
      return null;
    });
  });

  describe('when demoMode is enabled', () => {
    beforeEach(async () => {
      const { cache, logger, PubSub } = require('../../../../helpers');
      mockLogger = logger;
      cacheMock = cache;
      PubSubMock = PubSub;

      PubSubMock.publish = jest.fn();

      config.get = jest.fn(key => {
        if (key === 'demoMode') {
          return true;
        }
        return null;
      });

      const { handleSettingUpdate } = require('../setting-update');
      handleSettingUpdate(logger, mockWebSocketServer, {
        data: { newField: 'value' }
      });
    });

    it('triggers PubSub.publish', () => {
      expect(PubSubMock.publish).toHaveBeenCalledWith('frontend-notification', {
        type: 'warning',
        title: `You cannot update settings in the demo mode.`
      });
    });
  });

  describe('when configuration returns null for some reason', () => {
    beforeEach(async () => {
      const { cache, logger } = require('../../../../helpers');
      mockLogger = logger;
      cacheMock = cache;

      cacheMock.hdel = jest.fn().mockResolvedValue(true);
      cacheMock.hgetall = jest.fn().mockResolvedValue({});

      mockGetGlobalConfiguration = jest.fn().mockResolvedValue(null);

      const { handleSettingUpdate } = require('../setting-update');
      handleSettingUpdate(logger, mockWebSocketServer, {
        data: { newField: 'value' }
      });
    });

    it('triggers getGlobalConfiguration', () => {
      expect(mockGetGlobalConfiguration).toHaveBeenCalledWith(mockLogger);
    });

    it('does not trigger ws.send', () => {
      expect(mockWebSocketServerWebSocketSend).not.toHaveBeenCalled();
    });

    it('does not trigger cache.hdel', () => {
      expect(cacheMock.hdel).not.toHaveBeenCalled();
    });

    it('does not trigger deleteAllSymbolConfiguration', () => {
      expect(mockDeleteAllSymbolConfiguration).not.toHaveBeenCalled();
    });
  });

  describe('when configuration is valid', () => {
    describe('when apply to all', () => {
      beforeEach(async () => {
        const { logger, cache } = require('../../../../helpers');
        mockLogger = logger;
        cacheMock = cache;

        cacheMock.hdel = jest.fn().mockResolvedValue(true);
        cacheMock.hgetall = jest
          .fn()
          .mockResolvedValueOnce({
            'BTCUSDT-symbol-info': JSON.stringify({ some: 'value' }),
            'ETHUSDT-symbol-info': JSON.stringify({ some: 'value' })
          })
          .mockResolvedValueOnce({
            'BTCUSDT:5m': JSON.stringify({
              request: {
                interval: '5m'
              },
              result: {
                summary: { RECOMMENDATION: 'STRONG_SELL' },
                time: validTime
              }
            }),
            'BTCUSDT:15m': JSON.stringify({
              request: {
                interval: '15m'
              },
              result: {
                summary: { RECOMMENDATION: 'STRONG_SELL' },
                time: validTime
              }
            }),
            'BTCUSDT:30m': JSON.stringify({
              request: {
                interval: '30m'
              },
              result: {
                summary: { RECOMMENDATION: 'STRONG_SELL' },
                time: validTime
              }
            }),
            'ETHUSDT:5m': JSON.stringify({
              request: {
                interval: '5m'
              },
              result: {
                summary: { RECOMMENDATION: 'STRONG_SELL' },
                time: validTime
              }
            })
          });

        mockGetGlobalConfiguration = jest.fn().mockResolvedValue({
          enabled: true,
          symbols: ['BTCUSDT'],
          candles: {
            interval: '1d',
            limit: '10'
          },
          buy: {
            enabled: true,
            minPurchaseAmount: 50,
            maxPurchaseAmount: 100,
            lastBuyPriceRemoveThreshold: 10
          },
          sell: {
            enabled: true,
            lastbuyPercentage: 1.06,
            stopPercentage: 0.99,
            limitPercentage: 0.98
          },
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
            ],
            tradingViewOptions: {
              useOnlyWithin: 5,
              ifExpires: 'ignore'
            }
          },
          tradingViews: [
            {
              request: {
                interval: '5m'
              },
              result: {
                summary: { RECOMMENDATION: 'STRONG_SELL' },
                time: validTime
              }
            },
            {
              request: {
                interval: '15m'
              },
              result: {
                summary: { RECOMMENDATION: 'SELL' },
                time: validTime
              }
            }
          ]
        });

        mockSaveGlobalConfiguration = jest.fn().mockResolvedValue(true);

        const { handleSettingUpdate } = require('../setting-update');
        await handleSettingUpdate(logger, mockWebSocketServer, {
          data: {
            action: 'apply-to-all',
            enabled: true,
            symbols: ['BTCUSDT', 'LTCUSDT', 'ETHBTC'],
            supportFIATs: ['USDT', 'BUSD'],
            candles: {
              interval: '1h',
              limit: '100'
            },
            buy: {
              enabled: true,
              minPurchaseAmount: 100,
              maxPurchaseAmount: 150,
              lastBuyPriceRemoveThreshold: 10
            },
            sell: {
              enabled: true,
              lastbuyPercentage: 1.07,
              stopPercentage: 0.98,
              limitPercentage: 0.97
            },
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
                      whenSell: false,
                      whenStrongSell: true
                    }
                  }
                },
                {
                  interval: '30m',
                  buy: {
                    whenStrongBuy: false,
                    whenBuy: false
                  },
                  sell: {
                    forceSellOverZeroBelowTriggerPrice: {
                      whenNeutral: false,
                      whenSell: false,
                      whenStrongSell: true
                    }
                  }
                }
              ],
              tradingViewOptions: {
                useOnlyWithin: 5,
                ifExpires: 'ignore'
              }
            }
          }
        });
      });

      it('triggers getGlobalConfiguration', () => {
        expect(mockGetGlobalConfiguration).toHaveBeenCalledWith(mockLogger);
      });

      it('triggers saveGlobalConfiguration', () => {
        expect(mockSaveGlobalConfiguration).toHaveBeenCalledWith(mockLogger, {
          enabled: true,
          symbols: ['BTCUSDT', 'LTCUSDT', 'ETHBTC'],
          candles: {
            interval: '1h',
            limit: '100'
          },
          buy: {
            enabled: true,
            minPurchaseAmount: -1,
            maxPurchaseAmount: -1,
            lastBuyPriceRemoveThreshold: -1
          },
          sell: {
            enabled: true,
            lastbuyPercentage: 1.07,
            stopPercentage: 0.98,
            limitPercentage: 0.97
          },
          botOptions: {
            tradingViews: [
              {
                buy: {
                  whenBuy: true,
                  whenStrongBuy: true
                },
                interval: '15m',
                sell: {
                  forceSellOverZeroBelowTriggerPrice: {
                    whenNeutral: false,
                    whenSell: false,
                    whenStrongSell: true
                  }
                }
              },
              {
                buy: {
                  whenBuy: false,
                  whenStrongBuy: false
                },
                interval: '30m',
                sell: {
                  forceSellOverZeroBelowTriggerPrice: {
                    whenNeutral: false,
                    whenSell: false,
                    whenStrongSell: true
                  }
                }
              }
            ],
            tradingViewOptions: {
              ifExpires: 'ignore',
              useOnlyWithin: 5
            }
          },
          tradingViews: [
            {
              request: {
                interval: '5m'
              },
              result: {
                summary: {
                  RECOMMENDATION: 'STRONG_SELL'
                },
                time: validTime
              }
            },
            {
              request: {
                interval: '15m'
              },
              result: {
                summary: {
                  RECOMMENDATION: 'SELL'
                },
                time: validTime
              }
            }
          ]
        });
      });

      it('triggers cache.hdel for exchange-symbols', () => {
        expect(cacheMock.hdel).toHaveBeenCalledWith(
          'trailing-trade-common',
          'exchange-symbols'
        );
      });

      it('triggers cache.hdel for exchange-info', () => {
        expect(cacheMock.hdel).toHaveBeenCalledWith(
          'trailing-trade-common',
          'exchange-info'
        );
      });

      it('triggers cache.hdel for symbols', () => {
        expect(cacheMock.hdel).toHaveBeenCalledWith(
          'trailing-trade-symbols',
          'BTCUSDT-symbol-info'
        );
        expect(cacheMock.hdel).toHaveBeenCalledWith(
          'trailing-trade-symbols',
          'ETHUSDT-symbol-info'
        );
      });

      it('triggers deleteAllSymbolConfiguration', () => {
        expect(mockDeleteAllSymbolConfiguration).toHaveBeenCalledWith(
          mockLogger
        );
      });

      it('triggers ws.send', () => {
        expect(mockWebSocketServerWebSocketSend).toHaveBeenCalledWith(
          JSON.stringify({
            result: true,
            type: 'setting-update-result',
            newConfiguration: {
              enabled: true,
              symbols: ['BTCUSDT', 'LTCUSDT', 'ETHBTC'],
              candles: { interval: '1h', limit: '100' },
              buy: {
                enabled: true,
                minPurchaseAmount: -1,
                maxPurchaseAmount: -1,
                lastBuyPriceRemoveThreshold: -1
              },
              sell: {
                enabled: true,
                lastbuyPercentage: 1.07,
                stopPercentage: 0.98,
                limitPercentage: 0.97
              },
              botOptions: {
                tradingViews: [
                  {
                    interval: '15m',
                    buy: { whenStrongBuy: true, whenBuy: true },
                    sell: {
                      forceSellOverZeroBelowTriggerPrice: {
                        whenNeutral: false,
                        whenSell: false,
                        whenStrongSell: true
                      }
                    }
                  },
                  {
                    interval: '30m',
                    buy: { whenStrongBuy: false, whenBuy: false },
                    sell: {
                      forceSellOverZeroBelowTriggerPrice: {
                        whenNeutral: false,
                        whenSell: false,
                        whenStrongSell: true
                      }
                    }
                  }
                ],
                tradingViewOptions: { useOnlyWithin: 5, ifExpires: 'ignore' }
              },
              tradingViews: [
                {
                  request: { interval: '5m' },
                  result: {
                    summary: { RECOMMENDATION: 'STRONG_SELL' },
                    time: validTime
                  }
                },
                {
                  request: { interval: '15m' },
                  result: {
                    summary: { RECOMMENDATION: 'SELL' },
                    time: validTime
                  }
                }
              ]
            }
          })
        );
      });
    });

    describe('when apply to only global', () => {
      beforeEach(async () => {
        const { logger, cache } = require('../../../../helpers');
        mockLogger = logger;
        cacheMock = cache;

        cacheMock.hdel = jest.fn().mockResolvedValue(true);
        cacheMock.hgetall = jest
          .fn()
          .mockResolvedValueOnce({
            'BTCUSDT-symbol-info': JSON.stringify({ some: 'value' }),
            'ETHUSDT-symbol-info': JSON.stringify({ some: 'value' })
          })
          .mockResolvedValueOnce({
            'BTCUSDT:5m': JSON.stringify({
              request: {
                interval: '5m'
              },
              result: {
                summary: { RECOMMENDATION: 'STRONG_SELL' },
                time: validTime
              }
            }),
            'BTCUSDT:15m': JSON.stringify({
              request: {
                interval: '15m'
              },
              result: {
                summary: { RECOMMENDATION: 'STRONG_SELL' },
                time: validTime
              }
            }),
            'BTCUSDT:30m': JSON.stringify({
              request: {
                interval: '30m'
              },
              result: {
                summary: { RECOMMENDATION: 'STRONG_SELL' },
                time: validTime
              }
            }),
            'ETHUSDT:5m': JSON.stringify({
              request: {
                interval: '5m'
              },
              result: {
                summary: { RECOMMENDATION: 'STRONG_SELL' },
                time: validTime
              }
            })
          });

        mockGetGlobalConfiguration = jest.fn().mockResolvedValue({
          enabled: true,
          symbols: ['BTCUSDT'],
          candles: {
            interval: '1d',
            limit: '10'
          },
          buy: {
            enabled: true,
            minPurchaseAmount: 50,
            maxPurchaseAmount: 100,
            lastBuyPriceRemoveThreshold: 10
          },
          sell: {
            enabled: true,
            lastbuyPercentage: 1.06,
            stopPercentage: 0.99,
            limitPercentage: 0.98
          },
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
            ],
            tradingViewOptions: {
              useOnlyWithin: 5,
              ifExpires: 'ignore'
            }
          },
          tradingViews: [
            {
              request: {
                interval: '5m'
              },
              result: {
                summary: { RECOMMENDATION: 'STRONG_SELL' },
                time: validTime
              }
            },
            {
              request: {
                interval: '15m'
              },
              result: {
                summary: { RECOMMENDATION: 'SELL' },
                time: validTime
              }
            }
          ]
        });

        mockSaveGlobalConfiguration = jest.fn().mockResolvedValue(true);

        const { handleSettingUpdate } = require('../setting-update');
        await handleSettingUpdate(logger, mockWebSocketServer, {
          data: {
            action: 'apply-to-global-only',
            enabled: true,
            symbols: ['BTCUSDT', 'LTCUSDT', 'ETHBTC'],
            supportFIATs: ['USDT', 'BUSD'],
            candles: {
              interval: '1h',
              limit: '100'
            },
            buy: {
              enabled: true,
              minPurchaseAmount: 100,
              maxPurchaseAmount: 150,
              lastBuyPriceRemoveThreshold: 10
            },
            sell: {
              enabled: true,
              lastbuyPercentage: 1.07,
              stopPercentage: 0.98,
              limitPercentage: 0.97
            },
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
                      whenSell: false,
                      whenStrongSell: true
                    }
                  }
                },
                {
                  interval: '30m',
                  buy: {
                    whenStrongBuy: false,
                    whenBuy: false
                  },
                  sell: {
                    forceSellOverZeroBelowTriggerPrice: {
                      whenNeutral: false,
                      whenSell: false,
                      whenStrongSell: true
                    }
                  }
                }
              ],
              tradingViewOptions: {
                useOnlyWithin: 5,
                ifExpires: 'ignore'
              }
            }
          }
        });
      });

      it('triggers getGlobalConfiguration', () => {
        expect(mockGetGlobalConfiguration).toHaveBeenCalledWith(mockLogger);
      });

      it('triggers saveGlobalConfiguration', () => {
        expect(mockSaveGlobalConfiguration).toHaveBeenCalledWith(mockLogger, {
          enabled: true,
          symbols: ['BTCUSDT', 'LTCUSDT', 'ETHBTC'],
          candles: {
            interval: '1h',
            limit: '100'
          },
          buy: {
            enabled: true,
            minPurchaseAmount: -1,
            maxPurchaseAmount: -1,
            lastBuyPriceRemoveThreshold: -1
          },
          sell: {
            enabled: true,
            lastbuyPercentage: 1.07,
            stopPercentage: 0.98,
            limitPercentage: 0.97
          },
          botOptions: {
            tradingViews: [
              {
                buy: {
                  whenBuy: true,
                  whenStrongBuy: true
                },
                interval: '15m',
                sell: {
                  forceSellOverZeroBelowTriggerPrice: {
                    whenNeutral: false,
                    whenSell: false,
                    whenStrongSell: true
                  }
                }
              },
              {
                buy: {
                  whenBuy: false,
                  whenStrongBuy: false
                },
                interval: '30m',
                sell: {
                  forceSellOverZeroBelowTriggerPrice: {
                    whenNeutral: false,
                    whenSell: false,
                    whenStrongSell: true
                  }
                }
              }
            ],
            tradingViewOptions: {
              ifExpires: 'ignore',
              useOnlyWithin: 5
            }
          },
          tradingViews: [
            {
              request: {
                interval: '5m'
              },
              result: {
                summary: {
                  RECOMMENDATION: 'STRONG_SELL'
                },
                time: validTime
              }
            },
            {
              request: {
                interval: '15m'
              },
              result: {
                summary: {
                  RECOMMENDATION: 'SELL'
                },
                time: validTime
              }
            }
          ]
        });
      });

      it('triggers cache.hdel for exchange-symbols', () => {
        expect(cacheMock.hdel).toHaveBeenCalledWith(
          'trailing-trade-common',
          'exchange-symbols'
        );
      });

      it('triggers cache.hdel for exchange-info', () => {
        expect(cacheMock.hdel).toHaveBeenCalledWith(
          'trailing-trade-common',
          'exchange-info'
        );
      });

      it('triggers cache.hdel for symbols', () => {
        expect(cacheMock.hdel).toHaveBeenCalledWith(
          'trailing-trade-symbols',
          'BTCUSDT-symbol-info'
        );
        expect(cacheMock.hdel).toHaveBeenCalledWith(
          'trailing-trade-symbols',
          'ETHUSDT-symbol-info'
        );
      });

      it('does not trigger deleteAllSymbolConfiguration', () => {
        expect(mockDeleteAllSymbolConfiguration).not.toHaveBeenCalledWith(
          mockLogger
        );
      });

      it('triggers ws.send', () => {
        expect(mockWebSocketServerWebSocketSend).toHaveBeenCalledWith(
          JSON.stringify({
            result: true,
            type: 'setting-update-result',
            newConfiguration: {
              enabled: true,
              symbols: ['BTCUSDT', 'LTCUSDT', 'ETHBTC'],
              candles: { interval: '1h', limit: '100' },
              buy: {
                enabled: true,
                minPurchaseAmount: -1,
                maxPurchaseAmount: -1,
                lastBuyPriceRemoveThreshold: -1
              },
              sell: {
                enabled: true,
                lastbuyPercentage: 1.07,
                stopPercentage: 0.98,
                limitPercentage: 0.97
              },
              botOptions: {
                tradingViews: [
                  {
                    interval: '15m',
                    buy: { whenStrongBuy: true, whenBuy: true },
                    sell: {
                      forceSellOverZeroBelowTriggerPrice: {
                        whenNeutral: false,
                        whenSell: false,
                        whenStrongSell: true
                      }
                    }
                  },
                  {
                    interval: '30m',
                    buy: { whenStrongBuy: false, whenBuy: false },
                    sell: {
                      forceSellOverZeroBelowTriggerPrice: {
                        whenNeutral: false,
                        whenSell: false,
                        whenStrongSell: true
                      }
                    }
                  }
                ],
                tradingViewOptions: { useOnlyWithin: 5, ifExpires: 'ignore' }
              },
              tradingViews: [
                {
                  request: { interval: '5m' },
                  result: {
                    summary: { RECOMMENDATION: 'STRONG_SELL' },
                    time: validTime
                  }
                },
                {
                  request: { interval: '15m' },
                  result: {
                    summary: { RECOMMENDATION: 'SELL' },
                    time: validTime
                  }
                }
              ]
            }
          })
        );
      });
    });
  });
});
