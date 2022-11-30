/* eslint-disable global-require */
describe('manual-trade.js', () => {
  let mockWebSocketServer;
  let mockWebSocketServerWebSocketSend;

  let loggerMock;
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

  beforeEach(async () => {
    const { logger } = require('../../../../helpers');

    loggerMock = logger;

    const { handleManualTrade } = require('../manual-trade');
    await handleManualTrade(loggerMock, mockWebSocketServer, {
      data: {
        symbol: 'BTCUSDT',
        order: {
          some: 'value'
        }
      }
    });
  });

  it('triggers saveOverrideAction', () => {
    expect(mockSaveOverrideAction).toHaveBeenCalledWith(
      loggerMock,
      'BTCUSDT',
      {
        action: 'manual-trade',
        order: {
          some: 'value'
        },
        actionAt: expect.any(String),
        triggeredBy: 'user'
      },
      'The manual order received by the bot. Wait for placing the order.'
    );
  });

  it('triggers queue.executeFor', () => {
    expect(mockQueue.executeFor).toHaveBeenCalledWith(loggerMock, 'BTCUSDT');
  });

  it('triggers ws.send', () => {
    expect(mockWebSocketServerWebSocketSend).toHaveBeenCalledWith(
      JSON.stringify({
        result: true,
        type: 'manual-trade-result',
        message: 'The order has been received.'
      })
    );
  });
});
