/* eslint-disable global-require */

describe('symbol-trigger-buy.test.js', () => {
  let mockWebSocketServer;
  let mockWebSocketServerWebSocketSend;

  let loggerMock;
  let queueMock;

  let mockSaveOverrideAction;

  beforeEach(() => {
    jest.clearAllMocks().resetModules();

    mockWebSocketServerWebSocketSend = jest.fn().mockResolvedValue(true);

    mockWebSocketServer = {
      send: mockWebSocketServerWebSocketSend
    };

    mockSaveOverrideAction = jest.fn().mockResolvedValue(true);

    jest.mock('../../../../cronjob/trailingTradeHelper/common', () => ({
      saveOverrideAction: mockSaveOverrideAction
    }));
  });

  describe('when symbol is provided', () => {
    beforeEach(async () => {
      const { logger, queue } = require('../../../../helpers');
      loggerMock = logger;
      queueMock = queue;

      queueMock.executeFor = jest.fn().mockResolvedValue(true);

      const { handleSymbolTriggerBuy } = require('../symbol-trigger-buy');
      await handleSymbolTriggerBuy(loggerMock, mockWebSocketServer, {
        data: {
          symbol: 'BTCUSDT'
        }
      });
    });

    it('triggers saveOverrideAction', () => {
      expect(mockSaveOverrideAction).toHaveBeenCalledWith(
        loggerMock,
        'BTCUSDT',
        {
          action: 'buy',
          actionAt: expect.any(String),
          triggeredBy: 'user',
          notify: true,
          checkTradingView: false
        },
        'The buy order received by the bot. Wait for placing the order.'
      );
    });

    it('triggers queue.executeFor', () => {
      expect(queueMock.executeFor).toHaveBeenCalledWith(loggerMock, 'BTCUSDT');
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
