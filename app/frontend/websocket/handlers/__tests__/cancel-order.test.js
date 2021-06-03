/* eslint-disable global-require */
describe('cancel-order.js', () => {
  let mockWebSocketServer;
  let mockWebSocketServerWebSocketSend;

  let loggerMock;
  let cacheMock;
  let PubSubMock;

  beforeEach(() => {
    jest.clearAllMocks().resetModules();

    mockWebSocketServerWebSocketSend = jest.fn().mockResolvedValue(true);

    mockWebSocketServer = {
      send: mockWebSocketServerWebSocketSend
    };
  });

  beforeEach(async () => {
    const { cache, logger, PubSub } = require('../../../../helpers');

    cacheMock = cache;
    loggerMock = logger;
    PubSubMock = PubSub;

    cacheMock.hset = jest.fn().mockResolvedValue(true);
    PubSubMock.publish = jest.fn().mockResolvedValue(true);

    const { handleCancelOrder } = require('../cancel-order');
    await handleCancelOrder(loggerMock, mockWebSocketServer, {
      data: {
        symbol: 'BTCUSDT',
        order: {
          some: 'value'
        }
      }
    });
  });

  it('triggers cache.hset', () => {
    expect(cacheMock.hset).toHaveBeenCalledWith(
      'trailing-trade-override',
      'BTCUSDT',
      JSON.stringify({
        action: 'cancel-order',
        order: { some: 'value' }
      })
    );
  });

  it('triggers PubSub.publish', () => {
    expect(PubSubMock.publish).toHaveBeenCalledWith('frontend-notification', {
      type: 'info',
      title:
        'Cancelling the order action has been received. Wait for cancelling the order.'
    });
  });

  it('triggers ws.send', () => {
    expect(mockWebSocketServerWebSocketSend).toHaveBeenCalledWith(
      JSON.stringify({
        result: true,
        type: 'cancel-order-result',
        message: 'Cancelling the order action has been received.'
      })
    );
  });
});
