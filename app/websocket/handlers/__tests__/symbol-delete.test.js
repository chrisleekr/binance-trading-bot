/* eslint-disable global-require */

describe('symbol-delete.test.js', () => {
  let mockWebSocketServer;
  let mockWebSocketServerWebSocketSend;

  let cacheMock;
  let mongoMock;
  let loggerMock;

  beforeEach(() => {
    jest.clearAllMocks().resetModules();

    mockWebSocketServerWebSocketSend = jest.fn().mockResolvedValue(true);

    mockWebSocketServer = {
      send: mockWebSocketServerWebSocketSend
    };
  });

  describe('delete symbol', () => {
    beforeEach(async () => {
      const { cache, logger, mongo } = require('../../../helpers');
      cacheMock = cache;
      mongoMock = mongo;
      loggerMock = logger;

      cacheMock.hdel = jest.fn().mockResolvedValue(true);
      mongoMock.deleteOne = jest.fn().mockResolvedValue(true);
      cacheMock.hgetall = jest.fn().mockImplementation(key => {
        if (key === 'simple-stop-chaser-symbols') {
          return {
            'BTCUSDT-key-1': 'value1',
            'LTCUSDT-key-1': 'value3',
            'BTCUSDT-last-buy-price': 123,
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
    });

    it('triggers mongo.mock', () => {
      expect(mongoMock.deleteOne).toHaveBeenCalledWith(
        loggerMock,
        'simple-stop-chaser-symbols',
        { key: 'BTCUSDT-last-buy-price' }
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
