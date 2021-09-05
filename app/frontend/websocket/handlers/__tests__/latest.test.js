/* eslint-disable global-require */
describe('latest.test.js', () => {
  const trailingTradeCommonJson = require('./fixtures/latest-trailing-trade-common.json');
  const trailingTradeSymbols = require('./fixtures/latest-trailing-trade-symbols.json');
  const trailingTradeClosedTrades = require('./fixtures/latest-trailing-trade-closed-trades.json');

  // eslint-disable-next-line max-len
  const trailingTradeStateNotAuthenticatedUnlockList = require('./fixtures/latest-stats-not-authenticated-unlock-list.json');

  const trailingTradeStatsAuthenticated = require('./fixtures/latest-stats-authenticated.json');

  let mockFindOne;

  let mockWebSocketServer;
  let mockWebSocketServerWebSocketSend;

  let mockConfigGet;
  let mockCacheHGetAll;
  let mockCacheGetWithTTL;
  let mockMongoUpsertOne;
  let mockPubSubPublish;
  let mockBinanceClientGetInfo;

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
      enabled: true
    });
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
        mongo: {
          findOne: mockFindOne,
          upsertOne: mockMongoUpsertOne
        },
        cache: {
          hgetall: mockCacheHGetAll
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
      await handleLatest(logger, mockWebSocketServer, {});
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

        if (pattern === 'trailing-trade-symbols:*-processed-data') {
          return trailingTradeSymbols;
        }

        if (pattern === 'trailing-trade-closed-trades:*') {
          return trailingTradeClosedTrades;
        }

        return '';
      });

      mockCacheGetWithTTL = jest.fn().mockImplementation(key => {
        if (key === 'BNBUSDT-disable-action') {
          return [
            [null, 330],
            [
              null,
              JSON.stringify({
                disabledBy: 'stop loss',
                canResume: true,
                message: 'Temporary disabled by stop loss'
              })
            ]
          ];
        }

        if (key === 'ETHUSDT-disable-action') {
          return [
            [null, -2],
            [null, null]
          ];
        }

        return null;
      });
    });

    describe('not authenticated and locked list', () => {
      beforeEach(async () => {
        mockGetConfiguration = jest.fn().mockResolvedValue({
          enabled: true,
          type: 'i-am-global',
          candles: { interval: '15m' },
          botOptions: {
            authentication: {
              lockList: true,
              lockAfter: 120
            },
            autoTriggerBuy: {
              enabled: false,
              triggerAfter: 20
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
          isAuthenticated: false
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
              autoTriggerBuy: { enabled: false, triggerAfter: 20 }
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
          candles: { interval: '15m' },
          botOptions: {
            authentication: {
              lockList: false,
              lockAfter: 120
            },
            autoTriggerBuy: {
              enabled: false,
              triggerAfter: 20
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
            getWithTTL: mockCacheGetWithTTL
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
          isAuthenticated: false
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
          botOptions: {
            authentication: {
              lockList: true,
              lockAfter: 120
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
            getWithTTL: mockCacheGetWithTTL
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
          isAuthenticated: true
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
  });
});
