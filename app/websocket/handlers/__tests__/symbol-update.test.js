/* eslint-disable global-require */

describe('symbol-update.test.js', () => {
  let mockWebSocketServer;
  let mockWebSocketServerWebSocketSend;

  let loggerMock;
  let mongoMock;

  beforeEach(() => {
    jest.clearAllMocks().resetModules();

    mockWebSocketServerWebSocketSend = jest.fn().mockResolvedValue(true);

    mockWebSocketServer = {
      send: mockWebSocketServerWebSocketSend
    };
  });

  describe('update symbol', () => {
    beforeEach(async () => {
      const { mongo, logger } = require('../../../helpers');
      mongoMock = mongo;
      loggerMock = logger;

      mongoMock.upsertOne = jest.fn().mockResolvedValue(true);

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

    it('triggers mongo.upsertOne', () => {
      expect(mongoMock.upsertOne).toHaveBeenCalledWith(
        loggerMock,
        'simple-stop-chaser-symbols',
        { key: 'BTCUSDT-last-buy-price' },
        { key: 'BTCUSDT-last-buy-price', lastBuyPrice: 12000 }
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
