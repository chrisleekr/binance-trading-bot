/* eslint-disable global-require */
describe('candles.js', () => {
  let candles;
  let binanceMock;
  let loggerMock;
  let mongoMock;

  let mockExecute;

  let mockGetConfiguration;
  let mockSaveCandle;

  let mockWebsocketCandlesClean;

  beforeEach(() => {
    jest.clearAllMocks().resetModules();
  });

  describe('setupCandlesWebsocket', () => {
    beforeEach(async () => {
      const { binance, logger } = require('../../helpers');
      binanceMock = binance;
      loggerMock = logger;

      mockGetConfiguration = jest
        .fn()
        .mockImplementation((_logger, _symbol) => ({
          candles: { interval: '30m' }
        }));

      mockSaveCandle = jest.fn().mockResolvedValue(true);

      mockWebsocketCandlesClean = jest.fn();

      binanceMock.client.ws.candles = jest.fn((symbols, candleInterval, fn) => {
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

        return mockWebsocketCandlesClean;
      });

      mockExecute = jest.fn((funcLogger, symbol, jobPayload) => {
        if (!funcLogger || !symbol || !jobPayload) return false;
        return jobPayload.preprocessFn();
      });

      jest.mock('../../cronjob/trailingTradeHelper/queue', () => ({
        execute: mockExecute
      }));

      jest.mock('../../cronjob/trailingTradeHelper/common', () => ({
        saveCandle: mockSaveCandle
      }));

      jest.mock('../../cronjob/trailingTradeHelper/configuration', () => ({
        getConfiguration: mockGetConfiguration
      }));

      candles = require('../candles');

      await candles.setupCandlesWebsocket(loggerMock, ['ETHBTC', 'BNBUSDT']);
    });

    it('triggers getConfiguration twice', () => {
      expect(mockGetConfiguration).toHaveBeenCalledTimes(2);
    });

    it('triggers getConfiguration for ETHBTC', () => {
      expect(mockGetConfiguration).toHaveBeenCalledWith(loggerMock, 'ETHBTC');
    });

    it('triggers getConfiguration for BNBUSDT', () => {
      expect(mockGetConfiguration).toHaveBeenCalledWith(loggerMock, 'BNBUSDT');
    });

    it('triggers saveCandle', () => {
      expect(mockSaveCandle).toHaveBeenCalledWith(
        loggerMock,
        'trailing-trade-candles',
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

    it('checks websocketCandlesClean', () => {
      expect(candles.getWebsocketCandlesClean()).toStrictEqual({
        '30m': expect.any(Function)
      });
    });

    it('does not trigger websocketCandlesClean', () => {
      expect(mockWebsocketCandlesClean).not.toHaveBeenCalled();
    });

    describe('when called again', () => {
      beforeEach(async () => {
        mockGetConfiguration.mockClear();
        await candles.setupCandlesWebsocket(loggerMock, ['BTCUSDT']);
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

      it('triggers websocketCandlesClean', () => {
        expect(mockWebsocketCandlesClean).toHaveBeenCalledTimes(1);
      });
    });
  });

  describe('syncCandles', () => {
    beforeEach(async () => {
      const { binance, logger, mongo } = require('../../helpers');
      binanceMock = binance;
      loggerMock = logger;
      mongoMock = mongo;

      mockGetConfiguration = jest
        .fn()
        .mockImplementation((_logger, _symbol) => ({
          candles: { interval: '30m', limit: 1 }
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

      candles = require('../candles');

      await candles.syncCandles(loggerMock, ['ETHBTC']);
    });

    it('triggers mongo.deleteAll', () => {
      expect(mongoMock.deleteAll).toHaveBeenCalledWith(
        loggerMock,
        'trailing-trade-candles',
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
        interval: '30m',
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
        'trailing-trade-candles',
        [
          {
            updateOne: {
              filter: { interval: '30m', key: 'ETHBTC', time: 1508328900000 },
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

    it('triggers queue.execute for ETHBTC', () => {
      expect(mockExecute).toHaveBeenCalledWith(loggerMock, 'ETHBTC', {
        correlationId: expect.any(String),
        preprocessFn: expect.any(Function),
        processFn: expect.any(Function)
      });
    });
  });
});
