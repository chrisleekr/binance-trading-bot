/* eslint-disable global-require */
const _ = require('lodash');

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
  let mockCacheHGet;
  let mockCacheGetWithTTL;
  let mockMongoUpsertOne;
  let mockPubSubPublish;
  let mockBinanceClientGetInfo;

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

    mockFindOne = jest.fn((_logger, collection, filter) => {
      if (
        collection === 'trailing-trade-common' &&
        _.isEqual(filter, { key: 'configuration' })
      ) {
        return {
          enabled: true
        };
      }

      if (
        collection === 'trailing-trade-symbols' &&
        _.isEqual(filter, { key: 'BNBUSDT-configuration' })
      ) {
        return { enabled: true, symbol: 'BNBUSDT' };
      }
      if (
        collection === 'trailing-trade-symbols' &&
        _.isEqual(filter, { key: 'BNBUSDT-last-buy-price' })
      ) {
        return { lastBuyPrice: null };
      }

      if (
        collection === 'trailing-trade-symbols' &&
        _.isEqual(filter, { key: 'ETHUSDT-configuration' })
      ) {
        return { enabled: true, symbol: 'ETHUSDT' };
      }

      if (
        collection === 'trailing-trade-symbols' &&
        _.isEqual(filter, { key: 'ETHUSDT-last-buy-price' })
      ) {
        return { lastBuyPrice: null };
      }

      return null;
    });

    mockMongoUpsertOne = jest.fn();

    mockPubSubPublish = jest.fn();
  });

  describe('when some cache is invalid', () => {
    beforeEach(async () => {
      mockCacheHGetAll = jest.fn().mockImplementation(_key => '');

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

      mockCacheHGetAll = jest.fn().mockImplementation(key => {
        if (key === 'trailing-trade-common') {
          return trailingTradeCommonJson;
        }

        if (key === 'trailing-trade-symbols') {
          return trailingTradeSymbols;
        }

        if (key === 'trailing-trade-closed-trades') {
          return trailingTradeClosedTrades;
        }

        return '';
      });

      mockCacheHGet = jest.fn().mockImplementation((hash, key) => {
        if (
          hash === 'trailing-trade-symbols' &&
          key === 'BNBUSDT-symbol-info'
        ) {
          return JSON.stringify({
            filterMinNotional: { minNotional: '10.00000000' }
          });
        }

        if (
          hash === 'trailing-trade-symbols' &&
          key === 'ETHUSDT-symbol-info'
        ) {
          return JSON.stringify({
            filterMinNotional: { minNotional: '10.00000000' }
          });
        }

        return null;
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
        mockFindOne = jest
          .fn()
          .mockImplementation((_logger, collection, filter) => {
            if (
              collection === 'trailing-trade-common' &&
              _.isEqual(filter, { key: 'configuration' })
            ) {
              return {
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
              };
            }

            if (
              collection === 'trailing-trade-symbols' &&
              _.isEqual(filter, { key: 'BNBUSDT-configuration' })
            ) {
              return {
                enabled: true,
                symbol: 'BNBUSDT',
                type: 'i-am-symbol'
              };
            }
            if (
              collection === 'trailing-trade-symbols' &&
              _.isEqual(filter, { key: 'BNBUSDT-last-buy-price' })
            ) {
              return { lastBuyPrice: 100, quantity: 10, type: 'i-am-symbol' };
            }

            if (
              collection === 'trailing-trade-symbols' &&
              _.isEqual(filter, { key: 'ETHUSDT-configuration' })
            ) {
              return {
                enabled: true,
                symbol: 'ETHUSDT',
                type: 'i-am-symbol'
              };
            }

            if (
              collection === 'trailing-trade-symbols' &&
              _.isEqual(filter, { key: 'ETHUSDT-last-buy-price' })
            ) {
              return {
                lastBuyPrice: null,
                quantity: null,
                type: 'i-am-symbol'
              };
            }

            return null;
          });

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
            hgetall: mockCacheHGetAll,
            hget: mockCacheHGet,
            getWithTTL: mockCacheGetWithTTL
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
        mockFindOne = jest
          .fn()
          .mockImplementation((_logger, collection, filter) => {
            if (
              collection === 'trailing-trade-common' &&
              _.isEqual(filter, { key: 'configuration' })
            ) {
              return {
                enabled: true,
                type: 'i-am-global',
                candles: { interval: '15m' },
                botOptions: {
                  authentication: {
                    lockList: false,
                    lockAfter: 120
                  }
                },
                sell: {}
              };
            }

            if (
              collection === 'trailing-trade-symbols' &&
              _.isEqual(filter, { key: 'BNBUSDT-configuration' })
            ) {
              return {
                enabled: true,
                symbol: 'BNBUSDT',
                type: 'i-am-symbol'
              };
            }
            if (
              collection === 'trailing-trade-symbols' &&
              _.isEqual(filter, { key: 'BNBUSDT-last-buy-price' })
            ) {
              return { lastBuyPrice: 100, quantity: 10, type: 'i-am-symbol' };
            }

            if (
              collection === 'trailing-trade-symbols' &&
              _.isEqual(filter, { key: 'ETHUSDT-configuration' })
            ) {
              return {
                enabled: true,
                symbol: 'ETHUSDT',
                type: 'i-am-symbol'
              };
            }

            if (
              collection === 'trailing-trade-symbols' &&
              _.isEqual(filter, { key: 'ETHUSDT-last-buy-price' })
            ) {
              return {
                lastBuyPrice: null,
                quantity: null,
                type: 'i-am-symbol'
              };
            }

            return null;
          });

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
            hgetall: mockCacheHGetAll,
            hget: mockCacheHGet,
            getWithTTL: mockCacheGetWithTTL
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
        mockFindOne = jest
          .fn()
          .mockImplementation((_logger, collection, filter) => {
            if (
              collection === 'trailing-trade-common' &&
              _.isEqual(filter, { key: 'configuration' })
            ) {
              return {
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
              };
            }

            if (
              collection === 'trailing-trade-symbols' &&
              _.isEqual(filter, { key: 'BNBUSDT-configuration' })
            ) {
              return {
                enabled: true,
                symbol: 'BNBUSDT',
                type: 'i-am-symbol'
              };
            }
            if (
              collection === 'trailing-trade-symbols' &&
              _.isEqual(filter, { key: 'BNBUSDT-last-buy-price' })
            ) {
              return { lastBuyPrice: 100, quantity: 10, type: 'i-am-symbol' };
            }

            if (
              collection === 'trailing-trade-symbols' &&
              _.isEqual(filter, { key: 'ETHUSDT-configuration' })
            ) {
              return {
                enabled: true,
                symbol: 'ETHUSDT',
                type: 'i-am-symbol'
              };
            }

            if (
              collection === 'trailing-trade-symbols' &&
              _.isEqual(filter, { key: 'ETHUSDT-last-buy-price' })
            ) {
              return {
                lastBuyPrice: null,
                quantity: null,
                type: 'i-am-symbol'
              };
            }

            return null;
          });

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
            hgetall: mockCacheHGetAll,
            hget: mockCacheHGet,
            getWithTTL: mockCacheGetWithTTL
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
