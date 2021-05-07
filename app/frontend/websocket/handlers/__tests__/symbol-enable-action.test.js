/* eslint-disable global-require */

describe('symbol-enable-action.test.js', () => {
  let mockWebSocketServer;
  let mockWebSocketServerWebSocketSend;

  let mockLogger;

  let mockDeleteDisableActionByStopLoss;

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

      mockDeleteDisableActionByStopLoss = jest.fn().mockResolvedValue(true);

      jest.mock('../../../../cronjob/trailingTradeHelper/common', () => ({
        deleteDisableActionByStopLoss: mockDeleteDisableActionByStopLoss
      }));

      const { handleSymbolEnableAction } = require('../symbol-enable-action');
      await handleSymbolEnableAction(logger, mockWebSocketServer, {
        data: {
          symbol: 'BTCUSDT'
        }
      });
    });

    it('triggers deleteDisableActionByStopLoss', () => {
      expect(mockDeleteDisableActionByStopLoss).toHaveBeenCalledWith(
        mockLogger,
        'BTCUSDT'
      );
    });

    it('triggers ws.send', () => {
      expect(mockWebSocketServerWebSocketSend).toHaveBeenCalledWith(
        JSON.stringify({
          result: true,
          type: 'symbol-enable-action-result'
        })
      );
    });
  });
});
