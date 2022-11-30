/* eslint-disable global-require */
// eslint-disable-next-line max-classes-per-file
const { logger } = require('../helpers');

describe('server-binance', () => {
  let mockPubSub;
  let mockCache;
  let mockMongo;
  let mockQueue;

  let mockGetGlobalConfiguration;

  let mockGetAccountInfoFromAPI;
  let mockLockSymbol;
  let mockUnlockSymbol;
  let mockCacheExchangeSymbols;

  let mockSetupUserWebsocket;

  let mockSyncCandles;
  let mockSetupCandlesWebsocket;
  let mockGetWebsocketCandlesClean;

  let mockSyncATHCandles;
  let mockSetupATHCandlesWebsocket;
  let mockGetWebsocketATHCandlesClean;

  let mockSetupTickersWebsocket;
  let mockRefreshTickersClean;
  let mockGetWebsocketTickersClean;

  let mockSyncOpenOrders;
  let mockSyncDatabaseOrders;

  let mockSlack;
  let config;

  beforeEach(async () => {
    jest.clearAllMocks().resetModules();
    jest.useFakeTimers();

    jest.mock('config');
    jest.mock('../cronjob');

    config = require('config');

    mockCache = {
      hget: jest
        .fn()
        .mockResolvedValue(
          JSON.stringify(require('./fixtures/exchange-symbols.json'))
        ),
      hset: jest.fn().mockResolvedValue(true),
      hgetall: jest.fn()
    };
    mockMongo = {
      deleteAll: jest.fn().mockResolvedValue(true)
    };
    mockQueue = {
      init: jest.fn().mockResolvedValue(true),
      executeFor: jest.fn().mockResolvedValue(true)
    };
    mockSlack = {
      sendMessage: jest.fn().mockResolvedValue(true)
    };
    mockPubSub = {
      subscribe: jest.fn(),
      publish: jest.fn()
    };

    jest.mock('../helpers', () => ({
      logger: {
        info: jest.fn(),
        error: jest.fn(),
        warn: jest.fn(),
        debug: jest.fn(),
        child: jest.fn()
      },
      slack: mockSlack,
      mongo: mockMongo,
      PubSub: mockPubSub,
      cache: mockCache
    }));

    jest.mock('../cronjob/trailingTradeHelper/queue', () => mockQueue);
  });

  describe('when the bot is running live mode', () => {
    describe('when the bot just started', () => {
      beforeEach(async () => {
        config.get = jest.fn(key => {
          switch (key) {
            case 'mode':
              return 'live';
            default:
              return `value-${key}`;
          }
        });

        mockLockSymbol = jest.fn().mockResolvedValue(true);
        mockUnlockSymbol = jest.fn().mockResolvedValue(true);

        mockSetupUserWebsocket = jest.fn().mockResolvedValue(true);

        mockSyncCandles = jest.fn().mockResolvedValue(true);
        mockSetupCandlesWebsocket = jest.fn().mockResolvedValue(true);
        mockGetWebsocketCandlesClean = jest.fn().mockResolvedValue(1);

        mockSyncATHCandles = jest.fn().mockResolvedValue(true);
        mockSetupATHCandlesWebsocket = jest.fn().mockResolvedValue(true);
        mockGetWebsocketATHCandlesClean = jest.fn().mockResolvedValue(1);

        mockSetupTickersWebsocket = jest.fn().mockResolvedValue(true);
        mockRefreshTickersClean = jest.fn().mockResolvedValue(true);
        mockGetWebsocketTickersClean = jest.fn().mockResolvedValue(1);

        mockSyncOpenOrders = jest.fn().mockResolvedValue(true);
        mockSyncDatabaseOrders = jest.fn().mockResolvedValue(true);

        mockGetGlobalConfiguration = jest.fn().mockResolvedValue({
          symbols: ['BTCUSDT', 'BNBUSDT']
        });

        mockGetAccountInfoFromAPI = jest.fn().mockResolvedValue({
          account: 'info'
        });

        mockCacheExchangeSymbols = jest.fn().mockResolvedValue(true);

        jest.mock('../cronjob/trailingTradeHelper/configuration', () => ({
          getGlobalConfiguration: mockGetGlobalConfiguration
        }));

        jest.mock('../cronjob/trailingTradeHelper/common', () => ({
          getAccountInfoFromAPI: mockGetAccountInfoFromAPI,
          lockSymbol: mockLockSymbol,
          unlockSymbol: mockUnlockSymbol,
          cacheExchangeSymbols: mockCacheExchangeSymbols
        }));

        jest.mock('../binance/user', () => ({
          setupUserWebsocket: mockSetupUserWebsocket
        }));

        jest.mock('../binance/orders', () => ({
          syncOpenOrders: mockSyncOpenOrders,
          syncDatabaseOrders: mockSyncDatabaseOrders
        }));

        jest.mock('../binance/candles', () => ({
          syncCandles: mockSyncCandles,
          setupCandlesWebsocket: mockSetupCandlesWebsocket,
          getWebsocketCandlesClean: mockGetWebsocketCandlesClean
        }));

        jest.mock('../binance/ath-candles', () => ({
          syncATHCandles: mockSyncATHCandles,
          setupATHCandlesWebsocket: mockSetupATHCandlesWebsocket,
          getWebsocketATHCandlesClean: mockGetWebsocketATHCandlesClean
        }));

        jest.mock('../binance/tickers', () => ({
          setupTickersWebsocket: mockSetupTickersWebsocket,
          refreshTickersClean: mockRefreshTickersClean,
          getWebsocketTickersClean: mockGetWebsocketTickersClean
        }));

        const { runBinance } = require('../server-binance');
        await runBinance(logger);
      });

      it('triggers PubSub.subscribe for reset-all-websockets', () => {
        expect(mockPubSub.subscribe).toHaveBeenCalledWith(
          'reset-all-websockets',
          expect.any(Function)
        );
      });

      it('triggers PubSub.subscribe for reset-symbol-websockets', () => {
        expect(mockPubSub.subscribe).toHaveBeenCalledWith(
          'reset-symbol-websockets',
          expect.any(Function)
        );
      });

      it('triggers getGlobalConfiguration', () => {
        expect(mockGetGlobalConfiguration).toHaveBeenCalled();
      });

      it('triggers getAccountInfoFromAPI', () => {
        expect(mockGetAccountInfoFromAPI).toHaveBeenCalled();
      });

      it('triggers refreshCandles', () => {
        expect(mockMongo.deleteAll).toHaveBeenCalledWith(
          logger,
          'trailing-trade-candles',
          {}
        );
        expect(mockMongo.deleteAll).toHaveBeenCalledWith(
          logger,
          'trailing-trade-ath-candles',
          {}
        );
      });

      it('triggers syncCandles', () => {
        expect(mockSyncCandles).toHaveBeenCalledWith(logger, [
          'BTCUSDT',
          'BNBUSDT'
        ]);
      });

      it('triggers syncATHCandles', () => {
        expect(mockSyncATHCandles).toHaveBeenCalledWith(logger, [
          'BTCUSDT',
          'BNBUSDT'
        ]);
      });

      it('triggers syncOpenOrders', () => {
        expect(mockSyncOpenOrders).toHaveBeenCalledWith(logger, [
          'BTCUSDT',
          'BNBUSDT'
        ]);
      });

      it('triggers syncDatabaseOrders', () => {
        expect(mockSyncDatabaseOrders).toHaveBeenCalledWith(logger);
      });

      it('triggers cache.hset', () => {
        expect(mockCache.hset).toHaveBeenCalledWith(
          'trailing-trade-streams',
          `count`,
          1
        );
      });

      it('triggers queue.init', () => {
        expect(mockQueue.init).toHaveBeenCalled();
      });
    });

    describe('calculates number of open streams', () => {
      beforeEach(async () => {
        config.get = jest.fn(key => {
          switch (key) {
            case 'mode':
              return 'live';
            default:
              return `value-${key}`;
          }
        });

        mockLockSymbol = jest.fn().mockResolvedValue(true);
        mockUnlockSymbol = jest.fn().mockResolvedValue(true);

        mockSetupUserWebsocket = jest.fn().mockResolvedValue(true);

        mockSyncCandles = jest.fn().mockResolvedValue(true);
        mockSetupCandlesWebsocket = jest.fn().mockResolvedValue(true);
        mockGetWebsocketCandlesClean = jest
          .fn()
          .mockImplementation(() => ({ '1h': () => true }));

        mockSyncATHCandles = jest.fn().mockResolvedValue(true);
        mockSetupATHCandlesWebsocket = jest.fn().mockResolvedValue(true);

        mockGetWebsocketATHCandlesClean = jest
          .fn()
          .mockImplementation(() => ({ '1d': () => true, '30m': () => true }));

        mockSetupTickersWebsocket = jest.fn().mockResolvedValue(true);
        mockRefreshTickersClean = jest.fn().mockResolvedValue(true);
        mockGetWebsocketTickersClean = jest.fn().mockImplementation(() => ({
          BTCUSDT: () => true,
          BNBUSDT: () => true
        }));

        mockSyncOpenOrders = jest.fn().mockResolvedValue(true);
        mockSyncDatabaseOrders = jest.fn().mockResolvedValue(true);

        mockGetGlobalConfiguration = jest.fn().mockResolvedValue({
          symbols: ['BTCUSDT', 'BNBUSDT']
        });

        mockGetAccountInfoFromAPI = jest.fn().mockResolvedValue({
          account: 'info'
        });

        mockCacheExchangeSymbols = jest.fn().mockResolvedValue(true);

        jest.mock('../cronjob/trailingTradeHelper/configuration', () => ({
          getGlobalConfiguration: mockGetGlobalConfiguration
        }));

        jest.mock('../cronjob/trailingTradeHelper/common', () => ({
          getAccountInfoFromAPI: mockGetAccountInfoFromAPI,
          lockSymbol: mockLockSymbol,
          unlockSymbol: mockUnlockSymbol,
          cacheExchangeSymbols: mockCacheExchangeSymbols
        }));

        jest.mock('../binance/user', () => ({
          setupUserWebsocket: mockSetupUserWebsocket
        }));

        jest.mock('../binance/orders', () => ({
          syncOpenOrders: mockSyncOpenOrders,
          syncDatabaseOrders: mockSyncDatabaseOrders
        }));

        jest.mock('../binance/candles', () => ({
          syncCandles: mockSyncCandles,
          setupCandlesWebsocket: mockSetupCandlesWebsocket,
          getWebsocketCandlesClean: mockGetWebsocketCandlesClean
        }));

        jest.mock('../binance/ath-candles', () => ({
          syncATHCandles: mockSyncATHCandles,
          setupATHCandlesWebsocket: mockSetupATHCandlesWebsocket,
          getWebsocketATHCandlesClean: mockGetWebsocketATHCandlesClean
        }));

        jest.mock('../binance/tickers', () => ({
          setupTickersWebsocket: mockSetupTickersWebsocket,
          refreshTickersClean: mockRefreshTickersClean,
          getWebsocketTickersClean: mockGetWebsocketTickersClean
        }));

        const { runBinance } = require('../server-binance');

        await runBinance(logger);
      });

      it('triggers getWebsocketTickersClean', () => {
        expect(mockGetWebsocketTickersClean).toHaveBeenCalled();
      });

      it('triggers getWebsocketATHCandlesClean', () => {
        expect(mockGetWebsocketATHCandlesClean).toHaveBeenCalled();
      });

      it('triggers getWebsocketCandlesClean', () => {
        expect(mockGetWebsocketCandlesClean).toHaveBeenCalled();
      });

      it('triggers cacheExchangeSymbols', () => {
        expect(mockCacheExchangeSymbols).toHaveBeenCalled();
      });

      it('triggers cache.hset', () => {
        expect(mockCache.hset).toHaveBeenCalledWith(
          'trailing-trade-streams',
          `count`,
          1 + 5
        );
      });
    });

    describe('when data received in check-open-orders channel', () => {
      beforeEach(async () => {
        config.get = jest.fn(key => {
          switch (key) {
            case 'mode':
              return 'live';
            default:
              return `value-${key}`;
          }
        });

        mockLockSymbol = jest.fn().mockResolvedValue(true);
        mockUnlockSymbol = jest.fn().mockResolvedValue(true);

        mockSetupUserWebsocket = jest.fn().mockResolvedValue(true);

        mockSyncCandles = jest.fn().mockResolvedValue(true);
        mockSetupCandlesWebsocket = jest.fn().mockResolvedValue(true);
        mockGetWebsocketCandlesClean = jest
          .fn()
          .mockImplementation(() => ({ '1h': () => true }));

        mockSyncATHCandles = jest.fn().mockResolvedValue(true);
        mockSetupATHCandlesWebsocket = jest.fn().mockResolvedValue(true);

        mockGetWebsocketATHCandlesClean = jest
          .fn()
          .mockImplementation(() => ({ '1d': () => true, '30m': () => true }));

        mockSetupTickersWebsocket = jest.fn().mockResolvedValue(true);
        mockRefreshTickersClean = jest.fn().mockResolvedValue(true);
        mockGetWebsocketTickersClean = jest.fn().mockImplementation(() => ({
          BTCUSDT: () => true,
          BNBUSDT: () => true
        }));

        mockSyncOpenOrders = jest.fn().mockResolvedValue(true);
        mockSyncDatabaseOrders = jest.fn().mockResolvedValue(true);

        mockGetGlobalConfiguration = jest.fn().mockResolvedValue({
          symbols: ['BTCUSDT', 'BNBUSDT']
        });

        mockGetAccountInfoFromAPI = jest.fn().mockResolvedValue({
          account: 'info'
        });

        mockCacheExchangeSymbols = jest.fn().mockResolvedValue(true);

        jest.mock('../cronjob/trailingTradeHelper/configuration', () => ({
          getGlobalConfiguration: mockGetGlobalConfiguration
        }));

        jest.mock('../cronjob/trailingTradeHelper/common', () => ({
          getAccountInfoFromAPI: mockGetAccountInfoFromAPI,
          lockSymbol: mockLockSymbol,
          unlockSymbol: mockUnlockSymbol,
          cacheExchangeSymbols: mockCacheExchangeSymbols
        }));

        jest.mock('../binance/user', () => ({
          setupUserWebsocket: mockSetupUserWebsocket
        }));

        jest.mock('../binance/orders', () => ({
          syncOpenOrders: mockSyncOpenOrders,
          syncDatabaseOrders: mockSyncDatabaseOrders
        }));

        jest.mock('../binance/candles', () => ({
          syncCandles: mockSyncCandles,
          setupCandlesWebsocket: mockSetupCandlesWebsocket,
          getWebsocketCandlesClean: mockGetWebsocketCandlesClean
        }));

        jest.mock('../binance/ath-candles', () => ({
          syncATHCandles: mockSyncATHCandles,
          setupATHCandlesWebsocket: mockSetupATHCandlesWebsocket,
          getWebsocketATHCandlesClean: mockGetWebsocketATHCandlesClean
        }));

        jest.mock('../binance/tickers', () => ({
          setupTickersWebsocket: mockSetupTickersWebsocket,
          refreshTickersClean: mockRefreshTickersClean,
          getWebsocketTickersClean: mockGetWebsocketTickersClean
        }));

        mockPubSub.subscribe = jest.fn().mockImplementation((key, cb) => {
          if (key === 'check-open-orders') {
            cb('message', 'data');
          }
        });
      });

      describe('when open orders empty', () => {
        beforeEach(async () => {
          mockCache.hgetall = jest.fn().mockResolvedValue(null);

          const { runBinance } = require('../server-binance');
          await runBinance(logger);
        });

        it('does not trigger queue.executeFor', () => {
          expect(mockQueue.executeFor).not.toHaveBeenCalled();
        });
      });

      describe('when open orders not empty', () => {
        beforeEach(async () => {
          mockCache.hgetall = jest.fn().mockResolvedValue({
            BTCUSDT: [{ orderId: 1, symbol: 'BTCUSDT' }]
          });

          const { runBinance } = require('../server-binance');
          await runBinance(logger);
        });

        it('triggers queue.executeFor', () => {
          expect(mockQueue.executeFor).toHaveBeenCalledWith(logger, 'BTCUSDT');
        });
      });
    });

    describe('when data received in reset-symbol-websockets channel', () => {
      beforeEach(async () => {
        config.get = jest.fn(key => {
          switch (key) {
            case 'mode':
              return 'live';
            default:
              return `value-${key}`;
          }
        });

        mockLockSymbol = jest.fn().mockResolvedValue(true);
        mockUnlockSymbol = jest.fn().mockResolvedValue(true);

        mockSetupUserWebsocket = jest.fn().mockResolvedValue(true);

        mockSyncCandles = jest.fn().mockResolvedValue(true);
        mockSetupCandlesWebsocket = jest.fn().mockResolvedValue(true);
        mockGetWebsocketCandlesClean = jest
          .fn()
          .mockImplementation(() => ({ '1h': () => true }));

        mockSyncATHCandles = jest.fn().mockResolvedValue(true);
        mockSetupATHCandlesWebsocket = jest.fn().mockResolvedValue(true);

        mockGetWebsocketATHCandlesClean = jest
          .fn()
          .mockImplementation(() => ({ '1d': () => true, '30m': () => true }));

        mockSetupTickersWebsocket = jest.fn().mockResolvedValue(true);
        mockRefreshTickersClean = jest.fn().mockResolvedValue(true);
        mockGetWebsocketTickersClean = jest.fn().mockImplementation(() => ({
          BTCUSDT: () => true,
          BNBUSDT: () => true
        }));

        mockSyncOpenOrders = jest.fn().mockResolvedValue(true);
        mockSyncDatabaseOrders = jest.fn().mockResolvedValue(true);

        mockGetGlobalConfiguration = jest.fn().mockResolvedValue({
          symbols: ['BTCUSDT', 'BNBUSDT']
        });

        mockGetAccountInfoFromAPI = jest.fn().mockResolvedValue({
          account: 'info'
        });

        mockCacheExchangeSymbols = jest.fn().mockResolvedValue(true);

        jest.mock('../cronjob/trailingTradeHelper/configuration', () => ({
          getGlobalConfiguration: mockGetGlobalConfiguration
        }));

        jest.mock('../cronjob/trailingTradeHelper/common', () => ({
          getAccountInfoFromAPI: mockGetAccountInfoFromAPI,
          lockSymbol: mockLockSymbol,
          unlockSymbol: mockUnlockSymbol,
          cacheExchangeSymbols: mockCacheExchangeSymbols
        }));

        jest.mock('../binance/user', () => ({
          setupUserWebsocket: mockSetupUserWebsocket
        }));

        jest.mock('../binance/orders', () => ({
          syncOpenOrders: mockSyncOpenOrders,
          syncDatabaseOrders: mockSyncDatabaseOrders
        }));

        jest.mock('../binance/candles', () => ({
          syncCandles: mockSyncCandles,
          setupCandlesWebsocket: mockSetupCandlesWebsocket,
          getWebsocketCandlesClean: mockGetWebsocketCandlesClean
        }));

        jest.mock('../binance/ath-candles', () => ({
          syncATHCandles: mockSyncATHCandles,
          setupATHCandlesWebsocket: mockSetupATHCandlesWebsocket,
          getWebsocketATHCandlesClean: mockGetWebsocketATHCandlesClean
        }));

        jest.mock('../binance/tickers', () => ({
          setupTickersWebsocket: mockSetupTickersWebsocket,
          refreshTickersClean: mockRefreshTickersClean,
          getWebsocketTickersClean: mockGetWebsocketTickersClean
        }));

        mockPubSub.subscribe = jest.fn().mockImplementation((key, cb) => {
          if (key === 'reset-symbol-websockets') {
            cb('message', 'BTCUSDT');
          }
        });

        const { runBinance } = require('../server-binance');
        await runBinance(logger);
      });

      it('triggers setupTickersWebsocket', () => {
        expect(mockSetupTickersWebsocket).toHaveBeenCalledWith(logger, [
          'BTCUSDT'
        ]);
      });
    });
  });

  describe('when the bot is running test mode', () => {
    beforeEach(async () => {
      config.get = jest.fn(key => {
        switch (key) {
          case 'mode':
            return 'test';
          default:
            return `value-${key}`;
        }
      });

      mockLockSymbol = jest.fn().mockResolvedValue(true);
      mockUnlockSymbol = jest.fn().mockResolvedValue(true);

      mockSetupUserWebsocket = jest.fn().mockResolvedValue(true);

      mockSyncCandles = jest.fn().mockResolvedValue(true);
      mockSetupCandlesWebsocket = jest.fn().mockResolvedValue(true);
      mockGetWebsocketCandlesClean = jest.fn().mockResolvedValue(44);

      mockSyncATHCandles = jest.fn().mockResolvedValue(true);
      mockSetupATHCandlesWebsocket = jest.fn().mockResolvedValue(true);
      mockGetWebsocketATHCandlesClean = jest.fn().mockResolvedValue(44);

      mockSetupTickersWebsocket = jest.fn().mockResolvedValue(true);
      mockRefreshTickersClean = jest.fn().mockResolvedValue(true);
      mockGetWebsocketTickersClean = jest.fn().mockResolvedValue(44);

      mockSyncOpenOrders = jest.fn().mockResolvedValue(true);
      mockSyncDatabaseOrders = jest.fn().mockResolvedValue(true);

      mockGetGlobalConfiguration = jest.fn().mockResolvedValue({
        symbols: ['BTCUSDT', 'ETHUSDT', 'LTCUSDT']
      });

      mockGetAccountInfoFromAPI = jest.fn().mockResolvedValue({
        account: 'info'
      });

      mockCacheExchangeSymbols = jest.fn().mockResolvedValue(true);

      jest.mock('../cronjob/trailingTradeHelper/configuration', () => ({
        getGlobalConfiguration: mockGetGlobalConfiguration
      }));

      jest.mock('../cronjob/trailingTradeHelper/common', () => ({
        getAccountInfoFromAPI: mockGetAccountInfoFromAPI,
        lockSymbol: mockLockSymbol,
        unlockSymbol: mockUnlockSymbol,
        cacheExchangeSymbols: mockCacheExchangeSymbols
      }));

      jest.mock('../binance/user', () => ({
        setupUserWebsocket: mockSetupUserWebsocket
      }));

      jest.mock('../binance/orders', () => ({
        syncOpenOrders: mockSyncOpenOrders,
        syncDatabaseOrders: mockSyncDatabaseOrders
      }));

      jest.mock('../binance/candles', () => ({
        syncCandles: mockSyncCandles,
        setupCandlesWebsocket: mockSetupCandlesWebsocket,
        getWebsocketCandlesClean: mockGetWebsocketCandlesClean
      }));

      jest.mock('../binance/ath-candles', () => ({
        syncATHCandles: mockSyncATHCandles,
        setupATHCandlesWebsocket: mockSetupATHCandlesWebsocket,
        getWebsocketATHCandlesClean: mockGetWebsocketATHCandlesClean
      }));

      jest.mock('../binance/tickers', () => ({
        setupTickersWebsocket: mockSetupTickersWebsocket,
        refreshTickersClean: mockRefreshTickersClean,
        getWebsocketTickersClean: mockGetWebsocketTickersClean
      }));

      mockPubSub.subscribe = jest.fn().mockImplementation((_key, cb) => {
        cb('message', 'data');
      });

      const { runBinance } = require('../server-binance');
      await runBinance(logger);
    });

    it('triggers PubSub.subscribe for reset-all-websockets', () => {
      expect(mockPubSub.subscribe).toHaveBeenCalledWith(
        'reset-all-websockets',
        expect.any(Function)
      );
    });

    it('triggers PubSub.subscribe for reset-symbol-websockets', () => {
      expect(mockPubSub.subscribe).toHaveBeenCalledWith(
        'reset-symbol-websockets',
        expect.any(Function)
      );
    });

    it('triggers getGlobalConfiguration', () => {
      expect(mockGetGlobalConfiguration).toHaveBeenCalled();
    });

    it('triggers getAccountInfoFromAPI', () => {
      expect(mockGetAccountInfoFromAPI).toHaveBeenCalled();
    });

    it('triggers refreshCandles', () => {
      expect(mockMongo.deleteAll).toHaveBeenCalledWith(
        logger,
        'trailing-trade-candles',
        {}
      );
      expect(mockMongo.deleteAll).toHaveBeenCalledWith(
        logger,
        'trailing-trade-ath-candles',
        {}
      );
    });

    it('triggers cacheExchangeSymbols', () => {
      expect(mockCacheExchangeSymbols).toHaveBeenCalled();
    });

    it('triggers syncCandles', () => {
      expect(mockSyncCandles).toHaveBeenCalledWith(logger, [
        'BTCUSDT',
        'ETHUSDT',
        'LTCUSDT'
      ]);
    });

    it('triggers syncATHCandles', () => {
      expect(mockSyncATHCandles).toHaveBeenCalledWith(logger, [
        'BTCUSDT',
        'ETHUSDT',
        'LTCUSDT'
      ]);
    });

    it('triggers syncOpenOrders', () => {
      expect(mockSyncOpenOrders).toHaveBeenCalledWith(logger, [
        'BTCUSDT',
        'ETHUSDT',
        'LTCUSDT'
      ]);
    });

    it('triggers syncDatabaseOrders', () => {
      expect(mockSyncDatabaseOrders).toHaveBeenCalledWith(logger);
    });

    it('triggers cache.hset', () => {
      expect(mockCache.hset).toHaveBeenCalledWith(
        'trailing-trade-streams',
        `count`,
        1
      );
    });
  });

  describe('when running bot twice', () => {
    beforeEach(async () => {
      config.get = jest.fn(key => {
        switch (key) {
          case 'mode':
            return 'live';
          default:
            return `value-${key}`;
        }
      });

      mockLockSymbol = jest.fn().mockResolvedValue(true);
      mockUnlockSymbol = jest.fn().mockResolvedValue(true);

      mockSetupUserWebsocket = jest.fn().mockResolvedValue(true);

      mockSyncCandles = jest.fn().mockResolvedValue(true);
      mockSetupCandlesWebsocket = jest.fn().mockResolvedValue(true);
      mockGetWebsocketCandlesClean = jest.fn().mockResolvedValue(44);

      mockSyncATHCandles = jest.fn().mockResolvedValue(true);
      mockSetupATHCandlesWebsocket = jest.fn().mockResolvedValue(true);
      mockGetWebsocketATHCandlesClean = jest.fn().mockResolvedValue(44);

      mockSetupTickersWebsocket = jest.fn().mockResolvedValue(true);
      mockRefreshTickersClean = jest.fn().mockResolvedValue(true);
      mockGetWebsocketTickersClean = jest.fn().mockResolvedValue(44);

      mockSyncOpenOrders = jest.fn().mockResolvedValue(true);
      mockSyncDatabaseOrders = jest.fn().mockResolvedValue(true);

      mockGetGlobalConfiguration = jest.fn().mockResolvedValue({
        symbols: ['BTCUSDT', 'ETHUSDT', 'LTCUSDT']
      });

      mockGetAccountInfoFromAPI = jest.fn().mockResolvedValue({
        account: 'info'
      });

      mockCacheExchangeSymbols = jest.fn().mockResolvedValue(true);

      jest.mock('../cronjob/trailingTradeHelper/configuration', () => ({
        getGlobalConfiguration: mockGetGlobalConfiguration
      }));

      jest.mock('../cronjob/trailingTradeHelper/common', () => ({
        getAccountInfoFromAPI: mockGetAccountInfoFromAPI,
        lockSymbol: mockLockSymbol,
        unlockSymbol: mockUnlockSymbol,
        cacheExchangeSymbols: mockCacheExchangeSymbols
      }));

      jest.mock('../binance/user', () => ({
        setupUserWebsocket: mockSetupUserWebsocket
      }));

      jest.mock('../binance/orders', () => ({
        syncOpenOrders: mockSyncOpenOrders,
        syncDatabaseOrders: mockSyncDatabaseOrders
      }));

      jest.mock('../binance/candles', () => ({
        syncCandles: mockSyncCandles,
        setupCandlesWebsocket: mockSetupCandlesWebsocket,
        getWebsocketCandlesClean: mockGetWebsocketCandlesClean
      }));

      jest.mock('../binance/ath-candles', () => ({
        syncATHCandles: mockSyncATHCandles,
        setupATHCandlesWebsocket: mockSetupATHCandlesWebsocket,
        getWebsocketATHCandlesClean: mockGetWebsocketATHCandlesClean
      }));

      jest.mock('../binance/tickers', () => ({
        setupTickersWebsocket: mockSetupTickersWebsocket,
        refreshTickersClean: mockRefreshTickersClean,
        getWebsocketTickersClean: mockGetWebsocketTickersClean
      }));

      mockPubSub.subscribe = jest.fn().mockResolvedValue(true);

      const { runBinance } = require('../server-binance');
      await runBinance(logger);
      await runBinance(logger);
    });

    it('triggers cacheExchangeSymbols', () => {
      expect(mockCacheExchangeSymbols).toHaveBeenCalledTimes(2);
    });

    describe('when exchangeSymbolsInterval is passed', () => {
      beforeEach(() => {
        jest.advanceTimersByTime(61 * 1000);
      });

      it('triggers cacheExchangeSymbols', () => {
        expect(mockCacheExchangeSymbols).toHaveBeenCalledTimes(3);
      });
    });
  });
});
