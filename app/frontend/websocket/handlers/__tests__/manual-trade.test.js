/* eslint-disable global-require */
describe('manual-trade.js', () => {
  const queue = require('../../../../cronjob/trailingTradeHelper/queue');

  let mockWebSocketServer;
  let mockWebSocketServerWebSocketSend;

  let loggerMock;
  let mockQueue;

  let mockSaveOverrideAction;
  let mockExecuteTrailingTrade;

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

    mockExecuteTrailingTrade = jest.fn().mockResolvedValue(true);

    jest.mock('../../../../cronjob', async () => ({
      executeTrailingTrade: mockExecuteTrailingTrade
    }));

    mockQueue = queue;

    jest.mock('../../../../cronjob/trailingTradeHelper/queue', () => mockQueue);
  });

  beforeEach(async () => {
    const { logger } = require('../../../../helpers');

    loggerMock = logger;
    loggerMock.fields = { correlationId: 'correlationId' };

    await queue.init(loggerMock, ['BTCUSDT']);

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

  it('triggers executeTrailingTrade', () => {
    expect(mockExecuteTrailingTrade).toHaveBeenCalledWith(
      loggerMock,
      'BTCUSDT',
      {
        correlationId: 'correlationId'
      }
    );
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
