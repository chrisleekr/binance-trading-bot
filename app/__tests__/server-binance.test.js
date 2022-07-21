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

  let mockGetAPILimit;
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

    mockGetAPILimit = jest.fn().mockReturnValue(10);
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
          cacheExchangeSymbols: mockCacheExchangeSymbols,
          getAPILimit: mockGetAPILimit
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

        PubSubMock.subscribe = jest.fn().mockImplementation((_key, cb) => {
          cb('message', 'data');
        });

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

  describe('with errors', () => {
    beforeEach(async () => {
      mockLockSymbol = jest.fn().mockResolvedValue(true);
      mockUnlockSymbol = jest.fn().mockResolvedValue(true);

      mockSetupUserWebsocket = jest.fn().mockResolvedValue(true);

      mockSyncCandles = jest.fn().mockResolvedValue(true);
      mockSetupCandlesWebsocket = jest.fn().mockResolvedValue(true);
      mockGetWebsocketCandlesClean = jest.fn().mockResolvedValue(1);

      mockSyncATHCandles = jest.fn().mockResolvedValue(true);
      mockSetupATHCandlesWebsocket = jest.fn().mockResolvedValue(true);
      mockGetWebsocketATHCandlesClean = jest.fn().mockResolvedValue(1);

      mockRefreshTickersClean = jest.fn().mockResolvedValue(true);
      mockGetWebsocketTickersClean = jest.fn().mockResolvedValue(1);
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
        cacheExchangeSymbols: mockCacheExchangeSymbols,
        getAPILimit: mockGetAPILimit
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
        refreshTickersClean: mockRefreshTickersClean,
        getWebsocketTickersClean: mockGetWebsocketTickersClean,
        setupTickersWebsocket: mockSetupTickersWebsocket
      }));

      mongoMock.deleteAll = jest.fn().mockResolvedValue(true);

      PubSubMock.subscribe = jest.fn().mockResolvedValue(true);

      cacheMock.hget = jest
        .fn()
        .mockResolvedValue(
          JSON.stringify(require('./fixtures/exchange-symbols.json'))
        );

      cacheMock.hset = jest.fn().mockResolvedValue(true);
    });

    [
      {
        label: 'Error -1001',
        code: -1001,
        sendSlack: false,
        featureToggleNotifyDebug: false
      },
      {
        label: 'Error -1021',
        code: -1021,
        sendSlack: false,
        featureToggleNotifyDebug: true
      },
      {
        label: 'Error ECONNRESET',
        code: 'ECONNRESET',
        sendSlack: false,
        featureToggleNotifyDebug: false
      },
      {
        label: 'Error ECONNREFUSED',
        code: 'ECONNREFUSED',
        sendSlack: false,
        featureToggleNotifyDebug: true
      },
      {
        label: 'Error something else - with notify debug',
        code: 'something',
        sendSlack: true,
        featureToggleNotifyDebug: true
      },
      {
        label: 'Error something else - without notify debug',
        code: 'something',
        sendSlack: true,
        featureToggleNotifyDebug: false
      }
    ].forEach(errorInfo => {
      describe(`${errorInfo.label}`, () => {
        beforeEach(async () => {
          config.get = jest.fn(key => {
            if (key === 'featureToggle.notifyDebug') {
              return errorInfo.featureToggleNotifyDebug;
            }
            return null;
          });

          mockSyncOpenOrders = jest.fn().mockRejectedValueOnce(
            new (class CustomError extends Error {
              constructor() {
                super();
                this.code = errorInfo.code;
                this.message = `${errorInfo.featureToggleNotifyDebug} ${errorInfo.label} ${errorInfo.code}`;
              }
            })()
          );

          const { runBinance } = require('../server-binance');
          await runBinance(loggerMock);
        });

        if (errorInfo.sendSlack) {
          it('triggers slack.sendMessage', () => {
            expect(mockSlack.sendMessage).toHaveBeenCalled();
          });
        } else {
          it('does not trigger slack.sendMessagage', () => {
            expect(mockSlack.sendMessage).not.toHaveBeenCalled();
          });
        }
      });
    });

    describe(`redlock error`, () => {
      beforeEach(async () => {
        config.get = jest.fn(_key => null);

        mockSyncOpenOrders = jest.fn().mockResolvedValue(true);

        mockSetupTickersWebsocket = jest.fn().mockRejectedValueOnce(
          new (class CustomError extends Error {
            constructor() {
              super();
              this.code = 500;
              this.message = `redlock:trailing-trade-symbols:XRPBUSD-latest-candle`;
            }
          })()
        );

        const { runBinance } = require('../server-binance');
        await runBinance(loggerMock);
      });

      it('do not trigger slack.sendMessagage', () => {
        expect(mockSlack.sendMessage).not.toHaveBeenCalled();
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
