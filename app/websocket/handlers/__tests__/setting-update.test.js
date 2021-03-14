/* eslint-disable global-require */
const _ = require('lodash');

describe('setting-update.test.js', () => {
  let mockWebSocketServer;
  let mockWebSocketServerWebSocketSend;

  let cacheMock;
  let mongoMock;
  let mockLogger;

  beforeEach(() => {
    jest.clearAllMocks().resetModules();

    mockWebSocketServerWebSocketSend = jest.fn().mockResolvedValue(true);

    mockWebSocketServer = {
      send: mockWebSocketServerWebSocketSend
    };
  });

  describe('when configuration is invalid json', () => {
    beforeEach(async () => {
      const { mongo, cache, logger } = require('../../../helpers');
      mockLogger = logger;
      cacheMock = cache;
      mongoMock = mongo;

      cacheMock.hdel = jest.fn().mockResolvedValue(true);
      mongoMock.upsertOne = jest.fn().mockResolvedValue(true);
      mongoMock.findOne = jest
        .fn()
        .mockImplementation((_logger, collection, filter) => {
          if (
            collection === 'trailing-trade-common' &&
            _.isEqual(filter, { key: 'configuration' })
          ) {
            return '';
          }
          return '';
        });

      const { handleSettingUpdate } = require('../setting-update');
      handleSettingUpdate(logger, mockWebSocketServer, {
        data: { newField: 'value' }
      });
    });

    it('triggers mongo.findOne', () => {
      expect(mongoMock.findOne).toHaveBeenCalledWith(
        mockLogger,
        'trailing-trade-common',
        { key: 'configuration' }
      );
    });

    it('does not trigger mongo.upsertOne', () => {
      expect(mongoMock.upsertOne).not.toHaveBeenCalled();
    });

    it('does not trigger ws.send', () => {
      expect(mockWebSocketServerWebSocketSend).not.toHaveBeenCalled();
    });

    it('does not trigger cache.hdel', () => {
      expect(cacheMock.hdel).not.toHaveBeenCalled();
    });
  });

  describe('when configuration is valid', () => {
    beforeEach(async () => {
      const { mongo, logger, cache } = require('../../../helpers');
      mockLogger = logger;
      cacheMock = cache;
      mongoMock = mongo;

      cacheMock.hdel = jest.fn().mockResolvedValue(true);

      mongoMock.upsertOne = jest.fn().mockResolvedValue(true);
      mongoMock.findOne = jest
        .fn()
        .mockImplementation((_logger, collection, filter) => {
          if (
            collection === 'trailing-trade-common' &&
            _.isEqual(filter, { key: 'configuration' })
          ) {
            return {
              enabled: true,
              symbols: ['BTCUSDT'],
              supportFIATs: ['USDT'],
              candles: {
                interval: '1d',
                limit: '10'
              },
              buy: {
                enabled: true,
                maxPurchaseAmount: 100
              },
              sell: {
                enabled: true,
                lastbuyPercentage: 1.06,
                stopPercentage: 0.99,
                limitPercentage: 0.98
              }
            };
          }
          return '';
        });

      const { handleSettingUpdate } = require('../setting-update');
      await handleSettingUpdate(logger, mockWebSocketServer, {
        data: {
          enabeld: false,
          symbols: ['BTCUSDT', 'LTCUSDT'],
          supportFIATs: ['USDT', 'BUSD'],
          candles: {
            interval: '1h',
            limit: '100'
          },
          buy: {
            enabled: true,
            maxPurchaseAmount: 150
          },
          sell: {
            enabled: true,
            lastbuyPercentage: 1.07,
            stopPercentage: 0.98,
            limitPercentage: 0.97
          }
        }
      });
    });

    it('triggers mongo.findOne', () => {
      expect(mongoMock.findOne).toHaveBeenCalledWith(
        mockLogger,
        'trailing-trade-common',
        { key: 'configuration' }
      );
    });

    it('triggers mongo.upsertOne', () => {
      expect(mongoMock.upsertOne).toHaveBeenCalledWith(
        mockLogger,
        'trailing-trade-common',
        { key: 'configuration' },
        {
          key: 'configuration',
          enabled: true,
          symbols: ['BTCUSDT', 'LTCUSDT'],
          supportFIATs: ['USDT', 'BUSD'],
          candles: {
            interval: '1h',
            limit: '100'
          },
          buy: {
            enabled: true,
            maxPurchaseAmount: 150
          },
          sell: {
            enabled: true,
            lastbuyPercentage: 1.07,
            stopPercentage: 0.98,
            limitPercentage: 0.97
          }
        }
      );
    });

    it('triggersd cache.hdel', () => {
      expect(cacheMock.hdel).toHaveBeenCalledWith(
        'trailing-trade-common',
        'exchange-symbols'
      );
    });

    it('triggers ws.send', () => {
      expect(mockWebSocketServerWebSocketSend).toHaveBeenCalledWith(
        JSON.stringify({
          result: true,
          type: 'setting-update-result',
          newConfiguration: {
            enabled: true,
            symbols: ['BTCUSDT', 'LTCUSDT'],
            supportFIATs: ['USDT', 'BUSD'],
            candles: { interval: '1h', limit: '100' },
            buy: {
              enabled: true,
              maxPurchaseAmount: 150
            },
            sell: {
              enabled: true,
              lastbuyPercentage: 1.07,
              stopPercentage: 0.98,
              limitPercentage: 0.97
            }
          }
        })
      );
    });
  });
});
