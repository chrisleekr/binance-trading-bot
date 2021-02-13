/* eslint-disable global-require */

describe('symbol-update.test.js', () => {
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

  describe('update symbol', () => {
    beforeEach(async () => {
      const { cache, logger } = require('../../../helpers');
      cacheMock = cache;

      cacheMock.hset = jest.fn().mockResolvedValue(true);

      const { handleSymbolUpdate } = require('../symbol-update');
      handleSymbolUpdate(logger, mockWebSocketServer, {
        data: {
          symbol: 'BTCUSDT',
          sell: {
            lastBuyPrice: 12000
          }
        }
      });
    });

    it('triggers cache.hset', () => {
      expect(cacheMock.hset).toHaveBeenCalledWith(
        'simple-stop-chaser-symbols',
        'BTCUSDT-last-buy-price',
        12000
      );
    });

    it('triggers ws.send', () => {
      expect(mockWebSocketServerWebSocketSend).toHaveBeenCalledWith(
        JSON.stringify({
          result: true,
          type: 'symbol-update-result'
        })
      );
    });
  });
});
