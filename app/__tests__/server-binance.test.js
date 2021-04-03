/* eslint-disable global-require */

describe('server-binance', () => {
  let config;

  let PubSubMock;
  let binanceMock;
  let loggerMock;
  let cacheMock;

  let mockGetGlobalConfiguration;

  let mockWebsocketCandlesClean;

  beforeEach(async () => {
    jest.clearAllMocks().resetModules();
    jest.mock('config');

    const { PubSub, binance, logger, cache } = require('../helpers');

    PubSubMock = PubSub;
    binanceMock = binance;
    loggerMock = logger;
    cacheMock = cache;

    config = require('config');
  });

  describe('when websocket candles clean is null', () => {
    beforeEach(async () => {
      config.get = jest.fn(key => `value-${key}`);

      mockGetGlobalConfiguration = jest.fn().mockResolvedValue({
        symbols: ['BTCUSDT']
      });

      jest.mock('../cronjob/trailingTradeHelper/configuration', () => ({
        getGlobalConfiguration: mockGetGlobalConfiguration
      }));

      mockWebsocketCandlesClean = jest.fn().mockResolvedValue(true);
      PubSubMock.subscribe = jest.fn().mockImplementation((_key, cb) => {
        cb('message', 'data');

        return () => mockWebsocketCandlesClean;
      });

      cacheMock.hset = jest.fn().mockResolvedValue(true);

      binanceMock.client.ws.candles = jest
        .fn()
        .mockImplementation((_symbols, _interval, cb) =>
          cb({
            symbol: 'BTCUSDT'
          })
        );

      const { runBinance } = require('../server-binance');
      runBinance(loggerMock);
    });

    it('triggers PubSub.subscribe', () => {
      expect(PubSubMock.subscribe).toHaveBeenCalledWith(
        'trailing-trade-configuration-changed',
        expect.any(Function)
      );
    });

    it('triggers getGlobalConfiguration', () => {
      expect(mockGetGlobalConfiguration).toHaveBeenCalled();
    });

    it('does not trigger websocketCandlesClean', () => {
      expect(mockWebsocketCandlesClean).not.toHaveBeenCalled();
    });

    it('triggers cache.hset', () => {
      expect(cacheMock.hset).toHaveBeenCalledWith(
        'trailing-trade-symbols',
        'BTCUSDT-latest-candle',
        JSON.stringify({ symbol: 'BTCUSDT' })
      );
    });
  });

  describe('when websocket candles clean is not null', () => {
    beforeEach(async () => {
      config.get = jest.fn(key => `value-${key}`);

      mockGetGlobalConfiguration = jest.fn().mockResolvedValue({
        symbols: ['BTCUSDT']
      });

      jest.mock('../cronjob/trailingTradeHelper/configuration', () => ({
        getGlobalConfiguration: mockGetGlobalConfiguration
      }));

      mockWebsocketCandlesClean = jest.fn().mockResolvedValue(true);

      cacheMock.hset = jest.fn().mockResolvedValue(true);

      binanceMock.client.ws.candles = jest
        .fn()
        .mockImplementation((_symbols, _interval, cb) => {
          cb({
            symbol: 'BTCUSDT'
          });

          return mockWebsocketCandlesClean;
        });

      PubSubMock.subscribe = jest.fn().mockImplementation((_key, cb) => {
        cb('message', 'data');
      });

      const { runBinance } = require('../server-binance');

      runBinance(loggerMock);

      runBinance(loggerMock);
    });

    it('triggers PubSub.subscribe', () => {
      expect(PubSubMock.subscribe).toHaveBeenCalledWith(
        'trailing-trade-configuration-changed',
        expect.any(Function)
      );
    });

    it('triggers getGlobalConfiguration', () => {
      expect(mockGetGlobalConfiguration).toHaveBeenCalled();
    });

    it('triggers websocketCandlesClean', () => {
      expect(mockWebsocketCandlesClean).toHaveBeenCalled();
    });

    it('triggers cache.hset', () => {
      expect(cacheMock.hset).toHaveBeenCalledWith(
        'trailing-trade-symbols',
        'BTCUSDT-latest-candle',
        JSON.stringify({ symbol: 'BTCUSDT' })
      );
    });
  });
});
