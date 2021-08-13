/* eslint-disable global-require */

describe('symbol-trigger-buy.test.js', () => {
  let mockWebSocketServer;
  let mockWebSocketServerWebSocketSend;

  let mockCache;
  let mockLogger;

  beforeEach(() => {
    jest.clearAllMocks().resetModules();

    mockWebSocketServerWebSocketSend = jest.fn().mockResolvedValue(true);

    mockWebSocketServer = {
      send: mockWebSocketServerWebSocketSend
    };
  });

  describe('when symbol is provided', () => {
    beforeEach(async () => {
      const { cache, logger } = require('../../../../helpers');
      mockCache = cache;
      mockLogger = logger;

      mockCache.hset = jest.fn().mockResolvedValue(true);

      const { handleSymbolTriggerBuy } = require('../symbol-trigger-buy');
      await handleSymbolTriggerBuy(mockLogger, mockWebSocketServer, {
        data: {
          symbol: 'BTCUSDT'
        }
      });
    });

    it('triggers cache.hset', () => {
      expect(mockCache.hset.mock.calls[0][0]).toStrictEqual(
        'trailing-trade-override'
      );

      expect(mockCache.hset.mock.calls[0][1]).toStrictEqual('BTCUSDT');

      const args = JSON.parse(mockCache.hset.mock.calls[0][2]);
      expect(args).toStrictEqual({
        action: 'buy',
        actionAt: expect.any(String)
      });
    });

    it('triggers ws.send', () => {
      expect(mockWebSocketServerWebSocketSend).toHaveBeenCalledWith(
        JSON.stringify({
          result: true,
          type: 'symbol-trigger-buy-result'
        })
      );
    });
  });
});
