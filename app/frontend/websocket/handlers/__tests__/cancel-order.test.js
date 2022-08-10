/* eslint-disable global-require */
describe('cancel-order.js', () => {
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

    const { handleCancelOrder } = require('../cancel-order');
    await handleCancelOrder(loggerMock, mockWebSocketServer, {
      data: {
        symbol: 'BTCUSDT',
        order: {
          some: 'value',
          side: 'buy'
        }
      }
    });
  });

  it('triggers saveOverrideAction', () => {
    expect(mockSaveOverrideAction).toHaveBeenCalledWith(
      loggerMock,
      'BTCUSDT',
      {
        action: 'cancel-order',
        order: { some: 'value', side: 'buy' },
        actionAt: expect.any(String),
        triggeredBy: 'user'
      },
      'Cancelling the buy order action has been received. Wait for cancelling the order.'
    );
  });

  it('triggers queue.executeFor', () => {
    expect(mockQueue.executeFor).toHaveBeenCalledWith(loggerMock, 'BTCUSDT');
  });

  it('triggers ws.send', () => {
    expect(mockWebSocketServerWebSocketSend).toHaveBeenCalledWith(
      JSON.stringify({
        result: true,
        type: 'cancel-order-result',
        message: 'Cancelling the buy order action has been received.'
      })
    );
  });
});
