/* eslint-disable global-require */
describe('tickers.js', () => {
  let tickers;
  let binanceMock;
  let loggerMock;
  let cacheMock;
  let mockExecute;

  let mockGetAccountInfo;
  let mockGetCachedExchangeSymbols;

  let mockWebsocketTickersClean;
  let mockErrorHandlerWrapper;

  beforeEach(() => {
    jest.clearAllMocks().resetModules();

    mockErrorHandlerWrapper = jest
      .fn()
      .mockImplementation((_logger, _job, callback) =>
        Promise.resolve(callback())
      );

    jest.mock('../../error-handler', () => ({
      errorHandlerWrapper: mockErrorHandlerWrapper
    }));
  });

  describe('setupTickersWebsocket', () => {
    beforeEach(async () => {
      const { binance, logger, cache } = require('../../helpers');
      binanceMock = binance;
      loggerMock = logger;
      cacheMock = cache;

      mockExecute = jest.fn((funcLogger, symbol, jobPayload) => {
        if (!funcLogger || !symbol || !jobPayload) return false;
        return jobPayload.preprocessFn();
      });

      jest.mock('../../cronjob/trailingTradeHelper/queue', () => ({
        execute: mockExecute
      }));

      mockGetAccountInfo = jest.fn().mockResolvedValue({
        balances: [
          { asset: 'BTC', free: '0.00100000', locked: '0.99900000' },
          { asset: 'BNB', free: '0.00100000', locked: '0.99900000' }
        ]
      });
      mockGetCachedExchangeSymbols = jest.fn().mockResolvedValue({
        BNBBUSD: { symbol: 'BNBBUSD', quoteAsset: 'BUSD', minNotional: 10 },
        BTCBUSD: { symbol: 'BTCBUSD', quoteAsset: 'BUSD', minNotional: 10 },
        BNBBTC: { symbol: 'BNBBTC', quoteAsset: 'BTC', minNotional: 0.0001 },
        ETHBTC: { symbol: 'ETHBTC', quoteAsset: 'BTC', minNotional: 0.0001 }
      });

      cacheMock.hset = jest.fn().mockResolvedValue(true);

      mockWebsocketTickersClean = jest.fn();

      binanceMock.client.ws.miniTicker = jest.fn((_symbol, fn) => {
        fn({
          eventType: '24hrMiniTicker',
          eventTime: 1658062447261,
          symbol: 'BTCUSDT',
          curDayClose: '21391.62000000',
          open: '20701.45000000',
          high: '21689.60000000',
          low: '20257.25000000',
          volume: '7606.25866900',
          volumeQuote: '161554176.59059007'
        });

        return mockWebsocketTickersClean;
      });

      jest.mock('../../cronjob/trailingTradeHelper/common', () => ({
        getAccountInfo: mockGetAccountInfo,
        getCachedExchangeSymbols: mockGetCachedExchangeSymbols
      }));

      jest.mock('../../cronjob');

      tickers = require('../tickers');

      await tickers.setupTickersWebsocket(loggerMock, ['BTCUSDT', 'BNBUSDT']);
    });

    it('triggers getAccountInfo', () => {
      expect(mockGetAccountInfo).toHaveBeenCalledWith(loggerMock);
    });

    it('triggers getCachedExchangeSymbols', () => {
      expect(mockGetCachedExchangeSymbols).toHaveBeenCalledWith(loggerMock);
    });

    it('triggers cache.hset', () => {
      expect(cacheMock.hset).toHaveBeenCalledWith(
        'trailing-trade-symbols',
        'BTCUSDT-latest-candle',
        JSON.stringify({
          eventType: '24hrMiniTicker',
          eventTime: 1658062447261,
          symbol: 'BTCUSDT',
          close: '21391.62000000'
        })
      );
    });

    it('triggers queue.execute 2 times', () => {
      expect(mockExecute).toHaveBeenCalledTimes(2);
    });

    it('triggers queue.execute for BTCUSDT', () => {
      expect(mockExecute).toHaveBeenCalledWith(loggerMock, 'BTCUSDT', {
        correlationId: expect.any(String),
        preprocessFn: expect.any(Function),
        processFn: expect.any(Function)
      });
    });

    it('triggers queue.execute for BNBUSDT', () => {
      expect(mockExecute).toHaveBeenCalledWith(loggerMock, 'BNBUSDT', {
        correlationId: expect.any(String),
        preprocessFn: expect.any(Function),
        processFn: expect.any(Function)
      });
    });

    it('checks websocketTickersClean', () => {
      expect(tickers.getWebsocketTickersClean()).toStrictEqual({
        BNBBTC: expect.any(Function),
        BNBUSDT: expect.any(Function),
        BTCUSDT: expect.any(Function)
      });
    });

    it('does not trigger websocketTickersClean', () => {
      expect(mockWebsocketTickersClean).not.toHaveBeenCalled();
    });

    describe('when called again', () => {
      beforeEach(async () => {
        // Reset mock counter
        mockExecute.mockClear();
        await tickers.setupTickersWebsocket(loggerMock, ['BTCUSDT']);
      });

      it('triggers quque.execute', () => {
        expect(mockExecute).toHaveBeenCalledTimes(1);
      });

      it('triggers queue.execute for BTCUSDT', () => {
        expect(mockExecute).toHaveBeenCalledWith(loggerMock, 'BTCUSDT', {
          correlationId: expect.any(String),
          preprocessFn: expect.any(Function),
          processFn: expect.any(Function)
        });
      });

      it('triggers websocketTickersClean', () => {
        expect(mockWebsocketTickersClean).toHaveBeenCalledTimes(2);
      });
    });

    describe('if called refreshTickersClean', () => {
      beforeEach(async () => {
        // Reset mock counter
        mockWebsocketTickersClean.mockClear();

        await tickers.refreshTickersClean(loggerMock);
      });

      it('triggers websocketTickersClean 3 times', () => {
        expect(mockWebsocketTickersClean).toHaveBeenCalledTimes(3);
      });

      it('checks websocketTickersClean', () => {
        expect(tickers.getWebsocketTickersClean()).toStrictEqual({});
      });

      describe('if called refreshTickersClean one more time', () => {
        beforeEach(async () => {
          // Reset mock counter
          mockWebsocketTickersClean.mockClear();

          await tickers.refreshTickersClean(loggerMock);
        });

        it('does not trigger websocketTickersClean  times', () => {
          expect(mockWebsocketTickersClean).not.toHaveBeenCalled();
        });
      });
    });
  });
});
