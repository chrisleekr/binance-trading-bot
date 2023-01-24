/* eslint-disable global-require */
describe('manual-trade.js', () => {
  let mockWebSocketServer;
  let mockWebSocketServerWebSocketSend;

  let loggerMock;

  let mockSaveOverrideAction;
  let mockExecute;

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

    mockExecute = jest.fn((funcLogger, symbol, jobPayload) => {
      if (!funcLogger || !symbol || !jobPayload) return false;
      return jobPayload.preprocessFn();
    });

    jest.mock('../../../../cronjob/trailingTradeHelper/queue', () => ({
      execute: mockExecute
    }));
  });

  beforeEach(async () => {
    const { logger } = require('../../../../helpers');

    loggerMock = logger;
    loggerMock.fields = { correlationId: 'correlationId' };

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

  it('triggers queue.execute', () => {
    expect(mockExecute).toHaveBeenCalledWith(loggerMock, 'BTCUSDT', {
      correlationId: 'correlationId',
      preprocessFn: expect.any(Function),
      processFn: expect.any(Function)
    });
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
