/* eslint-disable global-require */

describe('symbol-setting-delete.test.js', () => {
  let mockWebSocketServer;
  let mockWebSocketServerWebSocketSend;

  let loggerMock;
  let queueMock;

  let mockDeleteSymbolConfiguration;

  beforeEach(() => {
    jest.clearAllMocks().resetModules();

    mockWebSocketServerWebSocketSend = jest.fn().mockResolvedValue(true);

    mockWebSocketServer = {
      send: mockWebSocketServerWebSocketSend
    };
  });

  describe('when symbol is provided', () => {
    beforeEach(async () => {
      const { logger, queue } = require('../../../../helpers');
      loggerMock = logger;
      queueMock = queue;

      queueMock.executeFor = jest.fn().mockResolvedValue(true);

      mockDeleteSymbolConfiguration = jest.fn().mockResolvedValue(true);

      jest.mock(
        '../../../../cronjob/trailingTradeHelper/configuration',
        () => ({
          deleteSymbolConfiguration: mockDeleteSymbolConfiguration
        })
      );

      const { handleSymbolSettingDelete } = require('../symbol-setting-delete');
      await handleSymbolSettingDelete(logger, mockWebSocketServer, {
        data: {
          symbol: 'BTCUSDT'
        }
      });
    });

    it('triggers deleteSymbolConfiguration', () => {
      expect(mockDeleteSymbolConfiguration).toHaveBeenCalledWith(
        loggerMock,
        'BTCUSDT'
      );
    });

    it('triggers queue.executeFor', () => {
      expect(queueMock.executeFor).toHaveBeenCalledWith(loggerMock, 'BTCUSDT');
    });

    it('triggers ws.send', () => {
      expect(mockWebSocketServerWebSocketSend).toHaveBeenCalledWith(
        JSON.stringify({
          result: true,
          type: 'symbol-setting-delete-result'
        })
      );
    });
  });
});
