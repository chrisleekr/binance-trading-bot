/* eslint-disable global-require */
describe('dust-transfer-get.js', () => {
  let mockWebSocketServer;
  let mockWebSocketServerWebSocketSend;

  let loggerMock;
  let cacheMock;
  let PubSubMock;

  let mockGetAccountInfo;
  let mockExtendBalancesWithDustTransfer;

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

    mockGetAccountInfo = jest.fn().mockResolvedValue({
      account: 'info'
    });
    mockExtendBalancesWithDustTransfer = jest.fn().mockResolvedValue({
      extended: 'balances',
      balances: [
        {
          asset: 'ETH',
          canDustTransfer: true
        },
        {
          asset: 'LTC',
          canDustTransfer: false
        },
        {
          asset: 'TRX',
          canDustTransfer: true
        }
      ]
    });

    jest.mock('../../../../cronjob/trailingTradeHelper/common', () => ({
      getAccountInfo: mockGetAccountInfo,
      extendBalancesWithDustTransfer: mockExtendBalancesWithDustTransfer
    }));

    const { handleDustTransferGet } = require('../dust-transfer-get');
    await handleDustTransferGet(loggerMock, mockWebSocketServer, {
      data: {}
    });
  });

  it('triggers getAccountInfo', () => {
    expect(mockGetAccountInfo).toHaveBeenCalledWith(loggerMock);
  });

  it('triggers extendBalancesWithDustTransfer', () => {
    expect(mockExtendBalancesWithDustTransfer).toHaveBeenCalledWith(
      loggerMock,
      {
        account: 'info'
      }
    );
  });

  it('triggers ws.send', () => {
    expect(mockWebSocketServerWebSocketSend).toHaveBeenCalledWith(
      JSON.stringify({
        result: true,
        type: 'dust-transfer-get-result',
        dustTransfer: [
          {
            asset: 'ETH',
            canDustTransfer: true
          },
          {
            asset: 'TRX',
            canDustTransfer: true
          }
        ]
      })
    );
  });
});
