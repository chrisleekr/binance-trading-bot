/* eslint-disable global-require */

describe('symbol-grid-trade-delete.test.js', () => {
  let mockWebSocketServer;
  let mockWebSocketServerWebSocketSend;

  let mockLogger;

  let mockDeleteSymbolGridTrade;

  beforeEach(() => {
    jest.clearAllMocks().resetModules();

    mockWebSocketServerWebSocketSend = jest.fn().mockResolvedValue(true);

    mockWebSocketServer = {
      send: mockWebSocketServerWebSocketSend
    };
  });

  describe('when symbol is provided', () => {
    beforeEach(async () => {
      const { logger } = require('../../../../helpers');
      mockLogger = logger;

      mockDeleteSymbolGridTrade = jest.fn().mockResolvedValue(true);

      jest.mock(
        '../../../../cronjob/trailingTradeHelper/configuration',
        () => ({
          deleteSymbolGridTrade: mockDeleteSymbolGridTrade
        })
      );

      const {
        handleSymbolGridTradeDelete
      } = require('../symbol-grid-trade-delete');
      await handleSymbolGridTradeDelete(logger, mockWebSocketServer, {
        data: {
          symbol: 'BTCUSDT'
        }
      });
    });

    it('triggers deleteSymbolGridTrade', () => {
      expect(mockDeleteSymbolGridTrade).toHaveBeenCalledWith(
        mockLogger,
        'BTCUSDT'
      );
    });

    it('triggers ws.send', () => {
      expect(mockWebSocketServerWebSocketSend).toHaveBeenCalledWith(
        JSON.stringify({
          result: true,
          type: 'symbol-grid-trade-delete-result'
        })
      );
    });
  });
});
