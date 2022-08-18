/* eslint-disable global-require */
describe('ath-candles.js', () => {
  let athCandles;
  let binanceMock;
  let loggerMock;
  let mongoMock;

  let mockGetConfiguration;
  let mockSaveCandle;

  let mockWebsocketATHCandlesClean;

  beforeEach(() => {
    jest.clearAllMocks().resetModules();
  });

  describe('when ATH enabled', () => {
    describe('setupATHCandlesWebsocket', () => {
      beforeEach(async () => {
        const { binance, logger } = require('../../helpers');
        binanceMock = binance;
        loggerMock = logger;

        mockGetConfiguration = jest
          .fn()
          .mockImplementation((_logger, _symbol) => ({
            buy: {
              athRestriction: {
                enabled: true,
                candles: { interval: '1d' }
              }
            }
          }));

        mockSaveCandle = jest.fn().mockResolvedValue(true);

        mockWebsocketATHCandlesClean = jest.fn();

        binanceMock.client.ws.candles = jest.fn(
          (symbols, candleInterval, fn) => {
            fn({
              eventType: 'kline',
              eventTime: 1525285576276,
              symbol: 'ETHBTC',
              startTime: 1525285560000,
              open: '0.04898000',
              high: '0.04902700',
              low: '0.04898000',
              close: '0.04901900',
              closeTime: 1525285619999,
              volume: '37.89600000',
              trades: 30,
              interval: '30m',
              isFinal: false,
              quoteVolume: '1.85728874',
              buyVolume: '21.79900000',
              quoteBuyVolume: '1.06838790'
            });

            return mockWebsocketATHCandlesClean;
          }
        );

        jest.mock('../../cronjob/trailingTradeHelper/common', () => ({
          saveCandle: mockSaveCandle
        }));

        jest.mock('../../cronjob/trailingTradeHelper/configuration', () => ({
          getConfiguration: mockGetConfiguration
        }));

        athCandles = require('../ath-candles');

        await athCandles.setupATHCandlesWebsocket(loggerMock, [
          'ETHBTC',
          'BNBUSDT'
        ]);
      });

      it('triggers getConfiguration twice', () => {
        expect(mockGetConfiguration).toHaveBeenCalledTimes(2);
      });

      it('triggers getConfiguration for ETHBTC', () => {
        expect(mockGetConfiguration).toHaveBeenCalledWith(loggerMock, 'ETHBTC');
      });

      it('triggers getConfiguration for BNBUSDT', () => {
        expect(mockGetConfiguration).toHaveBeenCalledWith(
          loggerMock,
          'BNBUSDT'
        );
      });

      it('triggers saveCandle', () => {
        expect(mockSaveCandle).toHaveBeenCalledWith(
          loggerMock,
          'trailing-trade-ath-candles',
          {
            close: 0.049019,
            high: 0.049027,
            interval: '30m',
            key: 'ETHBTC',
            low: 0.04898,
            open: 0.04898,
            time: 1525285560000,
            volume: 37.896
          }
        );
      });

      it('checks websocketATHCandlesClean', () => {
        expect(athCandles.getWebsocketATHCandlesClean()).toStrictEqual({
          '1d': expect.any(Function)
        });
      });

      it('does not trigger websocketATHCandlesClean', () => {
        expect(mockWebsocketATHCandlesClean).not.toHaveBeenCalled();
      });

      describe('when called again', () => {
        beforeEach(async () => {
          mockGetConfiguration.mockClear();
          await athCandles.setupATHCandlesWebsocket(loggerMock, ['BTCUSDT']);
        });

        it('triggers getConfiguration twice', () => {
          expect(mockGetConfiguration).toHaveBeenCalledTimes(1);
        });

        it('triggers getConfiguration for BTCUSDT', () => {
          expect(mockGetConfiguration).toHaveBeenCalledWith(
            loggerMock,
            'BTCUSDT'
          );
        });

        it('triggers websocketATHCandlesClean', () => {
          expect(mockWebsocketATHCandlesClean).toHaveBeenCalledTimes(1);
        });
      });
    });
    describe('syncATHCandles', () => {
      beforeEach(async () => {
        const { binance, logger, mongo } = require('../../helpers');
        binanceMock = binance;
        loggerMock = logger;
        mongoMock = mongo;

        mockGetConfiguration = jest
          .fn()
          .mockImplementation((_logger, _symbol) => ({
            buy: {
              athRestriction: {
                enabled: true,
                candles: { interval: '1d', limit: 1 }
              }
            }
          }));

        mongoMock.bulkWrite = jest.fn().mockResolvedValue(true);

        mongoMock.deleteAll = jest.fn().mockResolvedValue(true);

        binanceMock.client.candles = jest.fn().mockImplementation(options => {
          const { symbol } = options;

          if (symbol === 'ETHBTC') {
            return [
              {
                openTime: 1508328900000,
                open: '0.05655000',
                high: '0.05656500',
                low: '0.05613200',
                close: '0.05632400',
                volume: '68.88800000',
                closeTime: 1508329199999,
                quoteAssetVolume: '2.29500857',
                trades: 85,
                baseAssetVolume: '40.61900000'
              }
            ];
          }

          return [];
        });

        jest.mock('../../cronjob/trailingTradeHelper/configuration', () => ({
          getConfiguration: mockGetConfiguration
        }));

        athCandles = require('../ath-candles');

        await athCandles.syncATHCandles(loggerMock, ['ETHBTC']);
      });

      it('triggers mongo.deleteAll', () => {
        expect(mongoMock.deleteAll).toHaveBeenCalledWith(
          loggerMock,
          'trailing-trade-ath-candles',
          {
            key: 'ETHBTC'
          }
        );
      });

      it('triggers getConfiguration for ETHBTC', () => {
        expect(mockGetConfiguration).toHaveBeenCalledWith(loggerMock, 'ETHBTC');
      });

      it('triggers binance.client.candles', () => {
        expect(binanceMock.client.candles).toHaveBeenCalledWith({
          interval: '1d',
          limit: 1,
          symbol: 'ETHBTC'
        });
      });

      it('triggers mongo.bulkWrite one time', () => {
        expect(mongoMock.bulkWrite).toHaveBeenCalledTimes(1);
      });

      it('triggers mongo.bulkWrite with expected parameters', () => {
        expect(mongoMock.bulkWrite).toHaveBeenCalledWith(
          loggerMock,
          'trailing-trade-ath-candles',
          [
            {
              updateOne: {
                filter: { interval: '1d', key: 'ETHBTC', time: 1508328900000 },
                update: {
                  $set: {
                    close: 0.056324,
                    high: 0.056565,
                    low: 0.056132,
                    open: 0.05655,
                    volume: 68.888
                  }
                },
                upsert: true
              }
            }
          ]
        );
      });
    });
  });

  describe('when ATH disabled', () => {
    describe('setupATHCandlesWebsocket', () => {
      beforeEach(async () => {
        const { binance, logger } = require('../../helpers');
        binanceMock = binance;
        loggerMock = logger;

        mockGetConfiguration = jest
          .fn()
          .mockImplementation((_logger, _symbol) => ({
            buy: {
              athRestriction: {
                enabled: false,
                candles: { interval: '1d' }
              }
            }
          }));

        mockSaveCandle = jest.fn().mockResolvedValue(true);

        mockWebsocketATHCandlesClean = jest.fn();

        binanceMock.client.ws.candles = jest.fn().mockResolvedValue(true);

        jest.mock('../../cronjob/trailingTradeHelper/common', () => ({
          saveCandle: mockSaveCandle
        }));

        jest.mock('../../cronjob/trailingTradeHelper/configuration', () => ({
          getConfiguration: mockGetConfiguration
        }));

        athCandles = require('../ath-candles');

        await athCandles.setupATHCandlesWebsocket(loggerMock, ['ETHBTC']);
      });

      it('triggers getConfiguration', () => {
        expect(mockGetConfiguration).toHaveBeenCalledWith(loggerMock, 'ETHBTC');
      });

      it('does not trigger saveCandle', () => {
        expect(mockSaveCandle).not.toHaveBeenCalled();
      });

      it('does not trigger binance.client.ws.candles', () => {
        expect(binanceMock.client.ws.candles).not.toHaveBeenCalled();
      });

      it('checks websocketATHCandlesClean', () => {
        expect(athCandles.getWebsocketATHCandlesClean()).toStrictEqual({});
      });

      it('does not trigger websocketATHCandlesClean', () => {
        expect(mockWebsocketATHCandlesClean).not.toHaveBeenCalled();
      });
    });

    describe('syncATHCandles', () => {
      beforeEach(async () => {
        const { binance, logger, mongo } = require('../../helpers');
        binanceMock = binance;
        loggerMock = logger;
        mongoMock = mongo;

        mockGetConfiguration = jest
          .fn()
          .mockImplementation((_logger, _symbol) => ({
            buy: {
              athRestriction: {
                enabled: false,
                candles: { interval: '1d', limit: 1 }
              }
            }
          }));

        mockSaveCandle = jest.fn().mockResolvedValue(true);

        mongoMock.deleteAll = jest.fn().mockResolvedValue(true);

        binanceMock.client.candles = jest.fn().mockResolvedValue(true);

        jest.mock('../../cronjob/trailingTradeHelper/common', () => ({
          saveCandle: mockSaveCandle
        }));

        jest.mock('../../cronjob/trailingTradeHelper/configuration', () => ({
          getConfiguration: mockGetConfiguration
        }));

        athCandles = require('../ath-candles');

        await athCandles.syncATHCandles(loggerMock, ['ETHBTC']);
      });

      it('triggers mongo.deleteAll', () => {
        expect(mongoMock.deleteAll).toHaveBeenCalledWith(
          loggerMock,
          'trailing-trade-ath-candles',
          {
            key: 'ETHBTC'
          }
        );
      });

      it('triggers getConfiguration', () => {
        expect(mockGetConfiguration).toHaveBeenCalledWith(loggerMock, 'ETHBTC');
      });

      it('does not trigger binance.client.candles', () => {
        expect(binanceMock.client.candles).not.toHaveBeenCalled();
      });

      it('does not trigger saveCandle', () => {
        expect(mockSaveCandle).not.toHaveBeenCalled();
      });
    });
  });
});
