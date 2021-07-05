/* eslint-disable global-require */
const _ = require('lodash');

describe('manual-trade-all-symbols.js', () => {
  let mockWebSocketServer;
  let mockWebSocketServerWebSocketSend;

  let loggerMock;
  let cacheMock;
  let PubSubMock;

  let mockGetGlobalConfiguration;

  let index;

  const orders = {
    side: 'buy',
    buy: {
      type: 'market',
      marketType: 'total',
      isValid: true,
      symbols: {
        BNB: {
          baseAssets: {
            LTC: {
              symbol: 'LTCBNB',
              quoteOrderQty: 0
            },
            XRP: {
              symbol: 'XRPBNB',
              quoteOrderQty: 0
            },
            TRX: {
              symbol: 'TRXBNB',
              quoteOrderQty: '0.0336'
            }
          }
        },
        USDT: {
          baseAssets: {
            BTC: {
              symbol: 'BTCUSDT',
              quoteOrderQty: '8641.80'
            },
            BNB: {
              symbol: 'BNBUSDT',
              quoteOrderQty: 0
            },
            ETH: {
              symbol: 'ETHUSDT',
              quoteOrderQty: '6481.35'
            },
            LTC: {
              symbol: 'LTCUSDT',
              quoteOrderQty: 0
            },
            TRX: {
              symbol: 'TRXUSDT',
              quoteOrderQty: '2734.32'
            },
            XRP: {
              symbol: 'XRPUSDT',
              quoteOrderQty: '3645.76'
            }
          }
        },
        BTC: {
          baseAssets: {
            LTC: {
              symbol: 'LTCBTC',
              quoteOrderQty: '0.135381'
            },
            ETH: {
              symbol: 'ETHBTC',
              quoteOrderQty: 0
            },
            BNB: {
              symbol: 'BNBBTC',
              quoteOrderQty: '0.101536'
            },
            XRP: {
              symbol: 'XRPBTC',
              quoteOrderQty: '0.042835'
            },
            TRX: {
              symbol: 'TRXBTC',
              quoteOrderQty: '0.076152'
            }
          }
        },
        BUSD: {
          baseAssets: {
            BNB: {
              symbol: 'BNBBUSD',
              quoteOrderQty: '9148.30'
            },
            BTC: {
              symbol: 'BTCBUSD',
              quoteOrderQty: 0
            },
            ETH: {
              symbol: 'ETHBUSD',
              quoteOrderQty: '6861.23'
            },
            TRX: {
              symbol: 'TRXBUSD',
              quoteOrderQty: '3859.44'
            },
            LTC: {
              symbol: 'LTCBUSD',
              quoteOrderQty: 0
            },
            XRP: {
              symbol: 'XRPBUSD',
              quoteOrderQty: '2894.58'
            }
          }
        }
      }
    },
    sell: {
      type: 'market',
      marketType: 'amount',
      isValid: true,
      symbols: {
        BNB: {
          baseAssets: {
            LTC: {
              symbol: 'LTCBNB',
              marketQuantity: 126.99594
            },
            XRP: {
              symbol: 'XRPBNB',
              marketQuantity: 0
            },
            TRX: {
              symbol: 'TRXBNB',
              marketQuantity: 504559.3
            }
          }
        },
        BTC: {
          baseAssets: {
            XRP: {
              symbol: 'XRPBTC',
              marketQuantity: 60
            },
            ETH: {
              symbol: 'ETHBTC',
              marketQuantity: 14.58089
            },
            LTC: {
              symbol: 'LTCBTC',
              marketQuantity: 126.99594
            },
            BNB: {
              symbol: 'BNBBTC',
              marketQuantity: 0
            },
            TRX: {
              symbol: 'TRXBTC',
              marketQuantity: 504559.3
            }
          }
        },
        USDT: {
          baseAssets: {
            BTC: {
              symbol: 'BTCUSDT',
              marketQuantity: 0.641596
            },
            BNB: {
              symbol: 'BNBUSDT',
              marketQuantity: 42.58
            },
            ETH: {
              symbol: 'ETHUSDT',
              marketQuantity: 14.58089
            },
            XRP: {
              symbol: 'XRPUSDT',
              marketQuantity: 0
            },
            LTC: {
              symbol: 'LTCUSDT',
              marketQuantity: 126.99594
            },
            TRX: {
              symbol: 'TRXUSDT',
              marketQuantity: 504559.3
            }
          }
        },
        BUSD: {
          baseAssets: {
            BNB: {
              symbol: 'BNBBUSD',
              marketQuantity: 42.58
            },
            BTC: {
              symbol: 'BTCBUSD',
              marketQuantity: 0
            },
            ETH: {
              symbol: 'ETHBUSD',
              marketQuantity: 14.58089
            },
            TRX: {
              symbol: 'TRXBUSD',
              marketQuantity: 504559.3
            },
            LTC: {
              symbol: 'LTCBUSD',
              marketQuantity: 0
            },
            XRP: {
              symbol: 'XRPBUSD',
              marketQuantity: 60
            }
          }
        }
      }
    }
  };

  beforeEach(() => {
    jest.clearAllMocks().resetModules();

    mockWebSocketServerWebSocketSend = jest.fn().mockResolvedValue(true);

    mockWebSocketServer = {
      send: mockWebSocketServerWebSocketSend
    };
  });

  beforeEach(async () => {
    const { cache, logger, PubSub } = require('../../../../helpers');

    cacheMock = cache;
    loggerMock = logger;
    PubSubMock = PubSub;

    cacheMock.hset = jest.fn().mockResolvedValue(true);
    PubSubMock.publish = jest.fn().mockResolvedValue(true);
  });

  describe('buy', () => {
    beforeAll(() => {
      index = 0;
      orders.side = 'buy';
    });
    beforeEach(async () => {
      mockGetGlobalConfiguration = jest.fn().mockResolvedValue({
        system: { placeManualOrderInterval: 5 }
      });

      jest.mock(
        '../../../../cronjob/trailingTradeHelper/configuration',
        () => ({
          getGlobalConfiguration: mockGetGlobalConfiguration
        })
      );

      const {
        handleManualTradeAllSymbols
      } = require('../manual-trade-all-symbols');
      await handleManualTradeAllSymbols(loggerMock, mockWebSocketServer, {
        data: {
          orders
        }
      });
    });

    _.forOwn(orders.buy.symbols, (quoteAsset, _quoteSymbol) => {
      _.forOwn(quoteAsset.baseAssets, (baseAsset, _baseSymbol) => {
        const { symbol } = baseAsset;
        const quoteOrderQty = parseFloat(baseAsset.quoteOrderQty);

        if (quoteOrderQty > 0) {
          it(`triggers cache.hset for ${symbol}`, () => {
            expect(cacheMock.hset.mock.calls[index][0]).toStrictEqual(
              'trailing-trade-override'
            );
            expect(cacheMock.hset.mock.calls[index][1]).toStrictEqual(symbol);
            const args = JSON.parse(cacheMock.hset.mock.calls[index][2]);
            expect(args).toStrictEqual({
              action: 'manual-trade',
              order: {
                side: 'buy',
                buy: {
                  type: 'market',
                  marketType: 'total',
                  quoteOrderQty
                }
              },
              actionAt: expect.any(String)
            });
            index += 1;
          });
        } else {
          it(`does not trigger cache.hset for ${symbol}`, () => {
            // Get all symbols called with cache.hset
            const symbols = _.reduce(
              cacheMock.hset.mock.calls,
              (newSymbols, s) => {
                newSymbols.push(s[1]);
                return newSymbols;
              },
              []
            );
            expect(symbols).not.toContain(symbol);
          });
        }
      });
    });

    it('triggers PubSub.publish', () => {
      expect(PubSubMock.publish).toHaveBeenCalledWith('frontend-notification', {
        type: 'info',
        title:
          'The orders received by the bot. Start queuing the orders to place. Orders will be placed in sequence.'
      });
    });

    it('triggers ws.send', () => {
      expect(mockWebSocketServerWebSocketSend).toHaveBeenCalledWith(
        JSON.stringify({
          result: true,
          type: 'manual-trade-all-symbols-result',
          message: 'The orders have been received.'
        })
      );
    });
  });

  describe('sell', () => {
    beforeAll(() => {
      index = 0;
      orders.side = 'sell';
    });

    beforeEach(async () => {
      mockGetGlobalConfiguration = jest.fn().mockResolvedValue({
        system: { placeManualOrderInterval: 5 }
      });

      jest.mock(
        '../../../../cronjob/trailingTradeHelper/configuration',
        () => ({
          getGlobalConfiguration: mockGetGlobalConfiguration
        })
      );

      const {
        handleManualTradeAllSymbols
      } = require('../manual-trade-all-symbols');
      await handleManualTradeAllSymbols(loggerMock, mockWebSocketServer, {
        data: {
          orders
        }
      });
    });

    _.forOwn(orders.sell.symbols, (quoteAsset, _quoteSymbol) => {
      _.forOwn(quoteAsset.baseAssets, (baseAsset, _baseSymbol) => {
        const { symbol } = baseAsset;
        const marketQuantity = parseFloat(baseAsset.marketQuantity);

        if (marketQuantity > 0) {
          it(`triggers cache.hset for ${symbol}`, () => {
            expect(cacheMock.hset.mock.calls[index][0]).toStrictEqual(
              'trailing-trade-override'
            );
            expect(cacheMock.hset.mock.calls[index][1]).toStrictEqual(symbol);
            const args = JSON.parse(cacheMock.hset.mock.calls[index][2]);
            expect(args).toStrictEqual({
              action: 'manual-trade',
              order: {
                side: 'sell',
                sell: {
                  type: 'market',
                  marketType: 'amount',
                  marketQuantity
                }
              },
              actionAt: expect.any(String)
            });
            index += 1;
          });
        } else {
          it(`does not trigger cache.hset for ${symbol}`, () => {
            // Get all symbols called with cache.hset
            const symbols = _.reduce(
              cacheMock.hset.mock.calls,
              (newSymbols, s) => {
                newSymbols.push(s[1]);
                return newSymbols;
              },
              []
            );
            expect(symbols).not.toContain(symbol);
          });
        }
      });
    });

    it('triggers PubSub.publish', () => {
      expect(PubSubMock.publish).toHaveBeenCalledWith('frontend-notification', {
        type: 'info',
        title:
          'The orders received by the bot. Start queuing the orders to place. Orders will be placed in sequence.'
      });
    });

    it('triggers ws.send', () => {
      expect(mockWebSocketServerWebSocketSend).toHaveBeenCalledWith(
        JSON.stringify({
          result: true,
          type: 'manual-trade-all-symbols-result',
          message: 'The orders have been received.'
        })
      );
    });
  });
});
