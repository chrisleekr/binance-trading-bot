/* eslint-disable global-require */

describe('symbol-trigger-buy.test.js', () => {
  let mockWebSocketServer;
  let mockWebSocketServerWebSocketSend;

  let mockLogger;

  let mockQueue;

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

    mockQueue = {
      executeFor: jest.fn().mockResolvedValue(true)
    };

    jest.mock('../../../../cronjob/trailingTradeHelper/queue', () => mockQueue);
  });

  describe('when symbol is provided', () => {
    beforeEach(async () => {
      const { logger } = require('../../../../helpers');
      mockLogger = logger;

      const { handleSymbolTriggerBuy } = require('../symbol-trigger-buy');
      await handleSymbolTriggerBuy(mockLogger, mockWebSocketServer, {
        data: {
          symbol: 'BTCUSDT'
        }
      });
    });

    it('triggers saveOverrideAction', () => {
      expect(mockSaveOverrideAction).toHaveBeenCalledWith(
        mockLogger,
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
      expect(mockQueue.executeFor).toHaveBeenCalledWith(mockLogger, 'BTCUSDT');
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
