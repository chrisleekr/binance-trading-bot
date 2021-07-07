/* eslint-disable global-require */

describe('setting-update.test.js', () => {
  let mockWebSocketServer;
  let mockWebSocketServerWebSocketSend;

  let mockGetGlobalConfiguration;
  let mockSaveGlobalConfiguration;
  let mockDeleteAllSymbolConfiguration;

  let cacheMock;
  let mockLogger;

  beforeEach(() => {
    jest.clearAllMocks().resetModules();

    mockDeleteAllSymbolConfiguration = jest.fn().mockResolvedValue(true);

    jest.mock('../../../../cronjob/trailingTradeHelper/configuration', () => ({
      getGlobalConfiguration: mockGetGlobalConfiguration,
      saveGlobalConfiguration: mockSaveGlobalConfiguration,
      deleteAllSymbolConfiguration: mockDeleteAllSymbolConfiguration
    }));

    mockWebSocketServerWebSocketSend = jest.fn().mockResolvedValue(true);

    mockWebSocketServer = {
      send: mockWebSocketServerWebSocketSend
    };
  });

  describe('when configuration returns null for some reason', () => {
    beforeEach(async () => {
      const { cache, logger } = require('../../../../helpers');
      mockLogger = logger;
      cacheMock = cache;

      cacheMock.hdel = jest.fn().mockResolvedValue(true);

      mockGetGlobalConfiguration = jest.fn().mockResolvedValue(null);

      const { handleSettingUpdate } = require('../setting-update');
      handleSettingUpdate(logger, mockWebSocketServer, {
        data: { newField: 'value' }
      });
    });

    it('triggers getGlobalConfiguration', () => {
      expect(mockGetGlobalConfiguration).toHaveBeenCalledWith(mockLogger);
    });

    it('does not trigger ws.send', () => {
      expect(mockWebSocketServerWebSocketSend).not.toHaveBeenCalled();
    });

    it('does not trigger cache.hdel', () => {
      expect(cacheMock.hdel).not.toHaveBeenCalled();
    });

    it('does not trigger deleteAllSymbolConfiguration', () => {
      expect(mockDeleteAllSymbolConfiguration).not.toHaveBeenCalled();
    });
  });

  describe('when configuration is valid', () => {
    describe('when apply to all', () => {
      beforeEach(async () => {
        const { logger, cache } = require('../../../../helpers');
        mockLogger = logger;
        cacheMock = cache;

        cacheMock.hdel = jest.fn().mockResolvedValue(true);

        mockGetGlobalConfiguration = jest.fn().mockResolvedValue({
          enabled: true,
          symbols: ['BTCUSDT'],
          candles: {
            interval: '1d',
            limit: '10'
          },
          buy: {
            enabled: true,
            maxPurchaseAmount: 100,
            lastBuyPriceRemoveThreshold: 10
          },
          sell: {
            enabled: true,
            lastbuyPercentage: 1.06,
            stopPercentage: 0.99,
            limitPercentage: 0.98
          }
        });

        mockSaveGlobalConfiguration = jest.fn().mockResolvedValue(true);

        const { handleSettingUpdate } = require('../setting-update');
        await handleSettingUpdate(logger, mockWebSocketServer, {
          data: {
            action: 'apply-to-all',
            enabled: true,
            symbols: ['BTCUSDT', 'LTCUSDT', 'ETHBTC'],
            supportFIATs: ['USDT', 'BUSD'],
            candles: {
              interval: '1h',
              limit: '100'
            },
            buy: {
              enabled: true,
              maxPurchaseAmount: 150,
              lastBuyPriceRemoveThreshold: 10
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

      it('triggers getGlobalConfiguration', () => {
        expect(mockGetGlobalConfiguration).toHaveBeenCalledWith(mockLogger);
      });

      it('triggers saveGlobalConfiguration', () => {
        expect(mockSaveGlobalConfiguration).toHaveBeenCalledWith(mockLogger, {
          enabled: true,
          symbols: ['BTCUSDT', 'LTCUSDT', 'ETHBTC'],
          candles: {
            interval: '1h',
            limit: '100'
          },
          buy: {
            enabled: true,
            maxPurchaseAmount: -1,
            lastBuyPriceRemoveThreshold: -1
          },
          sell: {
            enabled: true,
            lastbuyPercentage: 1.07,
            stopPercentage: 0.98,
            limitPercentage: 0.97
          }
        });
      });

      it('triggers cache.hdel', () => {
        expect(cacheMock.hdel).toHaveBeenCalledWith(
          'trailing-trade-common',
          'exchange-symbols'
        );
      });

      it('triggers deleteAllSymbolConfiguration', () => {
        expect(mockDeleteAllSymbolConfiguration).toHaveBeenCalledWith(
          mockLogger
        );
      });

      it('triggers ws.send', () => {
        expect(mockWebSocketServerWebSocketSend).toHaveBeenCalledWith(
          JSON.stringify({
            result: true,
            type: 'setting-update-result',
            newConfiguration: {
              enabled: true,
              symbols: ['BTCUSDT', 'LTCUSDT', 'ETHBTC'],
              candles: { interval: '1h', limit: '100' },
              buy: {
                enabled: true,
                maxPurchaseAmount: -1,
                lastBuyPriceRemoveThreshold: -1
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

    describe('when apply to only global', () => {
      beforeEach(async () => {
        const { logger, cache } = require('../../../../helpers');
        mockLogger = logger;
        cacheMock = cache;

        cacheMock.hdel = jest.fn().mockResolvedValue(true);

        mockGetGlobalConfiguration = jest.fn().mockResolvedValue({
          enabled: true,
          symbols: ['BTCUSDT'],
          candles: {
            interval: '1d',
            limit: '10'
          },
          buy: {
            enabled: true,
            maxPurchaseAmount: 100,
            lastBuyPriceRemoveThreshold: 10
          },
          sell: {
            enabled: true,
            lastbuyPercentage: 1.06,
            stopPercentage: 0.99,
            limitPercentage: 0.98
          }
        });

        mockSaveGlobalConfiguration = jest.fn().mockResolvedValue(true);

        const { handleSettingUpdate } = require('../setting-update');
        await handleSettingUpdate(logger, mockWebSocketServer, {
          data: {
            action: 'apply-to-global-only',
            enabled: true,
            symbols: ['BTCUSDT', 'LTCUSDT', 'ETHBTC'],
            supportFIATs: ['USDT', 'BUSD'],
            candles: {
              interval: '1h',
              limit: '100'
            },
            buy: {
              enabled: true,
              maxPurchaseAmount: 150,
              lastBuyPriceRemoveThreshold: 10
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

      it('triggers getGlobalConfiguration', () => {
        expect(mockGetGlobalConfiguration).toHaveBeenCalledWith(mockLogger);
      });

      it('triggers saveGlobalConfiguration', () => {
        expect(mockSaveGlobalConfiguration).toHaveBeenCalledWith(mockLogger, {
          enabled: true,
          symbols: ['BTCUSDT', 'LTCUSDT', 'ETHBTC'],
          candles: {
            interval: '1h',
            limit: '100'
          },
          buy: {
            enabled: true,
            maxPurchaseAmount: -1,
            lastBuyPriceRemoveThreshold: -1
          },
          sell: {
            enabled: true,
            lastbuyPercentage: 1.07,
            stopPercentage: 0.98,
            limitPercentage: 0.97
          }
        });
      });

      it('triggers cache.hdel for exchange-symbols', () => {
        expect(cacheMock.hdel).toHaveBeenCalledWith(
          'trailing-trade-common',
          'exchange-symbols'
        );
      });

      it('triggers cache.hdel for exchange-info', () => {
        expect(cacheMock.hdel).toHaveBeenCalledWith(
          'trailing-trade-common',
          'exchange-info'
        );
      });

      it('does not trigger deleteAllSymbolConfiguration', () => {
        expect(mockDeleteAllSymbolConfiguration).not.toHaveBeenCalledWith(
          mockLogger
        );
      });

      it('triggers ws.send', () => {
        expect(mockWebSocketServerWebSocketSend).toHaveBeenCalledWith(
          JSON.stringify({
            result: true,
            type: 'setting-update-result',
            newConfiguration: {
              enabled: true,
              symbols: ['BTCUSDT', 'LTCUSDT', 'ETHBTC'],
              candles: { interval: '1h', limit: '100' },
              buy: {
                enabled: true,
                maxPurchaseAmount: -1,
                lastBuyPriceRemoveThreshold: -1
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
});
