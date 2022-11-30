/* eslint-disable global-require */
describe('latest.test.js', () => {
  const trailingTradeCommonJson = require('./fixtures/latest-trailing-trade-common.json');
  const trailingTradeTradingView = require('./fixtures/latest-trailing-trade-tradingview.json');
  const trailingTradeSymbols = require('./fixtures/latest-trailing-trade-symbols.json');
  const trailingTradeClosedTrades = require('./fixtures/latest-trailing-trade-closed-trades.json');

  // eslint-disable-next-line max-len
  const trailingTradeStateNotAuthenticatedUnlockList = require('./fixtures/latest-stats-not-authenticated-unlock-list.json');

  const trailingTradeStatsAuthenticated = require('./fixtures/latest-stats-authenticated.json');
  const trailingTradeStateInvalidCache = require('./fixtures/latest-stats-invalid-cache.json');

  let mockCountCacheTrailingTradeSymbols;
  let mockGetCacheTrailingTradeSymbols;
  let mockGetCacheTrailingTradeTotalProfitAndLoss;
  let mockGetCacheTrailingTradeQuoteEstimates;

  let mockWebSocketServer;
  let mockWebSocketServerWebSocketSend;

  let mockConfigGet;
  let mockCacheHGetWithoutLock;
  let mockCacheHGetAll;
  let mockPubSubPublish;
  let mockBinanceClientGetInfo;

  let mockIsActionDisabled;
  let mockGetConfiguration;

  beforeEach(() => {
    jest.clearAllMocks().resetModules();

    process.env.GIT_HASH = 'some-hash';

    mockBinanceClientGetInfo = jest.fn().mockReturnValue({
      spot: {
        usedWeight1m: '60'
      },
      futures: {}
    });
    mockWebSocketServerWebSocketSend = jest.fn().mockResolvedValue(true);

    mockGetCacheTrailingTradeSymbols = jest
      .fn()
      .mockResolvedValue(trailingTradeSymbols);

    mockCountCacheTrailingTradeSymbols = jest
      .fn()
      .mockResolvedValue(trailingTradeSymbols.length);

    mockGetCacheTrailingTradeTotalProfitAndLoss = jest
      .fn()
      .mockResolvedValue([]);

    mockGetCacheTrailingTradeQuoteEstimates = jest.fn().mockResolvedValue([]);

    mockCacheHGetWithoutLock = jest.fn().mockResolvedValue(6);

    mockWebSocketServer = {
      send: mockWebSocketServerWebSocketSend
    };

    mockConfigGet = jest.fn(key => {
      if (key === 'mongo.host') {
        return 'binance-mongo';
      }

      if (key === 'mongo.port') {
        return 27017;
      }

      if (key === 'mongo.database') {
        return 'binance-bot';
      }

      if (key === 'jobs.trailingTrade') {
        return {
          sell: {
            stopLoss: {
              enabled: false,
              maxLossPercentage: 0.8,
              disableBuyMinutes: 360,
              orderType: 'market'
            }
          }
        };
      }

      return null;
    });

    mockGetConfiguration = jest.fn().mockResolvedValue({
      enabled: true,
      symbols: ['BTCUSDT', 'BNBUSDT']
    });

    mockIsActionDisabled = jest.fn().mockImplementation(symbol => {
      if (symbol === 'BNBUSDT') {
        return {
          isDisabled: true,
          ttl: 330,
          disabledBy: 'stop loss',
          canResume: true,
          message: 'Temporary disabled by stop loss'
        };
      }

      return {
        isDisabled: false,
        ttl: -2
      };
    });

    jest.mock('../../../../cronjob/trailingTradeHelper/common', () => ({
      isActionDisabled: mockIsActionDisabled,
      countCacheTrailingTradeSymbols: mockCountCacheTrailingTradeSymbols,
      getCacheTrailingTradeSymbols: mockGetCacheTrailingTradeSymbols,
      getCacheTrailingTradeTotalProfitAndLoss:
        mockGetCacheTrailingTradeTotalProfitAndLoss,
      getCacheTrailingTradeQuoteEstimates:
        mockGetCacheTrailingTradeQuoteEstimates
    }));
  });

  describe('when some cache is invalid', () => {
    beforeEach(async () => {
      mockCacheHGetAll = jest.fn().mockImplementation(_key => '');

      jest.mock(
        '../../../../cronjob/trailingTradeHelper/configuration',
        () => ({
          getConfiguration: mockGetConfiguration
        })
      );

      jest.mock('../../../../helpers', () => ({
        logger: {
          info: jest.fn(),
          error: jest.fn(),
          warn: jest.fn(),
          debug: jest.fn(),
          child: jest.fn()
        },
        cache: {
          hgetall: mockCacheHGetAll,
          hgetWithoutLock: mockCacheHGetWithoutLock
        },
        config: {
          get: mockConfigGet
        },
        PubSub: {
          publish: mockPubSubPublish
        },
        binance: {
          client: {
            getInfo: mockBinanceClientGetInfo
          }
        }
      }));

      const { logger } = require('../../../../helpers');

      const { handleLatest } = require('../latest');
      await handleLatest(logger, mockWebSocketServer, {
        isAuthenticated: true,
        data: {
          sortBy: 'default',
          sortByDesc: false,
          page: 1,
          searchKeyword: ''
        }
      });
    });

    it('triggers ws.send with latest', () => {
      trailingTradeStateInvalidCache.common.version =
        require('../../../../../package.json').version;
      trailingTradeStateInvalidCache.common.gitHash = 'some-hash';

      expect(mockWebSocketServerWebSocketSend).toHaveBeenCalledWith(
        JSON.stringify(trailingTradeStateInvalidCache)
      );
    });
  });

  describe('with valid cache', () => {
    beforeEach(async () => {
      mockCacheHGetAll = jest.fn().mockImplementation((_key, pattern) => {
        if (pattern === 'trailing-trade-common:*') {
          return trailingTradeCommonJson;
        }

        if (pattern === 'trailing-trade-closed-trades:*') {
          return trailingTradeClosedTrades;
        }

        if (pattern === 'trailing-trade-tradingview:*') {
          return trailingTradeTradingView;
        }

        return '';
      });

      mockGetCacheTrailingTradeQuoteEstimates = jest.fn().mockResolvedValue([
        {
          baseAsset: 'ETH',
          estimatedValue: '1574.50',
          quoteAsset: 'USDT',
          tickSize: '0.01000000'
        }
      ]);
    });

    describe('not authenticated and locked list', () => {
      beforeEach(async () => {
        mockGetConfiguration = jest.fn().mockResolvedValue({
          enabled: true,
          type: 'i-am-global',
          symbols: ['BTCUSDT', 'BNBUSDT'],
          candles: { interval: '15m' },
          botOptions: {
            authentication: {
              lockList: true,
              lockAfter: 120
            },
            autoTriggerBuy: {
              enabled: false,
              triggerAfter: 20
            },
            orderLimit: {
              enabled: true,
              maxBuyOpenOrders: 3,
              maxOpenTrades: 5
            }
          },
          sell: {}
        });

        jest.mock(
          '../../../../cronjob/trailingTradeHelper/configuration',
          () => ({
            getConfiguration: mockGetConfiguration
          })
        );

        jest.mock('../../../../helpers', () => ({
          logger: {
            info: jest.fn(),
            error: jest.fn(),
            warn: jest.fn(),
            debug: jest.fn(),
            child: jest.fn()
          },
          cache: {
            hgetall: mockCacheHGetAll
          },
          config: {
            get: mockConfigGet
          },
          binance: {
            client: {
              getInfo: mockBinanceClientGetInfo
            }
          }
        }));

        const { logger } = require('../../../../helpers');
        const { handleLatest } = require('../latest');
        await handleLatest(logger, mockWebSocketServer, {
          isAuthenticated: false,
          data: {
            sortBy: 'default',
            sortByDesc: false,
            page: 1,
            searchKeyword: ''
          }
        });
      });

      it('triggers ws.send with latest', () => {
        expect(mockWebSocketServerWebSocketSend).toHaveBeenCalledWith(
          JSON.stringify({
            result: true,
            type: 'latest',
            isAuthenticated: false,
            botOptions: {
              authentication: { lockList: true, lockAfter: 120 },
              autoTriggerBuy: { enabled: false, triggerAfter: 20 },
              orderLimit: {
                enabled: true,
                maxBuyOpenOrders: 3,
                maxOpenTrades: 5
              }
            },
            configuration: {},
            common: {},
            closedTradesSetting: {},
            closedTrades: [],
            stats: {}
          })
        );
      });
    });

    describe('not authenticated and does not lock list', () => {
      beforeEach(async () => {
        mockGetConfiguration = jest.fn().mockResolvedValue({
          enabled: true,
          type: 'i-am-global',
          symbols: ['BTCUSDT', 'BNBUSDT', 'ETHBUSD', 'BTCBUSD', 'LTCBUSD'],
          candles: { interval: '15m' },
          botOptions: {
            authentication: {
              lockList: false,
              lockAfter: 120
            },
            autoTriggerBuy: {
              enabled: false,
              triggerAfter: 20
            },
            orderLimit: {
              enabled: true,
              maxBuyOpenOrders: 3,
              maxOpenTrades: 5
            }
          },
          sell: {}
        });

        jest.mock(
          '../../../../cronjob/trailingTradeHelper/configuration',
          () => ({
            getConfiguration: mockGetConfiguration
          })
        );

        jest.mock('../../../../helpers', () => ({
          logger: {
            info: jest.fn(),
            error: jest.fn(),
            warn: jest.fn(),
            debug: jest.fn(),
            child: jest.fn()
          },
          cache: {
            hgetall: mockCacheHGetAll,
            hgetWithoutLock: mockCacheHGetWithoutLock
          },
          config: {
            get: mockConfigGet
          },
          binance: {
            client: {
              getInfo: mockBinanceClientGetInfo
            }
          }
        }));

        const { logger } = require('../../../../helpers');
        const { handleLatest } = require('../latest');
        await handleLatest(logger, mockWebSocketServer, {
          isAuthenticated: false,
          data: {
            sortBy: 'default',
            sortByDesc: false,
            page: 1,
            searchKeyword: ''
          }
        });
      });

      it('triggers ws.send with latest', () => {
        trailingTradeStateNotAuthenticatedUnlockList.common.version =
          require('../../../../../package.json').version;
        trailingTradeStateNotAuthenticatedUnlockList.common.gitHash =
          'some-hash';

        expect(mockWebSocketServerWebSocketSend).toHaveBeenCalledWith(
          JSON.stringify(trailingTradeStateNotAuthenticatedUnlockList)
        );
      });
    });

    describe('authenticated', () => {
      beforeEach(async () => {
        mockGetConfiguration = jest.fn().mockResolvedValue({
          enabled: true,
          type: 'i-am-global',
          candles: { interval: '15m' },
          symbols: ['BTCUSDT', 'BNBUSDT', 'ETHBUSD', 'BTCBUSD', 'LTCBUSD'],
          botOptions: {
            authentication: {
              lockList: true,
              lockAfter: 120
            },
            autoTriggerBuy: {
              enabled: false,
              triggerAfter: 20
            },
            orderLimit: {
              enabled: true,
              maxBuyOpenOrders: 3,
              maxOpenTrades: 5
            }
          },
          sell: {}
        });

        jest.mock(
          '../../../../cronjob/trailingTradeHelper/configuration',
          () => ({
            getConfiguration: mockGetConfiguration
          })
        );

        jest.mock('../../../../helpers', () => ({
          logger: {
            info: jest.fn(),
            error: jest.fn(),
            warn: jest.fn(),
            debug: jest.fn(),
            child: jest.fn()
          },
          cache: {
            hgetall: mockCacheHGetAll,
            hgetWithoutLock: mockCacheHGetWithoutLock
          },
          config: {
            get: mockConfigGet
          },
          binance: {
            client: {
              getInfo: mockBinanceClientGetInfo
            }
          }
        }));

        const { logger } = require('../../../../helpers');
        const { handleLatest } = require('../latest');
        await handleLatest(logger, mockWebSocketServer, {
          isAuthenticated: true,
          data: {
            sortBy: 'default',
            sortByDesc: false,
            page: 1,
            searchKeyword: ''
          }
        });
      });

      it('triggers ws.send with latest', () => {
        trailingTradeStatsAuthenticated.common.version =
          require('../../../../../package.json').version;
        trailingTradeStatsAuthenticated.common.gitHash = 'some-hash';

        expect(mockWebSocketServerWebSocketSend).toHaveBeenCalledWith(
          JSON.stringify(trailingTradeStatsAuthenticated)
        );
      });
    });

    describe('authenticated and no git hash provided and no closed trades', () => {
      beforeEach(async () => {
        delete process.env.GIT_HASH;
        delete trailingTradeCommonJson['closed-trades'];

        mockGetConfiguration = jest.fn().mockResolvedValue({
          enabled: true,
          type: 'i-am-global',
          candles: { interval: '15m' },
          symbols: ['BTCUSDT', 'BNBUSDT', 'ETHBUSD', 'BTCBUSD', 'LTCBUSD'],
          botOptions: {
            authentication: {
              lockList: true,
              lockAfter: 120
            },
            autoTriggerBuy: {
              enabled: false,
              triggerAfter: 20
            },
            orderLimit: {
              enabled: true,
              maxBuyOpenOrders: 3,
              maxOpenTrades: 5
            }
          },
          sell: {}
        });

        jest.mock(
          '../../../../cronjob/trailingTradeHelper/configuration',
          () => ({
            getConfiguration: mockGetConfiguration
          })
        );

        jest.mock('../../../../helpers', () => ({
          logger: {
            info: jest.fn(),
            error: jest.fn(),
            warn: jest.fn(),
            debug: jest.fn(),
            child: jest.fn()
          },
          cache: {
            hgetall: mockCacheHGetAll,
            hgetWithoutLock: mockCacheHGetWithoutLock
          },
          config: {
            get: mockConfigGet
          },
          binance: {
            client: {
              getInfo: mockBinanceClientGetInfo
            }
          }
        }));

        const { logger } = require('../../../../helpers');
        const { handleLatest } = require('../latest');
        await handleLatest(logger, mockWebSocketServer, {
          isAuthenticated: true,
          data: {
            sortBy: 'default',
            sortByDesc: false,
            page: 1,
            searchKeyword: ''
          }
        });
      });

      it('triggers ws.send with latest', () => {
        trailingTradeStatsAuthenticated.common.version =
          require('../../../../../package.json').version;
        trailingTradeStatsAuthenticated.common.gitHash = 'unspecified';
        trailingTradeStatsAuthenticated.common.closedTradesSetting = {};

        expect(mockWebSocketServerWebSocketSend).toHaveBeenCalledWith(
          JSON.stringify(trailingTradeStatsAuthenticated)
        );
      });
    });
  });
});
