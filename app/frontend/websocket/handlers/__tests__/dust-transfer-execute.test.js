/* eslint-disable global-require */
describe('dust-transfer-execute.js', () => {
  let mockWebSocketServer;
  let mockWebSocketServerWebSocketSend;

  let loggerMock;

  let mockSaveOverrideIndicatorAction;

  beforeEach(() => {
    jest.clearAllMocks().resetModules();

    mockWebSocketServerWebSocketSend = jest.fn().mockResolvedValue(true);

    mockWebSocketServer = {
      send: mockWebSocketServerWebSocketSend
    };

    mockSaveOverrideIndicatorAction = jest.fn().mockResolvedValue(true);

    jest.mock('../../../../cronjob/trailingTradeHelper/common', () => ({
      saveOverrideIndicatorAction: mockSaveOverrideIndicatorAction
    }));
  });

  beforeEach(async () => {
    const { logger } = require('../../../../helpers');

    loggerMock = logger;

    const { handleDustTransferExecute } = require('../dust-transfer-execute');
    await handleDustTransferExecute(loggerMock, mockWebSocketServer, {
      data: {
        dustTransfer: ['TRX', 'ETH']
      }
    });
  });

  it('triggers saveOverrideAction', () => {
    expect(mockSaveOverrideIndicatorAction).toHaveBeenCalledWith(
      loggerMock,
      'global',
      {
        action: 'dust-transfer',
        params: ['TRX', 'ETH'],
        actionAt: expect.any(String),
        triggeredBy: 'user'
      },
      'The dust transfer request received by the bot. Wait for executing the dust transfer.'
    );
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
