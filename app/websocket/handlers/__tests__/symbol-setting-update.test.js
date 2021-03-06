/* eslint-disable global-require */

describe('symbol-setting-update.test.js', () => {
  let mockWebSocketServer;
  let mockWebSocketServerWebSocketSend;

  let mockLogger;

  let mockGetSymbolConfiguration;
  let mockSaveSymbolConfiguration;

  beforeEach(() => {
    jest.clearAllMocks().resetModules();

    mockWebSocketServerWebSocketSend = jest.fn().mockResolvedValue(true);

    mockWebSocketServer = {
      send: mockWebSocketServerWebSocketSend
    };
  });

  describe('when configuration is valid', () => {
    beforeEach(async () => {
      const { logger } = require('../../../helpers');
      mockLogger = logger;

      mockGetSymbolConfiguration = jest.fn().mockResolvedValue({
        candles: {
          interval: '1d',
          limit: '10'
        },
        maxPurchaseAmount: 100,
        stopLossLimit: {
          lastbuyPercentage: 1.06,
          stopPercentage: 0.99,
          limitPercentage: 0.98
        },
        buy: {
          enabled: true
        },
        sell: {
          enabled: true
        }
      });

      mockSaveSymbolConfiguration = jest.fn().mockResolvedValue(true);

      jest.mock('../../../jobs/simpleStopChaser/helper', () => ({
        getSymbolConfiguration: mockGetSymbolConfiguration,
        saveSymbolConfiguration: mockSaveSymbolConfiguration
      }));

      const { handleSymbolSettingUpdate } = require('../symbol-setting-update');
      await handleSymbolSettingUpdate(logger, mockWebSocketServer, {
        data: {
          symbol: 'BTCUSDT',
          configuration: {
            candles: {
              interval: '15m',
              limit: '200'
            },
            maxPurchaseAmount: 200,
            stopLossLimit: {
              lastbuyPercentage: 1.08,
              stopPercentage: 0.97,
              limitPercentage: 0.96
            },
            buy: {
              enabled: false
            },
            sell: {
              enabled: false
            },
            some: 'other value'
          }
        }
      });
    });

    it('triggers getSymbolConfiguration', () => {
      expect(mockGetSymbolConfiguration).toHaveBeenCalledWith(
        mockLogger,
        'BTCUSDT'
      );
    });

    it('triggers saveSymbolConfiguration', () => {
      expect(mockSaveSymbolConfiguration).toHaveBeenCalledWith(
        mockLogger,
        'BTCUSDT',
        {
          candles: {
            interval: '15m',
            limit: '200'
          },
          maxPurchaseAmount: 200,
          stopLossLimit: {
            lastbuyPercentage: 1.08,
            stopPercentage: 0.97,
            limitPercentage: 0.96
          },
          buy: {
            enabled: false
          },
          sell: {
            enabled: false
          }
        }
      );
    });

    it('triggers ws.send', () => {
      expect(mockWebSocketServerWebSocketSend).toHaveBeenCalledWith(
        JSON.stringify({
          result: true,
          type: 'symbol-setting-update-result'
        })
      );
    });
  });
});
