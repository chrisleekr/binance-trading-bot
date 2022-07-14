/* eslint-disable global-require */
const _ = require('lodash');

describe('latest.test.js', () => {
  const trailingTradeCommonJson = require('./fixtures/latest-trailing-trade-common.json');
  const trailingTradeSymbols = require('./fixtures/latest-trailing-trade-symbols.json');
  const trailingTradeClosedTrades = require('./fixtures/latest-trailing-trade-closed-trades.json');

  // eslint-disable-next-line max-len
  const trailingTradeStateNotAuthenticatedUnlockList = require('./fixtures/latest-stats-not-authenticated-unlock-list.json');

  const trailingTradeStatsAuthenticated = require('./fixtures/latest-stats-authenticated.json');

  let mockGetCacheTrailingTradeSymbols;
  let mockGetCacheTrailingTradeTotalProfitAndLoss;

  let mockWebSocketServer;
  let mockWebSocketServerWebSocketSend;

  let mockConfigGet;
  let mockCacheHGet;
  let mockCacheHGetAll;
  let mockPubSubPublish;
  let mockBinanceClientGetInfo;

  let mockIsActionDisabled;
  let mockGetConfiguration;

  beforeEach(() => {
    jest.clearAllMocks().resetModules();

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

    mockGetCacheTrailingTradeTotalProfitAndLoss = jest
      .fn()
      .mockResolvedValue([]);

    mockCacheHGet = jest.fn().mockResolvedValue(6);

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
      getCacheTrailingTradeSymbols: mockGetCacheTrailingTradeSymbols,
      getCacheTrailingTradeTotalProfitAndLoss:
        mockGetCacheTrailingTradeTotalProfitAndLoss
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
          hget: mockCacheHGet
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
        data: {
          sortBy: 'default',
          sortByDesc: false,
          page: 1,
          searchKeyword: ''
        }
      });
    });

    it('does not trigger ws.send', () => {
      expect(mockWebSocketServerWebSocketSend).not.toHaveBeenCalled();
    });
  });

  describe('with valid cache', () => {
    beforeEach(async () => {
      process.env.GIT_HASH = 'some-hash';

      mockCacheHGetAll = jest.fn().mockImplementation((_key, pattern) => {
        if (pattern === 'trailing-trade-common:*') {
          return trailingTradeCommonJson;
        }

        if (pattern === 'trailing-trade-closed-trades:*') {
          return trailingTradeClosedTrades;
        }

        return '';
      });
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
            hget: mockCacheHGet
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
        trailingTradeStateNotAuthenticatedUnlockList.common.closedTrades =
          _.map(trailingTradeClosedTrades, stats => JSON.parse(stats));
        trailingTradeStateNotAuthenticatedUnlockList.common.totalProfitAndLoss =
          [];
        trailingTradeStateNotAuthenticatedUnlockList.common.streamsCount = 6;
        trailingTradeStateNotAuthenticatedUnlockList.common.symbolsCount = 5;
        trailingTradeStateNotAuthenticatedUnlockList.common.totalPages = 1;
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
            hget: mockCacheHGet
          },
          config: {
            get: mockConfigGet,
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
        trailingTradeStatsAuthenticated.common.closedTrades = _.map(
          trailingTradeClosedTrades,
          stats => JSON.parse(stats)
        );
        trailingTradeStatsAuthenticated.common.totalProfitAndLoss = [];
        trailingTradeStatsAuthenticated.common.streamsCount = 6;
        trailingTradeStatsAuthenticated.common.symbolsCount = 5;
        trailingTradeStatsAuthenticated.common.totalPages = 1;
        expect(mockWebSocketServerWebSocketSend).toHaveBeenCalledWith(
          JSON.stringify(trailingTradeStatsAuthenticated)
        );
      });
    });
  });
});
