/* eslint-disable global-require */

describe('symbol-delete.test.js', () => {
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

  describe('delete symbol', () => {
    beforeEach(async () => {
      const { cache, logger } = require('../../../helpers');
      cacheMock = cache;

      cacheMock.hdel = jest.fn().mockResolvedValue(true);
      cacheMock.hgetall = jest.fn().mockImplementation(key => {
        if (key === 'simple-stop-chaser-symbols') {
          return {
            'BTCUSDT-key-1': 'value1',
            'LTCUSDT-key-1': 'value3',
            'BTCUSDT-key-2': 'value2',
            'LTCUSDT-key-2': 'value4'
          };
        }
        return '';
      });

      const { handleSymbolDelete } = require('../symbol-delete');
      handleSymbolDelete(logger, mockWebSocketServer, {
        data: {
          symbolInfo: {
            symbol: 'BTCUSDT'
          }
        }
      });
    });

    it('triggers cache.hdel', () => {
      expect(cacheMock.hdel).toHaveBeenCalledWith(
        'simple-stop-chaser-symbols',
        'BTCUSDT-key-1'
      );
      expect(cacheMock.hdel).toHaveBeenCalledWith(
        'simple-stop-chaser-symbols',
        'BTCUSDT-key-2'
      );
    });

    it('does not trigger cache.hdel with other symbols', () => {
      expect(cacheMock.hdel).not.toHaveBeenCalledWith(
        'simple-stop-chaser-symbols',
        'LTCUSDT-key-1'
      );
      expect(cacheMock.hdel).not.toHaveBeenCalledWith(
        'simple-stop-chaser-symbols',
        'LTCUSDT-key-2'
      );
    });

    it('triggers ws.send', () => {
      expect(mockWebSocketServerWebSocketSend).toHaveBeenCalledWith(
        JSON.stringify({
          result: true,
          type: 'symbol-delete-result'
        })
      );
    });
  });
});
