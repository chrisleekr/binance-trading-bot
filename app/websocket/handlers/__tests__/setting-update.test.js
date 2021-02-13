/* eslint-disable global-require */

describe('setting-update.test.js', () => {
  let mockWebSocketServer;
  let mockWebSocketServerWebSocketSend;

  let cacheMock;

  beforeEach(() => {
    jest.clearAllMocks().resetModules();

    mockWebSocketServerWebSocketSend = jest.fn().mockResolvedValue(true);

    mockWebSocketServer = {
      send: mockWebSocketServerWebSocketSend
    };
  });

  describe('when configuration is invalid json', () => {
    beforeEach(async () => {
      const { cache, logger } = require('../../../helpers');
      cacheMock = cache;

      cacheMock.hset = jest.fn().mockResolvedValue(true);
      cacheMock.hget = jest.fn().mockImplementation((key, field) => {
        if (key === 'simple-stop-chaser-common' && field === 'configuration') {
          return '';
        }
        return '';
      });

      const { handleSettingUpdate } = require('../setting-update');
      handleSettingUpdate(logger, mockWebSocketServer, {
        data: { newField: 'value' }
      });
    });

    it('triggers cache.hget', () => {
      expect(cacheMock.hget).toHaveBeenCalledWith(
        'simple-stop-chaser-common',
        'configuration'
      );
    });

    it('does not trigger cache.hset', () => {
      expect(cacheMock.hset).not.toHaveBeenCalled();
    });

    it('does not trigger ws.send', () => {
      expect(mockWebSocketServerWebSocketSend).not.toHaveBeenCalled();
    });
  });

  describe('when configuration is valid', () => {
    beforeEach(async () => {
      const { cache, logger } = require('../../../helpers');
      cacheMock = cache;

      cacheMock.hset = jest.fn().mockResolvedValue(true);
      cacheMock.hget = jest.fn().mockImplementation((key, field) => {
        if (key === 'simple-stop-chaser-common' && field === 'configuration') {
          return JSON.stringify({
            enabled: true,
            symbols: ['BTCUSDT'],
            candles: {
              interval: '1d',
              limit: '10'
            },
            maxPurchaseAmount: 100,
            stopLossLimit: {
              lastbuyPercentage: 1.06,
              stopPercentage: 0.99,
              limitPercentage: 0.98
            }
          });
        }
        return '';
      });

      const { handleSettingUpdate } = require('../setting-update');
      await handleSettingUpdate(logger, mockWebSocketServer, {
        data: {
          enabeld: false,
          symbols: ['BTCUSDT', 'LTCUSDT'],
          candles: {
            interval: '1h',
            limit: '100'
          },
          maxPurchaseAmount: 150,
          stopLossLimit: {
            lastbuyPercentage: 1.07,
            stopPercentage: 0.98,
            limitPercentage: 0.97
          }
        }
      });
    });

    it('triggers cache.hget', () => {
      expect(cacheMock.hget).toHaveBeenCalledWith(
        'simple-stop-chaser-common',
        'configuration'
      );
    });

    it('triggers cache.hset', () => {
      expect(cacheMock.hset).toHaveBeenCalledWith(
        'simple-stop-chaser-common',
        'configuration',
        JSON.stringify({
          enabled: true,
          symbols: ['BTCUSDT', 'LTCUSDT'],
          candles: {
            interval: '1h',
            limit: '100'
          },
          maxPurchaseAmount: 150,
          stopLossLimit: {
            lastbuyPercentage: 1.07,
            stopPercentage: 0.98,
            limitPercentage: 0.97
          }
        })
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
            candles: { interval: '1h', limit: '100' },
            maxPurchaseAmount: 150,
            stopLossLimit: {
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
