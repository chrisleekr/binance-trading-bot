/* eslint-disable global-require */
// eslint-disable-next-line max-classes-per-file
describe('server-binance', () => {
  let PubSubMock;
  let loggerMock;
  let cacheMock;
  let mongoMock;

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

    const { PubSub, logger, cache, mongo, slack } = require('../helpers');

    jest.mock('config');

    config = require('config');

    PubSubMock = PubSub;
    loggerMock = logger;
    cacheMock = cache;
    mongoMock = mongo;

    mockSlack = slack;
    mockSlack.sendMessage = jest.fn().mockResolvedValue(true);
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

        mongoMock.deleteAll = jest.fn().mockResolvedValue(true);

        PubSubMock.subscribe = jest.fn().mockResolvedValue(true);

        cacheMock.hget = jest
          .fn()
          .mockResolvedValue(
            JSON.stringify(require('./fixtures/exchange-symbols.json'))
          );
        cacheMock.hset = jest.fn().mockResolvedValue(true);

        const { runBinance } = require('../server-binance');
        await runBinance(loggerMock);
      });

      it('triggers PubSub.subscribe for reset-all-websockets', () => {
        expect(PubSubMock.subscribe).toHaveBeenCalledWith(
          'reset-all-websockets',
          expect.any(Function)
        );
      });

      it('triggers PubSub.subscribe for reset-symbol-websockets', () => {
        expect(PubSubMock.subscribe).toHaveBeenCalledWith(
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
        expect(mongoMock.deleteAll).toHaveBeenCalledWith(
          loggerMock,
          'trailing-trade-candles',
          {}
        );
        expect(mongoMock.deleteAll).toHaveBeenCalledWith(
          loggerMock,
          'trailing-trade-ath-candles',
          {}
        );
      });

      it('triggers syncCandles', () => {
        expect(mockSyncCandles).toHaveBeenCalledWith(loggerMock, [
          'BTCUSDT',
          'BNBUSDT'
        ]);
      });

      it('triggers syncATHCandles', () => {
        expect(mockSyncATHCandles).toHaveBeenCalledWith(loggerMock, [
          'BTCUSDT',
          'BNBUSDT'
        ]);
      });

      it('triggers syncOpenOrders', () => {
        expect(mockSyncOpenOrders).toHaveBeenCalledWith(loggerMock, [
          'BTCUSDT',
          'BNBUSDT'
        ]);
      });

      it('triggers syncDatabaseOrders', () => {
        expect(mockSyncDatabaseOrders).toHaveBeenCalledWith(loggerMock);
      });

      it('triggers cache.hset', () => {
        expect(cacheMock.hset).toHaveBeenCalledWith(
          'trailing-trade-streams',
          `count`,
          1
        );
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

        PubSubMock.subscribe = jest.fn().mockResolvedValue(true);

        mongoMock.deleteAll = jest.fn().mockResolvedValue(true);

        cacheMock.hset = jest.fn().mockResolvedValue(true);

        const { runBinance } = require('../server-binance');

        await runBinance(loggerMock);
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
        expect(cacheMock.hset).toHaveBeenCalledWith(
          'trailing-trade-streams',
          `count`,
          1 + 5
        );
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

      PubSubMock.subscribe = jest.fn().mockImplementation((_key, cb) => {
        cb('message', 'data');
      });

      mongoMock.deleteAll = jest.fn().mockResolvedValue(true);

      cacheMock.hset = jest.fn().mockResolvedValue(true);

      const { runBinance } = require('../server-binance');
      await runBinance(loggerMock);
    });

    it('triggers PubSub.subscribe for reset-all-websockets', () => {
      expect(PubSubMock.subscribe).toHaveBeenCalledWith(
        'reset-all-websockets',
        expect.any(Function)
      );
    });

    it('triggers PubSub.subscribe for reset-symbol-websockets', () => {
      expect(PubSubMock.subscribe).toHaveBeenCalledWith(
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
      expect(mongoMock.deleteAll).toHaveBeenCalledWith(
        loggerMock,
        'trailing-trade-candles',
        {}
      );
      expect(mongoMock.deleteAll).toHaveBeenCalledWith(
        loggerMock,
        'trailing-trade-ath-candles',
        {}
      );
    });

    it('triggers cacheExchangeSymbols', () => {
      expect(mockCacheExchangeSymbols).toHaveBeenCalled();
    });

    it('triggers syncCandles', () => {
      expect(mockSyncCandles).toHaveBeenCalledWith(loggerMock, [
        'BTCUSDT',
        'ETHUSDT',
        'LTCUSDT'
      ]);
    });

    it('triggers syncATHCandles', () => {
      expect(mockSyncATHCandles).toHaveBeenCalledWith(loggerMock, [
        'BTCUSDT',
        'ETHUSDT',
        'LTCUSDT'
      ]);
    });

    it('triggers syncOpenOrders', () => {
      expect(mockSyncOpenOrders).toHaveBeenCalledWith(loggerMock, [
        'BTCUSDT',
        'ETHUSDT',
        'LTCUSDT'
      ]);
    });

    it('triggers syncDatabaseOrders', () => {
      expect(mockSyncDatabaseOrders).toHaveBeenCalledWith(loggerMock);
    });

    it('triggers cache.hset', () => {
      expect(cacheMock.hset).toHaveBeenCalledWith(
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

      PubSubMock.subscribe = jest.fn().mockResolvedValue(true);

      mongoMock.deleteAll = jest.fn().mockResolvedValue(true);

      cacheMock.hset = jest.fn().mockResolvedValue(true);

      const { runBinance } = require('../server-binance');
      await runBinance(loggerMock);
      await runBinance(loggerMock);
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
