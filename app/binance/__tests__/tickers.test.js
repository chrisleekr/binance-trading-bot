/* eslint-disable global-require */

describe('tickers.js', () => {
  let binanceMock;
  let loggerMock;
  let cacheMock;

  let mockGetAccountInfo;
  let mockExecuteTrailingTrade;

  let websocketTickersClean;

  describe('setupTickersWebsocket', () => {
    beforeEach(async () => {
      jest.clearAllMocks().resetModules();

      const { binance, logger, cache } = require('../../helpers');
      binanceMock = binance;
      loggerMock = logger;
      cacheMock = cache;
    });

    describe('when tickers clean is null', () => {
      beforeEach(async () => {
        // mockUserClean = jest.fn().mockResolvedValue(true);
        cacheMock.hget = jest.fn().mockResolvedValue(JSON.stringify([]));
        cacheMock.hset = jest.fn().mockResolvedValue(true);
        mockExecuteTrailingTrade = jest.fn().mockResolvedValue(true);

        websocketTickersClean = jest.fn().mockResolvedValue({});

        mockGetAccountInfo = jest.fn().mockResolvedValue({
          balances: [
            { asset: 'BTC', free: '0.00100000', locked: '0.99900000' },
            { asset: 'BNB', free: '0.00100000', locked: '0.99900000' }
          ]
        });

        jest.mock('../../cronjob/trailingTradeHelper/common', () => ({
          getAccountInfo: mockGetAccountInfo
        }));

        jest.mock('../../cronjob', () => ({
          executeTrailingTrade: mockExecuteTrailingTrade
        }));

        binanceMock.client.ws.miniTicker = jest
          .fn()
          .mockImplementation((symbol, cb) => {
            cb({
              eventType: 'kline',
              eventTime: 1657974109931,
              curDayClose: '20629.04000000',
              symbol
            });

            return websocketTickersClean[symbol];
          });

        const { setupTickersWebsocket } = require('../tickers');

        await setupTickersWebsocket(loggerMock, ['BTCUSDT', 'BNBUSDT']);
      });

      it('triggers getAccountInfo', () => {
        expect(mockGetAccountInfo).toHaveBeenCalled();
      });

      it('triggers cache.hset', () => {
        expect(cacheMock.hset).toHaveBeenCalledWith(
          'trailing-trade-symbols',
          'BTCUSDT-latest-candle',
          JSON.stringify({
            eventType: 'kline',
            eventTime: 1657974109931,
            symbol: 'BTCUSDT',
            close: '20629.04000000'
          })
        );
      });

      it('does not trigger websocketTickersClean', () => {
        expect(websocketTickersClean).not.toHaveBeenCalled();
      });
    });

    describe('when tickers clean is not null', () => {
      beforeEach(async () => {
        cacheMock.hget = jest.fn().mockResolvedValue(JSON.stringify([]));
        cacheMock.hset = jest.fn().mockResolvedValue(true);
        mockExecuteTrailingTrade = jest.fn().mockResolvedValue(true);

        mockGetAccountInfo = jest.fn().mockResolvedValue({
          balances: [
            { asset: 'BTC', free: '0.00100000', locked: '0.99900000' },
            { asset: 'BNB', free: '0.00100000', locked: '0.99900000' }
          ]
        });

        // it should be dynamic?
        // websocketTickersClean = jest.fn().mockResolvedValue({});

        jest.mock('../../cronjob/trailingTradeHelper/common', () => ({
          getAccountInfo: mockGetAccountInfo
        }));

        jest.mock('../../cronjob', () => ({
          executeTrailingTrade: mockExecuteTrailingTrade
        }));

        binanceMock.client.ws.miniTicker = jest
          .fn()
          .mockImplementation((symbol, cb) => {
            cb({
              eventType: 'kline',
              eventTime: 1657974109931,
              curDayClose: '20629.04000000',
              symbol
            });

            return websocketTickersClean[symbol];
          });

        const { setupTickersWebsocket } = require('../tickers');

        await setupTickersWebsocket(loggerMock, ['BTCUSDT', 'BNBUSDT']);
        await setupTickersWebsocket(loggerMock, ['BTCUSDT', 'BNBUSDT']);
      });

      it('triggers getAccountInfo', () => {
        expect(mockGetAccountInfo).toHaveBeenCalled();
      });

      it('triggers cache.hset', () => {
        expect(cacheMock.hset).toHaveBeenCalledWith(
          'trailing-trade-symbols',
          'BTCUSDT-latest-candle',
          JSON.stringify({
            eventType: 'kline',
            eventTime: 1657974109931,
            symbol: 'BTCUSDT',
            close: '20629.04000000'
          })
        );
      });

      // check if websockets is cleaned
    });
  });
});
