/* eslint-disable global-require */
describe('dust-transfer-execute.js', () => {
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

    const { handleDustTransferExecute } = require('../dust-transfer-execute');
    await handleDustTransferExecute(loggerMock, mockWebSocketServer, {
      data: {
        dustTransfer: ['TRX', 'ETH']
      }
    });
  });

  it('triggers cache.hset', () => {
    expect(cacheMock.hset.mock.calls[0][0]).toStrictEqual(
      'trailing-trade-indicator-override'
    );
    expect(cacheMock.hset.mock.calls[0][1]).toStrictEqual('global');
    const args = JSON.parse(cacheMock.hset.mock.calls[0][2]);
    expect(args).toStrictEqual({
      action: 'dust-transfer',
      params: ['TRX', 'ETH'],
      actionAt: expect.any(String)
    });
  });

  it('triggers PubSub.publish', () => {
    expect(PubSubMock.publish).toHaveBeenCalledWith('frontend-notification', {
      title:
        'The dust transfer request received by the bot. Wait for executing the dust transfer.',
      type: 'info'
    });
  });

  it('triggers ws.send', () => {
    expect(mockWebSocketServerWebSocketSend).toHaveBeenCalledWith(
      JSON.stringify({
        result: true,
        type: 'dust-transfer-execute-result',
        message: 'The dust transfer request received.'
      })
    );
  });
});
